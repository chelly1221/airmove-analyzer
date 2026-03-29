/**
 * 보고서 편집 창 — 별도 Tauri 윈도우 (label: "report")
 * IDB에서 페이로드를 읽어 프리뷰를 렌더링하고 PDF 내보내기를 처리.
 */
import { useState, useRef, useCallback, useMemo, useEffect, startTransition } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { format } from "date-fns";
import { Download, Loader2, TriangleAlert } from "lucide-react";
import Titlebar from "../components/Layout/Titlebar";
import ReportPreviewContent, { getSectionToggles } from "../components/Report/ReportPreviewContent";
import { useReportExport, type ReportSaveMeta } from "../components/Report/useReportExport";
import TemplateConfigModal from "../components/Report/TemplateConfigModal";
import ObstacleMonthlyConfigModal from "../components/Report/ObstacleMonthlyConfigModal";
import ObstaclePreScreeningModal from "../components/Report/ObstaclePreScreeningModal";
import { generateOMFindingsText } from "../utils/omFindingsGenerator";
import {
  readReportPayload, clearReportPayload, deserializeOMData, serializeOMData,
  readReportConfig, clearReportConfig, writeGenerateRequest,
  templateDisplayLabel, DEFAULT_SECTIONS,
  type ReportTemplate, type ReportSections, type ReportWindowPayload,
  type ReportConfigPayload,
} from "../utils/reportTransfer";
import type {
  Flight, LoSProfileData, Aircraft as AircraftType, ReportMetadata,
  PanoramaPoint, ManualBuilding, RadarSite, TrackPoint, AzSector,
  ObstacleMonthlyResult, PreScreeningResult, OMReportData, SavedReportSummary,
} from "../types";
import type { CoverageLayer } from "../utils/radarCoverage";
import SourceOverlay from "../dev/SourceOverlay";

const appWindow = getCurrentWindow();


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
  singleFlightChartPoints?: TrackPoint[];
}

function payloadToState(p: ReportWindowPayload): LoadedState {
  return {
    template: p.template,
    sections: p.sections,
    editingReportId: p.editingReportId,
    coverTitle: p.coverTitle,
    coverSubtitle: p.coverSubtitle ?? format(new Date(), "yyyy년 MM월"),
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
    singleFlightChartPoints: p.singleFlightChartPoints,
  };
}

// ── 메인 컴포넌트 ──

