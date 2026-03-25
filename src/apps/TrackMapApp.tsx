import { useEffect, useRef, useState, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { FolderOpen, Loader2 } from "lucide-react";
import Titlebar from "../components/Layout/Titlebar";
import TrackMap from "../pages/TrackMap";
import { useAppStore } from "../store";
import { ToastContainer } from "../components/common/Toast";
import SourceOverlay from "../dev/SourceOverlay";
import ParseFilterModal, { type ParseFilterResult } from "../components/common/ParseFilterModal";
import {
  sendPointsToWorker, startConsolidate, getPointSummary,
  createThrottledChunkHandler, setConsolidationProgressCallback,
} from "../utils/flightConsolidationWorker";
import type { Aircraft, RadarSite, TrackPoint } from "../types";

/** DB에서 설정 복원 */
function useRestoreSettings() {
  const loadedRef = useRef(false);
  useEffect(() => {
    if (loadedRef.current) return;
    loadedRef.current = true;
    (async () => {
      try {
        const dbAircraft = await invoke<Aircraft[]>("get_aircraft_list");
        if (dbAircraft.length > 0) useAppStore.setState({ aircraft: dbAircraft });
      } catch {}
      try {
        for (const key of ["custom_radar_sites", "selected_radar_site", "dev_mode"]) {
          const value = await invoke<string | null>("load_setting", { key });
          if (!value) continue;
          if (key === "custom_radar_sites") {
            const sites: RadarSite[] = JSON.parse(value);
            if (sites.length > 0) useAppStore.getState().setCustomRadarSites(sites);
          } else if (key === "selected_radar_site") {
            useAppStore.getState().setRadarSite(JSON.parse(value));
          } else if (key === "dev_mode") {
            if (JSON.parse(value) === true) useAppStore.setState({ devMode: true });
          }
        }
      } catch {}
    })();
  }, []);
}

/** ASS 파일 선택 → 필터 모달 → 파싱 → Worker 전송 → 비행 통합 */
function useAssFilePicker() {
  const [parsing, setParsing] = useState(false);
  const [fileCount, setFileCount] = useState(0);
  const [filterModalOpen, setFilterModalOpen] = useState(false);
  const [pendingPaths, setPendingPaths] = useState<string[]>([]);
  const consolidatingRef = useRef(false);

  // 1단계: 파일 선택 → 필터 모달 표시
  const pickFiles = useCallback(async () => {
    if (parsing) return;
    const result = await open({
      multiple: true,
      filters: [{ name: "ASS Files", extensions: ["ass", "ASS"] }],
    });
    if (!result) return;
    const paths = (Array.isArray(result) ? result : [result]).filter((p): p is string => typeof p === "string");
    if (paths.length === 0) return;

    setPendingPaths(paths);
    setFilterModalOpen(true);
  }, [parsing]);

  // 2단계: 필터 확정 → 파싱 실행
  const parseWithFilter = useCallback(async (filter: ParseFilterResult) => {
    setFilterModalOpen(false);
    const paths = pendingPaths;
    if (paths.length === 0) return;

    setParsing(true);
    setFileCount(paths.length);

    const site = useAppStore.getState().radarSite;

    // 배치 파싱 이벤트 리스너
    const pointChunks: TrackPoint[] = [];
    const unlisten = await listen<{ points: TrackPoint[] }>("parse-points-chunk", (event) => {
      const pts = event.payload.points;
      for (const p of pts) p.radar_name = site.name;
      pointChunks.push(...pts);
    });

    try {
      await invoke("parse_and_analyze_batch", {
        filePaths: paths,
        radarLat: site.latitude,
        radarLon: site.longitude,
        modeSFilter: filter.modeSFilter,
        mode3aFilter: filter.mode3aFilter,
        filterLogic: filter.filterLogic,
        modeSExclude: filter.modeSExclude,
        mode3aExclude: filter.mode3aExclude,
      });
    } catch (e) {
      console.error("[TrackMap] 배치 파싱 실패:", e);
    }

    unlisten();

    // Worker에 포인트 전송
    if (pointChunks.length > 0) {
      await sendPointsToWorker(pointChunks);
      const summary = await getPointSummary();
      useAppStore.setState({
        workerPointCount: summary.totalPoints,
        workerPointSummary: summary.entries,
      });
    }

    // 비행 통합
    if (!consolidatingRef.current && useAppStore.getState().workerPointCount > 0) {
      consolidatingRef.current = true;
      useAppStore.getState().setConsolidating(true);
      useAppStore.getState().setConsolidationProgress({ stage: "grouping", current: 0, total: 0, flightsBuilt: 0 });
      setConsolidationProgressCallback((p) => useAppStore.getState().setConsolidationProgress(p as any));
      try {
        const state = useAppStore.getState();
        const { handler, flush } = createThrottledChunkHandler(
          (batch) => useAppStore.getState().appendFlights(batch), 250,
        );
        await startConsolidate([], state.aircraft, state.radarSite, handler);
        flush();
      } finally {
        consolidatingRef.current = false;
        setConsolidationProgressCallback(null);
        useAppStore.getState().setConsolidating(false);
        useAppStore.getState().setConsolidationProgress(null);
        useAppStore.getState().finalizeFlights();
      }
    }

    setParsing(false);
    setPendingPaths([]);
  }, [pendingPaths]);

  const closeFilterModal = useCallback(() => {
    setFilterModalOpen(false);
    setPendingPaths([]);
  }, []);

  return { pickFiles, parseWithFilter, closeFilterModal, filterModalOpen, parsing, fileCount };
}

export default function TrackMapApp() {
  const consolidating = useAppStore((s) => s.consolidating);
  const consolidationProgress = useAppStore((s) => s.consolidationProgress);
  const flights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);

  useRestoreSettings();
  const { pickFiles, parseWithFilter, closeFilterModal, filterModalOpen, parsing, fileCount } = useAssFilePicker();

  return (
    <div className="flex h-full flex-col bg-white">
      {/* 타이틀바 + ASS 파일 열기 버튼 */}
      <div className="flex h-8 shrink-0 items-center bg-white">
        <div data-tauri-drag-region className="flex flex-1 h-full items-center pl-4 gap-2">
          <button
            onClick={pickFiles}
            disabled={parsing || consolidating}
            className="pointer-events-auto flex items-center gap-1.5 rounded bg-[#a60739] px-3 py-1 text-[11px] font-medium text-white hover:bg-[#8a062f] disabled:opacity-50 transition-colors"
          >
            {parsing ? <Loader2 size={12} className="animate-spin" /> : <FolderOpen size={12} />}
            {parsing ? `파싱 중 (${fileCount})...` : "ASS 파일 열기"}
          </button>
          {flights.length > 0 && (
            <span className="text-[11px] text-gray-400 pointer-events-none">
              {flights.length}개 비행
            </span>
          )}
          {/* TrackMap 툴바 포탈: 왼쪽 (드롭다운+토글) */}
          <div id="trackmap-toolbar-left" className="pointer-events-auto flex items-center gap-2" />
          <div className="flex-1" />
          {/* TrackMap 툴바 포탈: 오른쪽 (통계) */}
          <div id="trackmap-toolbar-right" className="pointer-events-auto flex items-center gap-2" />
        </div>
        <Titlebar controlsOnly />
      </div>

      {/* TrackMap 전체 화면 */}
      <main className="relative flex-1 overflow-hidden">
        <TrackMap />
      </main>

      <SourceOverlay />
      <ToastContainer />

      {/* 파싱 필터 모달 */}
      <ParseFilterModal
        open={filterModalOpen}
        onClose={closeFilterModal}
        onConfirm={parseWithFilter}
        aircraft={aircraft}
      />

      {/* Consolidation progress overlay */}
      {consolidating && consolidationProgress && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-xl bg-white p-8 shadow-2xl border border-gray-200 min-w-[280px]">
            <Loader2 size={28} className="animate-spin text-[#a60739]" />
            <p className="text-sm text-gray-600">
              {consolidationProgress.stage === "grouping" && "포인트 그룹핑 중..."}
              {consolidationProgress.stage === "building" &&
                `비행 생성 중... (${consolidationProgress.flightsBuilt}건)`}
              {consolidationProgress.stage === "history" && "운항이력 로드 중..."}
              {consolidationProgress.stage === "done" && "완료"}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
