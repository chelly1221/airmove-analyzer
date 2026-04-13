/**
 * 보고서 편집 창 — 별도 Tauri 윈도우 (label: "report")
 * IDB에서 페이로드를 읽어 프리뷰를 렌더링하고 PDF 내보내기를 처리.
 */
import { useState, useRef, useCallback, useMemo, useEffect, startTransition } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { format } from "date-fns";
import { Download, Loader2, TriangleAlert, Check, Circle } from "lucide-react";
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
  PanoramaPoint, PanoramaMergeResult, ManualBuilding, RadarSite, TrackPoint, AzSector,
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
  psCovLayersWith: Map<string, CoverageLayer[]>;
  psCovLayersWithout: Map<string, CoverageLayer[]>;
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
    psCovLayersWith: new Map(p.psCovLayersWith),
    psCovLayersWithout: new Map(p.psCovLayersWithout),
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
    covWith: Map<string, CoverageLayer[]>;
    covWithout: Map<string, CoverageLayer[]>;
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

  // ── OM 프리뷰 staging 동기화 ──
  // OM 템플릿은 다수의 OMSectionImage가 각자 비동기로 html2canvas 캡처하므로
  // 전체가 준비될 때까지 프리뷰를 숨기고 상세 진행 오버레이를 표시한다.
  type CaptureEntry = { label: string; status: "pending" | "done" };
  const [captureMap, setCaptureMap] = useState<Map<string, CaptureEntry>>(new Map());
  const [omMountGrace, setOmMountGrace] = useState(false);
  const captureTracker = useMemo(() => ({
    register: (key: string, label: string) => {
      setCaptureMap((m) => {
        const next = new Map(m);
        next.set(key, { label, status: "pending" });
        return next;
      });
    },
    complete: (key: string) => {
      setCaptureMap((m) => {
        const entry = m.get(key);
        if (!entry || entry.status === "done") return m;
        const next = new Map(m);
        next.set(key, { ...entry, status: "done" });
        return next;
      });
    },
  }), []);

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
        // 캐시 즉시 삭제 대신 지연 삭제 — 비동기 로드 타이밍 보호
        setTimeout(() => { omDataCacheRef.current = null; }, 5000);
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
        // 캐시 즉시 삭제 대신 지연 삭제 — 비동기 로드 타이밍 보호
        setTimeout(() => { psDataCacheRef.current = null; }, 5000);
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
    const unlistenCov = listen<{ covLayersWithBuildings: [string, CoverageLayer[]][]; covLayersWithout: [string, CoverageLayer[]][]; coverageStatus: string }>(
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
              covLayersWithBuildings: new Map(event.payload.covLayersWithBuildings),
              covLayersWithout: new Map(event.payload.covLayersWithout),
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

  // ── OM staging: omData가 새로 로드되면 captureMap 리셋 + mount grace 활성화 ──
  // Why: OMSectionImage 들이 mount하여 captureTracker.register() 호출할 시간을 확보.
  // grace 기간 동안에는 pending===0 이어도 ready로 인정하지 않음.
  useEffect(() => {
    if (activeTemplate !== "obstacle_monthly" || !omData) {
      setOmMountGrace(false);
      return;
    }
    setCaptureMap(new Map());
    setOmMountGrace(true);
    const t = setTimeout(() => setOmMountGrace(false), 800);
    return () => clearTimeout(t);
  }, [activeTemplate, omData?.result]);

  // captureMap 기반 카운트 파생
  const { captureTotal, captureDone, capturePending } = useMemo(() => {
    let total = 0, done = 0;
    for (const v of captureMap.values()) {
      total++;
      if (v.status === "done") done++;
    }
    return { captureTotal: total, captureDone: done, capturePending: total - done };
  }, [captureMap]);

  // ── OM 준비 완료 여부 ──
  // 조건: (1) 커버리지 계산 종료 (2) 파노라마 계산 종료 (3) mount grace 해제 (4) 진행 중 캡처 0
  const omReady = useMemo(() => {
    if (activeTemplate !== "obstacle_monthly") return true;
    if (!omData) return false;
    const covReady = omData.coverageStatus === "done" || omData.coverageStatus === "error";
    const panoReady = omData.panoramaStatus === "done";
    return covReady && panoReady && !omMountGrace && capturePending === 0;
  }, [activeTemplate, omData, omMountGrace, capturePending]);
  const omPreparing = activeTemplate === "obstacle_monthly" && !omReady;

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

    // 프리뷰가 이미 ready 상태일 때만 이 함수에 도달 (버튼 disabled 가드).
    // 모든 OMSectionImage가 <img>로 치환된 정적 DOM을 PrintToPdf가 스냅샷한다.
    // 마지막 paint 동기화로 overlay 해제 직후 레이아웃 확정.
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
    covWith: Map<string, CoverageLayer[]>,
    covWithout: Map<string, CoverageLayer[]>,
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
      coverageStatus: covWith.size > 0 ? "done" : "loading",
      panoramaStatus: "deferred",
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
      // 커버리지 레이어는 IDB에 저장하여 새로고침 시에도 복원
      covLayersWithBuildings: covWith,
      covLayersWithout: covWithout,
      coverageStatus: covWith.size > 0 ? "done" : "idle",
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
    covWith: Map<string, CoverageLayer[]>,
    covWithout: Map<string, CoverageLayer[]>,
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
  const handleCoverageReady = useCallback((covWith: Map<string, CoverageLayer[]>, covWithout: Map<string, CoverageLayer[]>) => {
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

  // ── 파노라마 자동 계산 ──
  // 구조: omData가 로드되면 result 레퍼런스를 ref에 저장하고, 같은 result에
  // 대해서는 재실행 안 함. deps=[omData]로 모든 state 변화에 반응하되 ref로 guard.
  // 실행 방식: 전 레이더 × (with/without) 완전 병렬(Promise.all), 5초 대기 제거.
  const panoramaStartedRef = useRef<unknown>(null);
  useEffect(() => {
    if (!omData) return;
    // 동일 result 에 대해 중복 실행 방지
    if (panoramaStartedRef.current === omData.result) return;

    // 레이더 없음 → 즉시 done 처리
    if (omData.selectedRadarSites.length === 0) {
      panoramaStartedRef.current = omData.result;
      if (omData.panoramaStatus !== "done") {
        setOmData((prev) => prev ? { ...prev, panoramaStatus: "done" } : prev);
      }
      return;
    }

    // 이미 완료된 omData (edit 모드 리로드 등)
    if (omData.panoramaStatus === "done") {
      panoramaStartedRef.current = omData.result;
      return;
    }

    // 실행 플래그 설정 — 이 result 에 대해 이제 책임짐
    panoramaStartedRef.current = omData.result;

    const radars = omData.selectedRadarSites;
    const excludeIds = omData.selectedBuildings.map((b) => b.id);
    console.log(`[Panorama] 시작 (${radars.length}개 레이더, 병렬)`, radars.map((r) => r.name));

    let cancelled = false;
    const panoArgs = (radar: RadarSite) => ({
      radarLat: radar.latitude,
      radarLon: radar.longitude,
      radarHeightM: radar.altitude + radar.antenna_height,
      maxRangeKm: 100,
      azimuthStepDeg: 0.01,
      rangeStepM: 200,
    });

    (async () => {
      // loading 진입
      setOmData((prev) => prev ? { ...prev, panoramaStatus: "loading" } : prev);

      const withMap = new Map<string, PanoramaMergeResult>();
      const withoutMap = new Map<string, PanoramaMergeResult>();

      // 전 레이더 병렬 실행 — 각 레이더 내에서도 with/without 동시 호출
      await Promise.all(
        radars.map(async (radar) => {
          try {
            const withPromise = invoke<PanoramaMergeResult>("calculate_los_panorama", panoArgs(radar));
            const withoutPromise = excludeIds.length > 0
              ? invoke<PanoramaMergeResult>("calculate_los_panorama", {
                  ...panoArgs(radar),
                  excludeManualIds: excludeIds,
                })
              : Promise.resolve(null);
            const [withResult, withoutResult] = await Promise.all([withPromise, withoutPromise]);
            if (cancelled) return;
            withMap.set(radar.name, withResult);
            if (withoutResult) withoutMap.set(radar.name, withoutResult);
            // 진행 상황 오버레이 실시간 갱신 — 레이더가 완료될 때마다
            setOmData((prev) => prev ? {
              ...prev,
              panoWithTargets: new Map(withMap),
              panoWithoutTargets: new Map(withoutMap),
            } : prev);
            console.log(`[Panorama] ${radar.name} 완료`);
          } catch (err) {
            console.warn(`[Panorama] ${radar.name} 실패:`, err);
          }
        }),
      );

      if (cancelled) return;
      startTransition(() => {
        setOmData((prev) => prev ? {
          ...prev,
          panoWithTargets: withMap,
          panoWithoutTargets: withoutMap,
          panoramaStatus: "done",
        } : prev);
      });
      console.log("[Panorama] 전체 완료");
    })();

    return () => { cancelled = true; };
  }, [omData]);

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
    <div className="relative flex h-screen flex-col bg-white">
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
          disabled={generating || omPreparing}
          title={omPreparing ? "섹션 준비 중..." : undefined}
          className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-3 py-1 text-[11px] font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {generating ? `생성 중... ${exportElapsed}초` : omPreparing ? "섹션 준비 중..." : editingReportId ? "PDF 재저장" : "PDF"}
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

      {/* OM 섹션 준비 중 상세 진행 오버레이 — 프리뷰 위에 덮어 표시 */}
      {omPreparing && omData && (() => {
        type StageStatus = "waiting" | "active" | "done" | "error";
        const coverageStage: StageStatus =
          omData.coverageStatus === "done" ? "done"
          : omData.coverageStatus === "error" ? "error"
          : omData.coverageStatus === "loading" ? "active"
          : "waiting";
        const panoramaStage: StageStatus =
          omData.panoramaStatus === "done" ? "done"
          : omData.panoramaStatus === "loading" ? "active"
          : "waiting";
        const captureStage: StageStatus =
          coverageStage !== "done" && coverageStage !== "error" ? "waiting"
          : omMountGrace ? "active"
          : captureTotal === 0 ? "waiting"
          : captureDone === captureTotal ? "done"
          : "active";

        const totalSteps = 2 + Math.max(1, captureTotal);
        const doneSteps =
          (coverageStage === "done" || coverageStage === "error" ? 1 : 0)
          + (panoramaStage === "done" ? 1 : 0)
          + captureDone;
        const percent = Math.round((doneSteps / totalSteps) * 100);

        const StageIcon = ({ status }: { status: StageStatus }) => {
          if (status === "done") return <Check size={16} className="text-emerald-500" strokeWidth={3} />;
          if (status === "active") return <Loader2 size={16} className="animate-spin text-[#a60739]" />;
          if (status === "error") return <TriangleAlert size={16} className="text-red-500" />;
          return <Circle size={14} className="text-gray-300" />;
        };
        const stageTextClass = (status: StageStatus) =>
          status === "done" ? "text-gray-400"
          : status === "active" ? "text-gray-800 font-medium"
          : status === "error" ? "text-red-500 font-medium"
          : "text-gray-400";

        const coverageDetail =
          omData.coverageStatus === "loading" ? "레이더별 SRTM+건물 프로파일 계산 중"
          : omData.coverageStatus === "done" ? `${omData.covLayersWithBuildings.size}개 레이더 완료`
          : omData.coverageStatus === "error" ? "계산 실패 — 커버리지 없이 진행"
          : "대기 중";
        const panoramaDetail =
          omData.panoramaStatus === "done" ? `${omData.panoWithTargets.size}개 레이더 완료`
          : omData.panoramaStatus === "loading" ? `${omData.panoWithTargets.size}/${omData.selectedRadarSites.length} 레이더 계산 중 (병렬)`
          : "초기화 중";
        const captureDetail =
          captureStage === "waiting" ? "커버리지 대기 중"
          : omMountGrace ? "섹션 컴포넌트 마운트 중"
          : captureTotal === 0 ? "섹션 등록 대기 중"
          : `${captureDone}/${captureTotal} 섹션 html2canvas 캡처`;

        return (
          <div className="absolute inset-0 top-[44px] z-30 flex items-center justify-center bg-white/95 backdrop-blur-sm">
            <div className="mx-4 flex w-full max-w-md flex-col gap-5 rounded-xl border border-gray-200 bg-white p-6 shadow-lg">
              <div className="flex items-center gap-2">
                <Loader2 size={20} className="animate-spin text-[#a60739]" />
                <h3 className="text-base font-semibold text-gray-800">보고서 준비 중</h3>
                <div className="flex-1" />
                <span className="text-xs font-medium text-gray-500">{percent}%</span>
              </div>

              <div className="h-1 w-full overflow-hidden rounded-full bg-gray-100">
                <div
                  className="h-full bg-[#a60739] transition-all duration-300"
                  style={{ width: `${percent}%` }}
                />
              </div>

              <div className="flex flex-col gap-3">
                {/* Stage 1: 커버리지 */}
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5"><StageIcon status={coverageStage} /></div>
                  <div className="flex-1">
                    <p className={`text-sm ${stageTextClass(coverageStage)}`}>커버리지 계산</p>
                    <p className="text-xs text-gray-400">{coverageDetail}</p>
                  </div>
                </div>

                {/* Stage 2: 파노라마 */}
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5"><StageIcon status={panoramaStage} /></div>
                  <div className="flex-1">
                    <p className={`text-sm ${stageTextClass(panoramaStage)}`}>파노라마 LoS 계산</p>
                    <p className="text-xs text-gray-400">{panoramaDetail}</p>
                  </div>
                </div>

                {/* Stage 3: 섹션 캡처 */}
                <div className="flex items-start gap-2.5">
                  <div className="mt-0.5"><StageIcon status={captureStage} /></div>
                  <div className="flex-1">
                    <p className={`text-sm ${stageTextClass(captureStage)}`}>섹션 이미지 캡처</p>
                    <p className="text-xs text-gray-400">{captureDetail}</p>
                    {captureTotal > 0 && (
                      <div className="mt-2 flex flex-col gap-1">
                        {[...captureMap.entries()].map(([key, entry]) => (
                          <div key={key} className="flex items-center gap-2 text-[11px]">
                            {entry.status === "done"
                              ? <Check size={11} className="text-emerald-500" strokeWidth={3} />
                              : <Loader2 size={11} className="animate-spin text-[#a60739]" />}
                            <span className={entry.status === "done" ? "text-gray-400" : "text-gray-700"}>
                              {entry.label}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <p className="text-center text-[11px] text-gray-400">
                모든 섹션이 준비되면 자동으로 보고서가 표시됩니다
              </p>
            </div>
          </div>
        );
      })()}

      {/* 보고서 프리뷰 — staging 중에는 visibility hidden 으로 레이아웃만 유지 */}
      <div
        className="flex flex-1 min-h-0"
        style={{ visibility: omPreparing ? "hidden" : "visible" }}
        aria-hidden={omPreparing}
      >
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
          captureTracker={captureTracker}
          previewRef={previewRef}
        />
      </div>
    </div>
  );
}