export default function ReportApp() {
  const [state, setState] = useState<LoadedState | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 설정 모달 단계 (config payload가 있으면 모달 표시)
  const [configPayload, setConfigPayload] = useState<ReportConfigPayload | null>(null);

  // 보고서 준비 단계 (보고서 창 내 오버레이)
  const [prepPhase, setPrepPhase] = useState<"waiting" | "loading" | null>("waiting");

  // 섹션 토글 (로컬 상태)
  const [sections, setSections] = useState<ReportSections | null>(null);

  // 편집 가능 텍스트
  const [coverTitle, setCoverTitle] = useState("");
  const [coverSubtitle, setCoverSubtitle] = useState(() => format(new Date(), "yyyy년 MM월"));
  const [commentary, setCommentary] = useState("");
  const [editingReportId, setEditingReportId] = useState<string | null>(null);

  // omData (로컬, 비동기 업데이트 가능)
  const [omData, setOmData] = useState<OMReportData | null>(null);

  // 닫기 확인 모달
  const [closeConfirmOpen, setCloseConfirmOpen] = useState(false);

  // OM/PS 데이터 캐시 — IDB 왕복 시 커버리지 등 대용량 데이터 제외하고,
  // 보고서 창 메모리에 직접 보관하여 IDB 병목 방지
  const omDataCacheRef = useRef<OMReportData | null>(null);
  const psDataCacheRef = useRef<{
    result: PreScreeningResult;
    buildings: ManualBuilding[];
    radars: RadarSite[];
    losMap: Map<string, LoSProfileData>;
    covWith: CoverageLayer[];
    covWithout: CoverageLayer[];
    monthStr: string;
  } | null>(null);

  // PDF 내보내기
  const [generating, setGenerating] = useState(false);
  const generatingRef = useRef(false);
  const covQueueRef = useRef<(() => void) | null>(null);
  const [forceAllVisible, setForceAllVisible] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportElapsed, setExportElapsed] = useState(0);
  const exportTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const { exportPDF } = useReportExport();

  /** IDB에서 페이로드 읽기 → state 적용 */
  const loadingRef = useRef(false);
  const loadFromIDB = useCallback(async () => {
    // 중복 호출 방지 (fallback timer + event 동시 발생 시)
    if (loadingRef.current) return;
    loadingRef.current = true;
    setPrepPhase("loading");
    try {
      const payload = await readReportPayload();
      if (!payload) {
        loadingRef.current = false;
        setPrepPhase("waiting"); // 아직 IDB에 없음 — 이벤트 대기
        return;
      }
      const s = payloadToState(payload);
      await clearReportPayload();

      // 캐시된 대용량 데이터가 있으면 IDB에서 받은 경량 버전 대신 원본 사용
      const cachedOm = omDataCacheRef.current;
      if (cachedOm && s.template === "obstacle_monthly") {
        s.omData = cachedOm;
        omDataCacheRef.current = null;
      }
      const cachedPs = psDataCacheRef.current;
      if (cachedPs && s.template === "obstacle") {
        s.psResult = cachedPs.result;
        s.psSelectedBuildings = cachedPs.buildings;
        s.psSelectedRadarSites = cachedPs.radars;
        s.psLosMap = cachedPs.losMap;
        s.psCovLayersWith = cachedPs.covWith;
        s.psCovLayersWithout = cachedPs.covWithout;
        s.psAnalysisMonth = cachedPs.monthStr;
        psDataCacheRef.current = null;
      }

      startTransition(() => {
        setState(s);
        setSections(s.sections);
        setCoverTitle(s.coverTitle);
        setCoverSubtitle(s.coverSubtitle);
        setCommentary(s.commentary);
        setEditingReportId(s.editingReportId);
        setOmData(s.omData);
        setLoading(false);
        setPrepPhase(null);
        loadingRef.current = false;
      });
    } catch (e) {
      setError(`데이터 로드 실패: ${e instanceof Error ? e.message : String(e)}`);
      setLoading(false);
      setPrepPhase(null);
      loadingRef.current = false;
    }
  }, []);

  /** IDB에서 config 읽기 → 모달 표시 */
  const loadConfigFromIDB = useCallback(async () => {
    try {
      const config = await readReportConfig();
      if (config) {
        await clearReportConfig();

        setConfigPayload(config);
        setLoading(false);
        setPrepPhase(null);
        return true;
      }
    } catch { /* ignore */ }
    return false;
  }, []);

  // 이벤트 리스너: data-written, reload-config, reload-data, coverage-update
  useEffect(() => {
    // 보고서 창 DevTools 활성화
    invoke("open_devtools").catch(() => {});

    // 마운트 시: config 먼저 확인, 없으면 payload 확인
    (async () => {
      const hasConfig = await loadConfigFromIDB();
      if (!hasConfig) loadFromIDB();
    })();

    // report:data-written → IDB에서 전체 페이로드 읽기
    const unlistenData = listen("report:data-written", () => {
      loadFromIDB();
    });

    // report:reload-config → 기존 창 재사용 시 모달 다시 표시
    const unlistenReloadConfig = listen("report:reload-config", async () => {
      loadingRef.current = false;
      omDataCacheRef.current = null;
      psDataCacheRef.current = null;
      setState(null);
      setLoading(true);
      setPrepPhase("waiting");
      // 짧은 지연 후 config 읽기 (IDB 쓰기 완료 대기)
      setTimeout(() => loadConfigFromIDB(), 100);
    });

    // report:reload-data → 기존 창 재사용 시 (편집 모드) 오버레이 표시
    const unlistenReload = listen("report:reload-data", () => {
      loadingRef.current = false;
      omDataCacheRef.current = null;
      psDataCacheRef.current = null;
      setConfigPayload(null); // 모달 닫기
      setPrepPhase("waiting");
      setLoading(true);
    });

    // report:data-error → 메인 창에서 데이터 생성 실패 시 에러 표시
    const unlistenError = listen<{ message: string }>("report:data-error", (event) => {
      setError(`보고서 생성 실패: ${event.payload.message}`);
      setLoading(false);
      setPrepPhase(null);
      loadingRef.current = false;
    });

    // 비동기 커버리지 업데이트 수신 — PDF 생성 중이면 큐에 저장
    const unlistenCov = listen<{ covLayersWithBuildings: CoverageLayer[]; covLayersWithout: CoverageLayer[]; coverageStatus: string }>(
      "report:coverage-update",
      (event) => {
        const apply = () => {
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
        };
        if (generatingRef.current) {
          covQueueRef.current = apply;
        } else {
          apply();
        }
      },
    );

    // 보고서 윈도우 닫기 전 미저장 확인
    const unlistenClose = appWindow.onCloseRequested(async (event) => {
      if (generatingRef.current) {
        event.preventDefault();
        return;
      }
      event.preventDefault();
      setCloseConfirmOpen(true);
    });

    return () => {
      unlistenData.then((fn) => fn());
      unlistenReloadConfig.then((fn) => fn());
      unlistenReload.then((fn) => fn());
      unlistenError.then((fn) => fn());
      unlistenCov.then((fn) => fn());
      unlistenClose.then((fn) => fn());
    };
  }, [loadFromIDB, loadConfigFromIDB]);


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
    // 기존 보고서 덮어쓰기 확인
    if (editingReportId) {
      const { confirm } = await import("@tauri-apps/plugin-dialog");
      const yes = await confirm("기존 보고서를 덮어쓰시겠습니까? PDF가 새로 생성됩니다.", {
        title: "보고서 덮어쓰기",
        kind: "warning",
      });
      if (!yes) return;
    }
    setGenerating(true);
    generatingRef.current = true;
    setForceAllVisible(true);
    setExportError(null);
    setExportElapsed(0);
    exportTimerRef.current = setInterval(() => setExportElapsed((p) => p + 1), 1000);
    // OMSectionImage 캡처 완료 대기 (500ms delay + html2canvas) — 충분한 대기
    await new Promise((r) => setTimeout(r, 1200));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const dateStr = format(new Date(), "yyyyMMdd_HHmmss");
      const tplLabel = templateDisplayLabel(activeTemplate);
      const filename = `비행검사_${tplLabel}_보고서_${dateStr}.pdf`;

      // 보고서 메타데이터 준비 (통합 커맨드: PDF 생성 + DB 저장 일괄 처리)
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
      const reportMeta: ReportSaveMeta = {
        reportId,
        title: coverTitle,
        template: activeTemplate,
        radarName: state.radarSite?.name ?? "",
        reportConfigJson: configJson,
        metadataJson: JSON.stringify(state.reportMetadata),
      };

      const result = await exportPDF(previewRef, filename, reportMeta);
      if (!result.success && result.error && result.error !== "저장이 취소되었습니다") {
        setExportError(result.error);
      }
      // Rust에서 DB 저장 완료 → 메인 창에 알림만 발행
      if (result.success) {
        const summary: SavedReportSummary = {
          id: reportId,
          title: coverTitle,
          template: activeTemplate,
          radar_name: state.radarSite?.name ?? "",
          created_at: Math.floor(Date.now() / 1000),
          has_pdf: true,
        };
        await emit("report:saved", {
          summary,
          isEdit: !!editingReportId,
        });
        setEditingReportId(null);
        console.log(`[ReportApp] 보고서 저장 완료: ${reportId}`);
      }
    } catch (err) {
      setExportError(`PDF 내보내기 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (exportTimerRef.current) { clearInterval(exportTimerRef.current); exportTimerRef.current = null; }
      setGenerating(false);
      generatingRef.current = false;
      setForceAllVisible(false);
      // 큐에 쌓인 커버리지 업데이트 적용
      const queued = covQueueRef.current;
      if (queued) {
        covQueueRef.current = null;
        queued();
      }
    }
  }, [state, activeTemplate, activeSections, exportPDF, coverTitle, coverSubtitle, commentary, omData, editingReportId]);

  // ── 모달에서 생성 요청 → IDB + emit ──
  const handleModalGenerate = useCallback(async (
    tpl: ReportTemplate,
    sects: ReportSections,
    flightIds?: Set<string>,
    singleId?: string | null,
  ) => {

    setConfigPayload(null);
    setLoading(true);
    setPrepPhase("waiting");
    await writeGenerateRequest({
      template: tpl,
      sections: sects,
      selectedFlightIds: flightIds ? [...flightIds] : undefined,
      singleFlightId: singleId,
    });
    await emit("report:generate");
  }, []);

  // ── 장애물 월간 모달 생성 핸들러 ──
  const handleOMGenerate = useCallback(async (
    result: ObstacleMonthlyResult,
    buildings: ManualBuilding[],
    radars: RadarSite[],
    azMap: Map<string, AzSector[]>,
    losMap: Map<string, LoSProfileData>,
    covWith: CoverageLayer[],
    covWithout: CoverageLayer[],
    monthStr?: string,
  ) => {
    const newOmData: OMReportData = {
      result,
      selectedBuildings: buildings,
      selectedRadarSites: radars,
      azSectorsByRadar: azMap,
      losMap,
      covLayersWithBuildings: covWith,
      covLayersWithout: covWithout,
      analysisMonth: monthStr ?? "",
      findingsText: generateOMFindingsText({
        radarResults: result.radar_results,
        selectedBuildings: buildings,
        radarSites: radars,
        losMap,
        covLayersWithBuildings: covWith,
        covLayersWithout: covWithout,
        analysisMonth: monthStr ?? "",
      }),
      recommendText: "",
      coverageStatus: covWith.length > 0 ? "done" : "loading",
      panoramaStatus: "idle",
      sectionImages: new Map(),
      panoWithTargets: new Map(),
      panoWithoutTargets: new Map(),
    };

    // 대용량 데이터(커버리지 레이어 + track_points_geo)는 메모리에 캐시하고
    // IDB에는 경량 버전만 전송하여 직렬화/역직렬화 병목 방지
    omDataCacheRef.current = newOmData;

    const lightResult: ObstacleMonthlyResult = {
      radar_results: result.radar_results.map((rr) => ({
        ...rr,
        daily_stats: rr.daily_stats.map((d) => ({
          ...d,
          track_points_geo: [],
        })),
      })),
    };
    const lightOmData: OMReportData = {
      ...newOmData,
      result: lightResult,
      covLayersWithBuildings: [],
      covLayersWithout: [],
      coverageStatus: covWith.length > 0 ? "done" : "idle",
    };

    setConfigPayload(null);
    setLoading(true);
    setPrepPhase("waiting");
    await writeGenerateRequest({
      template: "obstacle_monthly",
      sections: { ...DEFAULT_SECTIONS },
      omData: serializeOMData(lightOmData),
    });
    await emit("report:generate");
  }, []);

  // ── 사전검토 모달 생성 핸들러 ──
  const handlePSGenerate = useCallback(async (
    result: PreScreeningResult,
    buildings: ManualBuilding[],
    radars: RadarSite[],
    losMap: Map<string, LoSProfileData>,
    covWith: CoverageLayer[],
    covWithout: CoverageLayer[],
    monthStr?: string,
  ) => {
    // 대용량 데이터(커버리지 레이어 + LoS)는 메모리에 캐시하고
    // IDB에는 경량 버전만 전송하여 직렬화/역직렬화 병목 방지
    psDataCacheRef.current = {
      result, buildings, radars, losMap,
      covWith, covWithout, monthStr: monthStr ?? "",
    };

    setConfigPayload(null);
    setLoading(true);
    setPrepPhase("waiting");
    await writeGenerateRequest({
      template: "obstacle",
      sections: { ...DEFAULT_SECTIONS },
      psResult: result,
      psSelectedBuildings: buildings,
      psSelectedRadarSites: radars,
      psLosMap: [...losMap],
      psCovLayersWith: [],
      psCovLayersWithout: [],
      psAnalysisMonth: monthStr,
    });
    await emit("report:generate");
  }, []);

  // ── 커버리지 콜백 (모달 언마운트 후에도 동작) ──
  const handleCoverageReady = useCallback((covWith: CoverageLayer[], covWithout: CoverageLayer[]) => {
    // 보고서 창 내부에서 직접 omData 업데이트
    setOmData((prev) => {
      if (!prev) return prev;
      const nextImages = new Map(prev.sectionImages);
      for (const key of nextImages.keys()) {
        if (key.startsWith("cov-") || key.startsWith("loss-ev")) nextImages.delete(key);
      }
      return {
        ...prev,
        covLayersWithBuildings: covWith,
        covLayersWithout: covWithout,
        coverageStatus: "done",
        sectionImages: nextImages,
      };
    });
  }, []);

  const handleCoverageError = useCallback(() => {
    setOmData((prev) => prev ? { ...prev, coverageStatus: "error" } : prev);
  }, []);

  // ── 파노라마 자동 계산 (보고서 창 내부) ──
  useEffect(() => {
    if (!omData || omData.panoramaStatus !== "idle" || omData.selectedRadarSites.length === 0) return;
    let cancelled = false;
    setOmData((prev) => prev ? { ...prev, panoramaStatus: "loading" } : prev);
    const excludeIds = omData.selectedBuildings.map((b) => b.id);
    const panoArgs = (radar: RadarSite) => ({
      radarLat: radar.latitude,
      radarLon: radar.longitude,
      radarHeightM: radar.altitude + radar.antenna_height,
      maxRangeKm: 100,
      azimuthStepDeg: 0.01,
      rangeStepM: 200,
    });
    (async () => {
      const withMap = new Map<string, PanoramaPoint[]>();
      const withoutMap = new Map<string, PanoramaPoint[]>();
      for (const radar of omData.selectedRadarSites) {
        if (cancelled) break;
        try {
          const withPts = await invoke<PanoramaPoint[]>("calculate_los_panorama", panoArgs(radar));
          if (!cancelled) withMap.set(radar.name, withPts);
          if (excludeIds.length > 0) {
            const withoutPts = await invoke<PanoramaPoint[]>("calculate_los_panorama", {
              ...panoArgs(radar),
              excludeManualIds: excludeIds,
            });
            if (!cancelled) withoutMap.set(radar.name, withoutPts);
          }
        } catch (err) {
          console.warn(`Panorama failed for ${radar.name}:`, err);
        }
      }
      if (!cancelled) {
        startTransition(() => {
          setOmData((prev) => prev ? {
            ...prev,
            panoWithTargets: withMap,
            panoWithoutTargets: withoutMap,
            panoramaStatus: "done",
          } : prev);
        });
      }
    })();
    return () => { cancelled = true; };
  }, [omData?.selectedRadarSites, omData?.selectedBuildings]);

  // ── 설정 모달 표시 ──
  if (configPayload && !state) {
    const { template: tpl } = configPayload;
    return (
      <div className="flex h-screen flex-col bg-white">
        <SourceOverlay />
        <Titlebar controlsOnly />
        <div className="flex flex-1 items-center justify-center">
          {tpl === "obstacle_monthly" ? (
            <ObstacleMonthlyConfigModal
              customRadarSites={configPayload.customRadarSites}
              aircraft={configPayload.aircraft}
              metadata={configPayload.metadata}
              onClose={() => appWindow.destroy()}
              onGenerate={handleOMGenerate}
              onCoverageReady={handleCoverageReady}
              onCoverageError={handleCoverageError}
            />
          ) : tpl === "obstacle" ? (
            <ObstaclePreScreeningModal
              customRadarSites={configPayload.customRadarSites}
              aircraft={configPayload.aircraft}
              metadata={configPayload.metadata}
              onClose={() => appWindow.destroy()}
              onGenerate={handlePSGenerate}
              onCoverageReady={handleCoverageReady}
              onCoverageError={handleCoverageError}
            />
          ) : (
            <TemplateConfigModal
              template={tpl}
              flights={configPayload.flights}
              losResults={configPayload.losResults}
              aircraft={configPayload.aircraft}
              metadata={configPayload.metadata}
              radarSite={configPayload.radarSite}
              panoramaData={configPayload.panoramaData}
              onClose={() => appWindow.destroy()}
              onGenerate={handleModalGenerate}
            />
          )}
        </div>
      </div>
    );
  }

  // 로딩/에러 화면
  if (loading || error || !state || !activeSections || !omData) {
    const phaseMessage = prepPhase === "waiting"
      ? "보고서 데이터 준비 중..."
      : prepPhase === "loading"
        ? "데이터 로딩 중..."
        : "보고서 데이터 로딩 중...";
    return (
      <div className="flex h-screen flex-col bg-white">
        <SourceOverlay />
        <Titlebar controlsOnly />
        <div className="flex flex-1 items-center justify-center">
          {error ? (
            <div className="flex flex-col items-center gap-3">
              <p className="text-sm text-red-500">{error}</p>
              <button
                onClick={() => appWindow.close()}
                className="rounded-lg border border-gray-200 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
              >
                닫기
              </button>
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={24} className="animate-spin text-[#a60739]" />
              <p className="text-sm text-gray-500">{phaseMessage}</p>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-white">
      <SourceOverlay />
      <Titlebar controlsOnly>
        {/* 섹션 토글 (컴팩트) */}
        <div className="flex items-center gap-1">
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

{activeTemplate === "obstacle_monthly" && !omData?.result && editingReportId && (
          <span className="rounded-full bg-orange-100 px-2.5 py-0.5 text-[11px] font-medium text-orange-600">
            분석 데이터 없음 — 소견 텍스트만 복원됨 (재분석 필요)
          </span>
        )}

        {exportError && (
          <span className="text-xs text-red-500">{exportError}</span>
        )}

        <button
          onClick={handleExportPDF}
          disabled={generating}
          className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {generating ? `생성 중... ${exportElapsed}초` : editingReportId ? "PDF 재저장" : "PDF"}
        </button>
      </Titlebar>

      {/* 닫기 확인 모달 */}
      {closeConfirmOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-gray-200 bg-white shadow-xl">
            <div className="flex flex-col items-center gap-3 px-6 pt-6 pb-4">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-amber-100">
                <TriangleAlert size={20} className="text-amber-600" />
              </div>
              <h3 className="text-base font-semibold text-gray-800">보고서 닫기</h3>
              <p className="text-center text-sm text-gray-500">
                보고서 창을 닫으시겠습니까?<br />
                저장하지 않은 변경사항은 사라집니다.
              </p>
            </div>
            <div className="flex gap-2 border-t border-gray-200 px-6 py-4">
              <button
                onClick={() => setCloseConfirmOpen(false)}
                className="flex-1 rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 transition-colors hover:bg-gray-100"
              >
                취소
              </button>
              <button
                onClick={() => { setCloseConfirmOpen(false); appWindow.destroy(); }}
                className="flex-1 rounded-lg bg-[#a60739] px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-[#85062e]"
              >
                닫기
              </button>
            </div>
          </div>
        </div>
      )}

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
        omResultTrimmed={omData?.result ?? null}
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
        singleFlightChartPoints={state.singleFlightChartPoints}
        previewRef={previewRef}
      />
    </div>
  );
}
