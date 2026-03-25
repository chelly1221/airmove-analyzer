/**
 * 보고서 편집 창 — 별도 Tauri 윈도우 (label: "report")
 * IDB에서 페이로드를 읽어 프리뷰를 렌더링하고 PDF 내보내기를 처리.
 */
import { useState, useRef, useCallback, useMemo, useEffect, startTransition } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { format } from "date-fns";
import { Download, Loader2, ArrowLeft } from "lucide-react";
import Titlebar from "../components/Layout/Titlebar";
import ReportPreviewContent, { getSectionToggles } from "../components/Report/ReportPreviewContent";
import { useReportExport } from "../components/Report/useReportExport";
import {
  readReportPayload, clearReportPayload, deserializeOMData,
  templateDisplayLabel,
  type ReportTemplate, type ReportSections, type ReportWindowPayload,
} from "../utils/reportTransfer";
import type {
  Flight, LoSProfileData, Aircraft as AircraftType, ReportMetadata,
  PanoramaPoint, ManualBuilding, RadarSite,
  ObstacleMonthlyResult, PreScreeningResult, OMReportData, SavedReportSummary,
} from "../types";
import type { CoverageLayer } from "../utils/radarCoverage";

const appWindow = getCurrentWindow();

/** OM result에서 2주 초과 시 최근 31일만 사용 */
function trimOMResult(result: ObstacleMonthlyResult | null): ObstacleMonthlyResult | null {
  if (!result) return null;
  const MAX_DAYS = 31;
  const TWO_WEEKS = 14;
  return {
    ...result,
    radar_results: result.radar_results.map((rr) => {
      if (rr.daily_stats.length <= TWO_WEEKS) return rr;
      const sorted = [...rr.daily_stats].sort((a, b) => b.date.localeCompare(a.date));
      const trimmed = sorted.slice(0, MAX_DAYS).sort((a, b) => a.date.localeCompare(b.date));
      return { ...rr, daily_stats: trimmed };
    }),
  };
}

// ── 로드 상태 ──

interface LoadedState {
  template: ReportTemplate;
  sections: ReportSections;
  editingReportId: string | null;
  coverTitle: string;
  coverSubtitle: string;
  commentary: string;
  flights: Flight[];
  reportFlights: Flight[];
  losResults: LoSProfileData[];
  aircraft: AircraftType[];
  radarSite: RadarSite;
  reportMetadata: ReportMetadata;
  panoramaData: PanoramaPoint[];
  panoramaPeakNames: Map<number, string>;
  coverageLayers: CoverageLayer[];
  mapImage: string | null;
  omData: OMReportData;
  psResult: PreScreeningResult | null;
  psSelectedBuildings: ManualBuilding[];
  psSelectedRadarSites: RadarSite[];
  psLosMap: Map<string, LoSProfileData>;
  psCovLayersWith: CoverageLayer[];
  psCovLayersWithout: CoverageLayer[];
  psAnalysisMonth: string;
  selectedFlightIds: string[];
  singleFlightId: string | null;
}

function payloadToState(p: ReportWindowPayload): LoadedState {
  return {
    template: p.template,
    sections: p.sections,
    editingReportId: p.editingReportId,
    coverTitle: p.coverTitle,
    coverSubtitle: p.coverSubtitle,
    commentary: p.commentary,
    flights: p.flights,
    reportFlights: p.reportFlights,
    losResults: p.losResults,
    aircraft: p.aircraft,
    radarSite: p.radarSite,
    reportMetadata: p.reportMetadata,
    panoramaData: p.panoramaData,
    panoramaPeakNames: new Map(p.panoramaPeakNames),
    coverageLayers: p.coverageLayers,
    mapImage: p.mapImage,
    omData: deserializeOMData(p.omData),
    psResult: p.psResult,
    psSelectedBuildings: p.psSelectedBuildings,
    psSelectedRadarSites: p.psSelectedRadarSites,
    psLosMap: new Map(p.psLosMap),
    psCovLayersWith: p.psCovLayersWith,
    psCovLayersWithout: p.psCovLayersWithout,
    psAnalysisMonth: p.psAnalysisMonth,
    selectedFlightIds: p.selectedFlightIds,
    singleFlightId: p.singleFlightId,
  };
}

// ── 메인 컴포넌트 ──

