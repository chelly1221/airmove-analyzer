import { useState, useCallback, useMemo, useEffect, useRef, startTransition } from "react";
import {
  FileText,
  Download,
  Loader2,
  Eye,
  Calendar,
  CalendarRange,
  ScanSearch,
  ListChecks,
  Mountain,
  Radio,
  ChevronRight,
  ChevronDown,
  Trash2,
  Clock,
  FilePlus,
  Pencil,
} from "lucide-react";
import { format } from "date-fns";
import { useAppStore } from "../store";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { queryFlightPoints } from "../utils/flightConsolidationWorker";
import { computeLayersForAltitudes, isGPUCacheValidFor, type CoverageLayer } from "../utils/radarCoverage";
import { haversineKm } from "../utils/geo";
import {
  writeReportPayload, writeReportConfig, readGenerateRequest, clearGenerateRequest,
  serializeOMData, deserializeOMData,
  templateDisplayLabel, DEFAULT_SECTIONS,
  type ReportTemplate, type ReportSections,
} from "../utils/reportTransfer";
import type {
  Flight, LoSProfileData, PanoramaPoint, NearbyPeak,
  ManualBuilding, RadarSite, SavedReportSummary,
  PreScreeningResult, OMReportData,
} from "../types";

export default function ReportGeneration() {
  const allFlights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);
  const losResults = useAppStore((s) => s.losResults);
  const radarSite = useAppStore((s) => s.radarSite);
  const flights = useMemo(
    () => allFlights.filter((f) => !f.radar_name || f.radar_name === radarSite.name),
    [allFlights, radarSite.name],
  );
  const reportMetadata = useAppStore((s) => s.reportMetadata);

  const customRadarSites = useAppStore((s) => s.customRadarSites);

  const [, setSections] = useState<ReportSections>({ ...DEFAULT_SECTIONS });
  const [, setMapImage] = useState<string | null>(null);

  // 장애물 월간 분석 상태 (통합)
  const initialOMData: OMReportData = {
    result: null,
    selectedBuildings: [],
    selectedRadarSites: [],
    azSectorsByRadar: new Map(),
    losMap: new Map(),
    covLayersWithBuildings: [],
    covLayersWithout: [],
    analysisMonth: "",
    findingsText: "",
    recommendText: "",
    panoWithTargets: new Map(),
    panoWithoutTargets: new Map(),
    coverageStatus: "idle",
    panoramaStatus: "idle",
    sectionImages: new Map(),
  };
  const [omData, setOmData] = useState<OMReportData>(initialOMData);

  // 사전검토 분석 상태
  const [psResult] = useState<PreScreeningResult | null>(null);
  const [psSelectedBuildings] = useState<ManualBuilding[]>([]);
  const [psSelectedRadarSites] = useState<RadarSite[]>([]);
  const [psLosMap] = useState<Map<string, LoSProfileData>>(new Map());
  const [psCovLayersWith] = useState<CoverageLayer[]>([]);
  const [psCovLayersWithout] = useState<CoverageLayer[]>([]);
  const [psAnalysisMonth] = useState<string>("");

  // 파노라마 데이터 (캐시에서 로드)
  const [panoramaData, setPanoramaData] = useState<PanoramaPoint[]>([]);
  const [panoramaPeakNames, setPanoramaPeakNames] = useState<Map<number, string>>(new Map());

  useEffect(() => {
    if (!radarSite) return;
    let cancelled = false;
    invoke<string | null>("load_panorama_cache", {
      radarLat: radarSite.latitude,
      radarLon: radarSite.longitude,
    })
      .then((json) => {
        if (cancelled) return;
        if (json) {
          const data = JSON.parse(json) as PanoramaPoint[];
          setPanoramaData(data);
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [radarSite]);

  // 파노라마 지형 장애물 산 이름 조회 (로컬 DB)
  useEffect(() => {
    if (panoramaData.length === 0) return;
    let cancelled = false;

    // haversineKm imported from ../utils/geo at top level

    const terrainPeaks: { idx: number; lat: number; lon: number; angle: number }[] = [];
    for (let i = 0; i < panoramaData.length; i++) {
      const pt = panoramaData[i];
      if (pt.obstacle_type !== "terrain" || pt.elevation_angle_deg <= 0.01) continue;
      let isLocalMax = true;
      for (let d = 1; d <= 5; d++) {
        const li = (i - d + panoramaData.length) % panoramaData.length;
        const ri = (i + d) % panoramaData.length;
        if (panoramaData[li].elevation_angle_deg > pt.elevation_angle_deg ||
            panoramaData[ri].elevation_angle_deg > pt.elevation_angle_deg) {
          isLocalMax = false;
          break;
        }
      }
      if (isLocalMax) {
        const isDup = terrainPeaks.some((p) => haversineKm(p.lat, p.lon, pt.lat, pt.lon) < 3);
        if (!isDup) terrainPeaks.push({ idx: i, lat: pt.lat, lon: pt.lon, angle: pt.elevation_angle_deg });
      }
    }

    terrainPeaks.sort((a, b) => b.angle - a.angle);
    const targets = terrainPeaks.slice(0, 15);
    if (targets.length === 0) return;

    (async () => {
      const names = new Map<number, string>();
      try {
        // 병렬 쿼리 (15개 동시 실행)
        const results = await Promise.all(
          targets.map((target) =>
            invoke<NearbyPeak[]>("query_nearby_peaks", {
              lat: target.lat, lon: target.lon, radiusKm: 3.0,
            }).then((peaks) => ({ target, peaks }))
              .catch(() => ({ target, peaks: [] as NearbyPeak[] })),
          ),
        );
        if (cancelled) return;
        for (const { target, peaks } of results) {
          if (peaks.length > 0) {
            names.set(target.idx, peaks[0].name);
            for (let d = 1; d <= 10; d++) {
              for (const dir of [-1, 1]) {
                const adj = (target.idx + dir * d + panoramaData.length) % panoramaData.length;
                const adjPt = panoramaData[adj];
                if (adjPt.obstacle_type === "terrain" && haversineKm(adjPt.lat, adjPt.lon, target.lat, target.lon) < 3) {
                  names.set(adj, peaks[0].name);
                } else break;
              }
            }
          }
        }
        if (!cancelled && names.size > 0) setPanoramaPeakNames(names);
      } catch (e) {
        console.error("파노라마 산 이름 조회 실패:", e);
      }
    })();

    return () => { cancelled = true; };
  }, [panoramaData]);

  // 커버리지 레이어 (GPU 캐시에서 동기 추출)
  const [coverageLayers, setCoverageLayers] = useState<CoverageLayer[]>([]);
  useEffect(() => {
    if (!isGPUCacheValidFor(radarSite)) { setCoverageLayers([]); return; }
    // 100ft ~ 30000ft, 적절 간격으로 레이어 생성
    const maxAlt = 30000;
    const step = 1000;
    const altFts: number[] = [];
    for (let alt = 100; alt <= maxAlt; alt += (alt < 2000 ? 500 : step)) {
      altFts.push(alt);
    }
    if (altFts.length > 0 && altFts[altFts.length - 1] !== maxAlt) {
      altFts.push(maxAlt);
    }
    setCoverageLayers(computeLayersForAltitudes(altFts));
  }, [radarSite]);

  // OM 분석 완료 시 파노라마 자동 계산 (0.01° 해상도, 포함/미포함 2회)
  useEffect(() => {
    if (omData.selectedRadarSites.length === 0) return;
    let cancelled = false;
    setOmData((prev) => ({ ...prev, panoramaStatus: "loading" }));
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
          await invoke("save_panorama_cache", {
            radarLat: radar.latitude, radarLon: radar.longitude,
            radarHeightM: radar.altitude + radar.antenna_height,
            dataJson: JSON.stringify(withPts),
          }).catch(() => {});
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
          setOmData((prev) => ({
            ...prev,
            panoWithTargets: withMap,
            panoWithoutTargets: withoutMap,
            panoramaStatus: "done",
          }));
        });
      }
    })();
    return () => { cancelled = true; };
  }, [omData.selectedRadarSites, omData.selectedBuildings]);

  // 비행 선택 (건별/단일 상세용)
  const [selectedFlightIds, setSelectedFlightIds] = useState<Set<string>>(new Set());
  const [singleFlightId, setSingleFlightId] = useState<string | null>(null);

  // 저장된 보고서 수정 모드 (보고서 창으로 전달용, 메인에선 항상 null)
  const editingReportId: string | null = null;

  const avgLossPercent =
    flights.length > 0
      ? flights.reduce((s, r) => s + r.loss_percentage, 0) / flights.length
      : 0;

  // 맵 캡처
  const captureMap = useCallback((targetFlights: Flight[]): Promise<string | null> => {
    return new Promise((resolve) => {
      const mapContainer = document.querySelector(".maplibregl-map");
      if (!mapContainer) { resolve(null); return; }

      const map = (window as any).__maplibreInstance;
      if (map && targetFlights.length > 0) {
        let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        let hasPoints = false;
        for (const f of targetFlights) {
          if (f.point_count > 0) {
            hasPoints = true;
            if (f.bbox.minLat < minLat) minLat = f.bbox.minLat;
            if (f.bbox.maxLat > maxLat) maxLat = f.bbox.maxLat;
            if (f.bbox.minLon < minLon) minLon = f.bbox.minLon;
            if (f.bbox.maxLon > maxLon) maxLon = f.bbox.maxLon;
          }
        }
        if (hasPoints && minLat < maxLat && minLon < maxLon) {
          map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
            padding: 60, duration: 0, bearing: 0, pitch: 0,
          });
        }
      }

      const doCapture = () => {
        const canvases = mapContainer.querySelectorAll("canvas");
        if (canvases.length === 0) { resolve(null); return; }
        const w = canvases[0].width;
        const h = canvases[0].height;
        const offscreen = document.createElement("canvas");
        offscreen.width = w;
        offscreen.height = h;
        const ctx = offscreen.getContext("2d");
        if (!ctx) { resolve(null); return; }
        for (const c of canvases) {
          ctx.drawImage(c, 0, 0);
        }
        const dataUrl = offscreen.toDataURL("image/png");
        // 캔버스 리소스 명시적 해제
        offscreen.width = 0;
        offscreen.height = 0;
        resolve(dataUrl);
      };
      // map.once('idle') 사용 가능 시 활용, 아니면 500ms fallback
      if (map && typeof map.once === "function") {
        map.once("idle", doCapture);
      } else {
        setTimeout(doCapture, 500);
      }
    });
  }, []);

  /** 보고서 창 열기 헬퍼 */
  const openReportWindow = useCallback(async (mode: "config" | "data" = "config") => {
    const { WebviewWindow, getAllWebviewWindows } = await import("@tauri-apps/api/webviewWindow");
    const existing = (await getAllWebviewWindows()).find((w) => w.label === "report");
    if (existing) {
      // 기존 창이 있으면 이벤트로 모드 전환 후 포커스
      await emit(mode === "config" ? "report:reload-config" : "report:reload-data");
      await existing.setFocus();
    } else {
      new WebviewWindow("report", {
        url: "index.html",
        title: "보고서 편집 — AirMove Analyzer",
        width: 900,
        height: 1000,
        minWidth: 800,
        minHeight: 700,
        decorations: false,
        center: true,
      });
    }
  }, []);

  // 보고서 창에서 저장 완료 시 목록 갱신
  useEffect(() => {
    const unlisten = listen<{ summary: SavedReportSummary; isEdit: boolean }>(
      "report:saved",
      (event) => {
        const { summary, isEdit } = event.payload;
        if (isEdit) {
          useAppStore.setState((state) => ({
            savedReports: state.savedReports.map((r) => r.id === summary.id ? summary : r),
          }));
        } else {
          useAppStore.getState().addSavedReport(summary);
        }
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // 보고서 준비 중 — 상세 상태 (오버레이 + 버튼 disable)
  const [prepState, setPrepState] = useState<{ active: boolean; message: string }>({ active: false, message: "" });

  /** 데이터 override (모달에서 직접 전달, state race condition 방지) */
  interface DataOverride {
    omData?: OMReportData;
    psResult?: PreScreeningResult;
    psSelectedBuildings?: ManualBuilding[];
    psSelectedRadarSites?: RadarSite[];
    psLosMap?: Map<string, LoSProfileData>;
    psCovLayersWith?: CoverageLayer[];
    psCovLayersWithout?: CoverageLayer[];
    psAnalysisMonth?: string;
  }

  // 보고서 생성 → IDB에 저장 → 별도 창 열기
  const handleGenerate = useCallback(async (
    tpl: ReportTemplate,
    sects: ReportSections,
    flightIds?: Set<string>,
    singleId?: string | null,
    dataOverride?: DataOverride,
  ) => {
    setPrepState({ active: true, message: "보고서 준비 중..." });

    try {
      if (flightIds) setSelectedFlightIds(flightIds);
      if (singleId !== undefined) setSingleFlightId(singleId);

      // override 또는 현재 state 사용 (state race condition 방지)
      const curOmData = dataOverride?.omData ?? omData;
      const curPsResult = dataOverride?.psResult ?? psResult;
      const curPsBuildings = dataOverride?.psSelectedBuildings ?? psSelectedBuildings;
      const curPsRadars = dataOverride?.psSelectedRadarSites ?? psSelectedRadarSites;
      const curPsLosMap = dataOverride?.psLosMap ?? psLosMap;
      const curPsCovWith = dataOverride?.psCovLayersWith ?? psCovLayersWith;
      const curPsCovWithout = dataOverride?.psCovLayersWithout ?? psCovLayersWithout;
      const curPsMonth = dataOverride?.psAnalysisMonth ?? psAnalysisMonth;

      // 타이틀/코멘터리 결정
      let title = "비행검사 보고서";
      const grade = avgLossPercent < 1 ? "양호" : avgLossPercent < 5 ? "주의" : "경고";
      let comm = `금주 비행검사 항적 분석 결과, 평균 소실율은 ${avgLossPercent.toFixed(1)}%로 종합 판정 '${grade}' 수준입니다. 특이사항 없음.`;
      if (tpl === "weekly" || tpl === "monthly") {
        const label = tpl === "weekly" ? "주간" : "월간";
        title = `비행검사 ${label} 보고서`;
        comm = `금${tpl === "weekly" ? "주" : "월"} 비행검사 항적 분석 결과, 평균 소실율은 ${avgLossPercent.toFixed(1)}%로 종합 판정 '${grade}' 수준입니다. 특이사항 없음.`;
      } else if (tpl === "flights") {
        title = "비행 건별 분석 보고서";
      } else if (tpl === "obstacle") {
        title = "전파 장애물 분석 보고서";
      } else if (tpl === "obstacle_monthly") {
        title = "장애물 월간 분석 보고서";
      } else if (tpl === "single") {
        title = "비행검사 상세 분석 보고서";
      }

      // 맵 캡처 대상 결정 (실제 캡처는 창 열고 나서 비동기)
      const needsMapCapture = sects.trackMap && tpl !== "obstacle" && tpl !== "obstacle_monthly";
      let mapTargetFlights: Flight[] | null = null;
      if (needsMapCapture) {
        if (tpl === "flights" && flightIds) {
          mapTargetFlights = flights.filter((f) => flightIds.has(f.id));
        } else if (tpl === "single" && singleId) {
          const found = flights.find((f) => f.id === singleId);
          mapTargetFlights = found ? [found] : flights;
        } else {
          mapTargetFlights = flights;
        }
      }

      // reportFlights 계산
      const ids = flightIds ?? selectedFlightIds;
      const sid = singleId !== undefined ? singleId : singleFlightId;
      let reportFlights: Flight[];
      if (tpl === "flights") {
        reportFlights = flights.filter((f) => ids.has(f.id));
      } else if (tpl === "single") {
        const found = flights.find((f) => f.id === sid);
        reportFlights = found ? [found] : [];
      } else {
        reportFlights = flights;
      }

      // 템플릿별 필요 데이터만 선별 (IDB 페이로드 최소화)
      const isObstacle = tpl === "obstacle" || tpl === "obstacle_monthly";
      const needsFlights = !isObstacle;
      const needsPanorama = !isObstacle && sects.panorama;
      const needsLoS = (tpl === "weekly" || tpl === "monthly" || tpl === "flights" || tpl === "single") && sects.los;
      const needsOm = tpl === "obstacle_monthly";
      const needsPs = tpl === "obstacle";

      // 단일비행 차트 포인트 사전 쿼리 (보고서 윈도우에서 Worker 없음)
      let singleFlightChartPoints: import("../types").TrackPoint[] | undefined;
      if (tpl === "single" && reportFlights.length > 0) {
        try {
          singleFlightChartPoints = await queryFlightPoints(reportFlights[0].id);
        } catch { /* Worker 미사용 환경 — 무시 */ }
      }

      // 맵 캡처를 IDB 저장 전에 수행 — 보고서 창에서 즉시 맵 이미지 사용 가능
      let capturedMapImage: string | null = null;
      if (needsMapCapture && mapTargetFlights) {
        setPrepState({ active: true, message: "맵 캡처 중..." });
        capturedMapImage = await captureMap(mapTargetFlights);
        setMapImage(capturedMapImage);
      }

      setPrepState({ active: true, message: "데이터 저장 중..." });

      // IDB에 페이로드 저장 (override된 데이터, 필요분만)
      await writeReportPayload({
        template: tpl,
        sections: sects,
        selectedFlightIds: [...ids],
        singleFlightId: sid ?? null,
        editingReportId,
        coverTitle: title,
        commentary: comm,
        flights: needsFlights ? reportFlights : [],
        reportFlights,
        losResults: needsLoS ? losResults : [],
        aircraft: needsFlights ? aircraft : [],
        radarSite,
        reportMetadata,
        panoramaData: needsPanorama ? panoramaData : [],
        panoramaPeakNames: needsPanorama ? [...panoramaPeakNames] : [],
        coverageLayers: [],
        mapImage: capturedMapImage,
        omData: needsOm ? serializeOMData(curOmData) : serializeOMData(omData),
        psResult: needsPs ? curPsResult : null,
        psSelectedBuildings: needsPs ? curPsBuildings : [],
        psSelectedRadarSites: needsPs ? curPsRadars : [],
        psLosMap: needsPs ? [...curPsLosMap] : [],
        psCovLayersWith: needsPs ? curPsCovWith : [],
        psCovLayersWithout: needsPs ? curPsCovWithout : [],
        psAnalysisMonth: needsPs ? curPsMonth : "",
        singleFlightChartPoints,
      });

      setSections(sects);

      // 이미 열려있는 보고서 창에 data-written 이벤트 전달
      await emit("report:data-written");
    } finally {
      setPrepState({ active: false, message: "" });
    }
  }, [avgLossPercent, captureMap, flights, aircraft, selectedFlightIds, singleFlightId, radarSite,
      omData, reportMetadata, panoramaData, panoramaPeakNames, coverageLayers, losResults,
      psResult, psSelectedBuildings, psSelectedRadarSites, psLosMap, psCovLayersWith, psCovLayersWithout,
      psAnalysisMonth, editingReportId]);

  // 템플릿 클릭 → config 저장 → 보고서 창 열기 (모달은 보고서 창에서 표시)
  const handleTemplateClick = useCallback(async (tpl: ReportTemplate) => {
    setPrepState({ active: true, message: "보고서 설정 창 열기..." });
    try {
      await writeReportConfig({
        template: tpl,
        flights,
        losResults,
        aircraft,
        metadata: reportMetadata,
        radarSite,
        panoramaData,
        panoramaPeakNames: [...panoramaPeakNames],
        coverageLayers,
        customRadarSites,
      });
      await openReportWindow();
    } finally {
      setPrepState({ active: false, message: "" });
    }
  }, [flights, losResults, aircraft, reportMetadata, radarSite, panoramaData, panoramaPeakNames, coverageLayers, customRadarSites, openReportWindow]);

  // ref로 최신 handleGenerate 참조 — 리스너 재등록 없이 항상 최신 클로저 사용
  const handleGenerateRef = useRef(handleGenerate);
  useEffect(() => { handleGenerateRef.current = handleGenerate; }, [handleGenerate]);

  // 보고서 창에서 생성 요청 수신 → 데이터 조립 + IDB 저장 + data-written emit
  useEffect(() => {
    const unlisten = listen("report:generate", async () => {
      try {
        const req = await readGenerateRequest();
        if (!req) return;
        await clearGenerateRequest();
        // handleGenerate에 위임 (DataOverride 포함)
        const dataOverride: DataOverride = {};
        if (req.omData) {
          dataOverride.omData = deserializeOMData(req.omData);
        }
        if (req.psResult !== undefined) {
          dataOverride.psResult = req.psResult ?? undefined;
          dataOverride.psSelectedBuildings = req.psSelectedBuildings;
          dataOverride.psSelectedRadarSites = req.psSelectedRadarSites;
          dataOverride.psLosMap = req.psLosMap ? new Map(req.psLosMap) : new Map();
          dataOverride.psCovLayersWith = req.psCovLayersWith;
          dataOverride.psCovLayersWithout = req.psCovLayersWithout;
          dataOverride.psAnalysisMonth = req.psAnalysisMonth;
        }
        await handleGenerateRef.current(
          req.template,
          req.sections,
          req.selectedFlightIds ? new Set(req.selectedFlightIds) : undefined,
          req.singleFlightId,
          dataOverride,
        );
      } catch (e) {
        console.error("[ReportGeneration] report:generate 처리 실패:", e);
        // 보고서 창에 에러 전달 — 로딩 화면에서 벗어날 수 있도록
        await emit("report:data-error", { message: e instanceof Error ? e.message : String(e) });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []); // 안정적 의존성 — ref를 통해 최신 함수 참조

  // 저장된 보고서 수정 → 별도 창에서 열기
  const handleEditReport = useCallback(async (reportId: string) => {
    setPrepState({ active: true, message: "보고서 데이터 로딩 중..." });
    try {
      const json = await invoke<string | null>("load_report_detail", { id: reportId });
      if (!json) return;
      const detail = JSON.parse(json) as {
        id: string;
        title: string;
        template: string;
        report_config_json: string;
      };
      const config = JSON.parse(detail.report_config_json) as {
        template?: ReportTemplate;
        sections?: ReportSections;
        selectedFlightIds?: string[];
        singleFlightId?: string | null;
        coverTitle?: string;
        coverSubtitle?: string;
        commentary?: string;
        omFindingsText?: string;
        omRecommendText?: string;
        mapImage?: string | null;
      };

      const tpl = (config.template ?? detail.template) as ReportTemplate;
      const sects = config.sections ?? { ...DEFAULT_SECTIONS };
      // OM 분석 데이터 복원: 현재 omData에 분석 결과가 있으면 그대로 사용,
      // 없으면 저장 텍스트만 복원하고 사용자에게 재분석 필요 알림
      const hasOmResult = omData.result !== null;
      const restoredOmData: OMReportData = {
        ...omData,
        findingsText: config.omFindingsText ?? omData.findingsText,
        recommendText: config.omRecommendText ?? omData.recommendText,
      };
      if (tpl === "obstacle_monthly" && !hasOmResult) {
        console.warn("[Report] OM 분석 데이터 없음 — 소견/추천 텍스트만 복원됨. 재분석 필요.");
      }

      // reportFlights 계산
      const ids = config.selectedFlightIds ?? [];
      const sid = config.singleFlightId ?? null;
      let reportFlights: Flight[];
      if (tpl === "flights") {
        const idSet = new Set(ids);
        reportFlights = flights.filter((f) => idSet.has(f.id));
      } else if (tpl === "single") {
        const found = flights.find((f) => f.id === sid);
        reportFlights = found ? [found] : [];
      } else {
        reportFlights = flights;
      }

      // 템플릿별 필요 데이터만 선별 (handleGenerate와 동일한 필터)
      const isObstacle = tpl === "obstacle" || tpl === "obstacle_monthly";
      const needsFlights = !isObstacle;
      const needsPanorama = !isObstacle && sects.panorama;
      const needsLoS = (tpl === "weekly" || tpl === "monthly" || tpl === "flights" || tpl === "single") && sects.los;
      const needsOm = tpl === "obstacle_monthly";
      const needsPs = tpl === "obstacle";

      // 단일비행 차트 포인트 사전 쿼리
      let editChartPoints: import("../types").TrackPoint[] | undefined;
      if (tpl === "single" && reportFlights.length > 0) {
        try { editChartPoints = await queryFlightPoints(reportFlights[0].id); } catch { /* 무시 */ }
      }

      await writeReportPayload({
        template: tpl,
        sections: sects,
        selectedFlightIds: ids,
        singleFlightId: sid,
        editingReportId: reportId,
        coverTitle: config.coverTitle ?? detail.title,
        coverSubtitle: config.coverSubtitle,
        commentary: config.commentary ?? "",
        flights: needsFlights ? reportFlights : [],
        reportFlights,
        losResults: needsLoS ? losResults : [],
        aircraft: needsFlights ? aircraft : [],
        radarSite,
        reportMetadata,
        panoramaData: needsPanorama ? panoramaData : [],
        panoramaPeakNames: needsPanorama ? [...panoramaPeakNames] : [],
        coverageLayers: [],
        mapImage: config.mapImage ?? null,
        omData: needsOm ? serializeOMData(restoredOmData) : serializeOMData(restoredOmData),
        psResult: needsPs ? psResult : null,
        psSelectedBuildings: needsPs ? psSelectedBuildings : [],
        psSelectedRadarSites: needsPs ? psSelectedRadarSites : [],
        psLosMap: needsPs ? [...psLosMap] : [],
        psCovLayersWith: needsPs ? psCovLayersWith : [],
        psCovLayersWithout: needsPs ? psCovLayersWithout : [],
        psAnalysisMonth: needsPs ? psAnalysisMonth : "",
        singleFlightChartPoints: editChartPoints,
      });

      await openReportWindow("data");
      await emit("report:data-written");
    } catch (e) {
      console.warn("[Report] 보고서 로드 실패:", e);
    } finally {
      setPrepState({ active: false, message: "" });
    }
  }, [flights, losResults, aircraft, radarSite, reportMetadata, panoramaData, panoramaPeakNames,
      coverageLayers, omData, psResult, psSelectedBuildings, psSelectedRadarSites, psLosMap,
      psCovLayersWith, psCovLayersWithout, psAnalysisMonth, openReportWindow]);

  const totalLoss = flights.reduce((s, r) => s + r.loss_points.length, 0);

  return (
      <div className="relative space-y-6">
        {/* 보고서 준비 오버레이 */}
        {prepState.active && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-white/80">
            <div className="flex flex-col items-center gap-3">
              <Loader2 size={28} className="animate-spin text-[#a60739]" />
              <p className="text-sm font-medium text-gray-600">{prepState.message}</p>
            </div>
          </div>
        )}
        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-800">보고서 생성</h1>
          <p className="mt-1 text-sm text-gray-500">
            템플릿을 선택하여 분석 결과 PDF 보고서를 생성합니다
          </p>
        </div>

        {/* Template list (expandable table) */}
        <div>
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700">
            <FilePlus size={16} className="text-[#a60739]" />
            보고서 템플릿
          </h2>
          <TemplateTable
            flights={flights}
            totalLoss={totalLoss}
            avgLossPercent={avgLossPercent}
            losResults={losResults}
            panoramaData={panoramaData}
            coverageLayers={coverageLayers}
            customRadarSites={customRadarSites}
            onSelect={handleTemplateClick}
            disabled={prepState.active}
          />
        </div>

        {/* Saved reports list */}
        <SavedReportsList onEdit={handleEditReport} />

        {/* 모달은 보고서 창에서 렌더링됨 — handleTemplateClick에서 config 전달 */}
      </div>
    );
}

// ── 템플릿 테이블 (expandable list) ──

interface TemplateRowDef {
  type: ReportTemplate;
  icon: typeof Calendar;
  title: string;
  description: string;
  stats: { label: string; value: string | number }[];
  disabled: boolean;
  wip?: boolean;
}

function TemplateTable({
  flights,
  totalLoss,
  avgLossPercent,
  losResults,
  panoramaData: _panoramaData,
  coverageLayers: _coverageLayers,
  customRadarSites,
  onSelect,
  disabled: externalDisabled,
}: {
  flights: Flight[];
  totalLoss: number;
  avgLossPercent: number;
  losResults: LoSProfileData[];
  panoramaData: PanoramaPoint[];
  coverageLayers: CoverageLayer[];
  customRadarSites: RadarSite[];
  onSelect: (tpl: ReportTemplate) => void;
  disabled?: boolean;
}) {
  const [expandedRow, setExpandedRow] = useState<ReportTemplate | null>(null);

  const rows: TemplateRowDef[] = [
    {
      type: "weekly",
      icon: Calendar,
      title: "주간 보고서",
      description: "주간 비행검사 결과를 상세하게 보고합니다. 비행별 상세 통계, 소실 구간 목록, LoS 분석 결과가 포함됩니다.",
      stats: [
        { label: "분석 비행", value: flights.length },
        { label: "소실 건수", value: totalLoss },
      ],
      disabled: true,
      wip: true,
    },
    {
      type: "monthly",
      icon: CalendarRange,
      title: "월간 보고서",
      description: "월간 요약 통계와 주요 소실 사항을 보고합니다. 추이 분석 차트와 종합 판정이 포함됩니다.",
      stats: [
        { label: "평균 소실율", value: `${avgLossPercent.toFixed(1)}%` },
        { label: "LoS 분석", value: `${losResults.length}건` },
      ],
      disabled: true,
      wip: true,
    },
    {
      type: "flights",
      icon: ListChecks,
      title: "비행 건별 보고서",
      description: "선택한 비행들의 비교 분석 보고서입니다. 비행별 소실 통계 비교 차트와 소실 상세가 포함됩니다.",
      stats: [
        { label: "선택 가능", value: `${flights.length}건` },
        { label: "소실 건수", value: totalLoss },
      ],
      disabled: true,
      wip: true,
    },
    {
      type: "single",
      icon: ScanSearch,
      title: "단일비행 상세 보고서",
      description: "1건의 비행을 심층 분석합니다. 소실 구간 상세, 시간대별 분포, 고도-거리 프로파일이 포함됩니다.",
      stats: [{ label: "선택 가능", value: `${flights.length}건` }],
      disabled: true,
      wip: true,
    },
    {
      type: "obstacle",
      icon: Radio,
      title: "장애물 전파영향 사전검토 보고서",
      description: "신규 건축물의 레이더 전파 차단 영향을 사전 분석합니다. 기존 지형 대비 추가 표적소실을 검출하고 최대 허용 건축높이를 산출합니다.",
      stats: [
        { label: "레이더", value: `${customRadarSites.length}개` },
        { label: "수동 건물", value: "선택식" },
      ],
      disabled: customRadarSites.length === 0,
    },
    {
      type: "obstacle_monthly",
      icon: Mountain,
      title: "장애물 월간 보고서",
      description: "특정 장애물의 월간 영향을 분석합니다. ASS 파일을 입력하여 일별 PSR 탐지율/표적소실율 추이, 주차별 비교, 커버리지 비교맵을 생성합니다.",
      stats: [
        { label: "레이더", value: `${customRadarSites.length}개` },
        { label: "수동 건물", value: "선택식" },
      ],
      disabled: customRadarSites.length === 0,
    },
  ];

  return (
    <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
      {rows.map((row, idx) => {
        const isExpanded = expandedRow === row.type;
        const Icon = row.icon;
        return (
          <div key={row.type}>
            {idx > 0 && <div className="border-t border-gray-100" />}
            <button
              onClick={() => setExpandedRow(isExpanded ? null : row.type)}
              disabled={row.disabled || externalDisabled}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                row.disabled || externalDisabled
                  ? "opacity-40 cursor-not-allowed"
                  : isExpanded
                  ? "bg-[#a60739]/5"
                  : "hover:bg-gray-50"
              }`}
            >
              {isExpanded
                ? <ChevronDown size={14} className="shrink-0 text-[#a60739]" />
                : <ChevronRight size={14} className="shrink-0 text-gray-400" />
              }
              <div className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
                row.disabled ? "bg-gray-100" : "bg-[#a60739]/10"
              }`}>
                <Icon size={16} className={row.disabled ? "text-gray-400" : "text-[#a60739]"} />
              </div>
              <div className="min-w-0 flex-1">
                <span className="text-sm font-semibold text-gray-800">{row.title}</span>
                <span className="ml-3 text-[11px] text-gray-400">
                  {templateDisplayLabel(row.type)}
                </span>
                {row.wip && (
                  <span className="ml-2 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-600">
                    개발 중
                  </span>
                )}
              </div>
              <div className="flex shrink-0 gap-2">
                {row.stats.map((s) => (
                  <div key={s.label} className="rounded-md bg-gray-100 px-2 py-1">
                    <span className="text-[9px] text-gray-400">{s.label}</span>
                    <span className="ml-1 text-[11px] font-semibold text-gray-600">{s.value}</span>
                  </div>
                ))}
              </div>
            </button>

            {/* Expanded detail */}
            {isExpanded && !row.disabled && (
              <div className="border-t border-gray-100 bg-gray-50/50 px-4 py-3">
                <p className="mb-3 text-xs leading-relaxed text-gray-500">{row.description}</p>
                <button
                  onClick={() => onSelect(row.type)}
                  className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e]"
                >
                  <Eye size={14} />
                  설정 및 생성
                </button>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── 저장된 보고서 목록 ──

function SavedReportsList({ onEdit }: { onEdit: (id: string) => void }) {
  const savedReports = useAppStore((s) => s.savedReports);
  const removeSavedReport = useAppStore((s) => s.removeSavedReport);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [downloadingId, setDownloadingId] = useState<string | null>(null);

  const handleDownload = useCallback(async (report: SavedReportSummary) => {
    if (!report.has_pdf) return;
    setDownloadingId(report.id);
    try {
      const json = await invoke<string | null>("load_report_detail", { id: report.id });
      const detail = json ? JSON.parse(json) as { pdf_base64?: string } : null;
      if (detail?.pdf_base64) {
        const dateStr = format(new Date(report.created_at * 1000), "yyyyMMdd_HHmmss");
        const filename = `${report.title}_${dateStr}.pdf`;
        const { save } = await import("@tauri-apps/plugin-dialog");
        const path = await save({
          defaultPath: filename,
          filters: [{ name: "PDF", extensions: ["pdf"] }],
        });
        if (!path) return; // 저장 취소
        await invoke("write_file_base64", {
          path,
          data: detail.pdf_base64,
        });
      }
    } catch (e) {
      if (e !== null && String(e) !== "저장이 취소되었습니다") {
        console.warn("[Report] PDF 다운로드 실패:", e);
      }
    } finally {
      setDownloadingId(null);
    }
  }, []);

  const handleDelete = useCallback((id: string) => {
    removeSavedReport(id);
    setConfirmDeleteId(null);
  }, [removeSavedReport]);

  if (savedReports.length === 0) return null;

  return (
    <div>
      <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-gray-700">
        <Clock size={16} className="text-gray-400" />
        생성된 보고서
        <span className="text-[11px] font-normal text-gray-400">{savedReports.length}건</span>
      </h2>
      <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
        {/* Header */}
        <div className="grid grid-cols-[1fr_100px_120px_140px_80px] gap-2 border-b border-gray-200 bg-gray-50 px-4 py-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">
          <span>제목</span>
          <span>템플릿</span>
          <span>레이더</span>
          <span>생성일시</span>
          <span className="text-center">관리</span>
        </div>

        {/* Rows */}
        <div className="max-h-[320px] overflow-y-auto">
          {savedReports.map((report, idx) => (
            <div key={report.id}>
              {idx > 0 && <div className="border-t border-gray-50" />}
              <div className="group grid grid-cols-[1fr_100px_120px_140px_80px] items-center gap-2 px-4 py-2.5 transition-colors hover:bg-gray-50">
                <div className="flex items-center gap-2 truncate">
                  <FileText size={14} className="shrink-0 text-gray-400" />
                  <span className="truncate text-[12px] font-medium text-gray-700">{report.title}</span>
                </div>
                <span className="rounded-full bg-[#a60739]/10 px-2 py-0.5 text-center text-[10px] font-medium text-[#a60739]">
                  {templateDisplayLabel(report.template as ReportTemplate)}
                </span>
                <span className="truncate text-[11px] text-gray-500">{report.radar_name || "—"}</span>
                <span className="text-[11px] text-gray-400">
                  {format(new Date(report.created_at * 1000), "yyyy-MM-dd HH:mm")}
                </span>
                <div className="flex items-center justify-center gap-1">
                  <button
                    onClick={() => onEdit(report.id)}
                    title="수정"
                    className="rounded p-1 text-gray-400 transition-colors hover:bg-blue-50 hover:text-blue-500"
                  >
                    <Pencil size={13} />
                  </button>
                  {report.has_pdf && (
                    <button
                      onClick={() => handleDownload(report)}
                      disabled={downloadingId === report.id}
                      title="PDF 다운로드"
                      className="rounded p-1 text-gray-400 transition-colors hover:bg-gray-100 hover:text-[#a60739] disabled:opacity-40"
                    >
                      {downloadingId === report.id
                        ? <Loader2 size={13} className="animate-spin" />
                        : <Download size={13} />
                      }
                    </button>
                  )}
                  {confirmDeleteId === report.id ? (
                    <button
                      onClick={() => handleDelete(report.id)}
                      title="삭제 확인"
                      className="rounded bg-red-500 px-1.5 py-0.5 text-[9px] font-medium text-white transition-colors hover:bg-red-600"
                    >
                      확인
                    </button>
                  ) : (
                    <button
                      onClick={() => setConfirmDeleteId(report.id)}
                      title="삭제"
                      className="rounded p-1 text-gray-300 transition-colors hover:bg-red-50 hover:text-red-500 opacity-0 group-hover:opacity-100"
                    >
                      <Trash2 size={13} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

