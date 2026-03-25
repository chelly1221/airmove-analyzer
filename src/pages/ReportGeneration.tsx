import { useState, useRef, useCallback, useMemo, useEffect, startTransition } from "react";
import {
  FileText,
  Download,
  Loader2,
  CheckSquare,
  Square,
  Map as MapIcon,
  BarChart3,
  Crosshair,
  ArrowLeft,
  Eye,
  Plane,
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
  MinusSquare,
} from "lucide-react";
import { format } from "date-fns";
import { useAppStore } from "../store";
import Modal from "../components/common/Modal";
import MonthPicker from "../components/common/MonthPicker";
import ReportPage from "../components/Report/ReportPage";
import ReportCoverPage from "../components/Report/ReportCoverPage";
import ReportSummarySection from "../components/Report/ReportSummarySection";
import ReportMapSection from "../components/Report/ReportMapSection";
import ReportStatsSection from "../components/Report/ReportStatsSection";
import ReportLossSection from "../components/Report/ReportLossSection";
import ReportLoSSection from "../components/Report/ReportLoSSection";
import ReportAircraftSection from "../components/Report/ReportAircraftSection";
import ReportFlightComparisonSection from "../components/Report/ReportFlightComparisonSection";
import ReportFlightProfileSection from "../components/Report/ReportFlightProfileSection";
import ReportFlightLossAnalysisSection from "../components/Report/ReportFlightLossAnalysisSection";
import ReportPanoramaSection from "../components/Report/ReportPanoramaSection";
import ReportOMSummarySection from "../components/Report/ReportOMSummarySection";
import ReportOMDailyChart from "../components/Report/ReportOMDailyChart";
import ReportOMWeeklyChart from "../components/Report/ReportOMWeeklyChart";
import ReportOMCoverageDiff from "../components/Report/ReportOMCoverageDiff";
import ReportOMBuildingLoS from "../components/Report/ReportOMBuildingLoS";
import ReportOMAltitudeDistribution from "../components/Report/ReportOMAltitudeDistribution";
import ReportOMFindings from "../components/Report/ReportOMFindings";
import ReportOMLossEvents from "../components/Report/ReportOMLossEvents";
import ReportOMAzDistScatter from "../components/Report/ReportOMAzDistScatter";
import OMSectionImage from "../components/Report/OMSectionImage";
import ReportPSSummarySection from "../components/Report/ReportPSSummarySection";
import ReportPSAngleHeight from "../components/Report/ReportPSAngleHeight";
import ReportPSAdditionalLoss from "../components/Report/ReportPSAdditionalLoss";
import { useReportExport } from "../components/Report/useReportExport";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import { flightLabel } from "../utils/flightConsolidation";
import { computeLayersForAltitudes, isGPUCacheValidFor, type CoverageLayer } from "../utils/radarCoverage";
import { generateOMFindingsText } from "../utils/omFindingsGenerator";
import { haversineKm } from "../utils/geo";
import type {
  Flight, LoSProfileData, Aircraft as AircraftType, ReportMetadata, PanoramaPoint, NearbyPeak,
  ManualBuilding, BuildingGroup, RadarSite, AzSector, ObstacleMonthlyResult, ObstacleMonthlyProgress, SavedReportSummary,
  PreScreeningResult, OMReportData,
} from "../types";

type ReportTemplate = "weekly" | "monthly" | "flights" | "single" | "obstacle" | "obstacle_monthly";
type ReportMode = "config" | "preview";

interface ReportSections {
  cover: boolean;
  summary: boolean;
  trackMap: boolean;
  stats: boolean;
  los: boolean;
  panorama: boolean;
  aircraft: boolean;
  // 건별 보고서 전용
  flightComparison: boolean;
  lossDetail: boolean;
  // 단일 상세 전용
  flightProfile: boolean;
  flightLossAnalysis: boolean;
  // 장애물 사전검토 보고서 전용
  obstacleSummary: boolean;
  coverageMap: boolean;
  psAdditionalLoss: boolean;
  psAngleHeight: boolean;
  // 장애물 월간 보고서 전용
  omSummary: boolean;
  omDailyPsr: boolean;
  omDailyLoss: boolean;
  omWeekly: boolean;
  omCoverageDiff: boolean;
  omAzDistScatter: boolean;
  omBuildingLos: boolean;
  omAltitude: boolean;
  omLossEvents: boolean;
  omFindings: boolean;
}

/** 뷰포트 기반 지연 렌더링 래퍼 — 화면 밖 무거운 섹션을 스크롤 시 점진적 마운트 */
function LazySection({ children, fallbackHeight = "297mm", forceVisible = false }: {
  children: React.ReactNode;
  fallbackHeight?: string;
  forceVisible?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (forceVisible) return;
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { rootMargin: "200px" },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [forceVisible]);

  if (forceVisible || visible) return <>{children}</>;
  return <div ref={ref} style={{ minHeight: fallbackHeight }} />;
}

const DEFAULT_SECTIONS: ReportSections = {
  cover: true,
  summary: true,
  trackMap: true,
  stats: true,
  los: true,
  panorama: true,
  aircraft: true,
  flightComparison: true,
  lossDetail: true,
  flightProfile: true,
  flightLossAnalysis: true,
  obstacleSummary: true,
  coverageMap: true,
  psAdditionalLoss: true,
  psAngleHeight: true,
  omSummary: true,
  omDailyPsr: true,
  omDailyLoss: true,
  omWeekly: true,
  omCoverageDiff: true,
  omAzDistScatter: true,
  omBuildingLos: true,
  omAltitude: true,
  omLossEvents: true,
  omFindings: true,
};

/** 템플릿별 표시할 섹션 토글 목록 */
function getSectionToggles(template: ReportTemplate, _sections: ReportSections): { key: keyof ReportSections; label: string }[] {
  if (template === "flights") {
    return [
      { key: "cover", label: "표지" },
      { key: "flightComparison", label: "비교" },
      { key: "trackMap", label: "지도" },
      { key: "lossDetail", label: "소실" },
      { key: "los", label: "LoS" },
      { key: "panorama", label: "장애물" },
    ];
  }
  if (template === "obstacle") {
    return [
      { key: "cover", label: "표지" },
      { key: "obstacleSummary", label: "요약" },
      { key: "psAngleHeight", label: "앙각/높이" },
      { key: "psAdditionalLoss", label: "추가Loss" },
      { key: "coverageMap", label: "커버리지" },
      { key: "los", label: "LoS" },
    ];
  }
  if (template === "obstacle_monthly") {
    return [
      { key: "cover", label: "표지" },
      { key: "omSummary", label: "요약" },
      { key: "omDailyPsr", label: "PSR" },
      { key: "omDailyLoss", label: "표적소실" },
      { key: "omWeekly", label: "주차" },
      { key: "omCoverageDiff", label: "커버리지" },
      { key: "omAzDistScatter", label: "산점도" },
      { key: "omBuildingLos", label: "LoS" },
      { key: "omAltitude", label: "고도분포" },
      { key: "omLossEvents", label: "표적소실상세" },
      { key: "omFindings", label: "소견" },
    ];
  }
  if (template === "single") {
    return [
      { key: "cover", label: "표지" },
      { key: "flightProfile", label: "프로파일" },
      { key: "trackMap", label: "지도" },
      { key: "flightLossAnalysis", label: "소실분석" },
      { key: "los", label: "LoS" },
      { key: "panorama", label: "장애물" },
    ];
  }
  return [
    { key: "cover", label: "표지" },
    { key: "summary", label: "요약" },
    { key: "trackMap", label: "지도" },
    { key: "stats", label: "통계" },
    { key: "los", label: "LoS" },
    { key: "panorama", label: "장애물" },
    { key: "aircraft", label: "검사기" },
  ];
}