export default function ReportApp() {
  const [state, setState] = useState<LoadedState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 섹션 토글 (로컬 상태)
  const [sections, setSections] = useState<ReportSections | null>(null);

  // 편집 가능 텍스트
  const [coverTitle, setCoverTitle] = useState("");
  const [coverSubtitle, setCoverSubtitle] = useState("");
  const [commentary, setCommentary] = useState("");
  const [editingReportId, setEditingReportId] = useState<string | null>(null);

  // omData (로컬, 비동기 업데이트 가능)
  const [omData, setOmData] = useState<OMReportData | null>(null);

  // PDF 내보내기
  const [generating, setGenerating] = useState(false);
  const [forceAllVisible, setForceAllVisible] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const { exportPDF } = useReportExport();


  // IDB에서 데이터 로드
  useEffect(() => {
    (async () => {
      try {
        const payload = await readReportPayload();
        if (!payload) {
          setError("보고서 데이터를 찾을 수 없습니다");
          setLoading(false);
          return;
        }
        const s = payloadToState(payload);

        // IDB 정리
        await clearReportPayload();

        // startTransition으로 무거운 렌더 지연 — 로딩 화면이 유지됨
        startTransition(() => {
          setState(s);
          setSections(s.sections);
          setCoverTitle(s.coverTitle);
          setCoverSubtitle(s.coverSubtitle);
          setCommentary(s.commentary);
          setEditingReportId(s.editingReportId);
          setOmData(s.omData);
          setLoading(false);
        });
      } catch (e) {
        setError(`데이터 로드 실패: ${e instanceof Error ? e.message : String(e)}`);
        setLoading(false);
      }
    })();
  }, []);

  // 비동기 커버리지 업데이트 수신
  useEffect(() => {
    const unlisten = listen<{ covLayersWithBuildings: CoverageLayer[]; covLayersWithout: CoverageLayer[]; coverageStatus: string }>(
      "report:coverage-update",
      (event) => {
        setOmData((prev) => {
          if (!prev) return prev;
          const nextImages = new Map(prev.sectionImages);
          for (const key of nextImages.keys()) {
            if (key.startsWith("cov-") || key.startsWith("loss-ev")) nextImages.delete(key);
          }
          return {
            ...prev,
            covLayersWithBuildings: event.payload.covLayersWithBuildings,
            covLayersWithout: event.payload.covLayersWithout,
            coverageStatus: event.payload.coverageStatus as OMReportData["coverageStatus"],
            sectionImages: nextImages,
          };
        });
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // 새 보고서 데이터 수신 (같은 창에서 재로드)
  useEffect(() => {
    const unlisten = listen<null>("report:reload-data", async () => {
      try {
        const payload = await readReportPayload();
        if (!payload) return;
        const s = payloadToState(payload);
        setState(s);
        setSections(s.sections);
        setCoverTitle(s.coverTitle);
        setCoverSubtitle(s.coverSubtitle);
        setCommentary(s.commentary);
        setEditingReportId(s.editingReportId);
        setOmData(s.omData);
        await clearReportPayload();
      } catch {}
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // OM trimmed result
  const omResultTrimmed = useMemo(() => {
    return trimOMResult(omData?.result ?? null);
  }, [omData?.result]);

  // 현재 활성 sections
  const activeSections = sections ?? state?.sections;
  const activeTemplate = state?.template ?? "weekly";

  // 섹션 토글 목록
  const toggles = useMemo(() => {
    if (!activeSections) return [];
    return getSectionToggles(activeTemplate, activeSections);
  }, [activeTemplate, activeSections]);

  // PDF 내보내기 + DB 저장
  const handleExportPDF = useCallback(async () => {
    if (!state || !activeSections) return;
    setGenerating(true);
    setForceAllVisible(true);
    setExportError(null);
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const dateStr = format(new Date(), "yyyyMMdd_HHmmss");
      const tplLabel = templateDisplayLabel(activeTemplate);
      const filename = `비행검사_${tplLabel}_보고서_${dateStr}.pdf`;
      const result = await exportPDF(previewRef, filename);
      if (!result.success && result.error && result.error !== "저장이 취소되었습니다") {
        setExportError(result.error);
      }
      // 보고서 DB 저장
      if (result.success && result.pdfBase64) {
        const reportId = editingReportId ?? `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const configJson = JSON.stringify({
          template: activeTemplate,
          sections: activeSections,
          selectedFlightIds: state.selectedFlightIds,
          singleFlightId: state.singleFlightId,
          coverTitle,
          coverSubtitle,
          commentary,
          omFindingsText: omData?.findingsText ?? "",
          omRecommendText: omData?.recommendText ?? "",
          mapImage: state.mapImage,
        });
        const metaJson = JSON.stringify(state.reportMetadata);
        try {
          await invoke("save_report", {
            id: reportId,
            title: coverTitle,
            template: activeTemplate,
            radarName: state.radarSite?.name ?? "",
            reportConfigJson: configJson,
            pdfBase64: result.pdfBase64,
            metadataJson: metaJson,
          });
          const summary: SavedReportSummary = {
            id: reportId,
            title: coverTitle,
            template: activeTemplate,
            radar_name: state.radarSite?.name ?? "",
            created_at: Math.floor(Date.now() / 1000),
            has_pdf: true,
          };
          // 메인 창에 알림
          await emit("report:saved", {
            summary,
            isEdit: !!editingReportId,
          });
          setEditingReportId(null);
          console.log(`[ReportApp] 보고서 DB 저장: ${reportId}`);
        } catch (e) {
          console.warn("[ReportApp] DB 저장 실패:", e);
        }
      }
    } catch (err) {
      setExportError(`PDF 내보내기 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(false);
      setForceAllVisible(false);
    }
  }, [state, activeTemplate, activeSections, exportPDF, coverTitle, coverSubtitle, commentary, omData, editingReportId]);

  // 로딩/에러 화면
  if (loading || error || !state || !activeSections || !omData) {
    return (
      <div className="flex h-screen flex-col bg-white">
        <Titlebar controlsOnly />
        <div className="flex flex-1 items-center justify-center">
          {loading ? (
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={24} className="animate-spin text-[#a60739]" />
              <p className="text-sm text-gray-500">보고서 데이터 로딩 중...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-red-500">{error ?? "데이터 없음"}</p>
              <button
                onClick={() => appWindow.close()}
                className="rounded-lg border border-gray-200 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
              >
                닫기
              </button>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white">
      <Titlebar controlsOnly />

      {/* 상단 툴바 */}
      <div className="z-20 flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 py-2">
        <button
          onClick={() => appWindow.close()}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-100"
        >
          <ArrowLeft size={14} />
          닫기
        </button>

        {/* 섹션 토글 (컴팩트) */}
        <div className="ml-2 flex items-center gap-1">
          {toggles.map((s) => (
            <button
              key={s.key}
              onClick={() => setSections((prev) => prev ? { ...prev, [s.key]: !prev[s.key] } : prev)}
              className={`rounded px-2 py-1 text-[11px] transition-colors ${
                activeSections[s.key]
                  ? "bg-[#a60739]/10 text-[#a60739] font-medium"
                  : "text-gray-400 hover:bg-gray-100"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>

        <div className="flex-1" />

        {editingReportId && (
          <span className="rounded-full bg-blue-100 px-2.5 py-0.5 text-[11px] font-medium text-blue-600">
            수정 모드
          </span>
        )}

        {exportError && (
          <span className="text-xs text-red-500">{exportError}</span>
        )}

        <button
          onClick={handleExportPDF}
          disabled={generating}
          className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {generating ? "생성 중..." : editingReportId ? "PDF 재저장" : "PDF 다운로드"}
        </button>
      </div>

      {/* 보고서 프리뷰 */}
      <ReportPreviewContent
        template={activeTemplate}
        sections={activeSections}
        flights={state.flights}
        reportFlights={state.reportFlights}
        losResults={state.losResults}
        aircraft={state.aircraft}
        radarSite={state.radarSite}
        reportMetadata={state.reportMetadata}
        panoramaData={state.panoramaData}
        panoramaPeakNames={state.panoramaPeakNames}
        coverageLayers={state.coverageLayers}
        mapImage={state.mapImage}
        omData={omData}
        omResultTrimmed={omResultTrimmed}
        psResult={state.psResult}
        psSelectedBuildings={state.psSelectedBuildings}
        psSelectedRadarSites={state.psSelectedRadarSites}
        psLosMap={state.psLosMap}
        psCovLayersWith={state.psCovLayersWith}
        psCovLayersWithout={state.psCovLayersWithout}
        psAnalysisMonth={state.psAnalysisMonth}
        coverTitle={coverTitle}
        onCoverTitleChange={setCoverTitle}
        coverSubtitle={coverSubtitle}
        onCoverSubtitleChange={setCoverSubtitle}
        commentary={commentary}
        onCommentaryChange={setCommentary}
        forceAllVisible={forceAllVisible}
        onOmDataChange={(updater) => setOmData((prev) => prev ? updater(prev) : prev)}
        previewRef={previewRef}
      />
    </div>
  );
}
