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
import TourHost from "../tour/TourHost";
import ParseFilterModal, { type ParseFilterResult } from "../components/common/ParseFilterModal";
import {
  postPointsToWorker, startConsolidate, getPointSummary,
  createThrottledChunkHandler, setConsolidationProgressCallback,
} from "../utils/flightConsolidationWorker";
import type { Aircraft, RadarSite, TrackPoint, WeatherVector } from "../types";

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
        for (const key of ["custom_radar_sites", "selected_radar_site", "dev_mode", "weather_nm_per_bin", "weather_colors", "bra_angle_deg"]) {
          const value = await invoke<string | null>("load_setting", { key });
          if (!value) continue;
          if (key === "custom_radar_sites") {
            const sites: RadarSite[] = JSON.parse(value);
            if (sites.length > 0) useAppStore.getState().setCustomRadarSites(sites);
          } else if (key === "selected_radar_site") {
            // 스냅샷 재해석 — selected_radar_site 는 저장 시점 스냅샷이라 이후 편집분이 빠져 있다.
            // 위 키 순서상 목록(custom_radar_sites)이 먼저 로드돼 있으므로 이름으로 최신 항목을 찾아 쓴다
            // (삭제된 사이트는 목록에 없으므로 스냅샷 폴백). setRadarSite 로 재영속 → 스냅샷 자가 치유
            const parsed: RadarSite = JSON.parse(value);
            const resolved = useAppStore.getState().customRadarSites.find((s) => s.name === parsed.name) ?? parsed;
            useAppStore.getState().setRadarSite(resolved);
          } else if (key === "dev_mode") {
            if (JSON.parse(value) === true) useAppStore.setState({ devMode: true });
          } else if (key === "weather_nm_per_bin") {
            const v = JSON.parse(value);
            if (typeof v === "number" && v > 0) useAppStore.setState({ weatherNmPerBin: v });
          } else if (key === "weather_colors") {
            // 강도 0~6 (7개) × [r,g,b] 0~255 형식일 때만 복원 (손상된 설정 무시)
            const v = JSON.parse(value);
            const ok =
              Array.isArray(v) && v.length === 7 &&
              v.every((c: unknown) =>
                Array.isArray(c) && c.length === 3 &&
                c.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n >= 0 && n <= 255)
              );
            if (ok) useAppStore.setState({ weatherColors: v as [number, number, number][] });
          } else if (key === "bra_angle_deg") {
            // 0.05~10° 범위의 유한수일 때만 복원 (손상된 설정 무시)
            const v = JSON.parse(value);
            if (typeof v === "number" && Number.isFinite(v) && v >= 0.05 && v <= 10) {
              useAppStore.setState({ braAngleDeg: v });
            }
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

    // 이전 기상 데이터 초기화
    useAppStore.getState().clearWeatherVectors();

    // 배치 파싱 이벤트 리스너 — 청크를 즉시 Worker로 fire-and-forget.
    // listener scope 종료 후 pts는 GC 가능 (closure capture 없음).
    let totalForwarded = 0;
    const unlisten = await listen<{ points: TrackPoint[] }>("parse-points-chunk", (event) => {
      const pts = event.payload.points;
      for (const p of pts) p.radar_name = site.name;
      totalForwarded += pts.length;
      postPointsToWorker(pts);
    });

    // 기상 벡터 청크 수신 → 누적 (CAT008, 트랙 독립). ~0.5M로 메인 보관 가능.
    const weatherAccum: WeatherVector[] = [];
    const unlistenWeather = await listen<{ vectors: WeatherVector[] }>("parse-weather-chunk", (event) => {
      const vs = event.payload.vectors;
      for (const v of vs) weatherAccum.push(v);
    });

    try {
      await invoke("parse_and_analyze_batch", {
        filePaths: paths,
        radarLat: site.latitude,
        radarLon: site.longitude,
        modeSInclude: filter.modeSInclude,
        modeSExclude: filter.modeSExclude,
        mode3aInclude: filter.mode3aInclude,
        mode3aExclude: filter.mode3aExclude,
      });
    } catch (e) {
      console.error("[TrackMap] 배치 파싱 실패:", e);
    }

    unlisten();
    unlistenWeather();

    // 기상 벡터 시간순 정렬 후 store 커밋 (여러 파일 병렬 도착 → 순서 보장 필요)
    if (weatherAccum.length > 0) {
      weatherAccum.sort((a, b) => a.time - b.time);
      useAppStore.getState().setWeatherVectors(weatherAccum);
    }

    if (totalForwarded > 0) {
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

    // 파싱 필터에 맞게 기본 필터 자동 설정
    const hasInclude = filter.modeSInclude.length > 0 || filter.mode3aInclude.length > 0;
    if (hasInclude) {
      const state = useAppStore.getState();
      const registeredCodes = new Set(state.aircraft.filter((a) => a.active).map((a) => a.mode_s_code.toUpperCase()));
      if (filter.modeSInclude.length === 1) {
        // 단일 Mode-S → 해당 기체 선택
        useAppStore.setState({ selectedModeS: filter.modeSInclude[0], selectedFlightId: null });
      } else if (filter.modeSInclude.length > 0 && filter.modeSInclude.every((c) => registeredCodes.has(c))) {
        // 포함된 Mode-S가 모두 등록 기체 → "등록 기체" 필터
        useAppStore.setState({ selectedModeS: null, selectedFlightId: null });
      } else {
        // 기타(비등록 포함 혼합) → 전체 항적
        useAppStore.setState({ selectedModeS: "__ALL__", selectedFlightId: null });
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

  // 레이더 사이트 변경 수신 (발신: 메인 창 레이더 관리) — 창마다 store 가 독립이고 시작 시 1회만
  // DB 복원하므로 이 경로가 없으면 편집 결과가 이 창에 전파되지 않는다.
  useEffect(() => {
    const unlisten = listen<{ sites: RadarSite[]; editedName?: string; site?: RadarSite }>(
      "radar-sites-changed",
      (e) => {
        // setter(setCustomRadarSites/setRadarSite) 대신 setState — 발신 창이 이미 DB에 영속했으므로 중복 쓰기 회피
        useAppStore.setState({ customRadarSites: e.payload.sites });
        const { editedName, site } = e.payload;
        if (editedName && site && useAppStore.getState().radarSite.name === editedName) {
          useAppStore.setState({ radarSite: site });
        }
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  return (
    <div className="flex h-full flex-col bg-white">
      {/* 상단바 — ASS 파일 열기 + 통계 */}
      <div className="relative flex h-8 shrink-0 items-center bg-white">
        <div data-tauri-drag-region className="flex flex-1 h-full items-center pl-4 gap-2">
          <button
            data-tour="tm-open-ass"
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
          <div className="flex-1" />
          {/* TrackMap 툴바 포탈: 통계 */}
          <div id="trackmap-toolbar-right" className="pointer-events-auto flex items-center gap-2" />
        </div>
        <Titlebar controlsOnly noBorder />
        {/* 하단 border — 사이드바(232px) 연결 구간 제외 */}
        <div className="pointer-events-none absolute bottom-0 left-[232px] right-0 h-px bg-gray-200" />
      </div>

      {/* 메인: 사이드바 + 지도 */}
      <div className="flex flex-1 min-h-0">
        <aside id="trackmap-sidebar" className="w-[232px] shrink-0 border-r border-gray-200 overflow-y-auto" />
        <main className="relative flex-1 overflow-hidden">
          <TrackMap />
        </main>
      </div>

      <SourceOverlay />
      <ToastContainer />
      <TourHost window="trackmap" />

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