function templateDisplayLabel(tpl: ReportTemplate): string {
  switch (tpl) {
    case "weekly": return "주간";
    case "monthly": return "월간";
    case "flights": return "건별";
    case "single": return "상세";
    case "obstacle": return "사전검토";
    case "obstacle_monthly": return "장애물월간";
  }
}

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

  const [mode, setMode] = useState<ReportMode>("config");
  const [template, setTemplate] = useState<ReportTemplate>("weekly");
  const [sections, setSections] = useState<ReportSections>({ ...DEFAULT_SECTIONS });
  const [generating, setGenerating] = useState(false);
  const [forceAllVisible, setForceAllVisible] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mapImage, setMapImage] = useState<string | null>(null);

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
  const [psResult, setPsResult] = useState<PreScreeningResult | null>(null);
  const [psSelectedBuildings, setPsSelectedBuildings] = useState<ManualBuilding[]>([]);
  const [psSelectedRadarSites, setPsSelectedRadarSites] = useState<RadarSite[]>([]);
  const [psLosMap, setPsLosMap] = useState<Map<string, LoSProfileData>>(new Map());
  const [psCovLayersWith, setPsCovLayersWith] = useState<CoverageLayer[]>([]);
  const [psCovLayersWithout, setPsCovLayersWithout] = useState<CoverageLayer[]>([]);
  const [psAnalysisMonth, setPsAnalysisMonth] = useState<string>("");

  // 2주 초과 데이터 → 최근 31일만 사용
  const omResultTrimmed = useMemo(() => {
    if (!omData.result) return null;
    const MAX_DAYS = 31;
    const TWO_WEEKS = 14;
    return {
      ...omData.result,
      radar_results: omData.result.radar_results.map((rr) => {
        if (rr.daily_stats.length <= TWO_WEEKS) return rr;
        const sorted = [...rr.daily_stats].sort((a, b) => b.date.localeCompare(a.date));
        const trimmed = sorted.slice(0, MAX_DAYS).sort((a, b) => a.date.localeCompare(b.date));
        return { ...rr, daily_stats: trimmed };
      }),
    };
  }, [omData.result]);

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
        for (const target of targets) {
          if (cancelled) return;
          const peaks = await invoke<NearbyPeak[]>("query_nearby_peaks", {
            lat: target.lat, lon: target.lon, radiusKm: 3.0,
          });
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

  // 템플릿 모달
  const [templateModalOpen, setTemplateModalOpen] = useState<ReportTemplate | null>(null);

  // 저장된 보고서 수정 모드
  const [editingReportId, setEditingReportId] = useState<string | null>(null);

  // 편집 가능 텍스트 상태
  const [coverTitle, setCoverTitle] = useState("비행검사 주간 보고서");
  const [coverSubtitle, setCoverSubtitle] = useState(
    `${format(new Date(), "yyyy년 MM월 dd일")} 기준 주간 보고`
  );

  const avgLossPercent =
    flights.length > 0
      ? flights.reduce((s, r) => s + r.loss_percentage, 0) / flights.length
      : 0;
  const [commentary, setCommentary] = useState(() => {
    const grade = avgLossPercent < 1 ? "양호" : avgLossPercent < 5 ? "주의" : "경고";
    return `금주 비행검사 항적 분석 결과, 평균 소실율은 ${avgLossPercent.toFixed(1)}%로 종합 판정 '${grade}' 수준입니다. 특이사항 없음.`;
  });

  const previewRef = useRef<HTMLDivElement>(null);
  const { exportPDF } = useReportExport();

  // 보고서 준비 상태 (프리뷰 진입 시 렌더링 완료까지 오버레이)
  const [reportPreparing, setReportPreparing] = useState(false);
  const [prepPageCount, setPrepPageCount] = useState(0);
  const prepTotalEstimate = useRef(1);

  /** 프리뷰 진입 시 예상 페이지 수 계산 */
  const estimateTotalPages = useCallback((tpl: ReportTemplate, sects: ReportSections) => {
    let total = 0;
    if (sects.cover) total++;
    if (tpl === "weekly" || tpl === "monthly") {
      if (sects.summary || sects.trackMap) total++;
      if (sects.stats && flights.length > 0) total++;
      if (sects.los && losResults.length > 0) total++;
      if (sects.panorama && panoramaData.length > 0) total++;
      if (sects.aircraft && aircraft.length > 0) total++;
    } else if (tpl === "obstacle") {
      if (sects.obstacleSummary) total++;
      if (sects.psAngleHeight) total++;
      if (sects.psAdditionalLoss) total++;
      if (sects.coverageMap) total++;
      if (sects.los) total++;
    } else if (tpl === "obstacle_monthly") {
      const nRadars = Math.max(omData.selectedRadarSites.length, 1);
      if (sects.omSummary) total++;
      if (sects.omDailyPsr) total += nRadars;
      if (sects.omDailyLoss) total += nRadars;
      if (sects.omWeekly) total += nRadars;
      if (sects.omCoverageDiff) total += nRadars;
      if (sects.omAzDistScatter) total += nRadars;
      if (sects.omBuildingLos) total++;
      if (sects.omAltitude) total++;
      if (sects.omLossEvents) total++;
      if (sects.omFindings) total++;
    } else if (tpl === "flights") {
      if (sects.flightComparison || sects.trackMap) total++;
      if (sects.lossDetail) total++;
      if (sects.los && losResults.length > 0) total++;
      if (sects.panorama && panoramaData.length > 0) total++;
    } else if (tpl === "single") {
      if (sects.flightProfile || sects.trackMap) total++;
      if (sects.flightLossAnalysis) total++;
      if (sects.los && losResults.length > 0) total++;
      if (sects.panorama && panoramaData.length > 0) total++;
    }
    return Math.max(total, 1);
  }, [flights.length, losResults.length, panoramaData.length, aircraft.length, omData.selectedRadarSites.length]);

  /** MutationObserver로 [data-page] 요소 수를 추적하여 렌더링 완료 감지 */
  useEffect(() => {
    if (mode !== "preview" || !reportPreparing) return;
    const container = previewRef.current;
    if (!container) return;

    let stableFrames = 0;
    let lastCount = 0;
    let rafId = 0;

    const countPages = () => container.querySelectorAll("[data-page]").length;

    const checkStable = () => {
      const count = countPages();
      setPrepPageCount(count);
      if (count >= prepTotalEstimate.current && count === lastCount) {
        stableFrames++;
        if (stableFrames >= 3) {
          // 렌더링 안정 → 준비 완료
          setReportPreparing(false);
          return;
        }
      } else {
        stableFrames = 0;
      }
      lastCount = count;
      rafId = requestAnimationFrame(checkStable);
    };

    const observer = new MutationObserver(() => {
      const count = countPages();
      setPrepPageCount(count);
    });
    observer.observe(container, { childList: true, subtree: true });

    // 초기 체크 시작
    rafId = requestAnimationFrame(checkStable);

    // 안전 타임아웃 (5초 후 강제 완료)
    const timeout = setTimeout(() => {
      setReportPreparing(false);
    }, 5000);

    return () => {
      observer.disconnect();
      cancelAnimationFrame(rafId);
      clearTimeout(timeout);
    };
  }, [mode, reportPreparing]);

  // 선택된 비행 목록 (preview용)
  const reportFlights = useMemo(() => {
    if (template === "flights") {
      return flights.filter((f) => selectedFlightIds.has(f.id));
    }
    if (template === "single") {
      const found = flights.find((f) => f.id === singleFlightId);
      return found ? [found] : [];
    }
    return flights;
  }, [template, flights, selectedFlightIds, singleFlightId]);

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

      setTimeout(() => {
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
        resolve(offscreen.toDataURL("image/png"));
      }, 500);
    });
  }, []);

  // 보고서 생성 (config → preview)
  const handleGenerate = useCallback(async (
    tpl: ReportTemplate,
    sects: ReportSections,
    flightIds?: Set<string>,
    singleId?: string | null,
  ) => {
    // 비행 선택 상태 저장
    if (flightIds) setSelectedFlightIds(flightIds);
    if (singleId !== undefined) setSingleFlightId(singleId);

    // 타이틀/서브타이틀 설정
    if (tpl === "weekly" || tpl === "monthly") {
      const label = tpl === "weekly" ? "주간" : "월간";
      setCoverTitle(`비행검사 ${label} 보고서`);
      setCoverSubtitle(
        tpl === "weekly"
          ? `${format(new Date(), "yyyy년 MM월 dd일")} 기준 주간 보고`
          : `${format(new Date(), "yyyy년 MM월")} 보고`
      );
      const grade = avgLossPercent < 1 ? "양호" : avgLossPercent < 5 ? "주의" : "경고";
      setCommentary(
        `금${tpl === "weekly" ? "주" : "월"} 비행검사 항적 분석 결과, 평균 소실율은 ${avgLossPercent.toFixed(1)}%로 종합 판정 '${grade}' 수준입니다. 특이사항 없음.`
      );
    } else if (tpl === "flights") {
      const ids = flightIds ?? selectedFlightIds;
      setCoverTitle("비행 건별 분석 보고서");
      setCoverSubtitle(`${format(new Date(), "yyyy년 MM월 dd일")} · 선택 ${ids.size}건 비행 분석`);
    } else if (tpl === "obstacle") {
      setCoverTitle("전파 장애물 분석 보고서");
      setCoverSubtitle(`${radarSite?.name ?? ""} 레이더 장애물 종합 분석 · ${format(new Date(), "yyyy년 MM월 dd일")}`);
    } else if (tpl === "obstacle_monthly") {
      const radarNames = omData.selectedRadarSites.map((r) => r.name).join(", ");
      setCoverTitle("장애물 월간 분석 보고서");
      const monthLabel = omData.analysisMonth
        ? `${omData.analysisMonth.slice(0, 4)}년 ${omData.analysisMonth.slice(5, 7)}월`
        : format(new Date(), "yyyy년 MM월");
      setCoverSubtitle(radarNames ? `${radarNames} ${monthLabel}` : monthLabel);
    } else if (tpl === "single") {
      const f = flights.find((fl) => fl.id === (singleId ?? singleFlightId));
      if (f) {
        const label = flightLabel(f, aircraft);
        setCoverTitle("비행검사 상세 분석 보고서");
        setCoverSubtitle(`${label} · ${format(new Date(f.start_time * 1000), "yyyy-MM-dd")}`);
      }
    }

    // 맵 캡처 (선택 비행 기준, 장애물 보고서는 항적지도 불포함)
    if (sects.trackMap && tpl !== "obstacle" && tpl !== "obstacle_monthly") {
      let targetFlights: Flight[];
      if (tpl === "flights" && flightIds) {
        targetFlights = flights.filter((f) => flightIds.has(f.id));
      } else if (tpl === "single" && singleId) {
        const found = flights.find((f) => f.id === singleId);
        targetFlights = found ? [found] : flights;
      } else {
        targetFlights = flights;
      }
      const img = await captureMap(targetFlights);
      setMapImage(img);
    }

    setTemplate(tpl);
    setSections(sects);
    setTemplateModalOpen(null);
    // 준비 오버레이 시작 → 프리뷰 진입
    prepTotalEstimate.current = estimateTotalPages(tpl, sects);
    setPrepPageCount(0);
    setReportPreparing(true);
    setMode("preview");
  }, [avgLossPercent, captureMap, flights, aircraft, selectedFlightIds, singleFlightId, radarSite, omData.selectedRadarSites, omData.analysisMonth, estimateTotalPages]);

  // PDF 내보내기 + DB 저장
  const handleExportPDF = useCallback(async () => {
    setGenerating(true);
    setForceAllVisible(true);
    setError(null);
    // LazySection 강제 마운트 후 렌더링 완료 대기
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    try {
      const dateStr = format(new Date(), "yyyyMMdd_HHmmss");
      const tplLabel = templateDisplayLabel(template);
      const filename = `비행검사_${tplLabel}_보고서_${dateStr}.pdf`;
      const result = await exportPDF(previewRef, filename);
      if (!result.success && result.error && result.error !== "저장이 취소되었습니다") {
        setError(result.error);
      }
      // 보고서 DB 저장
      if (result.success && result.pdfBase64) {
        const reportId = editingReportId ?? `rpt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const title = coverTitle;
        const configJson = JSON.stringify({
          template,
          sections,
          selectedFlightIds: Array.from(selectedFlightIds),
          singleFlightId,
          // 편집 가능 텍스트 포함
          coverTitle,
          coverSubtitle,
          commentary,
          omFindingsText: omData.findingsText,
          omRecommendText: omData.recommendText,
          mapImage,
        });
        const metaJson = JSON.stringify(reportMetadata);
        invoke("save_report", {
          id: reportId,
          title,
          template,
          radarName: radarSite?.name ?? "",
          reportConfigJson: configJson,
          pdfBase64: result.pdfBase64,
          metadataJson: metaJson,
        })
          .then(() => {
            const summary: SavedReportSummary = {
              id: reportId,
              title,
              template,
              radar_name: radarSite?.name ?? "",
              created_at: Math.floor(Date.now() / 1000),
              has_pdf: true,
            };
            if (editingReportId) {
              // 기존 보고서 업데이트: 목록에서 교체
              useAppStore.setState((state) => ({
                savedReports: state.savedReports.map((r) => r.id === reportId ? summary : r),
              }));
            } else {
              useAppStore.getState().addSavedReport(summary);
            }
            setEditingReportId(null);
            console.log(`[Report] 보고서 DB 저장: ${reportId}`);
          })
          .catch((e) => console.warn("[Report] DB 저장 실패:", e));
      }
    } catch (err) {
      setError(`PDF 내보내기 실패: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setGenerating(false);
      setForceAllVisible(false);
    }
  }, [template, exportPDF, coverTitle, coverSubtitle, commentary, omData.findingsText, omData.recommendText, mapImage, sections, selectedFlightIds, singleFlightId, reportMetadata, radarSite, editingReportId]);

  // 저장된 보고서 수정 (config → preview 복원)
  const handleEditReport = useCallback(async (reportId: string) => {
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

      // 상태 복원
      const tpl = (config.template ?? detail.template) as ReportTemplate;
      setTemplate(tpl);
      if (config.sections) setSections(config.sections);
      if (config.selectedFlightIds) setSelectedFlightIds(new Set(config.selectedFlightIds));
      if (config.singleFlightId !== undefined) setSingleFlightId(config.singleFlightId);
      setCoverTitle(config.coverTitle ?? detail.title);
      setCoverSubtitle(config.coverSubtitle ?? "");
      if (config.commentary) setCommentary(config.commentary);
      if (config.omFindingsText || config.omRecommendText) {
        setOmData((prev) => ({
          ...prev,
          findingsText: config.omFindingsText ?? prev.findingsText,
          recommendText: config.omRecommendText ?? prev.recommendText,
        }));
      }
      if (config.mapImage !== undefined) setMapImage(config.mapImage ?? null);

      setEditingReportId(reportId);
      // 준비 오버레이 시작
      const sects = config.sections ?? { ...DEFAULT_SECTIONS };
      prepTotalEstimate.current = estimateTotalPages(tpl, sects);
      setPrepPageCount(0);
      setReportPreparing(true);
      setMode("preview");
    } catch (e) {
      console.warn("[Report] 보고서 로드 실패:", e);
    }
  }, [estimateTotalPages]);

  // 활성 섹션 번호 계산
  const sectionNumbers = useMemo(() => {
    const nums: Record<string, number> = {};
    let n = 1;
    if (template === "flights") {
      if (sections.flightComparison) nums.flightComparison = n++;
      if (sections.trackMap) nums.trackMap = n++;
      if (sections.lossDetail) nums.lossDetail = n++;
      if (sections.los && losResults.length > 0) nums.los = n++;
      if (sections.panorama && panoramaData.length > 0) nums.panorama = n++;
    } else if (template === "obstacle") {
      if (sections.obstacleSummary) nums.obstacleSummary = n++;
      if (sections.psAngleHeight && psResult) nums.psAngleHeight = n++;
      if (sections.psAdditionalLoss && psResult) nums.psAdditionalLoss = n++;
      if (sections.coverageMap && (psCovLayersWith.length > 0 || psCovLayersWithout.length > 0)) nums.coverageMap = n++;
      if (sections.los && psLosMap.size > 0) nums.los = n++;
    } else if (template === "obstacle_monthly") {
      if (sections.omSummary) nums.omSummary = n++;
      if (sections.omDailyPsr) nums.omDailyPsr = n++;
      if (sections.omDailyLoss) nums.omDailyLoss = n++;
      if (sections.omWeekly) nums.omWeekly = n++;
      if (sections.omCoverageDiff) nums.omCoverageDiff = n++;
      if (sections.omAzDistScatter) nums.omAzDistScatter = n++;
      if (sections.omBuildingLos) nums.omBuildingLos = n++;
      if (sections.omAltitude) nums.omAltitude = n++;
      if (sections.omLossEvents) nums.omLossEvents = n++;
      if (sections.omFindings) nums.omFindings = n++;
    } else if (template === "single") {
      if (sections.flightProfile) nums.flightProfile = n++;
      if (sections.trackMap) nums.trackMap = n++;
      if (sections.flightLossAnalysis) nums.flightLossAnalysis = n++;
      if (sections.los && losResults.length > 0) nums.los = n++;
      if (sections.panorama && panoramaData.length > 0) nums.panorama = n++;
    } else {
      if (sections.summary) nums.summary = n++;
      if (sections.trackMap) nums.trackMap = n++;
      if (sections.stats && flights.length > 0) nums.stats = n++;
      if (sections.los && losResults.length > 0) nums.los = n++;
      if (sections.panorama && panoramaData.length > 0) nums.panorama = n++;
      if (sections.aircraft && aircraft.length > 0) nums.aircraft = n++;
    }
    return nums;
  }, [template, sections, losResults, flights, aircraft, panoramaData, coverageLayers]);

  // OM 레이더별 조건 텍스트 사전 계산 (렌더 내 haversine 반복 제거)
  const omRadarConditions = useMemo(() => {
    if (!omResultTrimmed) return new Map<string, { azText: string; bldgNames: string; minDistNm: string }>();
    const map = new Map<string, { azText: string; bldgNames: string; minDistNm: string }>();
    for (const rr of omResultTrimmed.radar_results) {
      const sectors = omData.azSectorsByRadar.get(rr.radar_name) ?? [];
      const azText = sectors.map((s) => `${s.start_deg.toFixed(1)}°~${s.end_deg.toFixed(1)}°`).join(", ");
      const bldgNames = omData.selectedBuildings.map((b) => b.name || `건물${b.id}`).join(", ");
      const rs = omData.selectedRadarSites.find((r) => r.name === rr.radar_name);
      let minDistKm = Infinity;
      if (rs) {
        const toRad = Math.PI / 180;
        for (const b of omData.selectedBuildings) {
          const dLat = (b.latitude - rs.latitude) * toRad;
          const dLon = (b.longitude - rs.longitude) * toRad;
          const a = Math.sin(dLat / 2) ** 2 + Math.cos(rs.latitude * toRad) * Math.cos(b.latitude * toRad) * Math.sin(dLon / 2) ** 2;
          const d = 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
          if (d < minDistKm) minDistKm = d;
        }
      }
      if (!isFinite(minDistKm)) minDistKm = 0;
      map.set(rr.radar_name, { azText, bldgNames, minDistNm: (minDistKm / 1.852).toFixed(1) });
    }
    return map;
  }, [omResultTrimmed, omData.azSectorsByRadar, omData.selectedRadarSites, omData.selectedBuildings]);

  // OM 섹션 이미지 캡처 콜백 (안정적 참조)
  const handleOMSectionCaptured = useCallback((key: string, dataUrl: string) => {
    setOmData((prev) => {
      const next = new Map(prev.sectionImages);
      next.set(key, dataUrl);
      return { ...prev, sectionImages: next };
    });
  }, []);

  // ── 설정 모드 (Config) ──
  if (mode === "config") {
    const totalLoss = flights.reduce((s, r) => s + r.loss_points.length, 0);

    return (
      <div className="space-y-6">
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
            onSelect={(tpl) => setTemplateModalOpen(tpl)}
          />
        </div>

        {/* Saved reports list */}
        <SavedReportsList onEdit={handleEditReport} />

        {/* Template modal */}
        {templateModalOpen && templateModalOpen !== "obstacle_monthly" && templateModalOpen !== "obstacle" && (
          <TemplateConfigModal
            template={templateModalOpen}
            flights={flights}
            losResults={losResults}
            aircraft={aircraft}
            metadata={reportMetadata}
            radarName={radarSite?.name ?? ""}
            panoramaData={panoramaData}
            onClose={() => setTemplateModalOpen(null)}
            onGenerate={handleGenerate}
          />
        )}
        {templateModalOpen === "obstacle_monthly" && (
          <ObstacleMonthlyConfigModal
            customRadarSites={customRadarSites}
            aircraft={aircraft}
            metadata={reportMetadata}
            onClose={() => setTemplateModalOpen(null)}
            onGenerate={(result, buildings, radars, azMap, losMap, covWith, covWithout, monthStr) => {
              setOmData((prev) => ({
                ...prev,
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
                sectionImages: new Map(), // 새 분석 시 이미지 캐시 초기화
              }));
              handleGenerate("obstacle_monthly", sections);
            }}
            onCoverageReady={(covWith, covWithout) => {
              startTransition(() => {
                setOmData((prev) => {
                  // 커버리지 도착 시 관련 섹션 이미지 캐시 무효화
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
              });
            }}
            onCoverageError={() => {
              setOmData((prev) => ({
                ...prev,
                coverageStatus: "error",
              }));
            }}
          />
        )}
        {templateModalOpen === "obstacle" && (
          <ObstaclePreScreeningModal
            customRadarSites={customRadarSites}
            aircraft={aircraft}
            metadata={reportMetadata}
            onClose={() => setTemplateModalOpen(null)}
            onGenerate={(result, buildings, radars, losMap, covWith, covWithout, monthStr) => {
              setPsResult(result);
              setPsSelectedBuildings(buildings);
              setPsSelectedRadarSites(radars);
              setPsLosMap(losMap);
              setPsCovLayersWith(covWith);
              setPsCovLayersWithout(covWithout);
              setPsAnalysisMonth(monthStr ?? "");
              handleGenerate("obstacle", sections);
            }}
            onCoverageReady={(covWith, covWithout) => {
              setPsCovLayersWith(covWith);
              setPsCovLayersWithout(covWithout);
            }}
          />
        )}
      </div>
    );
  }

  // ── 미리보기 모드 (Preview) ──
  const toggles = getSectionToggles(template, sections);
  const singleFlight = template === "single" ? reportFlights[0] : null;

  return (
    <div className="absolute inset-0 z-10 flex flex-col">
      {/* 상단 툴바 */}
      <div className="z-20 flex shrink-0 items-center gap-3 border-b border-gray-200 bg-white px-4 py-2">
        <button
          onClick={() => { setMode("config"); setEditingReportId(null); }}
          className="flex items-center gap-1.5 rounded-lg border border-gray-200 px-3 py-1.5 text-sm text-gray-600 transition-colors hover:bg-gray-100"
        >
          <ArrowLeft size={14} />
          돌아가기
        </button>

        {/* 섹션 토글 (컴팩트) */}
        <div className="ml-2 flex items-center gap-1">
          {toggles.map((s) => (
            <button
              key={s.key}
              onClick={() => setSections((prev) => ({ ...prev, [s.key]: !prev[s.key] }))}
              className={`rounded px-2 py-1 text-[11px] transition-colors ${
                sections[s.key]
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

        {error && (
          <span className="text-xs text-red-500">{error}</span>
        )}

        <button
          onClick={handleExportPDF}
          disabled={generating || reportPreparing}
          className="flex items-center gap-1.5 rounded-lg bg-[#a60739] px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40"
        >
          {generating ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
          {generating ? "생성 중..." : editingReportId ? "PDF 재저장" : "PDF 다운로드"}
        </button>
      </div>

      {/* 보고서 미리보기 영역 */}
      <div ref={previewRef} className="relative flex-1 overflow-auto bg-gray-300 py-6">
        {/* 보고서 준비 오버레이 */}
        {reportPreparing && (
          <div className="absolute inset-0 z-50 flex items-center justify-center bg-gray-300">
            <div className="min-w-[280px] rounded-xl bg-white px-8 py-7 text-center shadow-lg">
              <svg className="mx-auto mb-3 h-5 w-5 animate-spin text-[#a60739]" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="50 20" />
              </svg>
              <p className="mb-1 text-sm font-medium text-gray-700">보고서 준비 중...</p>
              <p className="mb-3 text-xs text-gray-400">
                {prepPageCount} / {prepTotalEstimate.current} 페이지
              </p>
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200">
                <div
                  className="h-full rounded-full bg-[#a60739] transition-all duration-300"
                  style={{ width: `${Math.min(100, (prepPageCount / prepTotalEstimate.current) * 100)}%` }}
                />
              </div>
            </div>
          </div>
        )}
        {/* 섹션 컨테이너 (준비 중에는 숨김 — 렌더링은 계속 진행) */}
        <div style={reportPreparing ? { visibility: "hidden", position: "absolute", top: 0, left: 0, right: 0 } : undefined}>
        {/* 표지 (공통) */}
        {sections.cover && (
          <ReportCoverPage
            template={template}
            radarName={radarSite?.name ?? ""}
            metadata={reportMetadata}
            editable
            title={coverTitle}
            onTitleChange={setCoverTitle}
            subtitle={coverSubtitle}
            onSubtitleChange={setCoverSubtitle}
          />
        )}

        {/* ─── 주간/월간 ─── */}
        {(template === "weekly" || template === "monthly") && (
          <>
            {(sections.summary || sections.trackMap) && (
              <ReportPage>
                {sections.summary && (
                  <ReportSummarySection
                    sectionNum={sectionNumbers.summary ?? 1}
                    flights={flights}
                    losResults={losResults}
                    aircraftCount={aircraft.filter((a) => a.active).length}
                    editable
                    commentary={commentary}
                    onCommentaryChange={setCommentary}
                  />
                )}
                {sections.trackMap && (
                  <ReportMapSection
                    sectionNum={sectionNumbers.trackMap ?? 2}
                    mapImage={mapImage}
                  />
                )}
              </ReportPage>
            )}

            {sections.stats && flights.length > 0 && (
              <ReportPage>
                <ReportStatsSection
                  sectionNum={sectionNumbers.stats ?? 3}
                  flights={flights}
                  template={template}
                />
              </ReportPage>
            )}


            {sections.los && losResults.length > 0 && (
              <ReportPage>
                <ReportLoSSection
                  sectionNum={sectionNumbers.los ?? 5}
                  losResults={losResults}
                />
              </ReportPage>
            )}

            {sections.panorama && panoramaData.length > 0 && radarSite && (
              <ReportPage>
                <ReportPanoramaSection
                  sectionNum={sectionNumbers.panorama ?? 6}
                  panoramaData={panoramaData}
                  radarSite={radarSite}
                  peakNames={panoramaPeakNames}
                />
              </ReportPage>
            )}

            {sections.aircraft && aircraft.length > 0 && (
              <ReportPage>
                <ReportAircraftSection
                  sectionNum={sectionNumbers.aircraft ?? 6}
                  aircraft={aircraft}
                />
                <div className="absolute bottom-[20mm] left-[20mm] right-[20mm]">
                  <div className="border-t-[2px] border-gray-300" />
                  <p className="mt-2 text-center text-[9px] text-gray-400">
                    {reportMetadata.footer}
                  </p>
                </div>
              </ReportPage>
            )}
          </>
        )}

        {/* ─── 장애물 전파영향 사전검토 ─── */}
        {template === "obstacle" && psResult && (
          <>
            {sections.obstacleSummary && (
              <ReportPage>
                <ReportPSSummarySection
                  sectionNum={sectionNumbers.obstacleSummary ?? 1}
                  result={psResult}
                  buildings={psSelectedBuildings}
                  radars={psSelectedRadarSites}
                  analysisMonth={psAnalysisMonth}
                />
              </ReportPage>
            )}

            {sections.psAngleHeight && (
              <ReportPage>
                <ReportPSAngleHeight
                  sectionNum={sectionNumbers.psAngleHeight ?? 2}
                  result={psResult}
                />
              </ReportPage>
            )}

            {sections.psAdditionalLoss && (
              <ReportPage>
                <ReportPSAdditionalLoss
                  sectionNum={sectionNumbers.psAdditionalLoss ?? 3}
                  result={psResult}
                />
              </ReportPage>
            )}

            {sections.coverageMap && (psCovLayersWith.length > 0 || psCovLayersWithout.length > 0) && psSelectedRadarSites[0] && (
              <ReportPage>
                <ReportOMCoverageDiff
                  sectionNum={sectionNumbers.coverageMap ?? 4}
                  layersWithTargets={psCovLayersWith}
                  layersWithoutTargets={psCovLayersWithout}
                  radarSite={psSelectedRadarSites[0]}
                  lossPoints={[]}
                  defaultAltFt={5000}
                  selectedBuildings={psSelectedBuildings}
                />
              </ReportPage>
            )}

            {sections.los && psLosMap.size > 0 && (
              <ReportPage>
                <ReportLoSSection
                  sectionNum={sectionNumbers.los ?? 5}
                  losResults={[...psLosMap.values()]}
                />
              </ReportPage>
            )}
          </>
        )}

        {/* ─── 장애물 월간 ─── */}
        {template === "obstacle_monthly" && omResultTrimmed && (
          <>
            {sections.omSummary && (
              <ReportOMSummarySection
                sectionNum={sectionNumbers.omSummary ?? 1}
                radarResults={omResultTrimmed.radar_results}
                selectedBuildings={omData.selectedBuildings}
                radarSites={omData.selectedRadarSites}
                azimuthSectorsByRadar={omData.azSectorsByRadar}
                analysisMonth={omData.analysisMonth}
              />
            )}

            {sections.omDailyPsr && omResultTrimmed.radar_results.map((rr) => {
              const info = omRadarConditions.get(rr.radar_name);
              const imgKey = `psr-${rr.radar_name}`;
              return (
                <ReportPage key={imgKey}>
                  <OMSectionImage
                    preCaptured={omData.sectionImages.get(imgKey)}
                    onCaptured={(url) => handleOMSectionCaptured(imgKey, url)}
                  >
                    <ReportOMDailyChart
                      sectionNum={sectionNumbers.omDailyPsr ?? 2}
                      mode="psr"
                      radarName={rr.radar_name}
                      dailyStats={rr.daily_stats}
                      analysisMonth={omData.analysisMonth}
                      conditions={[
                        `• 대상 장애물: ${info?.bldgNames ?? ""}`,
                        `• 영향 방위 구간: ${info?.azText || "전체"} · 장애물 후방(${info?.minDistNm ?? "0"}NM~) 항적만 포함`,
                        `• PSR 거리 제한: 레이더 60NM 이내`,
                        `• PSR율 = PSR 포함 탐지 / 전체 탐지 (SSR+Combined 기준)`,
                      ]}
                    />
                  </OMSectionImage>
                </ReportPage>
              );
            })}

            {sections.omDailyLoss && omResultTrimmed.radar_results.map((rr) => {
              const info = omRadarConditions.get(rr.radar_name);
              const imgKey = `loss-${rr.radar_name}`;
              return (
                <ReportPage key={imgKey}>
                  <OMSectionImage
                    preCaptured={omData.sectionImages.get(imgKey)}
                    onCaptured={(url) => handleOMSectionCaptured(imgKey, url)}
                  >
                    <ReportOMDailyChart
                      sectionNum={sectionNumbers.omDailyLoss ?? 3}
                      mode="loss"
                      radarName={rr.radar_name}
                      dailyStats={rr.daily_stats}
                      analysisMonth={omData.analysisMonth}
                      conditions={[
                        `• 대상 장애물: ${info?.bldgNames ?? ""}`,
                        `• 영향 방위 구간: ${info?.azText || "전체"} · 장애물 후방(${info?.minDistNm ?? "0"}NM~) 항적만 포함`,
                        `• 표적소실(Signal Loss)만 포함 (범위이탈 Out of Range 제외)`,
                        `• 표적소실율 = 소실 시간 / 총 항적 시간 × 100`,
                      ]}
                    />
                  </OMSectionImage>
                </ReportPage>
              );
            })}

            {sections.omWeekly && omResultTrimmed.radar_results.map((rr) => {
              const imgKey = `wk-${rr.radar_name}`;
              return (
                <ReportPage key={imgKey}>
                  <OMSectionImage
                    preCaptured={omData.sectionImages.get(imgKey)}
                    onCaptured={(url) => handleOMSectionCaptured(imgKey, url)}
                  >
                    <ReportOMWeeklyChart
                      sectionNum={sectionNumbers.omWeekly ?? 4}
                      radarName={rr.radar_name}
                      dailyStats={rr.daily_stats}
                      analysisMonth={omData.analysisMonth}
                    />
                  </OMSectionImage>
                </ReportPage>
              );
            })}

            {sections.omCoverageDiff && (omData.coverageStatus === "done" && omData.covLayersWithBuildings.length > 0 ? omData.selectedRadarSites.map((rs) => {
              const rr = omResultTrimmed.radar_results.find((r) => r.radar_name === rs.name);
              const allLoss = rr?.daily_stats.flatMap((d) => d.loss_points_summary) ?? [];
              const covImgKey = `cov-${rs.name}`;
              return (
                <LazySection key={covImgKey} forceVisible={forceAllVisible}>
                  <ReportPage>
                    <OMSectionImage
                      preCaptured={omData.sectionImages.get(covImgKey)}
                      onCaptured={(url) => handleOMSectionCaptured(covImgKey, url)}
                      delay={800}
                    >
                      <ReportOMCoverageDiff
                        sectionNum={sectionNumbers.omCoverageDiff ?? 5}
                        radarSite={rs}
                        layersWithTargets={omData.covLayersWithBuildings}
                        layersWithoutTargets={omData.covLayersWithout}
                        lossPoints={allLoss}
                        defaultAltFt={rr?.avg_loss_altitude_ft ?? 5000}
                        selectedBuildings={omData.selectedBuildings}
                      />
                    </OMSectionImage>
                  </ReportPage>
                </LazySection>
              );
            }) : omData.coverageStatus === "error" ? (
              <ReportPage>
                <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                  <p className="text-sm text-red-400">커버리지 계산 실패</p>
                  <p className="mt-1 text-xs">SRTM 데이터 또는 건물 데이터를 확인하세요</p>
                </div>
              </ReportPage>
            ) : (
              <ReportPage>
                <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                  <Loader2 size={24} className="mb-3 animate-spin" />
                  <p className="text-sm">커버리지 비교맵 계산 중...</p>
                </div>
              </ReportPage>
            ))}

            {sections.omAzDistScatter && omResultTrimmed.radar_results.map((rr) => {
              const rs = omData.selectedRadarSites.find((r) => r.name === rr.radar_name);
              const sectors = omData.azSectorsByRadar.get(rr.radar_name) ?? [];
              if (!rs) return null;
              const azImgKey = `azdist-${rr.radar_name}`;
              return (
                <LazySection key={azImgKey} forceVisible={forceAllVisible}>
                  <ReportPage>
                    <OMSectionImage
                      preCaptured={omData.sectionImages.get(azImgKey)}
                      onCaptured={(url) => handleOMSectionCaptured(azImgKey, url)}
                    >
                      <ReportOMAzDistScatter
                        sectionNum={sectionNumbers.omAzDistScatter ?? 6}
                        radarSite={rs}
                        dailyStats={rr.daily_stats}
                        selectedBuildings={omData.selectedBuildings}
                        azSectors={sectors}
                        analysisMonth={omData.analysisMonth}
                      />
                    </OMSectionImage>
                  </ReportPage>
                </LazySection>
              );
            })}

            {sections.omBuildingLos && (
              <ReportPage>
                <OMSectionImage
                  preCaptured={omData.sectionImages.get("buildingLos")}
                  onCaptured={(url) => handleOMSectionCaptured("buildingLos", url)}
                >
                  <ReportOMBuildingLoS
                    sectionNum={sectionNumbers.omBuildingLos ?? 7}
                    selectedBuildings={omData.selectedBuildings}
                    radarSites={omData.selectedRadarSites}
                    losMap={omData.losMap}
                  />
                </OMSectionImage>
              </ReportPage>
            )}

            {sections.omAltitude && (
              <LazySection forceVisible={forceAllVisible}>
                <ReportPage>
                  <OMSectionImage
                    preCaptured={omData.sectionImages.get("altitude")}
                    onCaptured={(url) => handleOMSectionCaptured("altitude", url)}
                    delay={800}
                  >
                    <ReportOMAltitudeDistribution
                      sectionNum={sectionNumbers.omAltitude ?? 7}
                      radarResults={omResultTrimmed.radar_results}
                      selectedBuildings={omData.selectedBuildings}
                      radarSites={omData.selectedRadarSites}
                      losMap={omData.losMap}
                      panoWithTargets={omData.panoWithTargets}
                      panoWithoutTargets={omData.panoWithoutTargets}
                    />
                  </OMSectionImage>
                </ReportPage>
              </LazySection>
            )}

            {sections.omLossEvents && (omData.coverageStatus === "done" && omData.covLayersWithBuildings.length > 0 ? (
              <LazySection forceVisible={forceAllVisible}>
                <ReportPage>
                  <ReportOMLossEvents
                    sectionNum={sectionNumbers.omLossEvents ?? 8}
                    radarResults={omResultTrimmed.radar_results}
                    selectedBuildings={omData.selectedBuildings}
                    radarSites={omData.selectedRadarSites}
                    layersWithTargets={omData.covLayersWithBuildings}
                    layersWithoutTargets={omData.covLayersWithout}
                  />
                </ReportPage>
              </LazySection>
            ) : omData.coverageStatus === "error" ? (
              <ReportPage>
                <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                  <p className="text-sm text-red-400">커버리지 계산 실패 — Loss 상세 표시 불가</p>
                </div>
              </ReportPage>
            ) : (
              <ReportPage>
                <div className="flex flex-col items-center justify-center py-20 text-gray-400">
                  <Loader2 size={24} className="mb-3 animate-spin" />
                  <p className="text-sm">Loss 상세 계산 중...</p>
                </div>
              </ReportPage>
            ))}

            {sections.omFindings && (
              <ReportPage>
                <ReportOMFindings
                  sectionNum={sectionNumbers.omFindings ?? 9}
                  radarResults={omResultTrimmed.radar_results}
                  selectedBuildings={omData.selectedBuildings}
                  radarSites={omData.selectedRadarSites}
                  findingsText={omData.findingsText}
                  onFindingsChange={(text) => setOmData((prev) => ({ ...prev, findingsText: text }))}
                  editable={true}
                  analysisMonth={omData.analysisMonth}
                />
              </ReportPage>
            )}
          </>
        )}

        {/* ─── 비행 건별 ─── */}
        {template === "flights" && (
          <>
            {(sections.flightComparison || sections.trackMap) && (
              <ReportPage>
                {sections.flightComparison && (
                  <ReportFlightComparisonSection
                    sectionNum={sectionNumbers.flightComparison ?? 1}
                    flights={reportFlights}
                    radarSite={radarSite}
                  />
                )}
                {sections.trackMap && (
                  <ReportMapSection
                    sectionNum={sectionNumbers.trackMap ?? 2}
                    mapImage={mapImage}
                  />
                )}
              </ReportPage>
            )}

            {sections.lossDetail && reportFlights.some((f) => f.loss_points.length > 0) && (
              <ReportPage>
                <ReportLossSection
                  sectionNum={sectionNumbers.lossDetail ?? 3}
                  flights={reportFlights}
                  template="flights"
                />
              </ReportPage>
            )}


            {sections.los && losResults.length > 0 && (
              <ReportPage>
                <ReportLoSSection
                  sectionNum={sectionNumbers.los ?? 5}
                  losResults={losResults}
                />
              </ReportPage>
            )}

            {sections.panorama && panoramaData.length > 0 && radarSite && (
              <ReportPage>
                <ReportPanoramaSection
                  sectionNum={sectionNumbers.panorama ?? 6}
                  panoramaData={panoramaData}
                  radarSite={radarSite}
                  peakNames={panoramaPeakNames}
                />
              </ReportPage>
            )}
          </>
        )}

        {/* ─── 단일비행 상세 ─── */}
        {template === "single" && singleFlight && (
          <>
            {(sections.flightProfile || sections.trackMap) && (
              <ReportPage>
                {sections.flightProfile && (
                  <ReportFlightProfileSection
                    sectionNum={sectionNumbers.flightProfile ?? 1}
                    flight={singleFlight}
                    radarSite={radarSite}
                  />
                )}
                {sections.trackMap && (
                  <ReportMapSection
                    sectionNum={sectionNumbers.trackMap ?? 2}
                    mapImage={mapImage}
                  />
                )}
              </ReportPage>
            )}

            {sections.flightLossAnalysis && (
              <ReportPage>
                <ReportFlightLossAnalysisSection
                  sectionNum={sectionNumbers.flightLossAnalysis ?? 3}
                  flight={singleFlight}
                />
              </ReportPage>
            )}


            {sections.los && losResults.length > 0 && (
              <ReportPage>
                <ReportLoSSection
                  sectionNum={sectionNumbers.los ?? 5}
                  losResults={losResults}
                />
              </ReportPage>
            )}

            {sections.panorama && panoramaData.length > 0 && radarSite && (
              <ReportPage>
                <ReportPanoramaSection
                  sectionNum={sectionNumbers.panorama ?? 6}
                  panoramaData={panoramaData}
                  radarSite={radarSite}
                  peakNames={panoramaPeakNames}
                />
              </ReportPage>
            )}
          </>
        )}
        </div>{/* /섹션 컨테이너 */}
      </div>
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
}: {
  flights: Flight[];
  totalLoss: number;
  avgLossPercent: number;
  losResults: LoSProfileData[];
  panoramaData: PanoramaPoint[];
  coverageLayers: CoverageLayer[];
  customRadarSites: RadarSite[];
  onSelect: (tpl: ReportTemplate) => void;
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
              disabled={row.disabled}
              className={`flex w-full items-center gap-3 px-4 py-3 text-left transition-colors ${
                row.disabled
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
        await invoke("write_file_base64", {
          path: await (async () => {
            const { save } = await import("@tauri-apps/plugin-dialog");
            const path = await save({
              defaultPath: filename,
              filters: [{ name: "PDF", extensions: ["pdf"] }],
            });
            return path;
          })(),
          base64Data: detail.pdf_base64,
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

// ── 템플릿 설정 모달 ──

function TemplateConfigModal({
  template,
  flights,
  losResults,
  aircraft,
  metadata,
  radarName,
  panoramaData,
  onClose,
  onGenerate,
}: {
  template: ReportTemplate;
  flights: Flight[];
  losResults: LoSProfileData[];
  aircraft: AircraftType[];
  metadata: ReportMetadata;
  radarName: string;
  panoramaData: PanoramaPoint[];
  onClose: () => void;
  onGenerate: (tpl: ReportTemplate, sections: ReportSections, flightIds?: Set<string>, singleId?: string | null) => void;
}) {
  const radarSite = useAppStore((s) => s.radarSite);
  const tplLabel = templateDisplayLabel(template);
  const [sections, setSections] = useState<ReportSections>({ ...DEFAULT_SECTIONS });

  // 비행 선택 상태 (건별용: 다중, 단일용: 라디오)
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set(flights.map((f) => f.id)));
  const [radioId, setRadioId] = useState<string | null>(flights[0]?.id ?? null);

  const isFlightsMode = template === "flights";
  const isSingleMode = template === "single";
  const needsFlightSelect = isFlightsMode || isSingleMode;

  const totalLoss = flights.reduce((s, r) => s + r.loss_points.length, 0);
  const avgLossPercent =
    flights.length > 0
      ? flights.reduce((s, r) => s + r.loss_percentage, 0) / flights.length
      : 0;

  // 템플릿별 섹션 항목
  const sectionItems: { key: keyof ReportSections; label: string; icon: typeof MapIcon; desc: string; available: boolean }[] = (() => {
    if (isFlightsMode) {
      return [
        { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
        { key: "flightComparison", label: "비행 비교", icon: BarChart3, desc: "선택 비행 비교 테이블 및 차트", available: true },
        { key: "trackMap", label: "항적 지도", icon: MapIcon, desc: "선택 비행 항적 경로 시각화", available: true },
        { key: "lossDetail", label: "소실 상세", icon: Crosshair, desc: "소실 포인트 상세 목록", available: true },
        { key: "los", label: "LoS 분석", icon: Crosshair, desc: "전파 가시선 차단 분석", available: losResults.length > 0 },
        { key: "panorama", label: "전파 장애물", icon: Mountain, desc: "360° 파노라마 장애물 분석", available: panoramaData.length > 0 },
      ];
    }
    if (template === "obstacle") {
      const hasCoverage = isGPUCacheValidFor(radarSite);
      return [
        { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
        { key: "obstacleSummary", label: "장애물 종합 요약", icon: Radio, desc: "LoS·파노라마 통합 KPI, 주요 장애물 TOP 5", available: losResults.length > 0 || panoramaData.length > 0 },
        { key: "coverageMap", label: "커버리지 맵", icon: Radio, desc: "고도별 스펙트럼 커버리지 극좌표 시각화", available: hasCoverage },
        { key: "los", label: "LoS 분석", icon: Crosshair, desc: "전파 가시선 차단/양호 상세 결과", available: losResults.length > 0 },
        { key: "panorama", label: "360° 파노라마", icon: Mountain, desc: "방위별 최대 앙각 장애물 및 건물 목록", available: panoramaData.length > 0 },
      ];
    }
    if (isSingleMode) {
      return [
        { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
        { key: "flightProfile", label: "비행 프로파일", icon: Plane, desc: "기본정보, KPI, 고도 추이 차트", available: true },
        { key: "trackMap", label: "항적 지도", icon: MapIcon, desc: "해당 비행 항적 경로 시각화", available: true },
        { key: "flightLossAnalysis", label: "소실 구간 분석", icon: BarChart3, desc: "구간별 상세, 분포 분석 차트", available: true },
        { key: "los", label: "LoS 분석", icon: Crosshair, desc: "전파 가시선 차단 분석", available: losResults.length > 0 },
        { key: "panorama", label: "전파 장애물", icon: Mountain, desc: "360° 파노라마 장애물 분석", available: panoramaData.length > 0 },
      ];
    }
    return [
      { key: "cover", label: "표지", icon: FileText, desc: "문서번호, 시행일자, 레이더명", available: true },
      { key: "summary", label: "분석 요약", icon: BarChart3, desc: "KPI 그리드, 종합 판정, 소견", available: true },
      { key: "trackMap", label: "항적 지도", icon: MapIcon, desc: "항적 경로 및 Loss 구간 시각화", available: true },
      { key: "stats", label: "분석 통계", icon: BarChart3, desc: `비행별 상세 ${template === "weekly" ? "통계" : "추이 차트"}`, available: flights.length > 0 },
      { key: "los", label: "LoS 분석", icon: Crosshair, desc: "전파 가시선 차단 분석", available: losResults.length > 0 },
      { key: "panorama", label: "전파 장애물", icon: Mountain, desc: "360° 파노라마 장애물 분석", available: panoramaData.length > 0 },
      { key: "aircraft", label: "검사기 현황", icon: Plane, desc: "비행검사기 운용 현황", available: aircraft.length > 0 },
    ];
  })();

  const hasRadar = radarName.length > 0;
  const canGenerate = hasRadar && (isFlightsMode ? checkedIds.size > 0 : isSingleMode ? !!radioId : true);

  return (
    <Modal open onClose={onClose} title={`${tplLabel} 보고서 설정`} width={needsFlightSelect ? "max-w-2xl" : "max-w-lg"}>
      <div className="space-y-5">
        {/* 기본 정보 */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
            <div className="flex justify-between">
              <span className="text-gray-400">기관</span>
              <span className="font-medium text-gray-700">{metadata.organization}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">레이더</span>
              <span className="font-medium text-gray-700">{radarName || <span className="text-red-500">미선택</span>}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">부서</span>
              <span className="font-medium text-gray-700">{metadata.department}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-gray-400">현장</span>
              <span className="font-medium text-gray-700">{metadata.siteName || "—"}</span>
            </div>
          </div>
          <p className="mt-2 text-[10px] text-gray-400">
            메타데이터는 사이드바 하단에서 수정할 수 있습니다
          </p>
        </div>

        {/* 데이터 요약 */}
        <div className="flex gap-3">
          <SummaryPill label="분석 비행" value={flights.length} />
          <SummaryPill label="소실 건수" value={totalLoss} accent />
          <SummaryPill label="평균 소실율" value={`${avgLossPercent.toFixed(1)}%`} accent />
          <SummaryPill label="LoS" value={`${losResults.length}건`} />
        </div>

        {/* 비행 선택 영역 (건별/단일 모드) */}
        {needsFlightSelect && (
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-700">
                {isFlightsMode ? "비행 선택 (다중)" : "비행 선택 (1건)"}
              </h3>
              {isFlightsMode && (
                <div className="flex gap-2">
                  <button
                    onClick={() => setCheckedIds(new Set(flights.map((f) => f.id)))}
                    className="text-[11px] text-[#a60739] hover:underline"
                  >
                    전체 선택
                  </button>
                  <button
                    onClick={() => setCheckedIds(new Set())}
                    className="text-[11px] text-gray-400 hover:underline"
                  >
                    전체 해제
                  </button>
                </div>
              )}
            </div>

            <div className="max-h-52 space-y-1 overflow-y-auto rounded-lg border border-gray-200 p-2">
              {flights.map((f) => {
                const label = flightLabel(f, aircraft);
                const isChecked = isFlightsMode ? checkedIds.has(f.id) : radioId === f.id;
                return (
                  <button
                    key={f.id}
                    onClick={() => {
                      if (isFlightsMode) {
                        setCheckedIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(f.id)) next.delete(f.id);
                          else next.add(f.id);
                          return next;
                        });
                      } else {
                        setRadioId(f.id);
                      }
                    }}
                    className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-all ${
                      isChecked
                        ? "border-[#a60739] bg-[#a60739] text-white"
                        : "border-gray-100 hover:border-gray-200"
                    }`}
                  >
                    {isFlightsMode ? (
                      isChecked
                        ? <CheckSquare size={14} className="shrink-0 text-white" />
                        : <Square size={14} className="shrink-0 text-gray-300" />
                    ) : (
                      <div className={`flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 ${
                        isChecked ? "border-white" : "border-gray-300"
                      }`}>
                        {isChecked && <div className="h-2 w-2 rounded-full bg-white" />}
                      </div>
                    )}
                    <div className="min-w-0 flex-1">
                      <span className={`text-[12px] font-medium ${isChecked ? "text-white" : "text-gray-500"}`}>
                        {label}
                      </span>
                      <span className={`ml-2 text-[10px] ${isChecked ? "text-white/70" : "text-gray-400"}`}>
                        {format(new Date(f.start_time * 1000), "MM-dd HH:mm")}~{format(new Date(f.end_time * 1000), "HH:mm")}
                      </span>
                    </div>
                    <div className="flex shrink-0 gap-2 text-[10px]">
                      <span className={isChecked ? "text-white/70" : "text-gray-400"}>{f.point_count.toLocaleString()}pt</span>
                      <span className={isChecked ? "font-semibold text-white" : f.loss_percentage > 5 ? "font-semibold text-red-600" : f.loss_percentage > 1 ? "text-yellow-600" : "text-green-600"}>
                        {f.loss_percentage.toFixed(1)}%
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>

            {isFlightsMode && (
              <p className="mt-1 text-[10px] text-gray-400">
                {checkedIds.size}건 선택됨
              </p>
            )}
          </div>
        )}

        {/* 포함 섹션 */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">포함 항목</h3>
          <div className="space-y-1.5">
            {sectionItems.map(({ key, label, icon: Icon, desc, available }) => (
              <button
                key={key}
                onClick={() => available && setSections((s) => ({ ...s, [key]: !s[key] }))}
                disabled={!available}
                className={`flex w-full items-center gap-3 rounded-lg border px-3 py-2 text-left transition-all ${
                  !available
                    ? "border-gray-100 bg-gray-50 opacity-40 cursor-not-allowed"
                    : sections[key]
                    ? "border-[#a60739] bg-[#a60739] text-white"
                    : "border-gray-200 hover:border-gray-300"
                }`}
              >
                {sections[key] && available ? (
                  <CheckSquare size={16} className="shrink-0 text-white" />
                ) : (
                  <Square size={16} className="shrink-0 text-gray-300" />
                )}
                <Icon size={14} className={`shrink-0 ${sections[key] && available ? "text-white" : "text-gray-400"}`} />
                <div className="min-w-0">
                  <span className={`text-sm font-medium ${sections[key] && available ? "text-white" : "text-gray-500"}`}>{label}</span>
                  <span className={`ml-2 text-[11px] ${sections[key] && available ? "text-white/70" : "text-gray-400"}`}>{desc}</span>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* 생성 버튼 */}
        <div className="flex items-center justify-end gap-2 pt-1">
          {!hasRadar && (
            <span className="mr-auto text-xs text-red-500">레이더를 먼저 선택해 주세요 (설정 &gt; 레이더 사이트)</span>
          )}
          <button
            onClick={onClose}
            className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
          >
            취소
          </button>
          <button
            onClick={() => onGenerate(
              template,
              sections,
              isFlightsMode ? checkedIds : undefined,
              isSingleMode ? radioId : undefined,
            )}
            disabled={!canGenerate}
            className="flex items-center gap-2 rounded-lg bg-[#a60739] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40"
          >
            <Eye size={14} />
            보고서 생성
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── 작은 UI 컴포넌트 ──

function SummaryPill({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="flex-1 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-center">
      <p className="text-[10px] text-gray-400">{label}</p>
      <p className={`text-sm font-bold ${accent ? "text-[#a60739]" : "text-gray-800"}`}>
        {value}
      </p>
    </div>
  );
}

// ─── 장애물 월간 보고서 전용 설정 모달 ───

/** 건물 도형의 레이더 방향 노출면 방위 구간 계산 */
function calcBuildingAzExtent(
  radarLat: number, radarLon: number,
  building: ManualBuilding,
): AzSector {
  const toRad = Math.PI / 180;
  const bearingTo = (lat2: number, lon2: number) => {
    const y = Math.sin((lon2 - radarLon) * toRad) * Math.cos(lat2 * toRad);
    const x = Math.cos(radarLat * toRad) * Math.sin(lat2 * toRad) -
      Math.sin(radarLat * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - radarLon) * toRad);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
  };

  const geo = building.geometry_json ? JSON.parse(building.geometry_json) : null;
  const bearings: number[] = [bearingTo(building.latitude, building.longitude)];

  if (building.geometry_type === "polygon" && geo && Array.isArray(geo)) {
    for (const pt of geo) {
      if (Array.isArray(pt) && pt.length === 2) {
        bearings.push(bearingTo(pt[0], pt[1]));
      }
    }
  } else if (building.geometry_type === "multi" && geo && Array.isArray(geo)) {
    // 복합 도형: 서브 도형 재귀 처리하여 방위 합산
    for (const sub of geo) {
      const subType = sub.type;
      const subJson = sub.json;
      if (!subType || !subJson) continue;
      const subBuilding = { ...building, geometry_type: subType, geometry_json: subJson };
      const subResult = calcBuildingAzExtent(radarLat, radarLon, subBuilding);
      bearings.push(subResult.start_deg, subResult.end_deg);
    }
  }

  if (bearings.length <= 1) {
    // 점 도형: ±2° 기본 마진
    const az = bearings[0];
    return { start_deg: (az - 2 + 360) % 360, end_deg: (az + 2) % 360 };
  }

  // 방위 범위 계산 (circular range)
  bearings.sort((a, b) => a - b);
  let maxGap = 0, gapStart = 0;
  for (let i = 0; i < bearings.length; i++) {
    const next = (i + 1) % bearings.length;
    const gap = next === 0 ? (360 - bearings[i] + bearings[0]) : (bearings[next] - bearings[i]);
    if (gap > maxGap) { maxGap = gap; gapStart = i; }
  }
  const start = bearings[(gapStart + 1) % bearings.length];
  const end = bearings[gapStart];
  return { start_deg: start, end_deg: end };
}

/** 방위 구간 병합 */
function mergeAzSectors(sectors: AzSector[]): AzSector[] {
  if (sectors.length <= 1) return sectors;
  // 단순 구현: 연속된 구간 병합
  const sorted = [...sectors].sort((a, b) => a.start_deg - b.start_deg);
  const merged: AzSector[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = merged[merged.length - 1];
    const curr = sorted[i];
    if (curr.start_deg <= prev.end_deg + 2) {
      prev.end_deg = Math.max(prev.end_deg, curr.end_deg);
    } else {
      merged.push({ ...curr });
    }
  }
  return merged;
}

function ObstacleMonthlyConfigModal({
  customRadarSites,
  aircraft,
  metadata,
  onClose,
  onGenerate,
  onCoverageReady,
  onCoverageError,
}: {
  customRadarSites: RadarSite[];
  aircraft: AircraftType[];
  metadata: ReportMetadata;
  onClose: () => void;
  onGenerate: (
    result: ObstacleMonthlyResult,
    buildings: ManualBuilding[],
    radars: RadarSite[],
    azMap: Map<string, AzSector[]>,
    losMap: Map<string, LoSProfileData>,
    covWith: CoverageLayer[],
    covWithout: CoverageLayer[],
    analysisMonth?: string,
  ) => void;
  onCoverageReady: (covWith: CoverageLayer[], covWithout: CoverageLayer[]) => void;
  onCoverageError?: () => void;
}) {
  // 1단계: 레이더 선택
  const [checkedRadars, setCheckedRadars] = useState<Set<string>>(new Set());
  // 2단계: 건물 선택
  const [manualBuildings, setManualBuildings] = useState<ManualBuilding[]>([]);
  const [buildingGroups, setBuildingGroups] = useState<BuildingGroup[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number | null>>(new Set());
  const [checkedBldgIds, setCheckedBldgIds] = useState<Set<number>>(new Set());
  // 3단계: 레이더별 파일
  const [radarFiles, setRadarFiles] = useState<Map<string, string[]>>(new Map());
  // 분석월 선택 (YYYY-MM, 빈 문자열이면 전체)
  const [analysisMonth, setAnalysisMonth] = useState(() => format(new Date(), "yyyy-MM"));
  // 분석 상태
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState("");
  const [progressPct, setProgressPct] = useState(0);

  // 수동 건물 목록 + 그룹 로드
  useEffect(() => {
    invoke<ManualBuilding[]>("list_manual_buildings").then(setManualBuildings).catch(() => {});
    invoke<BuildingGroup[]>("list_building_groups").then(setBuildingGroups).catch(() => {});
  }, []);

  // 선택된 레이더/건물
  const selectedRadars = customRadarSites.filter((r) => checkedRadars.has(r.name));
  const selectedBuildings = manualBuildings.filter((b) => checkedBldgIds.has(b.id));

  // 방위 구간 계산
  const azSectorsByRadar = useMemo(() => {
    const map = new Map<string, AzSector[]>();
    for (const r of selectedRadars) {
      const sectors = selectedBuildings.map((b) =>
        calcBuildingAzExtent(r.latitude, r.longitude, b),
      );
      map.set(r.name, mergeAzSectors(sectors));
    }
    return map;
  }, [selectedRadars, selectedBuildings]);

  // 파일 선택 핸들러
  const handleSelectFiles = useCallback(async (radarName: string) => {
    const result = await open({
      multiple: true,
      filters: [{ name: "ASS Files", extensions: ["ass", "ASS"] }],
    });
    if (result && Array.isArray(result)) {
      setRadarFiles((prev) => {
        const next = new Map(prev);
        next.set(radarName, result.map((r) => typeof r === "string" ? r : r));
        return next;
      });
    }
  }, []);

  // 분석 시작
  const handleAnalyze = useCallback(async () => {
    if (analyzing) return;
    setAnalyzing(true);
    setProgress("분석 준비 중...");
    setProgressPct(0);

    let unlistenFn: (() => void) | null = null;
    try {
      unlistenFn = await listen<ObstacleMonthlyProgress>("obstacle-monthly-progress", (e) => {
        setProgress(e.payload.message);
        if (e.payload.total > 0) {
          setProgressPct(Math.round((e.payload.current / e.payload.total) * 100));
        }
      });
      const excludeMs = aircraft.map((a) => a.mode_s_code).filter(Boolean);

      const radarFileSets = selectedRadars.map((r) => {
        // 선택된 건물 중 레이더에서 가장 가까운 건물까지의 거리 (km)
        let minObstacleDist = 0;
        for (const b of selectedBuildings) {
          const d = haversineKm(r.latitude, r.longitude, b.latitude, b.longitude);
          if (minObstacleDist === 0 || d < minObstacleDist) minObstacleDist = d;
        }

        return {
          radar_name: r.name,
          radar_lat: r.latitude,
          radar_lon: r.longitude,
          radar_altitude: r.altitude,
          antenna_height: r.antenna_height,
          file_paths: radarFiles.get(r.name) ?? [],
          azimuth_sectors: azSectorsByRadar.get(r.name) ?? [],
          min_obstacle_distance_km: minObstacleDist,
        };
      });

      const result = await invoke<ObstacleMonthlyResult>("analyze_obstacle_monthly", {
        radarFileSets,
        excludeModeS: excludeMs,
      });

      // LoS 분석 (건물별 × 레이더별, fetch_elevation + query_buildings_along_path)
      setProgress("LoS 분석 중...");
      const losMap = new Map<string, LoSProfileData>();
      const totalLosJobs = selectedRadars.length * selectedBuildings.length;
      let losJobDone = 0;
      for (const radar of selectedRadars) {
        const radarHeight = radar.altitude + radar.antenna_height;
        for (const bldg of selectedBuildings) {
          losJobDone++;
          setProgress(`LoS 분석 중... ${radar.name} → ${bldg.name || `건물${bldg.id}`} (${losJobDone}/${totalLosJobs})`);
          try {
            const samples = 150;
            const lats: number[] = [];
            const lons: number[] = [];
            for (let i = 0; i <= samples; i++) {
              const t = i / samples;
              lats.push(radar.latitude + (bldg.latitude - radar.latitude) * t);
              lons.push(radar.longitude + (bldg.longitude - radar.longitude) * t);
            }
            // 지형 고도 + 경로 건물 동시 조회
            const [elevations, pathBuildings] = await Promise.all([
              invoke<number[]>("fetch_elevation", { latitudes: lats, longitudes: lons }),
              invoke<{ distance_km: number; height_m: number; ground_elev_m: number; total_height_m: number; name: string | null; address: string | null }[]>(
                "query_buildings_along_path",
                { radarLat: radar.latitude, radarLon: radar.longitude, targetLat: bldg.latitude, targetLon: bldg.longitude, corridorWidthM: 200 },
              ),
            ]);
            const totalDist = Math.sqrt(
              ((bldg.latitude - radar.latitude) * 111320) ** 2 +
              ((bldg.longitude - radar.longitude) * 111320 * Math.cos(radar.latitude * Math.PI / 180)) ** 2,
            ) / 1000;

            // 건물 높이를 지형에 합산
            const combinedElev = [...elevations];
            for (const pb of pathBuildings) {
              const sampleIdx = Math.round((pb.distance_km / totalDist) * samples);
              if (sampleIdx >= 0 && sampleIdx < combinedElev.length) {
                const bldgTop = pb.ground_elev_m + pb.height_m;
                if (bldgTop > combinedElev[sampleIdx]) {
                  combinedElev[sampleIdx] = bldgTop;
                }
              }
            }

            // LoS 차단 판정 (4/3 유효지구 모델)
            let blocked = false;
            let maxBlockDist = 0, maxBlockElev = -Infinity, maxBlockName = "";
            const R = 6371000;
            const Reff = R * 4 / 3;
            const targetElev = bldg.ground_elev + bldg.height;
            for (let i = 1; i < combinedElev.length; i++) {
              const d = (i / samples) * totalDist * 1000;
              const t = i / samples;
              const losHeight = radarHeight * (1 - t) + targetElev * t;
              const curvDrop = (d * d) / (2 * Reff);
              const terrainAdjusted = combinedElev[i] + curvDrop;
              if (terrainAdjusted > losHeight) {
                blocked = true;
                if (terrainAdjusted > maxBlockElev) {
                  maxBlockElev = terrainAdjusted;
                  maxBlockDist = t * totalDist;
                  // 이 위치의 건물 이름 찾기
                  const nearBldg = pathBuildings.find((pb) => Math.abs(pb.distance_km - maxBlockDist) < 0.5);
                  maxBlockName = nearBldg?.name ?? nearBldg?.address ?? "";
                }
              }
            }
            if (maxBlockElev === -Infinity) blocked = false;

            const bearing = ((Math.atan2(
              (bldg.longitude - radar.longitude) * Math.cos(radar.latitude * Math.PI / 180),
              bldg.latitude - radar.latitude,
            ) * 180) / Math.PI + 360) % 360;

            const elevProfile = combinedElev.map((elev, idx) => ({
              distance: (idx / samples) * totalDist,
              elevation: elev,
              latitude: lats[idx],
              longitude: lons[idx],
            }));
            losMap.set(`${radar.name}_${bldg.id}`, {
              id: `om_${radar.name}_${bldg.id}`,
              radarSiteName: radar.name,
              radarLat: radar.latitude,
              radarLon: radar.longitude,
              radarHeight,
              targetLat: bldg.latitude,
              targetLon: bldg.longitude,
              bearing,
              totalDistance: totalDist,
              elevationProfile: elevProfile,
              losBlocked: blocked,
              maxBlockingPoint: blocked ? { distance: maxBlockDist, elevation: maxBlockElev, name: maxBlockName } : undefined,
              timestamp: Date.now(),
            });
          } catch (err) {
            console.warn(`LoS 계산 실패: ${radar.name}→${bldg.name}:`, err);
          }
        }
      }

      // 분석월 필터링
      const filteredResult: ObstacleMonthlyResult = analysisMonth
        ? {
            ...result,
            radar_results: result.radar_results.map((rr) => ({
              ...rr,
              daily_stats: rr.daily_stats.filter((d) => d.date.startsWith(analysisMonth)),
            })),
          }
        : result;

      // 미리보기 먼저 전환 (커버리지 없이) — 전파장애물 탭 패턴
      onGenerate(filteredResult, selectedBuildings, selectedRadars, azSectorsByRadar, losMap, [], [], analysisMonth);

      // 커버리지는 미리보기 전환 후 백그라운드 계산
      if (selectedRadars.length > 0) {
        const r = selectedRadars[0];
        const altFts = [1000, 2000, 3000, 5000, 10000, 15000, 20000, 25000, 30000];
        const excludeIds = selectedBuildings.map((b) => b.id);
        import("../utils/gpuCoverage").then(({ computeCoverageLayersOM }) =>
          computeCoverageLayersOM(
            {
              radarName: r.name,
              radarLat: r.latitude,
              radarLon: r.longitude,
              radarAltitude: r.altitude,
              antennaHeight: r.antenna_height,
              rangeNm: r.range_nm,
              bearingStepDeg: 0.01,
            },
            altFts,
            excludeIds,
          ).then(({ layersWith, layersWithout }) => {
            onCoverageReady(layersWith, layersWithout);
          }).catch((err) => {
            console.warn("커버리지 계산 실패:", err);
            onCoverageError?.();
          }),
        );
      }
    } catch (err) {
      setProgress(`오류: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      unlistenFn?.();
      setAnalyzing(false);
    }
  }, [analyzing, selectedRadars, selectedBuildings, radarFiles, azSectorsByRadar, aircraft, onGenerate, onCoverageError, analysisMonth]);

  const allFilesSelected = selectedRadars.every((r) => (radarFiles.get(r.name)?.length ?? 0) > 0);
  const canAnalyze = selectedRadars.length > 0 && selectedBuildings.length > 0 && allFilesSelected && !analyzing;

  return (
    <Modal open onClose={onClose} title="장애물 월간 보고서 설정" width="max-w-3xl">
      <div className="space-y-5">
        {/* 기본 정보 */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
            <div className="flex justify-between">
              <span className="text-gray-400">기관</span>
              <span className="font-medium text-gray-700">{metadata.organization}</span>
            </div>
          </div>
        </div>

        {/* 분석월 선택 */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="flex items-center gap-3 text-[12px]">
            <span className="font-semibold text-gray-700">분석월</span>
            <MonthPicker value={analysisMonth} onChange={setAnalysisMonth} />
            <span className="text-[10px] text-gray-400">해당 월의 데이터만 보고서에 포함됩니다</span>
          </div>
        </div>

        {/* 1단계: 레이더 선택 */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">
            1. 레이더 선택 <span className="text-[11px] font-normal text-gray-400">(필수, 복수 가능)</span>
          </h3>
          <div className="space-y-1 rounded-lg border border-gray-200 p-2">
            {customRadarSites.map((r) => {
              const checked = checkedRadars.has(r.name);
              return (
                <button
                  key={r.name}
                  onClick={() => setCheckedRadars((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.name)) next.delete(r.name);
                    else next.add(r.name);
                    return next;
                  })}
                  className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-all ${
                    checked ? "border-[#a60739] bg-[#a60739] text-white" : "border-gray-100 hover:border-gray-200"
                  }`}
                >
                  {checked
                    ? <CheckSquare size={14} className="shrink-0 text-white" />
                    : <Square size={14} className="shrink-0 text-gray-300" />
                  }
                  <span className={`text-[12px] font-medium ${checked ? "text-white" : "text-gray-500"}`}>
                    {r.name}
                  </span>
                  <span className={`ml-auto text-[10px] ${checked ? "text-white/70" : "text-gray-400"}`}>
                    {r.latitude.toFixed(4)}°N {r.longitude.toFixed(4)}°E
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 2단계: 장애물 선택 */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">
            2. 장애물 선택 <span className="text-[11px] font-normal text-gray-400">(수동 건물, 복수 가능)</span>
          </h3>
          {manualBuildings.length === 0 ? (
            <p className="text-xs text-gray-400">등록된 수동 건물이 없습니다. 그리기 도구에서 건물을 먼저 등록하세요.</p>
          ) : (
            <>
              <div className="mb-1 flex gap-2 text-[11px]">
                <button onClick={() => setCheckedBldgIds(new Set(manualBuildings.map((b) => b.id)))} className="text-[#a60739] hover:underline">전체 선택</button>
                <button onClick={() => setCheckedBldgIds(new Set())} className="text-gray-400 hover:underline">전체 해제</button>
              </div>
              <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
                {(() => {
                  // 그룹별로 건물 분류
                  const groupMap = new Map<number | null, ManualBuilding[]>();
                  for (const b of manualBuildings) {
                    const gid = b.group_id ?? null;
                    if (!groupMap.has(gid)) groupMap.set(gid, []);
                    groupMap.get(gid)!.push(b);
                  }
                  // 그룹 순서: 등록된 그룹 → 미분류(null)
                  const orderedKeys: (number | null)[] = [
                    ...buildingGroups.map((g) => g.id).filter((id) => groupMap.has(id)),
                    ...(groupMap.has(null) ? [null as number | null] : []),
                    // 그룹 삭제 후 남은 orphan group_id
                    ...[...groupMap.keys()].filter((k) => k !== null && !buildingGroups.find((g) => g.id === k)),
                  ];

                  const renderBuilding = (b: ManualBuilding) => {
                    const checked = checkedBldgIds.has(b.id);
                    const azInfo = selectedRadars.map((r) => {
                      const sector = calcBuildingAzExtent(r.latitude, r.longitude, b);
                      return `${r.name}: ${sector.start_deg.toFixed(0)}°~${sector.end_deg.toFixed(0)}°`;
                    }).join(", ");
                    return (
                      <button
                        key={b.id}
                        onClick={() => setCheckedBldgIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(b.id)) next.delete(b.id);
                          else next.add(b.id);
                          return next;
                        })}
                        className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-1.5 text-left transition-all ${
                          checked ? "border-[#a60739] bg-[#a60739] text-white" : "border-gray-100 hover:border-gray-200"
                        }`}
                      >
                        {checked
                          ? <CheckSquare size={14} className="shrink-0 text-white" />
                          : <Square size={14} className="shrink-0 text-gray-300" />
                        }
                        <div className="min-w-0 flex-1">
                          <span className={`text-[12px] font-medium ${checked ? "text-white" : "text-gray-500"}`}>
                            {b.name || `건물 ${b.id}`}
                          </span>
                          <span className={`ml-2 text-[10px] ${checked ? "text-white/70" : "text-gray-400"}`}>{b.height.toFixed(0)}m · {b.geometry_type}</span>
                          {checked && selectedRadars.length > 0 && (
                            <p className="mt-0.5 text-[9px] text-white/60">{azInfo}</p>
                          )}
                        </div>
                      </button>
                    );
                  };

                  return orderedKeys.map((gid) => {
                    const buildings = groupMap.get(gid) ?? [];
                    if (buildings.length === 0) return null;
                    const group = gid !== null ? buildingGroups.find((g) => g.id === gid) : null;
                    const groupName = group?.name ?? (gid !== null ? `그룹 ${gid}` : "미분류");
                    const groupColor = group?.color ?? "#9ca3af";
                    const collapsed = collapsedGroups.has(gid);
                    const groupBldgIds = buildings.map((b) => b.id);
                    const allChecked = groupBldgIds.every((id) => checkedBldgIds.has(id));
                    const someChecked = groupBldgIds.some((id) => checkedBldgIds.has(id));

                    return (
                      <div key={gid ?? "ungrouped"} className="mb-1">
                        {/* 그룹 헤더 */}
                        <div className="flex items-center gap-1">
                          {/* 그룹 체크박스 — 그룹 전체 선택/해제 */}
                          <button
                            onClick={() => setCheckedBldgIds((prev) => {
                              const next = new Set(prev);
                              if (allChecked) groupBldgIds.forEach((id) => next.delete(id));
                              else groupBldgIds.forEach((id) => next.add(id));
                              return next;
                            })}
                            className="shrink-0 p-0.5"
                          >
                            {allChecked
                              ? <CheckSquare size={14} className="text-[#a60739]" />
                              : someChecked
                              ? <MinusSquare size={14} className="text-[#a60739]/50" />
                              : <Square size={14} className="text-gray-300" />
                            }
                          </button>
                          <button
                            onClick={() => setCollapsedGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(gid)) next.delete(gid);
                              else next.add(gid);
                              return next;
                            })}
                            className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-100"
                          >
                            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: groupColor }} />
                            <span>{groupName}</span>
                            <span className="ml-1 font-normal text-gray-400">({buildings.length})</span>
                          </button>
                        </div>
                        {/* 그룹 내 건물 목록 */}
                        {!collapsed && (
                          <div className="ml-6 mt-0.5 space-y-0.5">
                            {buildings.map(renderBuilding)}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            </>
          )}

          {/* 병합된 방위 구간 표시 */}
          {selectedRadars.length > 0 && selectedBuildings.length > 0 && (
            <div className="mt-2 rounded-md bg-gray-50 px-3 py-1.5 text-[10px]">
              {selectedRadars.map((r) => {
                const sectors = azSectorsByRadar.get(r.name) ?? [];
                return (
                  <div key={r.name}>
                    <span className="text-gray-400">{r.name} 분석 구간:</span>{" "}
                    <span className="font-mono font-semibold text-[#a60739]">
                      {sectors.map((s) => `${s.start_deg.toFixed(1)}°~${s.end_deg.toFixed(1)}°`).join(", ")}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 3단계: 레이더별 파일 선택 */}
        {selectedRadars.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-700">
              3. 레이더별 ASS 파일 선택
            </h3>
            <div className="space-y-2">
              {selectedRadars.map((r) => {
                const files = radarFiles.get(r.name) ?? [];
                return (
                  <div key={r.name} className="rounded-lg border border-gray-200 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-gray-700">📡 {r.name}</span>
                      <button
                        onClick={() => handleSelectFiles(r.name)}
                        className="rounded-md bg-gray-100 px-3 py-1 text-[11px] text-gray-600 hover:bg-gray-200 transition-colors"
                      >
                        📂 파일 선택
                      </button>
                    </div>
                    {files.length > 0 && (
                      <p className="mt-1 text-[10px] text-gray-500">
                        {files.length}개 파일 선택됨
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 분석 진행 */}
        {analyzing && (
          <div className="rounded-lg border border-[#a60739]/20 bg-[#a60739]/5 p-3">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-[#a60739]" />
              <span className="text-[12px] text-gray-700">{progress}</span>
            </div>
            <div className="mt-2 h-2 rounded-full bg-gray-200">
              <div
                className="h-full rounded-full bg-[#a60739] transition-all"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
        )}

        {/* 버튼 */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
            취소
          </button>
          <button
            onClick={handleAnalyze}
            disabled={!canAnalyze}
            className="flex items-center gap-2 rounded-lg bg-[#a60739] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40"
          >
            <BarChart3 size={14} />
            분석 시작
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ── 장애물 전파영향 사전검토 모달 ──

function ObstaclePreScreeningModal({
  customRadarSites,
  aircraft,
  metadata,
  onClose,
  onGenerate,
  onCoverageReady,
}: {
  customRadarSites: RadarSite[];
  aircraft: AircraftType[];
  metadata: ReportMetadata;
  onClose: () => void;
  onGenerate: (
    result: PreScreeningResult,
    buildings: ManualBuilding[],
    radars: RadarSite[],
    losMap: Map<string, LoSProfileData>,
    covWith: CoverageLayer[],
    covWithout: CoverageLayer[],
    analysisMonth?: string,
  ) => void;
  onCoverageReady: (covWith: CoverageLayer[], covWithout: CoverageLayer[]) => void;
}) {
  const [checkedRadars, setCheckedRadars] = useState<Set<string>>(new Set());
  const [manualBuildings, setManualBuildings] = useState<ManualBuilding[]>([]);
  const [buildingGroups, setBuildingGroups] = useState<BuildingGroup[]>([]);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<number | null>>(new Set());
  const [checkedBldgIds, setCheckedBldgIds] = useState<Set<number>>(new Set());
  const [radarFiles, setRadarFiles] = useState<Map<string, string[]>>(new Map());
  const [analysisMonth, setAnalysisMonth] = useState(() => format(new Date(), "yyyy-MM"));
  const [analyzing, setAnalyzing] = useState(false);
  const [progress, setProgress] = useState("");
  const [progressPct, setProgressPct] = useState(0);

  useEffect(() => {
    invoke<ManualBuilding[]>("list_manual_buildings").then(setManualBuildings).catch(() => {});
    invoke<BuildingGroup[]>("list_building_groups").then(setBuildingGroups).catch(() => {});
  }, []);

  const selectedRadars = customRadarSites.filter((r) => checkedRadars.has(r.name));
  const selectedBuildings = manualBuildings.filter((b) => checkedBldgIds.has(b.id));

  const handleSelectFiles = useCallback(async (radarName: string) => {
    const result = await open({
      multiple: true,
      filters: [{ name: "ASS Files", extensions: ["ass", "ASS"] }],
    });
    if (result && Array.isArray(result)) {
      setRadarFiles((prev) => {
        const next = new Map(prev);
        next.set(radarName, result.map((r) => typeof r === "string" ? r : r));
        return next;
      });
    }
  }, []);

  const handleAnalyze = useCallback(async () => {
    if (analyzing) return;
    setAnalyzing(true);
    setProgress("분석 준비 중...");
    setProgressPct(0);

    let unlistenFn: (() => void) | null = null;
    try {
      unlistenFn = await listen<ObstacleMonthlyProgress>("pre-screening-progress", (e) => {
        setProgress(e.payload.message);
        if (e.payload.total > 0) {
          setProgressPct(Math.round((e.payload.current / e.payload.total) * 100));
        }
      });

      const excludeMs = aircraft.map((a) => a.mode_s_code).filter(Boolean);

      // 방위 구간 계산
      const azSectorsByRadar = new Map<string, AzSector[]>();
      for (const r of selectedRadars) {
        const sectors = selectedBuildings.map((b) => calcBuildingAzExtent(r.latitude, r.longitude, b));
        azSectorsByRadar.set(r.name, mergeAzSectors(sectors));
      }

      const radarFileSets = selectedRadars.map((r) => ({
        radar_name: r.name,
        radar_lat: r.latitude,
        radar_lon: r.longitude,
        radar_altitude: r.altitude,
        antenna_height: r.antenna_height,
        file_paths: radarFiles.get(r.name) ?? [],
        azimuth_sectors: azSectorsByRadar.get(r.name) ?? [],
      }));

      // 제안 건물 정보
      const proposedBuildings = selectedBuildings.map((b) => ({
        id: b.id,
        name: b.name || `건물 ${b.id}`,
        latitude: b.latitude,
        longitude: b.longitude,
        height_m: b.height,
        ground_elev_m: b.ground_elev,
      }));

      const result = await invoke<PreScreeningResult>("analyze_pre_screening", {
        radarFileSets,
        proposedBuildings,
        excludeModeS: excludeMs,
      });

      // LoS 분석
      setProgress("LoS 분석 중...");
      const losMap = new Map<string, LoSProfileData>();
      for (const radar of selectedRadars) {
        const radarHeight = radar.altitude + radar.antenna_height;
        for (const bldg of selectedBuildings) {
          try {
            const samples = 150;
            const lats: number[] = [];
            const lons: number[] = [];
            for (let i = 0; i <= samples; i++) {
              const t = i / samples;
              lats.push(radar.latitude + (bldg.latitude - radar.latitude) * t);
              lons.push(radar.longitude + (bldg.longitude - radar.longitude) * t);
            }
            const [elevations, pathBuildings] = await Promise.all([
              invoke<number[]>("fetch_elevation", { latitudes: lats, longitudes: lons }),
              invoke<{ distance_km: number; height_m: number; ground_elev_m: number; total_height_m: number; name: string | null; address: string | null }[]>(
                "query_buildings_along_path",
                { radarLat: radar.latitude, radarLon: radar.longitude, targetLat: bldg.latitude, targetLon: bldg.longitude, corridorWidthM: 200 },
              ),
            ]);
            const totalDist = Math.sqrt(
              ((bldg.latitude - radar.latitude) * 111320) ** 2 +
              ((bldg.longitude - radar.longitude) * 111320 * Math.cos(radar.latitude * Math.PI / 180)) ** 2,
            ) / 1000;

            const combinedElev = [...elevations];
            for (const pb of pathBuildings) {
              const sampleIdx = Math.round((pb.distance_km / totalDist) * samples);
              if (sampleIdx >= 0 && sampleIdx < combinedElev.length) {
                const bldgTop = pb.ground_elev_m + pb.height_m;
                if (bldgTop > combinedElev[sampleIdx]) combinedElev[sampleIdx] = bldgTop;
              }
            }

            const R = 6371000;
            const Reff = R * 4 / 3;
            const targetElev = bldg.ground_elev + bldg.height;
            let blocked = false;
            let maxBlockDist = 0, maxBlockElev = -Infinity, maxBlockName = "";
            for (let i = 1; i < combinedElev.length; i++) {
              const d = (i / samples) * totalDist * 1000;
              const t = i / samples;
              const losHeight = radarHeight * (1 - t) + targetElev * t;
              const curvDrop = (d * d) / (2 * Reff);
              const terrainAdjusted = combinedElev[i] + curvDrop;
              if (terrainAdjusted > losHeight) {
                blocked = true;
                if (terrainAdjusted > maxBlockElev) {
                  maxBlockElev = terrainAdjusted;
                  maxBlockDist = t * totalDist;
                  const nearBldg = pathBuildings.find((pb) => Math.abs(pb.distance_km - maxBlockDist) < 0.5);
                  maxBlockName = nearBldg?.name ?? nearBldg?.address ?? "";
                }
              }
            }
            if (maxBlockElev === -Infinity) blocked = false;

            const bearing = ((Math.atan2(
              (bldg.longitude - radar.longitude) * Math.cos(radar.latitude * Math.PI / 180),
              bldg.latitude - radar.latitude,
            ) * 180) / Math.PI + 360) % 360;

            const elevProfile = combinedElev.map((elev, idx) => ({
              distance: (idx / samples) * totalDist,
              elevation: elev,
              latitude: lats[idx],
              longitude: lons[idx],
            }));
            losMap.set(`${radar.name}_${bldg.id}`, {
              id: `ps_${radar.name}_${bldg.id}`,
              radarSiteName: radar.name,
              radarLat: radar.latitude,
              radarLon: radar.longitude,
              radarHeight,
              targetLat: bldg.latitude,
              targetLon: bldg.longitude,
              bearing,
              totalDistance: totalDist,
              elevationProfile: elevProfile,
              losBlocked: blocked,
              maxBlockingPoint: blocked ? { distance: maxBlockDist, elevation: maxBlockElev, name: maxBlockName } : undefined,
              timestamp: Date.now(),
            });
          } catch (err) {
            console.warn(`LoS 계산 실패: ${radar.name}→${bldg.name}:`, err);
          }
        }
      }

      onGenerate(result, selectedBuildings, selectedRadars, losMap, [], [], analysisMonth);

      // 커버리지 백그라운드 계산
      if (selectedRadars.length > 0) {
        const r = selectedRadars[0];
        const altFts = [1000, 2000, 3000, 5000, 10000, 15000, 20000, 25000, 30000];
        const excludeIds = selectedBuildings.map((b) => b.id);
        import("../utils/gpuCoverage").then(({ computeCoverageLayersOM }) =>
          computeCoverageLayersOM(
            {
              radarName: r.name,
              radarLat: r.latitude,
              radarLon: r.longitude,
              radarAltitude: r.altitude,
              antennaHeight: r.antenna_height,
              rangeNm: r.range_nm,
              bearingStepDeg: 0.01,
            },
            altFts,
            excludeIds,
          ).then(({ layersWith, layersWithout }) => {
            onCoverageReady(layersWith, layersWithout);
          }).catch((err) => console.warn("커버리지 계산 실패:", err)),
        );
      }
    } catch (err) {
      setProgress(`오류: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      unlistenFn?.();
      setAnalyzing(false);
    }
  }, [analyzing, selectedRadars, selectedBuildings, radarFiles, aircraft, onGenerate, analysisMonth]);

  const allFilesSelected = selectedRadars.every((r) => (radarFiles.get(r.name)?.length ?? 0) > 0);
  const canAnalyze = selectedRadars.length > 0 && selectedBuildings.length > 0 && allFilesSelected && !analyzing;

  return (
    <Modal open onClose={onClose} title="장애물 전파영향 사전검토 설정" width="max-w-3xl">
      <div className="space-y-5">
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="grid grid-cols-2 gap-x-6 gap-y-1.5 text-[12px]">
            <div className="flex justify-between">
              <span className="text-gray-400">기관</span>
              <span className="font-medium text-gray-700">{metadata.organization}</span>
            </div>
          </div>
        </div>

        {/* 분석월 */}
        <div className="rounded-lg border border-gray-200 bg-gray-50 p-3">
          <div className="flex items-center gap-3 text-[12px]">
            <span className="font-semibold text-gray-700">분석월</span>
            <MonthPicker value={analysisMonth} onChange={setAnalysisMonth} />
            <span className="text-[10px] text-gray-400">한달분 ASS 데이터를 선택하세요</span>
          </div>
        </div>

        {/* 1단계: 레이더 선택 */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">
            1. 레이더 선택 <span className="text-[11px] font-normal text-gray-400">(필수)</span>
          </h3>
          <div className="space-y-1 rounded-lg border border-gray-200 p-2">
            {customRadarSites.map((r) => {
              const checked = checkedRadars.has(r.name);
              return (
                <button
                  key={r.name}
                  onClick={() => setCheckedRadars((prev) => {
                    const next = new Set(prev);
                    if (next.has(r.name)) next.delete(r.name);
                    else next.add(r.name);
                    return next;
                  })}
                  className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-2 text-left transition-all ${
                    checked ? "border-[#a60739] bg-[#a60739] text-white" : "border-gray-100 hover:border-gray-200"
                  }`}
                >
                  {checked
                    ? <CheckSquare size={14} className="shrink-0 text-white" />
                    : <Square size={14} className="shrink-0 text-gray-300" />
                  }
                  <span className={`text-[12px] font-medium ${checked ? "text-white" : "text-gray-500"}`}>
                    {r.name}
                  </span>
                  <span className={`ml-auto text-[10px] ${checked ? "text-white/70" : "text-gray-400"}`}>
                    {r.latitude.toFixed(4)}°N {r.longitude.toFixed(4)}°E
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* 2단계: 제안 건물 선택 */}
        <div>
          <h3 className="mb-2 text-sm font-semibold text-gray-700">
            2. 검토 대상 건물 선택 <span className="text-[11px] font-normal text-gray-400">(수동 건물, 복수 가능)</span>
          </h3>
          {manualBuildings.length === 0 ? (
            <p className="text-xs text-gray-400">등록된 수동 건물이 없습니다. 그리기 도구에서 건물을 먼저 등록하세요.</p>
          ) : (
            <>
              <div className="mb-1 flex gap-2 text-[11px]">
                <button onClick={() => setCheckedBldgIds(new Set(manualBuildings.map((b) => b.id)))} className="text-[#a60739] hover:underline">전체 선택</button>
                <button onClick={() => setCheckedBldgIds(new Set())} className="text-gray-400 hover:underline">전체 해제</button>
              </div>
              <div className="max-h-52 space-y-0.5 overflow-y-auto rounded-lg border border-gray-200 p-2">
                {(() => {
                  const groupMap = new Map<number | null, ManualBuilding[]>();
                  for (const b of manualBuildings) {
                    const gid = b.group_id ?? null;
                    if (!groupMap.has(gid)) groupMap.set(gid, []);
                    groupMap.get(gid)!.push(b);
                  }
                  const orderedKeys: (number | null)[] = [
                    ...buildingGroups.map((g) => g.id).filter((id) => groupMap.has(id)),
                    ...(groupMap.has(null) ? [null as number | null] : []),
                    ...[...groupMap.keys()].filter((k) => k !== null && !buildingGroups.find((g) => g.id === k)),
                  ];

                  const renderBuilding = (b: ManualBuilding) => {
                    const checked = checkedBldgIds.has(b.id);
                    return (
                      <button
                        key={b.id}
                        onClick={() => setCheckedBldgIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(b.id)) next.delete(b.id);
                          else next.add(b.id);
                          return next;
                        })}
                        className={`flex w-full items-center gap-2.5 rounded-md border px-3 py-1.5 text-left transition-all ${
                          checked ? "border-[#a60739] bg-[#a60739] text-white" : "border-gray-100 hover:border-gray-200"
                        }`}
                      >
                        {checked
                          ? <CheckSquare size={14} className="shrink-0 text-white" />
                          : <Square size={14} className="shrink-0 text-gray-300" />
                        }
                        <div className="min-w-0 flex-1">
                          <span className={`text-[12px] font-medium ${checked ? "text-white" : "text-gray-500"}`}>
                            {b.name || `건물 ${b.id}`}
                          </span>
                          <span className={`ml-2 text-[10px] ${checked ? "text-white/70" : "text-gray-400"}`}>{b.height.toFixed(0)}m · {b.geometry_type}</span>
                        </div>
                      </button>
                    );
                  };

                  return orderedKeys.map((gid) => {
                    const buildings = groupMap.get(gid) ?? [];
                    if (buildings.length === 0) return null;
                    const group = gid !== null ? buildingGroups.find((g) => g.id === gid) : null;
                    const groupName = group?.name ?? (gid !== null ? `그룹 ${gid}` : "미분류");
                    const groupColor = group?.color ?? "#9ca3af";
                    const collapsed = collapsedGroups.has(gid);
                    const groupBldgIds = buildings.map((b) => b.id);
                    const allChecked = groupBldgIds.every((id) => checkedBldgIds.has(id));
                    const someChecked = groupBldgIds.some((id) => checkedBldgIds.has(id));

                    return (
                      <div key={gid ?? "ungrouped"} className="mb-1">
                        <div className="flex items-center gap-1">
                          {/* 그룹 체크박스 — 그룹 전체 선택/해제 */}
                          <button
                            onClick={() => setCheckedBldgIds((prev) => {
                              const next = new Set(prev);
                              if (allChecked) groupBldgIds.forEach((id) => next.delete(id));
                              else groupBldgIds.forEach((id) => next.add(id));
                              return next;
                            })}
                            className="shrink-0 p-0.5"
                          >
                            {allChecked
                              ? <CheckSquare size={14} className="text-[#a60739]" />
                              : someChecked
                              ? <MinusSquare size={14} className="text-[#a60739]/50" />
                              : <Square size={14} className="text-gray-300" />
                            }
                          </button>
                          <button
                            onClick={() => setCollapsedGroups((prev) => {
                              const next = new Set(prev);
                              if (next.has(gid)) next.delete(gid);
                              else next.add(gid);
                              return next;
                            })}
                            className="flex items-center gap-1 rounded px-1 py-0.5 text-[11px] font-semibold text-gray-600 hover:bg-gray-100"
                          >
                            {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
                            <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ backgroundColor: groupColor }} />
                            <span>{groupName}</span>
                            <span className="ml-1 font-normal text-gray-400">({buildings.length})</span>
                          </button>
                        </div>
                        {!collapsed && (
                          <div className="ml-6 mt-0.5 space-y-0.5">
                            {buildings.map(renderBuilding)}
                          </div>
                        )}
                      </div>
                    );
                  });
                })()}
              </div>
            </>
          )}
        </div>

        {/* 3단계: 파일 선택 */}
        {selectedRadars.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-700">
              3. 레이더별 ASS 파일 선택 <span className="text-[11px] font-normal text-gray-400">(한달분)</span>
            </h3>
            <div className="space-y-2">
              {selectedRadars.map((r) => {
                const files = radarFiles.get(r.name) ?? [];
                return (
                  <div key={r.name} className="rounded-lg border border-gray-200 p-3">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-semibold text-gray-700">📡 {r.name}</span>
                      <button
                        onClick={() => handleSelectFiles(r.name)}
                        className="rounded-md bg-gray-100 px-3 py-1 text-[11px] text-gray-600 hover:bg-gray-200 transition-colors"
                      >
                        📂 파일 선택
                      </button>
                    </div>
                    {files.length > 0 && (
                      <p className="mt-1 text-[10px] text-gray-500">{files.length}개 파일 선택됨</p>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* 진행 */}
        {analyzing && (
          <div className="rounded-lg border border-[#a60739]/20 bg-[#a60739]/5 p-3">
            <div className="flex items-center gap-2">
              <Loader2 size={14} className="animate-spin text-[#a60739]" />
              <span className="text-[12px] text-gray-700">{progress}</span>
            </div>
            <div className="mt-2 h-2 rounded-full bg-gray-200">
              <div className="h-full rounded-full bg-[#a60739] transition-all" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        )}

        {/* 버튼 */}
        <div className="flex items-center justify-end gap-2 pt-1">
          <button onClick={onClose} className="rounded-lg border border-gray-200 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 transition-colors">
            취소
          </button>
          <button
            onClick={handleAnalyze}
            disabled={!canAnalyze}
            className="flex items-center gap-2 rounded-lg bg-[#a60739] px-5 py-2 text-sm font-medium text-white transition-colors hover:bg-[#85062e] disabled:opacity-40"
          >
            <BarChart3 size={14} />
            분석 시작
          </button>
        </div>
      </div>
    </Modal>
  );
}
