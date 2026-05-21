import { useState, useMemo, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import MapGL, { NavigationControl, type MapRef } from "react-map-gl/maplibre";
import type maplibregl from "maplibre-gl";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { PathLayer, ScatterplotLayer, LineLayer, IconLayer, BitmapLayer } from "@deck.gl/layers";
import {
  Mountain,
  Crosshair,
  ChevronDown,
  Radar,
  Plane,
  Loader2,
  Building2,
  X,
  Search,
  MapPin,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

/** 항적선 아이콘 (꺾인 경로선) */
const TrackLineIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="2,12 6,5 10,9 14,3" />
  </svg>
);


import { format } from "date-fns";
import { useAppStore } from "../store";
import type { TrackPoint, LossSegment, LossPoint, Building3D } from "../types";
import { queryViewportPoints } from "../utils/flightConsolidationWorker";
import LoSProfilePanel from "../components/Map/LoSProfilePanel";
import { isGPUCacheValidFor, renderCoverageImageAsync, queryMinDetectionAlt, COVERAGE_MIN_ALT_FT, COVERAGE_MAX_ALT_FT, COVERAGE_ALT_STEP_FT } from "../utils/radarCoverage";
import { GPU2D, type RectData } from "../utils/gpu2d";
import { addPlanOverlay, removePlanOverlay, updatePlanOpacity, updatePlanBounds, rotateBounds } from "../utils/planOverlay";
import { fetchBuildingsForViewport, invalidateBuildingCache, buildingsToGeoJSON } from "../utils/buildingTileCache";
import { detectionTypeColor, radarTypeLabel, MAP_STYLE_URL } from "../utils/radarConstants";
import AddressSearch, { AddressMarker } from "../components/Map/AddressSearch";
import PlaybackControls from "../components/Map/PlaybackControls";
import CoveragePanel from "../components/Map/CoveragePanel";

/** 전체 항적 표시 시 최대 선택 가능 윈도우 (초) = 24시간 */
const MAX_WINDOW_SECS = 86400;

/** 방위 선택 원형 컨트롤 */
function AzimuthCircle({ azimuth, onChange, disabled }: { azimuth: number; onChange: (az: number) => void; disabled?: boolean }) {
  const svgRef = useRef<SVGSVGElement>(null);
  const size = 72;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - 8;

  const calcAngle = useCallback((e: React.MouseEvent | MouseEvent) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const x = e.clientX - rect.left - cx;
    const y = e.clientY - rect.top - cy;
    return ((Math.atan2(x, -y) * 180 / Math.PI) + 360) % 360;
  }, [cx, cy]);

  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    if (disabled) return;
    const a = calcAngle(e);
    if (a !== undefined) onChange(Math.round(a));
    const onMove = (ev: MouseEvent) => {
      const a2 = calcAngle(ev);
      if (a2 !== undefined) onChange(Math.round(a2));
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [calcAngle, onChange, disabled]);

  const azRad = azimuth * Math.PI / 180;
  const nx = cx + Math.sin(azRad) * r * 0.78;
  const ny = cy - Math.cos(azRad) * r * 0.78;

  return (
    <svg ref={svgRef} width={size} height={size} className={`shrink-0 ${disabled ? "opacity-40" : "cursor-pointer"}`} onMouseDown={handleMouseDown}>
      <circle cx={cx} cy={cy} r={r} fill="none" stroke="#d1d5db" strokeWidth="1" />
      {/* 눈금 (30° 간격) */}
      {Array.from({ length: 12 }, (_, i) => {
        const a = i * 30 * Math.PI / 180;
        const inner = r - 3;
        return <line key={i} x1={cx + Math.sin(a) * inner} y1={cy - Math.cos(a) * inner} x2={cx + Math.sin(a) * r} y2={cy - Math.cos(a) * r} stroke="#d1d5db" strokeWidth="0.8" />;
      })}
      <text x={cx} y={9} textAnchor="middle" className="text-[7px] fill-gray-400 select-none font-medium">N</text>
      <text x={size - 4} y={cy + 2.5} textAnchor="middle" className="text-[7px] fill-gray-400 select-none font-medium">E</text>
      <text x={cx} y={size - 2} textAnchor="middle" className="text-[7px] fill-gray-400 select-none font-medium">S</text>
      <text x={5} y={cy + 2.5} textAnchor="middle" className="text-[7px] fill-gray-400 select-none font-medium">W</text>
      <circle cx={cx} cy={cy} r="1.5" fill="#a60739" />
      <line x1={cx} y1={cy} x2={nx} y2={ny} stroke="#a60739" strokeWidth="1.5" strokeLinecap="round" />
      <circle cx={nx} cy={ny} r="3" fill="#a60739" />
    </svg>
  );
}

/** LoS 분석용 인라인 주소 검색 */
function LosAddressSearch({ onSelect }: { onSelect: (lat: number, lon: number) => void }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ display_name: string; sub_addr?: string; lat: number; lon: number }[]>([]);
  const [searching, setSearching] = useState(false);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const search = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    setSearching(true);
    try {
      const res = await invoke<{ address: string; building_name: string; latitude: number; longitude: number; result_type: string }[]>(
        "search_vworld_address", { query: q, limit: 5 },
      );
      setResults(res.map((r) => ({
        display_name: r.result_type === "place" && r.building_name ? r.building_name : r.address,
        sub_addr: r.result_type === "place" ? r.address : (r.building_name || ""),
        lat: r.latitude,
        lon: r.longitude,
      })));
    } catch {
      setResults([]);
    } finally {
      setSearching(false);
    }
  }, []);

  const handleInput = useCallback((value: string) => {
    setQuery(value);
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => search(value), 400);
  }, [search]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  return (
    <div ref={ref} className="relative flex-1 min-w-0">
      <div className="flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1">
        <Search size={11} className="shrink-0 text-gray-400" />
        <input
          type="text" value={query}
          onChange={(e) => { handleInput(e.target.value); setOpen(true); }}
          onFocus={() => { if (results.length > 0) setOpen(true); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); search(query); setOpen(true); }
            if (e.key === "Escape") setOpen(false);
          }}
          placeholder="주소/건물명 검색..."
          className="flex-1 min-w-0 bg-transparent text-[11px] text-gray-700 outline-none placeholder:text-gray-400"
        />
        {searching && <Loader2 size={10} className="animate-spin text-gray-400" />}
        {query && !searching && (
          <button onClick={() => { setQuery(""); setResults([]); setOpen(false); }} className="text-gray-400 hover:text-gray-600">
            <X size={10} />
          </button>
        )}
      </div>
      {open && results.length > 0 && (
        <div className="absolute left-0 right-0 mt-1 max-h-[150px] overflow-y-auto rounded-md border border-gray-200 bg-white shadow-lg z-10">
          {results.map((r, i) => (
            <button
              key={i}
              onClick={() => { onSelect(r.lat, r.lon); setQuery(r.display_name); setOpen(false); }}
              className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left text-[11px] text-gray-700 hover:bg-gray-50"
            >
              <MapPin size={10} className="mt-0.5 shrink-0 text-[#a60739]" />
              <div className="min-w-0">
                <span className="line-clamp-1">{r.display_name}</span>
                {r.sub_addr && <div className="text-[9px] text-gray-400 line-clamp-1">{r.sub_addr}</div>}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

interface TrackPath {
  modeS: string;
  radarType: string;
  path: ([number, number] | [number, number, number])[];
  color: [number, number, number];
  avgAlt: number;
  pointCount: number;
}

export default function TrackMap() {
  const flights = useAppStore((s) => s.flights);
  const consolidating = useAppStore((s) => s.consolidating);
  const consolidationProgress = useAppStore((s) => s.consolidationProgress);
  const aircraft = useAppStore((s) => s.aircraft);
  const radarSite = useAppStore((s) => s.radarSite);
  const setRadarSite = useAppStore((s) => s.setRadarSite);
  const customRadarSites = useAppStore((s) => s.customRadarSites);
  const selectedModeS = useAppStore((s) => s.selectedModeS);
  const setSelectedModeS = useAppStore((s) => s.setSelectedModeS);
  const selectedFlightId = useAppStore((s) => s.selectedFlightId);
  const setSelectedFlightId = useAppStore((s) => s.setSelectedFlightId);

  const [portalReady, setPortalReady] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  useEffect(() => {
    // 포탈 타겟이 DOM에 마운트된 후 렌더링
    if (document.getElementById("trackmap-sidebar")) setPortalReady(true);
    else {
      const id = requestAnimationFrame(() => setPortalReady(!!document.getElementById("trackmap-sidebar")));
      return () => cancelAnimationFrame(id);
    }
  }, []);

  const [sliderValue, setSliderValue] = useState(100);
  const [playing, setPlaying] = useState(false);
  const altScale = 1;
  const [trackLine, setTrackLine] = useState(true);
  const [hiddenLegendItems, setHiddenLegendItems] = useState<Set<string>>(new Set());
  const [showBuildings, setShowBuildings] = useState(false);
  const [buildingsLoading, setBuildingsLoading] = useState(false);
  const [buildings3dData, setBuildings3dData] = useState<Building3D[]>([]);
  /** 건물 3D↔점 전환 경계 (줌 15+: 3D, 14 이하: 점) */
  const [buildings3dMode, setBuildings3dMode] = useState(false);
  /** 비활성화된 건물 출처 (건물통합정보/수동 개별 토글) */
  const [hiddenBuildingSources, setHiddenBuildingSources] = useState<Set<string>>(new Set());
  const [losBuildingHighlight, setLosBuildingHighlight] = useState<{ lat: number; lon: number; height_m: number; name: string | null; address: string | null; usage: string | null } | null>(null);
  const [detailBuilding, setDetailBuilding] = useState<{ lat: number; lon: number; height_m: number; ground_elev_m: number; name: string | null; address: string | null; usage: string | null; distance_km: number; isBlocking?: boolean } | null>(null);
  // 건물 클릭 시 VWorld 건축물정보 팝업
  const [bldgPopup, setBldgPopup] = useState<{
    x: number; y: number; lat: number; lon: number;
    loading: boolean;
    info: {
      name: string; dong_name: string; road_addr: string; jibun_addr: string;
      usage: string; structure: string; floors_above: string; floors_below: string;
      height: string; area: string; total_area: string; site_area: string;
      floor_area_ratio: string; building_coverage: string; approval_date: string;
    } | null;
    localName?: string; localHeight?: number; localUsage?: string;
    /** true: 클릭으로 고정됨 (호버로 닫히지 않음) */
    pinned: boolean;
  } | null>(null);
  /** 호버 디바운스 타이머 — 250ms 머무르면 팝업 표시 */
  const bldgHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showBldgPopupForHover = useCallback((args: {
    x: number; y: number; lat: number; lon: number;
    name?: string; height?: number; usage?: string;
  }) => {
    setBldgPopup((prev) => {
      if (prev?.pinned) return prev;
      // 같은 좌표면 위치만 갱신
      if (prev && Math.abs(prev.lat - args.lat) < 1e-6 && Math.abs(prev.lon - args.lon) < 1e-6) {
        return { ...prev, x: args.x, y: args.y };
      }
      return {
        x: args.x, y: args.y, lat: args.lat, lon: args.lon,
        loading: true, info: null,
        localName: args.name, localHeight: args.height, localUsage: args.usage,
        pinned: false,
      };
    });
  }, []);
  const scheduleBldgHover = useCallback((args: {
    x: number; y: number; lat: number; lon: number;
    name?: string; height?: number; usage?: string;
  }) => {
    if (bldgHoverTimerRef.current) clearTimeout(bldgHoverTimerRef.current);
    bldgHoverTimerRef.current = setTimeout(() => showBldgPopupForHover(args), 220);
  }, [showBldgPopupForHover]);
  const clearBldgHover = useCallback(() => {
    if (bldgHoverTimerRef.current) { clearTimeout(bldgHoverTimerRef.current); bldgHoverTimerRef.current = null; }
    setBldgPopup((prev) => (prev && !prev.pinned ? null : prev));
  }, []);
  const [rangeStart, setRangeStart] = useState(0);
  /** 재생 모드 트레일 길이 (초). 0=전체 표시, >0=최근 N초만 표시 */
  const [trailDuration, setTrailDuration] = useState(0);

  // bldgPopup 좌표 설정 시 VWorld 건물정보 조회
  useEffect(() => {
    if (!bldgPopup || !bldgPopup.loading) return;
    let cancelled = false;
    invoke<typeof bldgPopup.info>("get_vworld_building_info", { lat: bldgPopup.lat, lon: bldgPopup.lon })
      .then((res) => { if (!cancelled) setBldgPopup((prev) => prev ? { ...prev, loading: false, info: res ?? null } : null); })
      .catch(() => { if (!cancelled) setBldgPopup((prev) => prev ? { ...prev, loading: false, info: null } : null); });
    return () => { cancelled = true; };
  }, [bldgPopup?.lat, bldgPopup?.lon]); // eslint-disable-line react-hooks/exhaustive-deps

  // 비행 선택 시 시간 바 리셋 (전체 범위 표시)
  useEffect(() => {
    setSliderValue(100);
    setRangeStart(0);
    setPlaying(false);
  }, [selectedFlightId]);
  const [hoverInfo, setHoverInfo] = useState<{
    x: number;
    y: number;
    lines: { label: string; value: string; color?: string }[];
  } | null>(null);
  const [terrainEnabled, setTerrainEnabled] = useState(true);
  const [modeSSearch, setModeSSearch] = useState("");
  const [aircraftDropOpen, setAircraftDropOpen] = useState(false);
  const [radarDropOpen, setRadarDropOpen] = useState(false);

  // 레이더 커버리지
  const [coverageAlt, setCoverageAlt] = useState(COVERAGE_MAX_ALT_FT);
  const [coverageAltMin, setCoverageAltMin] = useState(COVERAGE_MIN_ALT_FT);
  const [gpuCacheReady, setGpuCacheReady] = useState(false);
  const [coverageImage, setCoverageImage] = useState<ImageBitmap | null>(null);
  const [coverageBounds, setCoverageBounds] = useState<[number, number, number, number] | null>(null);
  const [coverageUsedAlts, setCoverageUsedAlts] = useState<number[]>([]);
  const coverageVisible = useAppStore((s) => s.coverageVisible);
  const coverageLoading = useAppStore((s) => s.coverageLoading);
  const [showConeOfSilence, _setShowConeOfSilence] = useState(true);
  const [coverageOpacity, setCoverageOpacity] = useState(0.55);
  const [coverageRendering, setCoverageRendering] = useState(false);
  const [coverageTooltip, setCoverageTooltip] = useState<{ x: number; y: number; altFt: number | null; loading: boolean } | null>(null);
  const coverageTooltipTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const coverageTooltipSeqRef = useRef(0);


  // 파노라마 장애물 맵 하이라이트 (전역 스토어)
  const panoramaViewActive = useAppStore((s) => s.panoramaViewActive);
  const panoramaActivePoint = useAppStore((s) => s.panoramaActivePoint);
  const panoramaPinned = useAppStore((s) => s.panoramaPinned);

  // LoS Analysis state
  const [losMode, setLosMode] = useState(false);
  const [losTarget, setLosTarget] = useState<{ lat: number; lon: number } | null>(null);
  const [losCursor, setLosCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [losHoverRatio, setLosHoverRatio] = useState<number | null>(null);
  const [losHighlightIdx, setLosHighlightIdx] = useState<number | null>(null);
  const [losHoverIdx, setLosHoverIdx] = useState<number | null>(null);
  // 주소 검색으로 LoS 분석 시작한 경우, 해당 좌표를 단면도에 전달해 건물 선택 표시
  const [losSearchedAddress, setLosSearchedAddress] = useState<{ lat: number; lon: number } | null>(null);
  const savedPitchRef = useRef(45);
  const savedBearingRef = useRef(0);
  const losPointClickedRef = useRef(false); // deck.gl LoS 포인트 클릭 여부 (빈 영역 클릭 구분용)
  const [losExpanded, setLosExpanded] = useState(false);
  const [losCursorPicking, setLosCursorPicking] = useState(false);
  const [coverageExpanded, setCoverageExpanded] = useState(false);

  const mapRef = useRef<MapRef>(null);
  const terrainAdded = useRef(false);
  const aircraftDropRef = useRef<HTMLDivElement>(null);
  const radarDropRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  const prevPointsLen = useRef(0);
  const allPointsRef = useRef<TrackPoint[]>([]);

  // 주소 검색 마커 (AddressSearch 컴포넌트에서 관리, 마커만 부모에서 유지)
  const [addressMarker, setAddressMarker] = useState<{ lat: number; lon: number; label: string } | null>(null);
  const handleAddressSelect = useCallback((lat: number, lon: number, label: string) => {
    if (lat !== 0 && lon !== 0) {
      setViewState((v) => ({ ...v, latitude: lat, longitude: lon, zoom: 15 }));
      setAddressMarker({ lat, lon, label });
    } else {
      setAddressMarker(null);
    }
  }, []);

  // 선택된 레이더용 비행만 필터 (radar_name이 없는 레거시 데이터는 항상 표시)
  const radarFilteredFlights = useMemo(() => {
    const name = radarSite.name;
    return flights.filter((f) => !f.radar_name || f.radar_name === name);
  }, [flights, radarSite.name]);

  // 레이더 정보
  const radarInfo = useMemo(() => {
    if (radarFilteredFlights.length === 0) {
      // 비행 없어도 radarSite에서 직접 생성 (동심원/라벨 표시용)
      return {
        lat: radarSite.latitude,
        lon: radarSite.longitude,
        maxRange: radarSite.range_nm > 0 ? radarSite.range_nm * 1.852 : 200,
        rangeNm: radarSite.range_nm,
        name: radarSite.name,
      };
    }
    let maxRange = 0;
    for (const f of radarFilteredFlights) if (f.max_radar_range_km > maxRange) maxRange = f.max_radar_range_km;
    const rangeKm = radarSite.range_nm > 0
      ? radarSite.range_nm * 1.852
      : maxRange;
    return {
      lat: radarSite.latitude,
      lon: radarSite.longitude,
      maxRange: rangeKm,
      rangeNm: radarSite.range_nm,
      name: radarSite.name,
    };
  }, [radarFilteredFlights, radarSite]);

  // 비정상 항적 제거용: Mode-S별 포인트 수 카운트 (메타데이터 기반)
  const validModeS = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of radarFilteredFlights) {
      counts.set(f.mode_s, (counts.get(f.mode_s) ?? 0) + f.point_count);
    }
    return new Set(
      Array.from(counts.entries())
        .filter(([, count]) => count >= 10)
        .map(([ms]) => ms)
    );
  }, [radarFilteredFlights]);

  // 등록된 비행검사기 Mode-S 코드 집합
  const registeredModeS = useMemo(
    () => new Set(aircraft.filter((a) => a.active).map((a) => a.mode_s_code.toUpperCase())),
    [aircraft]
  );

  // 전체 포인트/Loss 합산 (비정상 항적 + UNKNOWN 제거)
  // 각 비행 내 포인트는 이미 시간순 — 전역 정렬 불필요, 청크 concat
  type AllPointsResult = { allPoints: TrackPoint[]; allLoss: LossSegment[]; allLossPoints: LossPoint[]; paddedTimeRange?: { min: number; max: number }; computedTimeRange?: { min: number; max: number } };
  const [allPointsState, setAllPointsState] = useState<AllPointsResult>({ allPoints: [], allLoss: [], allLossPoints: [] });

  // 렌더링 진행률 (쿼리 + 경로빌드)
  const [renderProgress, setRenderProgress] = useState<{ stage: "query" | "paths"; current: number; total: number } | null>(null);

  useEffect(() => {
    let cancelled = false;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const compute = async () => {
      // 통합 진행 중이면 비행 데이터 불완전 → 쿼리 스킵
      if (consolidating && radarFilteredFlights.length === 0) return;

      // Loss 데이터는 Flight 메타에 포함 (작은 배열, 메인에서 직접 필터)
      const loss: LossSegment[] = [];
      const lossP: LossPoint[] = [];

      // Worker 쿼리 파라미터 결정
      const registeredMS = Array.from(registeredModeS);
      let timeRange: [number, number] | undefined;
      let queryModeS: string | null | undefined = selectedModeS;
      let paddedTimeRange: { min: number; max: number } | undefined;

      if (selectedFlightId) {
        const targetFlight = radarFilteredFlights.find((f) => f.id === selectedFlightId);
        if (targetFlight) {
          const padding = 3600;
          timeRange = [targetFlight.start_time - padding, targetFlight.end_time + padding];
          queryModeS = targetFlight.mode_s;
          paddedTimeRange = { min: timeRange[0], max: timeRange[1] };
          // Loss 필터
          for (const f of radarFilteredFlights) {
            for (const s of f.loss_segments) {
              if (validModeS.has(s.mode_s) && s.mode_s === queryModeS && s.start_time >= timeRange[0] && s.end_time <= timeRange[1]) loss.push(s);
            }
            for (const p of f.loss_points) {
              if (validModeS.has(p.mode_s) && p.mode_s === queryModeS && p.timestamp >= timeRange[0] && p.timestamp <= timeRange[1]) lossP.push(p);
            }
          }
        }
      } else {
        // 일반 필터: Loss 데이터 수집
        const showAll = selectedModeS === "__ALL__";
        for (const f of radarFilteredFlights) {
          for (const s of f.loss_segments) {
            if (showAll) { if (validModeS.has(s.mode_s)) loss.push(s); }
            else if (!selectedModeS) { if (validModeS.has(s.mode_s) && registeredModeS.has(s.mode_s.toUpperCase())) loss.push(s); }
            else { if (s.mode_s === selectedModeS) loss.push(s); }
          }
          for (const p of f.loss_points) {
            if (showAll) { if (validModeS.has(p.mode_s)) lossP.push(p); }
            else if (!selectedModeS) { if (validModeS.has(p.mode_s) && registeredModeS.has(p.mode_s.toUpperCase())) lossP.push(p); }
            else { if (p.mode_s === selectedModeS) lossP.push(p); }
          }
        }
      }

      // Worker에 뷰포트 포인트 쿼리 (포인트는 Worker 소유)
      const totalPtsEst = radarFilteredFlights.reduce((s, f) => s + f.point_count, 0);
      setRenderProgress({ stage: "query", current: 0, total: totalPtsEst });
      const { points: pts } = await queryViewportPoints({
        radarName: radarSite.name,
        selectedModeS: queryModeS,
        registeredModeS: registeredMS,
        timeRange,
        paddingPoints: true,
        onProgress: (loaded) => setRenderProgress({ stage: "query", current: loaded, total: totalPtsEst }),
      });
      if (cancelled) return;

      // 시간 범위 계산 (메타데이터 기반)
      let tsMin = Infinity, tsMax = -Infinity;
      for (const f of radarFilteredFlights) {
        if (f.point_count > 0) {
          if (f.start_time < tsMin) tsMin = f.start_time;
          if (f.end_time > tsMax) tsMax = f.end_time;
        }
      }

      setAllPointsState({
        allPoints: pts,
        allLoss: loss,
        allLossPoints: lossP,
        paddedTimeRange,
        computedTimeRange: pts.length > 0 ? { min: tsMin, max: tsMax } : undefined,
      });
    };

    // 통합 진행 중에는 debounce 500ms — 빈번한 appendFlights 재계산 방지
    // 완료 후에는 즉시 실행
    if (consolidating) {
      debounceTimer = setTimeout(() => {
        if (!cancelled) compute();
      }, 500);
    } else {
      compute();
    }

    return () => {
      cancelled = true;
      if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    };
  }, [consolidating, radarFilteredFlights, radarSite.name, selectedModeS, selectedFlightId, validModeS, registeredModeS]);

  const { allPoints, allLoss, allLossPoints, paddedTimeRange, computedTimeRange } = allPointsState;
  allPointsRef.current = allPoints;

  // 고유 Mode-S 목록
  const uniqueModeS = useMemo(() => {
    const counts = new Map<string, number>();
    for (const f of radarFilteredFlights) {
      counts.set(f.mode_s, (counts.get(f.mode_s) ?? 0) + f.point_count);
    }
    const registered = new Set(aircraft.map((a) => a.mode_s_code.toUpperCase()));
    return Array.from(counts.entries())
      .filter(([, count]) => count >= 10)
      .sort(([a, ca], [b, cb]) => {
        const aReg = registered.has(a) ? 1 : 0;
        const bReg = registered.has(b) ? 1 : 0;
        if (aReg !== bReg) return bReg - aReg;
        return cb - ca;
      })
      .slice(0, 200)
      .map(([ms]) => ms);
  }, [radarFilteredFlights, aircraft]);

  // 시간 범위 (비행 선택 시 ±1시간 패딩 포함, 일반 모드는 수집 시 계산된 min/max 사용)
  const timeRange = useMemo(() => {
    if (allPoints.length === 0 && !paddedTimeRange && !computedTimeRange) return { min: 0, max: 0 };
    const pointMin = computedTimeRange?.min ?? (allPoints.length > 0 ? allPoints[0].timestamp : Infinity);
    const pointMax = computedTimeRange?.max ?? (allPoints.length > 0 ? allPoints[allPoints.length - 1].timestamp : -Infinity);
    return {
      min: paddedTimeRange ? Math.min(paddedTimeRange.min, pointMin) : pointMin,
      max: paddedTimeRange ? Math.max(paddedTimeRange.max, pointMax) : pointMax,
    };
  }, [allPoints, paddedTimeRange, computedTimeRange]);

  // 퍼센트 → 타임스탬프
  const pctToTs = useCallback(
    (pct: number) => {
      const range = timeRange.max - timeRange.min;
      return timeRange.min + (range * pct) / 100;
    },
    [timeRange]
  );

  // 전체항적 24시간 윈도우: 초 → 퍼센트 변환
  const secsToPct = useCallback(
    (secs: number) => {
      const range = timeRange.max - timeRange.min;
      return range > 0 ? (secs / range) * 100 : 100;
    },
    [timeRange]
  );

  /** 전체항적 모드에서 24시간 윈도우 적용 여부 */
  const isAllTrackMode = selectedModeS === "__ALL__" && !selectedFlightId;
  const maxWindowPct = secsToPct(MAX_WINDOW_SECS);

  // 전체항적 모드 진입 시 24시간 윈도우로 초기화
  useEffect(() => {
    if (!isAllTrackMode) return;
    const totalSecs = timeRange.max - timeRange.min;
    if (totalSecs > MAX_WINDOW_SECS) {
      // 마지막 24시간 구간으로 설정
      const startPct = Math.max(0, 100 - maxWindowPct);
      setRangeStart(startPct);
      setSliderValue(100);
    }
  }, [isAllTrackMode, timeRange.min, timeRange.max]); // eslint-disable-line react-hooks/exhaustive-deps

  // 24시간 제한 refs (드래그 클로저에서 최신값 참조용)
  const isAllTrackModeRef = useRef(isAllTrackMode);
  isAllTrackModeRef.current = isAllTrackMode;
  const maxWindowPctRef = useRef(maxWindowPct);
  maxWindowPctRef.current = maxWindowPct;

  /** rangeStart 변경 시 24시간 윈도우 제한 적용 */
  const setConstrainedRangeStart = useCallback(
    (newStart: number) => {
      setRangeStart(newStart);
      if (isAllTrackModeRef.current) {
        // 시작점을 왼쪽으로 벌리면 끝점이 따라감
        setSliderValue((sv) => {
          const range = timeRange.max - timeRange.min;
          const startTs = timeRange.min + (range * newStart) / 100;
          const endTs = timeRange.min + (range * sv) / 100;
          if ((endTs - startTs) > MAX_WINDOW_SECS) {
            return Math.min(100, newStart + maxWindowPctRef.current);
          }
          return sv;
        });
      }
    },
    [timeRange]
  );

  /** sliderValue 변경 시 24시간 윈도우 제한 적용 */
  const setConstrainedSliderValue = useCallback(
    (newEnd: number) => {
      setSliderValue(newEnd);
      if (isAllTrackModeRef.current) {
        // 끝점을 오른쪽으로 벌리면 시작점이 따라감
        setRangeStart((rs) => {
          const range = timeRange.max - timeRange.min;
          const startTs = timeRange.min + (range * rs) / 100;
          const endTs = timeRange.min + (range * newEnd) / 100;
          if ((endTs - startTs) > MAX_WINDOW_SECS) {
            return Math.max(0, newEnd - maxWindowPctRef.current);
          }
          return rs;
        });
      }
    },
    [timeRange]
  );

  // 현재 표시 범위: rangeStart ~ sliderValue
  const { visibleMinTs, visibleMaxTs } = useMemo(() => {
    const maxTs = sliderValue >= 100 ? Infinity : pctToTs(sliderValue);
    const minTs = trailDuration > 0 && maxTs !== Infinity
      ? Math.max(pctToTs(rangeStart), maxTs - trailDuration)
      : pctToTs(rangeStart);
    return { visibleMinTs: minTs, visibleMaxTs: maxTs };
  }, [sliderValue, rangeStart, timeRange, pctToTs, trailDuration]);


  // Auto fit bounds
  const [viewState, setViewState] = useState({
    longitude: 127.0,
    latitude: 36.5,
    zoom: 6,
    pitch: 45,
    bearing: 0,
  });

  useEffect(() => {
    if (allPoints.length > 0 && allPoints.length !== prevPointsLen.current) {
      prevPointsLen.current = allPoints.length;
      fittedRef.current = false;
    }
    if (allPoints.length > 0 && !fittedRef.current) {
      let minLat = Infinity,
        maxLat = -Infinity,
        minLon = Infinity,
        maxLon = -Infinity;
      for (const p of allPoints) {
        if (p.latitude < minLat) minLat = p.latitude;
        if (p.latitude > maxLat) maxLat = p.latitude;
        if (p.longitude < minLon) minLon = p.longitude;
        if (p.longitude > maxLon) maxLon = p.longitude;
      }
      const cLat = (minLat + maxLat) / 2;
      const cLon = (minLon + maxLon) / 2;
      const latSpan = maxLat - minLat;
      const lonSpan = maxLon - minLon;
      const span = Math.max(latSpan, lonSpan, 0.01);
      const zoom = Math.max(2, Math.min(15, Math.log2(360 / span) - 0.5));
      setViewState((v) => ({ ...v, latitude: cLat, longitude: cLon, zoom }));
      fittedRef.current = true;
    }
  }, [allPoints]);

  // 지형 DEM 소스/레이어 추가 헬퍼
  const setupTerrain = useCallback((map: maplibregl.Map) => {
    if (!map.getSource("terrain-dem")) {
      map.addSource("terrain-dem", {
        type: "raster-dem",
        tiles: [
          "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
        ],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
      });
    }
    if (!map.getSource("hillshade-dem")) {
      map.addSource("hillshade-dem", {
        type: "raster-dem",
        tiles: [
          "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png",
        ],
        encoding: "terrarium",
        tileSize: 256,
        maxzoom: 15,
      });
    }
    if (!map.getLayer("hillshade")) {
      const firstSymbol = map.getStyle().layers?.find((l) => l.type === "symbol")?.id;
      map.addLayer(
        {
          id: "hillshade",
          type: "hillshade",
          source: "hillshade-dem",
          paint: {
            "hillshade-shadow-color": "#000000",
            "hillshade-highlight-color": "#ffffff",
            "hillshade-exaggeration": 0.3,
          },
        },
        firstSymbol
      );
    }
    if (terrainEnabled) {
      map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
    }
    terrainAdded.current = true;
  }, [terrainEnabled]);

  // 맵 로드 시 지형 설정
  const onMapLoad = useCallback(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    // 보고서 캡처용으로 맵 인스턴스를 window에 노출
    (window as any).__maplibreInstance = map;
    setupTerrain(map);
    setMapLoaded(true);
    map.on("style.load", () => {
      terrainAdded.current = false;
      setupTerrain(map);
    });
  }, [setupTerrain]);

  // 지형 on/off 토글
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !terrainAdded.current) return;
    if (terrainEnabled) {
      map.setTerrain({ source: "terrain-dem", exaggeration: 1.5 });
      if (map.getLayer("hillshade")) {
        map.setLayoutProperty("hillshade", "visibility", "visible");
      }
    } else {
      map.setTerrain(undefined as any);
      if (map.getLayer("hillshade")) {
        map.setLayoutProperty("hillshade", "visibility", "none");
      }
    }
  }, [terrainEnabled]);

  // 레이더 사이트 변경 시 커버리지 캐시 무효화
  useEffect(() => {
    if (!isGPUCacheValidFor(radarSite)) {
      setGpuCacheReady(false);
      setCoverageImage(null);
      setCoverageBounds(null);
      setCoverageUsedAlts([]);
    }
  }, [radarSite.name, radarSite.latitude, radarSite.longitude, radarSite.altitude, radarSite.antenna_height]); // eslint-disable-line react-hooks/exhaustive-deps

  const activePlanOverlays = useAppStore((s) => s.activePlanOverlays);
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;
    const activeIds = new Set<number>();
    activePlanOverlays.forEach((data, groupId) => {
      activeIds.add(groupId);
      const rotated = rotateBounds(data.bounds, data.rotation);
      if (!map.getSource(`plan-image-${groupId}`)) {
        addPlanOverlay(map, groupId, data.imageDataUrl, rotated, data.opacity);
      } else {
        // 투명도/회전 변경 시 기존 레이어 업데이트
        updatePlanOpacity(map, groupId, data.opacity);
        updatePlanBounds(map, groupId, rotated);
      }
    });
    // 비활성 오버레이 제거
    for (const layer of map.getStyle().layers) {
      if (layer.id.startsWith("plan-raster-")) {
        const gid = Number(layer.id.replace("plan-raster-", ""));
        if (!activeIds.has(gid)) removePlanOverlay(map, gid);
      }
    }
  }, [activePlanOverlays]);

  /** 고도 비율 → 색상 스펙트럼 매핑 (HSL 0°→240° : 빨강→파랑) */
  const altToColor = useCallback((altFt: number): [number, number, number] => {
    const t = Math.min(1, Math.max(0, (altFt - COVERAGE_MIN_ALT_FT) / (COVERAGE_MAX_ALT_FT - COVERAGE_MIN_ALT_FT)));
    const hue = t * 240; // 0°(red) → 60°(yellow) → 120°(green) → 180°(cyan) → 240°(blue)
    const s = 0.85, l = 0.5;
    // HSL → RGB 변환
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
    const m = l - c / 2;
    let r1: number, g1: number, b1: number;
    if (hue < 60)       { r1 = c; g1 = x; b1 = 0; }
    else if (hue < 120) { r1 = x; g1 = c; b1 = 0; }
    else if (hue < 180) { r1 = 0; g1 = c; b1 = x; }
    else if (hue < 240) { r1 = 0; g1 = x; b1 = c; }
    else                { r1 = 0; g1 = 0; b1 = c; }
    return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
  }, []);

  // 커버리지 비표시 시 이미지 클리어
  useEffect(() => {
    if (!coverageVisible) { setCoverageImage(null); setCoverageBounds(null); setCoverageUsedAlts([]); }
  }, [coverageVisible]);


  // ── 타일 기반 건물 캐시 로딩 ──────────────────────────────────

  /** 뷰포트 건물 로드 (타일 캐시 + binary IPC + 점진적 로딩) */
  const buildingFetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const buildingFetchAbortRef = useRef(0); // 요청 시퀀스 — stale 응답 무시

  const loadBuildingsForViewport = useCallback(async (initial = false) => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    if (initial) setBuildingsLoading(true);

    const seq = ++buildingFetchAbortRef.current;
    try {
      const bounds = map.getBounds();
      const zoom = map.getZoom();
      await fetchBuildingsForViewport(
        {
          south: bounds.getSouth(),
          north: bounds.getNorth(),
          west: bounds.getWest(),
          east: bounds.getEast(),
          zoom,
        },
        [...hiddenBuildingSources],
        // 점진적 콜백: 타일 배치 완료마다 UI 업데이트
        (buildings) => {
          if (seq !== buildingFetchAbortRef.current) return;
          setBuildings3dData(buildings);
        },
      );
    } catch (err) {
      console.error("건물 타일 로드 실패:", err);
    } finally {
      if (seq === buildingFetchAbortRef.current && initial) {
        setBuildingsLoading(false);
      }
    }
  }, [hiddenBuildingSources]);

  /** 건물 최초 로드 (토글 클릭 시) */
  const fetchBuildingOverlay = useCallback(async () => {
    setBuildingsLoading(true);
    setShowBuildings(true);
    await loadBuildingsForViewport(true);
    setBuildingsLoading(false);
  }, [loadBuildingsForViewport]);

  // 레이더 사이트 변경 시 캐시 무효화 + 재로드
  useEffect(() => {
    if (showBuildings && buildings3dData.length > 0) {
      invalidateBuildingCache();
      loadBuildingsForViewport(false);
    }
  }, [radarSite.latitude, radarSite.longitude]); // eslint-disable-line react-hooks/exhaustive-deps

  // 뷰포트 이동 시 타일 기반 건물 로드 (300ms 디바운스)
  useEffect(() => {
    if (!showBuildings) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const onMoveEnd = () => {
      if (buildingFetchTimerRef.current) clearTimeout(buildingFetchTimerRef.current);
      buildingFetchTimerRef.current = setTimeout(() => loadBuildingsForViewport(false), 300);
    };
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
      if (buildingFetchTimerRef.current) clearTimeout(buildingFetchTimerRef.current);
    };
  }, [showBuildings, loadBuildingsForViewport]);

  // hiddenBuildingSources 변경 시 캐시 무효화 + 재로드
  useEffect(() => {
    if (showBuildings) {
      // 즉시 기존 3D 건물 제거 (비동기 재로드 완료 전까지 이전 데이터가 남는 문제 방지)
      setBuildings3dData([]);
      invalidateBuildingCache();
      loadBuildingsForViewport(false);
    }
  }, [hiddenBuildingSources]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── MapLibre fill-extrusion (3D 건물) ──────────────────────────
  // 건물 3D 모드: MapLibre 네이티브 fill-extrusion 레이어 사용
  // 2D 모드: deck.gl ScatterplotLayer (기존 유지)

  const buildings3dGeoJSON = useMemo(() => {
    if (!showBuildings || !buildings3dMode || buildings3dData.length === 0) return null;
    return buildingsToGeoJSON(buildings3dData);
  }, [showBuildings, buildings3dMode, buildings3dData]);

  // MapLibre fill-extrusion 레이어 동기화
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;

    const sourceId = "buildings-3d-src";
    const layerId = "buildings-3d-fill";

    if (buildings3dGeoJSON && buildings3dMode) {
      // GeoJSON 소스 업데이트 또는 생성
      const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(buildings3dGeoJSON);
      } else {
        map.addSource(sourceId, { type: "geojson", data: buildings3dGeoJSON });
        map.addLayer({
          id: layerId,
          type: "fill-extrusion",
          source: sourceId,
          paint: {
            "fill-extrusion-color": [
              "case",
              ["!=", ["get", "group_color"], null],
              ["get", "group_color"],
              ["==", ["get", "source"], "fac"],
              "#e5e7eb",
              "#ef4444",
            ],
            // AMSL 옥상 높이 = 지반 표고 + 건물 높이
            "fill-extrusion-height": ["+", ["get", "base"], ["get", "height"]],
            "fill-extrusion-base": ["get", "base"],
            "fill-extrusion-opacity": 1.0,
          },
        });
      }
      // 레이어 표시
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", "visible");
      }
    } else {
      // 3D 모드 아닐 때 레이어 숨김
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", "none");
      }
    }
  }, [buildings3dGeoJSON, buildings3dMode]);

  // showBuildings=false 시 fill-extrusion 레이어 제거
  useEffect(() => {
    if (showBuildings) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    if (map.getLayer("buildings-3d-fill")) map.removeLayer("buildings-3d-fill");
    if (map.getSource("buildings-3d-src")) map.removeSource("buildings-3d-src");
  }, [showBuildings]);

  // MapLibre fill-extrusion 호버/클릭 이벤트 (3D 모드)
  const buildingHoverActiveRef = useRef(false);
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map) return;
    const layerId = "buildings-3d-fill";

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(layerId)) {
        if (buildingHoverActiveRef.current) {
          buildingHoverActiveRef.current = false;
          clearBldgHover();
        }
        return;
      }
      const features = map.queryRenderedFeatures(e.point, { layers: [layerId] });
      if (features.length > 0) {
        buildingHoverActiveRef.current = true;
        map.getCanvas().style.cursor = "pointer";
        const p = features[0].properties;
        if (!p) return;
        scheduleBldgHover({
          x: e.point.x, y: e.point.y,
          lat: Number(p.lat), lon: Number(p.lon),
          name: p.name || undefined,
          height: p.height != null ? Number(p.height) : undefined,
          usage: p.usage || undefined,
        });
      } else if (buildingHoverActiveRef.current) {
        buildingHoverActiveRef.current = false;
        map.getCanvas().style.cursor = "";
        clearBldgHover();
      }
    };

    const onClick = (e: maplibregl.MapMouseEvent) => {
      if (!map.getLayer(layerId)) { setBldgPopup(null); return; }
      const features = map.queryRenderedFeatures(e.point, { layers: [layerId] });
      if (features.length > 0) {
        if (losTarget) losPointClickedRef.current = true;
        const p = features[0].properties;
        if (p) {
          const lat = Number(p.lat);
          const lon = Number(p.lon);
          if (bldgHoverTimerRef.current) { clearTimeout(bldgHoverTimerRef.current); bldgHoverTimerRef.current = null; }
          setBldgPopup((prev) => {
            // 같은 건물이면 기존 정보 유지하고 pinned만 켠다
            if (prev && Math.abs(prev.lat - lat) < 1e-6 && Math.abs(prev.lon - lon) < 1e-6) {
              return { ...prev, x: e.point.x, y: e.point.y, pinned: true };
            }
            return {
              x: e.point.x, y: e.point.y, lat, lon,
              loading: true, info: null,
              localName: p.name || undefined,
              localHeight: p.height ? Number(p.height) : undefined,
              localUsage: p.usage || undefined,
              pinned: true,
            };
          });
        }
      } else {
        setBldgPopup(null);
      }
    };

    map.on("mousemove", onMouseMove);
    map.on("click", onClick);

    return () => {
      map.off("mousemove", onMouseMove);
      map.off("click", onClick);
      if (buildingHoverActiveRef.current) {
        buildingHoverActiveRef.current = false;
        map.getCanvas().style.cursor = "";
      }
    };
  }, [losTarget, buildings3dMode, showBuildings]); // eslint-disable-line react-hooks/exhaustive-deps

  // 커버리지 활성 시 맵 hover → 최저 탐지고도 tooltip
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !coverageVisible || !gpuCacheReady) {
      setCoverageTooltip(null);
      return;
    }

    const onMouseMove = (e: maplibregl.MapMouseEvent) => {
      // 건물 hover 중이면 커버리지 tooltip 숨김
      if (buildingHoverActiveRef.current) {
        setCoverageTooltip(null);
        return;
      }
      const { point, lngLat } = e;
      const lat = lngLat.lat;
      const lon = lngLat.lng;
      const x = point.x;
      const y = point.y;

      // 디바운스: 50ms
      if (coverageTooltipTimerRef.current) clearTimeout(coverageTooltipTimerRef.current);
      coverageTooltipTimerRef.current = setTimeout(() => {
        const seq = ++coverageTooltipSeqRef.current;
        setCoverageTooltip({ x, y, altFt: null, loading: true });
        queryMinDetectionAlt(lat, lon).then((altFt) => {
          if (coverageTooltipSeqRef.current !== seq) return;
          setCoverageTooltip({ x, y, altFt: altFt ?? null, loading: false });
        }).catch(() => {
          if (coverageTooltipSeqRef.current !== seq) return;
          setCoverageTooltip(null);
        });
      }, 50);
    };

    const onMouseLeave = () => {
      if (coverageTooltipTimerRef.current) clearTimeout(coverageTooltipTimerRef.current);
      ++coverageTooltipSeqRef.current;
      setCoverageTooltip(null);
    };

    map.on("mousemove", onMouseMove);
    map.getCanvas().addEventListener("mouseleave", onMouseLeave);
    return () => {
      map.off("mousemove", onMouseMove);
      map.getCanvas().removeEventListener("mouseleave", onMouseLeave);
      if (coverageTooltipTimerRef.current) clearTimeout(coverageTooltipTimerRef.current);
    };
  }, [coverageVisible, gpuCacheReady]); // eslint-disable-line react-hooks/exhaustive-deps

  // LoS 단면도 건물 클릭/호버 → 3D 건물 주황색 하이라이트
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;

    const hlSourceId = "buildings-3d-hl-src";
    const hlLayerId = "buildings-3d-hl-fill";

    // 기존 하이라이트 레이어 제거
    if (map.getLayer(hlLayerId)) map.removeLayer(hlLayerId);
    if (map.getSource(hlSourceId)) map.removeSource(hlSourceId);

    if (!losBuildingHighlight || !buildings3dMode || buildings3dData.length === 0) return;

    // lat/lon 근접 매칭으로 Building3D 찾기
    const tgt = losBuildingHighlight;
    const matched = buildings3dData.find(
      (b) => Math.abs(b.lat - tgt.lat) < 0.0001 && Math.abs(b.lon - tgt.lon) < 0.0001
    );
    if (!matched || matched.polygon.length < 3) return;

    const geoJSON = buildingsToGeoJSON([matched]);

    map.addSource(hlSourceId, { type: "geojson", data: geoJSON });
    map.addLayer({
      id: hlLayerId,
      type: "fill-extrusion",
      source: hlSourceId,
      paint: {
        "fill-extrusion-color": "#f97316",  // 주황색
        "fill-extrusion-height": ["+", ["get", "base"], ["get", "height"]],
        "fill-extrusion-base": ["get", "base"],
        "fill-extrusion-opacity": 0.9,
      },
    });

    return () => {
      if (map.getLayer(hlLayerId)) map.removeLayer(hlLayerId);
      if (map.getSource(hlSourceId)) map.removeSource(hlSourceId);
    };
  }, [losBuildingHighlight, buildings3dMode, buildings3dData]);


  // ESC 키로 LoS 커서 모드 해제
  useEffect(() => {
    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape" && losCursorPicking) setLosCursorPicking(false);
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [losCursorPicking]);

  // WASD 키로 맵 패닝
  useEffect(() => {
    const PAN_PX = 100;
    const keyMap: Record<string, [number, number]> = {
      w: [0, -PAN_PX], a: [-PAN_PX, 0], s: [0, PAN_PX], d: [PAN_PX, 0],
    };
    const handleWASD = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || (e.target as HTMLElement).isContentEditable) return;
      const dir = keyMap[e.key.toLowerCase()];
      if (!dir) return;
      const map = mapRef.current?.getMap();
      if (map) { e.preventDefault(); map.panBy(dir, { duration: 200 }); }
    };
    window.addEventListener("keydown", handleWASD);
    return () => window.removeEventListener("keydown", handleWASD);
  }, []);

  // 뷰포트 정보를 포함한 커버리지 이미지 렌더링 (화면 해상도에 맞춤)
  const coverageRenderSeqRef = useRef(0);
  const coverageRenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const renderCoverageForViewport = useCallback(() => {
    if (!gpuCacheReady || !coverageVisible || coverageLoading) return;

    const effMin = Math.min(coverageAltMin, coverageAlt);
    const effMax = Math.max(coverageAltMin, coverageAlt);
    const range = effMax - effMin;
    let step: number;
    if (range <= 2000) step = COVERAGE_ALT_STEP_FT;
    else if (range <= 5000) step = 500;
    else step = 1000;

    const altFts: number[] = [];
    for (let alt = effMin; alt <= effMax; alt += step) altFts.push(alt);
    if (altFts.length === 0 || altFts[altFts.length - 1] !== effMax) altFts.push(effMax);

    // 현재 맵 뷰포트 → 화면 해상도로 렌더링
    const map = mapRef.current?.getMap();
    let viewport: { width: number; height: number; west: number; south: number; east: number; north: number } | undefined;
    if (map) {
      const bounds = map.getBounds();
      const container = map.getContainer();
      viewport = {
        width: Math.round(container.clientWidth * devicePixelRatio),
        height: Math.round(container.clientHeight * devicePixelRatio),
        west: bounds.getWest(), east: bounds.getEast(),
        south: bounds.getSouth(), north: bounds.getNorth(),
      };
    }

    const seq = ++coverageRenderSeqRef.current;
    setCoverageRendering(true);
    renderCoverageImageAsync(altFts, showConeOfSilence, viewport)
      .then((result) => {
        if (coverageRenderSeqRef.current !== seq || !result) return;
        setCoverageImage(result.image);
        setCoverageBounds(result.bounds);
        setCoverageUsedAlts(result.usedAltFts);
      }).catch(() => {}).finally(() => {
        if (coverageRenderSeqRef.current === seq) setCoverageRendering(false);
      });
  }, [gpuCacheReady, coverageVisible, coverageLoading, coverageAlt, coverageAltMin, showConeOfSilence]);

  // 고도 슬라이더/설정 변경 시 렌더링
  useEffect(() => {
    renderCoverageForViewport();
  }, [renderCoverageForViewport]);

  // 맵 이동/줌 후 커버리지 재렌더링 (300ms 디바운스)
  useEffect(() => {
    if (!coverageVisible || !gpuCacheReady) return;
    const map = mapRef.current?.getMap();
    if (!map) return;
    const onMoveEnd = () => {
      if (coverageRenderTimerRef.current) clearTimeout(coverageRenderTimerRef.current);
      coverageRenderTimerRef.current = setTimeout(renderCoverageForViewport, 300);
    };
    map.on("moveend", onMoveEnd);
    return () => {
      map.off("moveend", onMoveEnd);
      if (coverageRenderTimerRef.current) clearTimeout(coverageRenderTimerRef.current);
    };
  }, [coverageVisible, gpuCacheReady, renderCoverageForViewport]);

  // Mode-S별 트랙 패스 데이터 (gap + radar_type 변경 시 분할)
  /** 1포인트 항적용 데이터 */
  interface SinglePoint {
    modeS: string;
    position: [number, number] | [number, number, number];
    color: [number, number, number];
    point: TrackPoint;
  }

  // mode_s → 색상 안정 매핑 (allPoints 기반, 정렬하여 슬라이더/필터 변경에도 색상 유지)

  const [trackPathsState, setTrackPathsState] = useState<{ trackPaths: TrackPath[]; singlePoints: SinglePoint[] }>({ trackPaths: [], singlePoints: [] });

  useEffect(() => {
    let cancelled = false;

    const compute = async () => {
      const groups = new Map<string, TrackPoint[]>();
      const n = allPoints.length;
      const isLarge = n > 100_000;
      const YIELD_INTERVAL = 30_000; // 30K 포인트마다 yield (이전 100K → 30K)

      if (isLarge) setRenderProgress({ stage: "paths", current: 0, total: n });

      // Pass 1: 그룹핑 — 대량 시 30K마다 yield
      for (let i = 0; i < n; i++) {
        const p = allPoints[i];
        if (p.timestamp > visibleMaxTs || p.timestamp < visibleMinTs) continue;
        let arr = groups.get(p.mode_s);
        if (!arr) { arr = []; groups.set(p.mode_s, arr); }
        arr.push(p);
        if (isLarge && i > 0 && i % YIELD_INTERVAL === 0) {
          await new Promise((r) => setTimeout(r, 0));
          if (cancelled) return;
        }
      }

      if (cancelled) return;

      const paths: TrackPath[] = [];
      const singles: SinglePoint[] = [];
      let pointsProcessed = 0;
      let pointsSinceFlush = 0;
      const FLUSH_THRESHOLD = 50_000; // 50K 포인트 처리할 때마다 progressive 렌더링

      const splitThreshold = 7;

      // 그룹별 세그먼트 분할 + 경로 빌드 (개별 그룹 내부에서도 yield)
      const processGroup = (modeS: string, pts: TrackPoint[]) => {
        if (pts.length === 1) {
          const p = pts[0];
          singles.push({ modeS, position: losMode ? [p.longitude, p.latitude] : [p.longitude, p.latitude, p.altitude * altScale], color: detectionTypeColor(p.radar_type), point: p });
          return;
        }
        let altSum = 0;
        for (const p of pts) altSum += p.altitude;
        const avgAlt = altSum / pts.length;

        // 세그먼트 수집
        const rawSegs: { start: number; end: number }[] = [];
        let segStart = 0;
        for (let i = 1; i <= pts.length; i++) {
          const isEnd = i === pts.length;
          const hasGap = !isEnd && pts[i].timestamp - pts[i - 1].timestamp > splitThreshold;
          const typeChanged = !isEnd && pts[i].radar_type !== pts[i - 1].radar_type;
          if (isEnd || hasGap || typeChanged) {
            rawSegs.push({ start: segStart, end: i });
            segStart = typeChanged && !hasGap ? i - 1 : i;
          }
        }

        // 1-포인트 세그먼트 병합
        for (let s = 0; s < rawSegs.length; s++) {
          if (rawSegs[s].end - rawSegs[s].start === 1) {
            const singlePt = pts[rawSegs[s].start];
            const canMergeNext = s < rawSegs.length - 1 && pts[rawSegs[s + 1].start].timestamp - singlePt.timestamp <= splitThreshold;
            const canMergePrev = s > 0 && singlePt.timestamp - pts[rawSegs[s - 1].end - 1].timestamp <= splitThreshold;
            if (canMergeNext) { rawSegs[s + 1].start = rawSegs[s].start; rawSegs.splice(s, 1); s--; }
            else if (canMergePrev) { rawSegs[s - 1].end = rawSegs[s].end; rawSegs.splice(s, 1); s--; }
          }
        }

        // PathLayer 데이터 생성
        for (const seg of rawSegs) {
          const len = seg.end - seg.start;
          if (len >= 2) {
            const rt = pts[seg.end - 1].radar_type;
            const path: [number, number][] | [number, number, number][] = [];
            for (let i = seg.start; i < seg.end; i++) {
              const p = pts[i];
              path.push(losMode ? [p.longitude, p.latitude] : [p.longitude, p.latitude, p.altitude * altScale] as any);
            }
            paths.push({ modeS, radarType: rt, path, color: detectionTypeColor(rt), avgAlt, pointCount: len });
          } else if (len === 1) {
            const p = pts[seg.start];
            singles.push({ modeS, position: losMode ? [p.longitude, p.latitude] : [p.longitude, p.latitude, p.altitude * altScale], color: detectionTypeColor(p.radar_type), point: p });
          }
        }
      };

      for (const [modeS, pts] of groups) {
        // Worker는 비행별로 포인트를 보내므로, 같은 mode_s의 다중 비행 포인트가
        // 시간순이 아닐 수 있음 → 정렬 필수 (세그먼트 분할이 인접 timestamp gap 기반)
        pts.sort((a, b) => a.timestamp - b.timestamp);
        processGroup(modeS, pts);
        pointsProcessed += pts.length;
        pointsSinceFlush += pts.length;

        if (cancelled) return;

        // 대량 데이터: progressive 렌더링 — 누적 결과를 중간 플러시
        if (isLarge && pointsSinceFlush >= FLUSH_THRESHOLD) {
          // 현재까지 누적된 결과를 즉시 렌더링
          setTrackPathsState({ trackPaths: [...paths], singlePoints: [...singles] });
          setRenderProgress({ stage: "paths", current: pointsProcessed, total: n });
          pointsSinceFlush = 0;
          // 렌더 프레임 양보
          await new Promise((r) => setTimeout(r, 0));
          if (cancelled) return;
        }
      }

      if (!cancelled) {
        setTrackPathsState({ trackPaths: paths, singlePoints: singles });
        setRenderProgress(null);
      }
    };

    if (allPoints.length > 100_000) {
      requestAnimationFrame(() => { compute(); });
    } else {
      compute();
    }

    return () => { cancelled = true; };
  }, [allPoints, visibleMinTs, visibleMaxTs, altScale, losMode]);

  const { trackPaths, singlePoints } = trackPathsState;

  // Loss 데이터 (전체 loss type 표시)
  const signalLoss = useMemo(() => {
    return allLoss.filter(
      (s) => s.start_time >= visibleMinTs && s.start_time <= visibleMaxTs
    );
  }, [allLoss, visibleMinTs, visibleMaxTs]);

  // Loss 포인트 (전체 loss type, 시간 범위 필터)
  const signalLossPoints = useMemo(() => {
    return allLossPoints.filter(
      (p) => p.timestamp >= visibleMinTs && p.timestamp <= visibleMaxTs
    );
  }, [allLossPoints, visibleMinTs, visibleMaxTs]);

  // ADS-B fetch는 FileUpload에서 관리 (store 공유)

  // mode_s별 사전 그룹핑 캐시 (airplaneMarkers, timelineBands 등에서 공유)
  const allPointsByModeS = useMemo(() => {
    const groups = new Map<string, TrackPoint[]>();
    for (const p of allPoints) {
      let arr = groups.get(p.mode_s);
      if (!arr) { arr = []; groups.set(p.mode_s, arr); }
      arr.push(p);
    }
    return groups;
  }, [allPoints]);

  // 재생 시 비행기 아이콘 위치 (mode_s별 보간, 데이터 gap에서는 숨김)
  const airplaneMarkers = useMemo(() => {
    if (sliderValue >= 100 || allPointsByModeS.size === 0) return [];
    const currentTs = visibleMaxTs;
    if (!isFinite(currentTs)) return [];
    const result: TrackPoint[] = [];
    const GAP_THRESHOLD_SECS = 15; // 이 이상 gap이면 데이터 없는 구간으로 판단
    for (const [, pts] of allPointsByModeS) {
      // 이진 탐색: currentTs 이하 최대 인덱스
      let lo = 0, hi = pts.length - 1, idx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (pts[mid].timestamp <= currentTs) { idx = mid; lo = mid + 1; }
        else hi = mid - 1;
      }
      if (idx < 0) continue;
      const prev = pts[idx];
      if (prev.timestamp < visibleMinTs) continue;
      const next = idx + 1 < pts.length ? pts[idx + 1] : null;
      // gap 검사: 이전 포인트가 currentTs보다 너무 오래 전이면 숨김
      if (currentTs - prev.timestamp > GAP_THRESHOLD_SECS) continue;
      // 다음 포인트가 있고 gap이 짧으면 보간
      if (next && next.timestamp - prev.timestamp <= GAP_THRESHOLD_SECS && next.timestamp > currentTs) {
        const t = (currentTs - prev.timestamp) / (next.timestamp - prev.timestamp);
        // heading 보간 (각도 wrap-around 처리)
        let dh = next.heading - prev.heading;
        if (dh > 180) dh -= 360;
        if (dh < -180) dh += 360;
        const heading = ((prev.heading + dh * t) % 360 + 360) % 360;
        result.push({
          ...prev,
          latitude: prev.latitude + (next.latitude - prev.latitude) * t,
          longitude: prev.longitude + (next.longitude - prev.longitude) * t,
          altitude: prev.altitude + (next.altitude - prev.altitude) * t,
          speed: prev.speed + (next.speed - prev.speed) * t,
          heading,
        });
      } else {
        result.push(prev);
      }
    }
    return result;
  }, [allPointsByModeS, visibleMinTs, visibleMaxTs, sliderValue]);

  // 원시 탐지점 (항적선 OFF 시 표시)
  const dotPoints = useMemo(() => {
    if (trackLine) return [];
    return allPoints.filter(
      (p) => p.timestamp >= visibleMinTs && p.timestamp <= visibleMaxTs
    );
  }, [trackLine, allPoints, visibleMinTs, visibleMaxTs]);

  // 레이더 동심원 + 귀치도 (MapLibre 네이티브 레이어 - 지형에 밀착)
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !radarInfo || !mapLoaded) return;

    const { lat, lon, name } = radarInfo;
    const intervalNm = 20;
    const maxNm = 200;
    const features: any[] = [];

    for (let nm = intervalNm; nm <= maxNm + intervalNm * 0.5; nm += intervalNm) {
      const rKm = nm * 1.852;
      const coords: [number, number][] = [];
      for (let i = 0; i <= 120; i++) {
        const angle = (i / 120) * 2 * Math.PI;
        const dLat = (rKm / 111.32) * Math.cos(angle);
        const dLon =
          (rKm / (111.32 * Math.cos((lat * Math.PI) / 180))) * Math.sin(angle);
        coords.push([lon + dLon, lat + dLat]);
      }
      features.push({
        type: "Feature",
        properties: { label: `${nm}NM` },
        geometry: { type: "LineString", coordinates: coords },
      });
    }
    features.push({
      type: "Feature",
      properties: { isCenter: "true", name },
      geometry: { type: "Point", coordinates: [lon, lat] },
    });

    const geojson = { type: "FeatureCollection", features } as any;

    const addLayers = () => {
      try {
        for (const lid of ["radar-center-label", "range-ring-labels", "range-ring-lines"]) {
          if (map.getLayer(lid)) map.removeLayer(lid);
        }
        if (map.getSource("range-rings")) map.removeSource("range-rings");

        map.addSource("range-rings", { type: "geojson", data: geojson });
        map.addLayer({
          id: "range-ring-lines",
          type: "line",
          source: "range-rings",
          filter: ["==", ["geometry-type"], "LineString"],
          paint: {
            "line-color": "rgba(30,100,180,0.35)",
            "line-width": 1.5,
          },
        });
        map.addLayer({
          id: "range-ring-labels",
          type: "symbol",
          source: "range-rings",
          filter: ["==", ["geometry-type"], "LineString"],
          layout: {
            "symbol-placement": "line",
            "text-field": ["get", "label"],
            "text-size": 11,
            "text-font": ["Open Sans Regular", "Arial Unicode MS Regular"],
          },
          paint: {
            "text-color": "rgba(30,80,140,0.8)",
            "text-halo-color": "rgba(255,255,255,0.9)",
            "text-halo-width": 1.5,
          },
        });
        map.addLayer({
          id: "radar-center-label",
          type: "symbol",
          source: "range-rings",
          filter: ["==", ["get", "isCenter"], "true"],
          layout: {
            "text-field": ["get", "name"],
            "text-size": 13,
            "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
            "text-offset": [0, -1.5],
            "text-anchor": "bottom",
          },
          paint: {
            "text-color": "rgba(30,80,140,0.9)",
            "text-halo-color": "rgba(255,255,255,0.9)",
            "text-halo-width": 2,
          },
        });
      } catch (e) {
        console.warn("Range ring layer error:", e);
      }
    };

    if (map.isStyleLoaded()) addLayers();
    const onStyle = () => addLayers();
    map.on("style.load", onStyle);
    return () => { map.off("style.load", onStyle); };
  }, [radarInfo, mapLoaded]);

  // LoS mode map click handler (카메라 조정은 단면도 로딩 완료 후)
  const handleMapClick = useCallback(
    (evt: any) => {
      if (!losMode || !losCursorPicking) return;
      // deck.gl LoS 포인트 클릭이었으면 스킵 (빈 영역 클릭만 처리)
      if (losPointClickedRef.current) {
        losPointClickedRef.current = false;
        return;
      }
      const { lngLat } = evt;
      // 이미 타겟이 있으면 하이라이트/호버 초기화 후 새 타겟으로 재생성
      if (losTarget) {
        setLosHighlightIdx(null);
        setLosHoverIdx(null);
        setLosHoverRatio(null);
        setLosBuildingHighlight(null);
        setDetailBuilding(null);
      }
      setLosTarget({ lat: lngLat.lat, lon: lngLat.lng });
      setLosSearchedAddress(null);
      setLosCursorPicking(false);
    },
    [losMode, losCursorPicking, losTarget]
  );

  // LoS 단면도 로딩 완료 → 카메라 자동 정렬
  const losTargetRef = useRef(losTarget);
  losTargetRef.current = losTarget;
  const handleLosLoaded = useCallback(() => {
    const map = mapRef.current?.getMap();
    const target = losTargetRef.current;
    if (!map || !target) return;
    const rLat = radarSite.latitude;
    const rLon = radarSite.longitude;
    const cosLat = Math.cos(((rLat + target.lat) / 2) * Math.PI / 180);
    const dLon = (target.lon - rLon) * cosLat;
    const dLat = target.lat - rLat;
    const bearing = (Math.atan2(dLon, dLat) * 180) / Math.PI;
    const cameraBearing = ((bearing - 90) % 360 + 360) % 360;
    const minLat = Math.min(rLat, target.lat);
    const maxLat = Math.max(rLat, target.lat);
    const minLon = Math.min(rLon, target.lon);
    const maxLon = Math.max(rLon, target.lon);
    map.fitBounds(
      [[minLon, minLat], [maxLon, maxLat]],
      { bearing: cameraBearing, pitch: 0, padding: { top: 80, bottom: 250, left: 80, right: 80 }, duration: 800, maxZoom: 12 }
    );
  }, [radarSite]);

  // LoS mode mouse move handler (커서 추적)
  const handleMapMouseMove = useCallback(
    (evt: any) => {
      if (!losMode || losTarget || !losCursorPicking) return;
      const { lngLat } = evt;
      setLosCursor({ lat: lngLat.lat, lon: lngLat.lng });
    },
    [losMode, losTarget, losCursorPicking]
  );

  // LoS 방위/거리 (losTarget 기반)
  const losAzimuth = useMemo(() => {
    if (!losTarget) return 0;
    const dLat = losTarget.lat - radarSite.latitude;
    const dLon = losTarget.lon - radarSite.longitude;
    const cosLat = Math.cos(radarSite.latitude * Math.PI / 180);
    return ((Math.atan2(dLon * cosLat, dLat) * 180 / Math.PI) + 360) % 360;
  }, [losTarget, radarSite.latitude, radarSite.longitude]);

  const losDistanceKm = useMemo(() => {
    if (!losTarget) return Math.round(radarSite.range_nm * 1.852 * 0.5);
    const cosLat = Math.cos(radarSite.latitude * Math.PI / 180);
    const dLat = (losTarget.lat - radarSite.latitude) * 111.32;
    const dLon = (losTarget.lon - radarSite.longitude) * 111.32 * cosLat;
    return Math.sqrt(dLat * dLat + dLon * dLon);
  }, [losTarget, radarSite.latitude, radarSite.longitude, radarSite.range_nm]);

  // 초정밀 방위 슬라이더의 중심 (휠/주소검색/지도클릭 등 큰 변경 시에만 재중심)
  const [losAzFineCenter, setLosAzFineCenter] = useState(0);
  useEffect(() => {
    if (Math.abs(losAzimuth - losAzFineCenter) > 1.99) {
      setLosAzFineCenter(Math.round(losAzimuth));
    }
  }, [losAzimuth, losAzFineCenter]);

  const setLosFromAzDist = useCallback((az: number, distKm: number) => {
    if (!losMode) {
      setLosMode(true);
      savedPitchRef.current = viewState.pitch ?? 45;
      savedBearingRef.current = viewState.bearing ?? 0;
      const map = mapRef.current?.getMap();
      if (map) map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
    }
    const azRad = az * Math.PI / 180;
    const cosLat = Math.cos(radarSite.latitude * Math.PI / 180);
    const lat = radarSite.latitude + (distKm / 111.32) * Math.cos(azRad);
    const lon = radarSite.longitude + (distKm / (111.32 * cosLat)) * Math.sin(azRad);
    setLosTarget({ lat, lon });
  }, [radarSite.latitude, radarSite.longitude, losMode, viewState.pitch, viewState.bearing]);

  // LoS 선상 항적/Loss 포인트 전체 (단면도 전달용)
  const losTrackPoints = useMemo(() => {
    if (!losTarget) return [];
    const rLat = radarSite.latitude;
    const rLon = radarSite.longitude;
    const tLat = losTarget.lat;
    const tLon = losTarget.lon;
    // 미터 단위 거리 계산용 상수
    const DEG2RAD = Math.PI / 180;
    const R_EARTH = 6_371_000; // 지구 반경(m)
    const cosLat = Math.cos(rLat * DEG2RAD);
    const mPerDegLat = DEG2RAD * R_EARTH;
    const mPerDegLon = DEG2RAD * R_EARTH * cosLat;
    // 레이더→타겟 방향 벡터 (미터 단위)
    const lineDxM = (tLat - rLat) * mPerDegLat;
    const lineDyM = (tLon - rLon) * mPerDegLon;
    const lineLen = Math.sqrt(lineDxM ** 2 + lineDyM ** 2);
    const cosB = lineDxM / lineLen;
    const sinB = lineDyM / lineLen;
    const TOLERANCE_M = 1000; // 수직 1km
    const pts: { distRatio: number; altitude: number; mode_s: string; timestamp: number; radar_type: string; isLoss: boolean; latitude: number; longitude: number }[] = [];
    // 항적 포인트 (타임라인 슬라이더 범위 적용)
    for (const p of allPoints) {
      if (p.timestamp < visibleMinTs || p.timestamp > visibleMaxTs) continue;
      const dx = (p.latitude - rLat) * mPerDegLat;
      const dy = (p.longitude - rLon) * mPerDegLon;
      const along = dx * cosB + dy * sinB;
      const across = Math.abs(-dx * sinB + dy * cosB);
      if (across < TOLERANCE_M && along > 0 && along <= lineLen) {
        pts.push({ distRatio: along / lineLen, altitude: p.altitude, mode_s: p.mode_s, timestamp: p.timestamp, radar_type: p.radar_type, isLoss: false, latitude: p.latitude, longitude: p.longitude });
      }
    }
    // Loss 포인트
    for (const lp of signalLossPoints) {
      const dx = (lp.latitude - rLat) * mPerDegLat;
      const dy = (lp.longitude - rLon) * mPerDegLon;
      const along = dx * cosB + dy * sinB;
      const across = Math.abs(-dx * sinB + dy * cosB);
      if (across < TOLERANCE_M && along > 0 && along <= lineLen) {
        pts.push({ distRatio: along / lineLen, altitude: lp.altitude, mode_s: lp.mode_s, timestamp: lp.timestamp, radar_type: "loss", isLoss: true, latitude: lp.latitude, longitude: lp.longitude });
      }
    }
    return pts;
  }, [losTarget, radarSite, allPoints, signalLossPoints, visibleMinTs, visibleMaxTs]);

  // 커버리지 전용 deck.gl 레이어 — BitmapLayer (이미지 텍스처 1장, tessellation 없음)
  const coverageDeckLayers = useMemo(() => {
    if (!coverageImage || !coverageBounds) return [];
    return [
      new BitmapLayer({
        id: "coverage-bitmap",
        image: coverageImage,
        bounds: coverageBounds,
        opacity: coverageOpacity,
        parameters: { depthWriteEnabled: false },
      }),
    ];
  }, [coverageImage, coverageBounds, coverageOpacity]);


  // LoS 전용 deck.gl 레이어 (LoS 모드 상태 변경 시에만 재생성)
  const losDeckLayers = useMemo(() => {
    if (!losMode) return [];
    const layers: any[] = [];
    const losPreviewTarget = losTarget ?? losCursor;
    const losRadarPos = radarInfo
      ? [radarInfo.lon, radarInfo.lat]
      : [radarSite.longitude, radarSite.latitude];
    if (losPreviewTarget) {
      layers.push(
        new LineLayer({
          id: "los-preview-line",
          data: [{ from: losRadarPos, to: [losPreviewTarget.lon, losPreviewTarget.lat] }],
          getSourcePosition: (d: any) => d.from,
          getTargetPosition: (d: any) => d.to,
          getColor: losTarget ? [233, 69, 96, 200] : [233, 69, 96, 120],
          getWidth: losTarget ? 2 : 1,
          widthUnits: "pixels" as const,
        })
      );

      // LoS 단면도 호버 위치 → 지도 위 점
      if (losTarget && losHoverRatio !== null) {
        const rLat = radarSite.latitude;
        const rLon = radarSite.longitude;
        const hoverLat = rLat + (losTarget.lat - rLat) * losHoverRatio;
        const hoverLon = rLon + (losTarget.lon - rLon) * losHoverRatio;
        layers.push(
          new ScatterplotLayer({
            id: "los-hover-dot",
            data: [{ position: [hoverLon, hoverLat] }],
            getPosition: (d: any) => d.position,
            getFillColor: [255, 255, 255, 255],
            getLineColor: [233, 69, 96, 255],
            getRadius: 6,
            radiusMinPixels: 5,
            radiusMaxPixels: 10,
            radiusUnits: "pixels",
            lineWidthMinPixels: 2,
            stroked: true,
            pickable: false,
          })
        );
      }

      // LoS 선상 항적/Loss 포인트 (맵에서 클릭 가능)
      if (losTrackPoints.length > 0) {
        const losTPData = losTrackPoints.map((tp, idx) => ({
          position: [tp.longitude, tp.latitude],
          idx,
          isLoss: tp.isLoss,
          radar_type: tp.radar_type,
        }));
        layers.push(
          new ScatterplotLayer({
            id: "los-track-points",
            data: losTPData,
            getPosition: (d: any) => d.position,
            getFillColor: (d: any) => d.isLoss ? [239, 68, 68, 180] : [...detectionTypeColor(d.radar_type), 140],
            getLineColor: [255, 255, 255, 100],
            getRadius: 3,
            radiusMinPixels: 2,
            radiusMaxPixels: 6,
            radiusUnits: "pixels",
            lineWidthMinPixels: 0.5,
            stroked: true,
            pickable: true,
            onClick: (info: any) => {
              if (info.object) {
                losPointClickedRef.current = true;
                const clickedIdx = info.object.idx;
                setLosHighlightIdx((prev) => prev === clickedIdx ? null : clickedIdx);
              }
            },
            onHover: (info: any) => {
              setLosHoverIdx(info.object ? info.object.idx : null);
            },
          })
        );
      }

      // LoS 맵 호버 마커 (핀과 별도)
      const effectiveHoverIdx = losHoverIdx !== null ? losHoverIdx : null;
      if (effectiveHoverIdx !== null && effectiveHoverIdx !== losHighlightIdx && losTrackPoints[effectiveHoverIdx]) {
        const htp = losTrackPoints[effectiveHoverIdx];
        layers.push(
          new ScatterplotLayer({
            id: "los-track-hover",
            data: [{ position: [htp.longitude, htp.latitude] }],
            getPosition: (d: any) => d.position,
            getFillColor: htp.isLoss ? [239, 68, 68, 200] : [...detectionTypeColor(htp.radar_type), 200],
            getLineColor: [255, 255, 255, 200],
            getRadius: 6,
            radiusMinPixels: 5,
            radiusMaxPixels: 11,
            radiusUnits: "pixels",
            lineWidthMinPixels: 1.5,
            stroked: true,
            pickable: false,
          })
        );
      }

      // LoS 단면도 항적 포인트 하이라이트 (핀) → 지도 위 마커
      if (losHighlightIdx !== null && losTrackPoints[losHighlightIdx]) {
        const tp = losTrackPoints[losHighlightIdx];
        layers.push(
          new ScatterplotLayer({
            id: "los-track-highlight",
            data: [{ position: [tp.longitude, tp.latitude] }],
            getPosition: (d: any) => d.position,
            getFillColor: tp.isLoss ? [239, 68, 68, 255] : [...detectionTypeColor(tp.radar_type), 255],
            getLineColor: [255, 255, 255, 255],
            getRadius: 8,
            radiusMinPixels: 7,
            radiusMaxPixels: 14,
            radiusUnits: "pixels",
            lineWidthMinPixels: 2.5,
            stroked: true,
            pickable: false,
          })
        );
      }
    }
    return layers;
  }, [losMode, losTarget, losCursor, radarInfo, radarSite.latitude, radarSite.longitude, losHoverRatio, losHighlightIdx, losHoverIdx, losTrackPoints]);

  // Loss 포인트 전용 deck.gl 레이어 (Loss 데이터 변경 시에만 재생성)
  const lossDeckLayers = useMemo(() => {
    if (signalLossPoints.length === 0 || hiddenLegendItems.has("loss")) return [];
    const acName = (ms: string) => {
      const a = aircraft.find((ac) => ac.mode_s_code.toLowerCase() === ms.toLowerCase());
      return a ? a.name : ms;
    };
    return [
      new ScatterplotLayer<LossPoint>({
        id: "loss-points",
        data: signalLossPoints,
        getPosition: (d) => losMode ? [d.longitude, d.latitude, 0] : [d.longitude, d.latitude, d.altitude * altScale],
        updateTriggers: { getPosition: [losMode, altScale] },
        getFillColor: [233, 69, 96, 200],
        getRadius: 3,
        radiusMinPixels: 1.5,
        radiusMaxPixels: 5,
        radiusUnits: "pixels",
        billboard: true,
        pickable: true,
        onClick: () => { if (losTarget) losPointClickedRef.current = true; },
        onHover: (info) => {
          if (info.object) {
            const d = info.object;
            const name = acName(d.mode_s);
            const altFt = Math.round(d.altitude / 0.3048);
            setHoverInfo({
              x: info.x,
              y: info.y,
              lines: [
                { label: "표적소실", value: name !== d.mode_s ? `${name} (${d.mode_s})` : d.mode_s, color: "#e94560" },
                { label: "예상시각", value: format(new Date(d.timestamp * 1000), "HH:mm:ss") },
                { label: "미탐지", value: `${d.scan_index}/${d.total_missed_scans} 스캔` },
                { label: "gap", value: `${d.gap_duration_secs.toFixed(1)}초` },
                { label: "고도", value: `FL${Math.round(altFt / 100)} (${Math.round(d.altitude)}m)` },
                { label: "레이더거리", value: `${d.radar_distance_km.toFixed(1)}km` },
                { label: "좌표", value: `${d.latitude.toFixed(4)}°N ${d.longitude.toFixed(4)}°E` },
              ],
            });
          } else {
            setHoverInfo(null);
          }
        },
      }),
    ];
  }, [signalLossPoints, hiddenLegendItems, losMode, altScale, aircraft]);

  // 건물 2D 오버레이 전용 deck.gl 레이어
  const buildingDeckLayers = useMemo(() => {
    if (!showBuildings || buildings3dData.length === 0 || buildings3dMode) return [];
    const hexToRgb = (hex: string): [number, number, number] => {
      const h = hex.replace("#", "");
      return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
    };
    const isHighlighted = (d: Building3D) =>
      losBuildingHighlight && Math.abs(d.lat - losBuildingHighlight.lat) < 0.0001 && Math.abs(d.lon - losBuildingHighlight.lon) < 0.0001;
    const fillColor = (d: Building3D): [number, number, number, number] => {
      if (isHighlighted(d)) return [249, 115, 22, 255]; // 주황색 하이라이트
      if (d.group_color) { const c = hexToRgb(d.group_color); return [c[0], c[1], c[2], 200]; }
      return d.source === "fac" ? [229, 231, 235, 220]
        : d.source === "manual" ? [239, 68, 68, 220]
        : [209, 213, 219, 220];
    };
    const buildingHover = (info: { object?: Building3D; x: number; y: number }) => {
      if (info.object) {
        const d = info.object;
        scheduleBldgHover({
          x: info.x, y: info.y, lat: d.lat, lon: d.lon,
          name: d.name || undefined, height: d.height_m, usage: d.usage || undefined,
        });
      } else {
        clearBldgHover();
      }
    };
    return [
      new ScatterplotLayer({
        id: "buildings-dots",
        data: buildings3dData,
        getPosition: (d: Building3D) => [d.lon, d.lat],
        getRadius: (d: Building3D) => isHighlighted(d) ? 6 : 3,
        radiusUnits: "pixels" as const,
        getFillColor: fillColor,
        updateTriggers: { getFillColor: [losBuildingHighlight], getRadius: [losBuildingHighlight] },
        pickable: true,
        onClick: (info: { object?: Building3D; x: number; y: number }) => {
          if (losTarget) losPointClickedRef.current = true;
          if (info.object) {
            const d = info.object;
            if (bldgHoverTimerRef.current) { clearTimeout(bldgHoverTimerRef.current); bldgHoverTimerRef.current = null; }
            setBldgPopup((prev) => {
              if (prev && Math.abs(prev.lat - d.lat) < 1e-6 && Math.abs(prev.lon - d.lon) < 1e-6) {
                return { ...prev, x: info.x, y: info.y, pinned: true };
              }
              return {
                x: info.x, y: info.y, lat: d.lat, lon: d.lon,
                loading: true, info: null,
                localName: d.name || undefined,
                localHeight: d.height_m,
                localUsage: d.usage || undefined,
                pinned: true,
              };
            });
          }
        },
        onHover: buildingHover,
      }),
    ];
  }, [showBuildings, buildings3dData, buildings3dMode, losBuildingHighlight]);

  // 파노라마 전용 deck.gl 레이어 (파노라마 모드 활성 시에만 재생성)
  const panoramaDeckLayers = useMemo(() => {
    if (!panoramaViewActive || !panoramaActivePoint) return [];
    const pt = panoramaActivePoint;
    const isBuilding = pt.obstacle_type !== "terrain";
    const hasPolygon = isBuilding && pt.polygon && pt.polygon.length >= 3;
    const color: [number, number, number, number] = isBuilding
      ? [239, 68, 68, 230]
      : [34, 197, 94, 230];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const layers: any[] = [
      new LineLayer({
        id: "panorama-direction-line",
        data: [pt],
        getSourcePosition: () => [radarSite.longitude, radarSite.latitude],
        getTargetPosition: (d) => [d.lon, d.lat],
        getColor: [...color.slice(0, 3), 100] as [number, number, number, number],
        getWidth: 2,
        widthMinPixels: 1.5,
        widthUnits: "pixels" as const,
      }),
    ];
    // 폴리곤 없는 장애물(지형, point-only 건물)은 기존 점 마커
    if (!hasPolygon) {
      layers.push(
        new ScatterplotLayer({
          id: "panorama-highlight-point",
          data: [pt],
          getPosition: (d) => [d.lon, d.lat],
          getFillColor: color,
          getLineColor: [255, 255, 255, 200] as [number, number, number, number],
          getRadius: panoramaPinned ? 8 : 6,
          radiusUnits: "pixels" as const,
          lineWidthMinPixels: panoramaPinned ? 2.5 : 1.5,
          stroked: true,
          pickable: false,
        }),
      );
    }
    return layers;
  }, [panoramaViewActive, panoramaActivePoint, panoramaPinned, radarSite.latitude, radarSite.longitude]);

  // 파노라마 장애물 건물 3D fill-extrusion (폴리곤이 있는 건물만)
  const panoramaObstacleGeoJSON = useMemo(() => {
    if (!panoramaViewActive || !panoramaActivePoint) return null;
    const pt = panoramaActivePoint;
    if (pt.obstacle_type === "terrain" || !pt.polygon || pt.polygon.length < 3) return null;
    // polygon: [[lat,lon], ...] → GeoJSON coordinates [[lon,lat], ...]
    const coords = pt.polygon.map(([lat, lon]) => [lon, lat]);
    const first = coords[0];
    const last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
    const bldgH = "height_m" in pt ? pt.height_m : (pt as any).obstacle_height_m ?? 0;
    return {
      type: "FeatureCollection" as const,
      features: [{
        type: "Feature" as const,
        properties: { height: bldgH, base: pt.ground_elev_m },
        geometry: { type: "Polygon" as const, coordinates: [coords] },
      }],
    };
  }, [panoramaViewActive, panoramaActivePoint]);

  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;
    const sourceId = "panorama-obstacle-3d-src";
    const layerId = "panorama-obstacle-3d-fill";

    if (panoramaObstacleGeoJSON) {
      const source = map.getSource(sourceId) as maplibregl.GeoJSONSource | undefined;
      if (source) {
        source.setData(panoramaObstacleGeoJSON);
      } else {
        map.addSource(sourceId, { type: "geojson", data: panoramaObstacleGeoJSON });
        map.addLayer({
          id: layerId,
          type: "fill-extrusion",
          source: sourceId,
          paint: {
            "fill-extrusion-color": panoramaPinned ? "#dc2626" : "#ef4444",
            "fill-extrusion-height": ["+", ["get", "base"], ["get", "height"]],
            "fill-extrusion-base": ["get", "base"],
            "fill-extrusion-opacity": panoramaPinned ? 0.95 : 0.8,
          },
        });
      }
      // 색상/투명도 업데이트
      if (map.getLayer(layerId)) {
        map.setPaintProperty(layerId, "fill-extrusion-color", panoramaPinned ? "#dc2626" : "#ef4444");
        map.setPaintProperty(layerId, "fill-extrusion-opacity", panoramaPinned ? 0.95 : 0.8);
        map.setLayoutProperty(layerId, "visibility", "visible");
      }
    } else {
      if (map.getLayer(layerId)) map.setLayoutProperty(layerId, "visibility", "none");
    }
  }, [panoramaObstacleGeoJSON, panoramaPinned]);

  // 필터된 트랙/포인트 데이터 (deckLayers 밖에서 캐시 — inline filter 방지)
  const filteredTrackPaths = useMemo(
    () => trackPaths.filter((d) => !hiddenLegendItems.has(d.radarType)),
    [trackPaths, hiddenLegendItems],
  );
  const filteredSinglePoints = useMemo(
    () => singlePoints.filter((d) => !hiddenLegendItems.has(d.point.radar_type)),
    [singlePoints, hiddenLegendItems],
  );
  const filteredDotPoints = useMemo(
    () => dotPoints.filter((d) => !hiddenLegendItems.has(d.radar_type)),
    [dotPoints, hiddenLegendItems],
  );

  // deck.gl 레이어
  const deckLayers = useMemo(() => {
    const layers = [];
    const acName = (ms: string) => {
      const a = aircraft.find((ac) => ac.mode_s_code.toLowerCase() === ms.toLowerCase());
      return a ? a.name : ms;
    };

    // 항적선 또는 원시 탐지점
    if (!trackLine) {
      // 수직선 (지면 → 고도)
      layers.push(
        new LineLayer<TrackPoint>({
          id: "dot-stems",
          data: filteredDotPoints,
          getSourcePosition: (d) => losMode ? [d.longitude, d.latitude, 0] : [d.longitude, d.latitude, 0],
          getTargetPosition: (d) => losMode ? [d.longitude, d.latitude, 0] : [d.longitude, d.latitude, d.altitude * altScale],
          updateTriggers: { getSourcePosition: [losMode], getTargetPosition: [losMode, altScale] },
          getColor: (d) => {
            const c = detectionTypeColor(d.radar_type);
            return [...c, 60];
          },
          getWidth: 1,
          widthMinPixels: 0.5,
          widthMaxPixels: 1.5,
          widthUnits: "pixels" as const,
        })
      );
      // 고도 위치 점
      layers.push(
        new ScatterplotLayer<TrackPoint>({
          id: "dot-points",
          data: filteredDotPoints,
          getPosition: (d) => losMode ? [d.longitude, d.latitude, 0] : [d.longitude, d.latitude, d.altitude * altScale],
          updateTriggers: { getPosition: [losMode, altScale] },
          getFillColor: (d) => {
            const c = detectionTypeColor(d.radar_type);
            return [...c, 200];
          },
          getRadius: 3,
          radiusMinPixels: 1.5,
          radiusMaxPixels: 5,
          radiusUnits: "pixels",
          billboard: true,
          pickable: true,
          onClick: () => { if (losTarget) losPointClickedRef.current = true; },
          onHover: (info) => {
            if (info.object) {
              const p = info.object;
              const altFt = Math.round(p.altitude / 0.3048);
              const name = acName(p.mode_s);
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "항적", value: name !== p.mode_s ? `${name} (${p.mode_s})` : p.mode_s, color: (() => { const c = detectionTypeColor(p.radar_type); return `rgb(${c[0]},${c[1]},${c[2]})`; })() },
                  { label: "시각", value: format(new Date(p.timestamp * 1000), "MM-dd HH:mm:ss") },
                  { label: "고도", value: `FL${Math.round(altFt / 100)} (${Math.round(p.altitude)}m)` },
                  { label: "속도", value: `${p.speed.toFixed(0)} kts` },
                  { label: "방위", value: `${p.heading.toFixed(0)}°` },
                  { label: "레이더", value: radarTypeLabel(p.radar_type) },
                  { label: "좌표", value: `${p.latitude.toFixed(4)}°N ${p.longitude.toFixed(4)}°E` },
                ],
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    } else {
      layers.push(
        new PathLayer<TrackPath>({
          id: "track-paths",
          data: filteredTrackPaths,
          getPath: (d) => d.path,
          getColor: (d) => [...d.color, 200],
          getWidth: 2,
          widthMinPixels: 1.5,
          widthMaxPixels: 4,
          widthUnits: "pixels",
          billboard: true,
          jointRounded: true,
          capRounded: true,
          pickable: true,
          autoHighlight: true,
          highlightColor: [255, 255, 255, 80],
          onClick: () => { if (losTarget) losPointClickedRef.current = true; },
          onHover: (info) => {
            if (info.object && info.coordinate) {
              const d = info.object;
              const [hLon, hLat] = info.coordinate;
              // 해당 세그먼트의 mode_s로 가장 가까운 실제 TrackPoint 찾기 (ref 사용 — 레이어 재생성 방지)
              let bestPt: TrackPoint | null = null;
              let bestDist = Infinity;
              for (const p of allPointsRef.current) {
                if (p.mode_s !== d.modeS) continue;
                const dl = p.latitude - hLat;
                const dn = p.longitude - hLon;
                const dist2 = dl * dl + dn * dn;
                if (dist2 < bestDist) {
                  bestDist = dist2;
                  bestPt = p;
                }
              }
              if (bestPt) {
                const p = bestPt;
                const altFt = Math.round(p.altitude / 0.3048);
                const name = acName(d.modeS);
                setHoverInfo({
                  x: info.x,
                  y: info.y,
                  lines: [
                    { label: "항적", value: name !== d.modeS ? `${name} (${d.modeS})` : d.modeS, color: `rgb(${d.color[0]},${d.color[1]},${d.color[2]})` },
                    { label: "시각", value: format(new Date(p.timestamp * 1000), "MM-dd HH:mm:ss") },
                    { label: "고도", value: `FL${Math.round(altFt / 100)} (${Math.round(p.altitude)}m)` },
                    { label: "속도", value: `${p.speed.toFixed(0)} kts` },
                    { label: "방위", value: `${p.heading.toFixed(0)}°` },
                    { label: "레이더", value: radarTypeLabel(p.radar_type) },
                    { label: "좌표", value: `${p.latitude.toFixed(4)}°N ${p.longitude.toFixed(4)}°E` },
                  ],
                });
              }
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    }

    // 1포인트 항적 (ScatterplotLayer)
    if (filteredSinglePoints.length > 0) {
      layers.push(
        new ScatterplotLayer({
          id: "track-single-points",
          data: filteredSinglePoints,
          getPosition: (d: any) => d.position,
          getFillColor: (d: any) => [d.color[0], d.color[1], d.color[2], 220] as [number, number, number, number],
          getLineColor: [255, 255, 255, 160],
          getRadius: 5,
          radiusMinPixels: 3,
          radiusMaxPixels: 10,
          radiusUnits: "pixels",
          stroked: true,
          lineWidthMinPixels: 1,
          billboard: true,
          pickable: true,
          onClick: () => { if (losTarget) losPointClickedRef.current = true; },
          onHover: (info: any) => {
            if (info.object) {
              const d = info.object;
              const p = d.point;
              const altFt = Math.round(p.altitude / 0.3048);
              const name = acName(d.modeS);
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "항적", value: name !== d.modeS ? `${name} (${d.modeS})` : d.modeS, color: `rgb(${d.color[0]},${d.color[1]},${d.color[2]})` },
                  { label: "시각", value: format(new Date(p.timestamp * 1000), "MM-dd HH:mm:ss") },
                  { label: "고도", value: `FL${Math.round(altFt / 100)} (${Math.round(p.altitude)}m)` },
                  { label: "속도", value: `${p.speed.toFixed(0)} kts` },
                  { label: "레이더", value: radarTypeLabel(p.radar_type) },
                  { label: "포인트", value: "1개 (단독)" },
                ],
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    }

    // 레이더 아이콘
    if (radarInfo) {
      layers.push(
        new IconLayer({
          id: "radar-icon",
          data: [radarInfo],
          getPosition: (d: typeof radarInfo) => [d.lon, d.lat, 0],
          getIcon: () => ({
            url: "/radar-icon.png",
            width: 570,
            height: 620,
            anchorY: 620,
          }),
          getSize: 50,
          sizeMinPixels: 24,
          sizeMaxPixels: 60,
          sizeUnits: "meters",
          billboard: true,
          pickable: true,
          onClick: () => { if (losTarget) losPointClickedRef.current = true; },
          onHover: (info) => {
            if (info.object) {
              const d = info.object as typeof radarInfo;
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "레이더", value: d!.name, color: "#22d3ee" },
                  { label: "지원범위", value: `${d!.rangeNm}NM (${d!.maxRange.toFixed(0)}km)` },
                  { label: "좌표", value: `${d!.lat.toFixed(4)}°N ${d!.lon.toFixed(4)}°E` },
                ],
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    }

    // LoS 레이어 합성 (별도 useMemo)
    layers.push(...losDeckLayers);

    // 커버리지 맵 합성 (2D/3D 모드에 따라 선택)
    layers.push(...coverageDeckLayers);

    // 건물 2D 오버레이 합성 (별도 useMemo)
    layers.push(...buildingDeckLayers);

    // LoS 단면도 건물 호버/클릭 하이라이트 (건물 오버레이 비활성 상태에서도 표시)
    if (losBuildingHighlight) {
      layers.push(
        new IconLayer({
          id: "los-building-highlight",
          data: [losBuildingHighlight],
          getPosition: (d: typeof losBuildingHighlight) => [d!.lon, d!.lat],
          getIcon: () => ({
            url: "/building-icon.png",
            width: 128,
            height: 128,
            anchorY: 128,
          }),
          getSize: 15,
          sizeUnits: "pixels" as const,
          pickable: false,
        })
      );
    }

    // ── 재생 중 비행기 아이콘 ──
    if (airplaneMarkers.length > 0) {
      layers.push(
        new IconLayer({
          id: "airplane-markers",
          data: airplaneMarkers,
          getPosition: (d: TrackPoint) => losMode ? [d.longitude, d.latitude] : [d.longitude, d.latitude, d.altitude * altScale],
          getIcon: () => ({
            url: "/airplane-icon.png",
            width: 512,
            height: 512,
            anchorX: 256,
            anchorY: 256,
          }),
          getSize: 22,
          sizeUnits: "pixels" as const,
          sizeMinPixels: 16,
          sizeMaxPixels: 32,
          getAngle: (d: TrackPoint) => -d.heading,
          billboard: false,
          pickable: true,
          onHover: (info) => {
            if (info.object) {
              const d = info.object as TrackPoint;
              const name = (() => { const a = aircraft.find(ac => ac.mode_s_code.toLowerCase() === d.mode_s.toLowerCase()); return a ? a.name : d.mode_s; })();
              const altFt = d.altitude * 3.28084;
              setHoverInfo({
                x: info.x,
                y: info.y,
                lines: [
                  { label: "기체", value: name !== d.mode_s ? `${name} (${d.mode_s})` : d.mode_s, color: "#3b82f6" },
                  { label: "시각", value: format(new Date(d.timestamp * 1000), "HH:mm:ss") },
                  { label: "고도", value: `FL${Math.round(altFt / 100)} (${Math.round(d.altitude)}m)` },
                  { label: "속도", value: `${(d.speed * 3.6).toFixed(0)} km/h` },
                  { label: "방위", value: `${d.heading.toFixed(0)}°` },
                ],
              });
            } else {
              setHoverInfo(null);
            }
          },
        })
      );
    }

    // Loss 포인트 합성 (별도 useMemo)
    layers.push(...lossDeckLayers);

    // 파노라마 레이어 합성 (별도 useMemo)
    layers.push(...panoramaDeckLayers);

    return layers;
  }, [filteredTrackPaths, filteredSinglePoints, filteredDotPoints, altScale, radarInfo, losMode, trackLine, aircraft, selectedModeS, losDeckLayers, coverageDeckLayers, buildingDeckLayers, lossDeckLayers, panoramaDeckLayers, losBuildingHighlight, airplaneMarkers]);

  // Aircraft name lookup
  const getAircraftName = useCallback(
    (modeS: string): string => {
      const a = aircraft.find(
        (ac) => ac.mode_s_code.toLowerCase() === modeS.toLowerCase()
      );
      return a ? `${a.name}` : modeS;
    },
    [aircraft]
  );

  // 모달/드롭다운 외부 클릭 닫기
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (aircraftDropRef.current && !aircraftDropRef.current.contains(e.target as Node)) {
        setAircraftDropOpen(false);
      }
      if (radarDropRef.current && !radarDropRef.current.contains(e.target as Node)) {
        setRadarDropOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Mode-S 검색 필터
  const filteredModeS = useMemo(() => {
    // 등록된 비행검사기는 상단 섹션에 표시되므로 제외
    const withoutRegistered = uniqueModeS.filter((ms) => !registeredModeS.has(ms));
    if (!modeSSearch) return withoutRegistered;
    const q = modeSSearch.toLowerCase();
    return withoutRegistered.filter((ms) => {
      const name = getAircraftName(ms).toLowerCase();
      return name.includes(q) || ms.toLowerCase().includes(q);
    });
  }, [uniqueModeS, modeSSearch, getAircraftName, registeredModeS]);

  // 레이더 사이트 목록
  const allRadarSites = customRadarSites;

  // 시작점 드래그
  const [draggingStart, setDraggingStart] = useState(false);
  const timelineRef = useRef<HTMLDivElement>(null);
  // 타임라인 GPU 렌더링
  const tlCanvasRef = useRef<HTMLCanvasElement>(null);
  const tlGpuRef = useRef<GPU2D | null>(null);

  // 타임라인 줌 (커서 기준 스크롤 축척)
  const [zoomView, setZoomView] = useState<[number, number]>([0, 100]);
  const zoomViewRef = useRef<[number, number]>([0, 100]);
  const zoomVStart = zoomView[0];
  const zoomVEnd = zoomView[1];
  const zoomRange = zoomVEnd - zoomVStart;
  const absToScreen = (abs: number) => zoomRange > 0 ? ((abs - zoomVStart) / zoomRange) * 100 : 0;

  // 타임라인 줌: 스크롤 핸들러
  useEffect(() => {
    const el = timelineRef.current;
    if (!el) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mouseRatio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
      const [vs, ve] = zoomViewRef.current;
      const cursorAbs = vs + mouseRatio * (ve - vs);
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      const newRange = Math.max(0.005, Math.min(100, (ve - vs) * factor));
      let ns = cursorAbs - mouseRatio * newRange;
      let ne = ns + newRange;
      if (ns < 0) { ns = 0; ne = Math.min(100, newRange); }
      if (ne > 100) { ne = 100; ns = Math.max(0, 100 - newRange); }
      zoomViewRef.current = [ns, ne];
      setZoomView([ns, ne]);
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [allPoints.length > 0]); // eslint-disable-line react-hooks/exhaustive-deps

  // 데이터 변경 시 줌 리셋
  useEffect(() => {
    zoomViewRef.current = [0, 100];
    setZoomView([0, 100]);
  }, [timeRange.min, timeRange.max]);

  // 재생 중 자동 팬 (재생 헤드가 뷰 우측 15% 이내에 도달 시)
  useEffect(() => {
    if (!playing) return;
    const [vs, ve] = zoomViewRef.current;
    if (ve >= 99.5) return;
    const range = ve - vs;
    const threshold = range * 0.15;
    if (sliderValue > ve - threshold) {
      const shift = range * 0.3;
      const newEnd = Math.min(100, ve + shift);
      const newStart = Math.max(0, newEnd - range);
      zoomViewRef.current = [newStart, newEnd];
      setZoomView([newStart, newEnd]);
    }
  }, [sliderValue, playing]);

  // 표시 시간 포맷 (날짜 포함)
  const fmtDate = useCallback(
    (ts: number) => (ts > 0 ? format(new Date(ts * 1000), "yyyy-MM-dd") : "----/--/--"),
    []
  );
  const fmtTime = useCallback(
    (ts: number) => (ts > 0 ? format(new Date(ts * 1000), "HH:mm:ss") : "--:--:--"),
    []
  );

  // 타임라인 띠 데이터: 각 Mode-S별 시간 구간 (dot 형태로 시각화)
  const timelineBands = useMemo(() => {
    if (allPointsByModeS.size === 0 || timeRange.max <= timeRange.min) return [];
    const range = timeRange.max - timeRange.min;
    const bands: { modeS: string; color: [number, number, number]; segments: { start: number; end: number }[] }[] = [];
    for (const [modeS, pts] of allPointsByModeS) {
      // 단일 패스: 타임스탬프 수집 + 탐지 유형 카운트
      const times: number[] = new Array(pts.length);
      const typeCounts = new Map<string, number>();
      for (let i = 0; i < pts.length; i++) {
        times[i] = pts[i].timestamp;
        typeCounts.set(pts[i].radar_type, (typeCounts.get(pts[i].radar_type) ?? 0) + 1);
      }
      let dominantType = "mode_s_rollcall";
      let maxCount = 0;
      for (const [rt, cnt] of typeCounts) {
        if (cnt > maxCount) { maxCount = cnt; dominantType = rt; }
      }
      const color = detectionTypeColor(dominantType);
      // 연속 구간 병합 (15초 이내 gap은 연결)
      const sorted = times.sort((a, b) => a - b);
      const segments: { start: number; end: number }[] = [];
      let segStart = sorted[0], segEnd = sorted[0];
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] - segEnd <= 15) {
          segEnd = sorted[i];
        } else {
          segments.push({
            start: ((segStart - timeRange.min) / range) * 100,
            end: ((segEnd - timeRange.min) / range) * 100,
          });
          segStart = sorted[i];
          segEnd = sorted[i];
        }
      }
      segments.push({
        start: ((segStart - timeRange.min) / range) * 100,
        end: ((segEnd - timeRange.min) / range) * 100,
      });
      bands.push({ modeS, color, segments });
    }
    return bands;
  }, [allPointsByModeS, timeRange]);

  // 타임라인 GPU 정리 (언마운트 시)
  useEffect(() => {
    return () => { tlGpuRef.current?.dispose(); tlGpuRef.current = null; };
  }, []);

  // ── 타임라인 GPU 렌더링 (밴드 + Loss 마커, lazy-init) ──
  const tlLossMarkers = useMemo(() => {
    const range = timeRange.max - timeRange.min;
    if (range <= 0) return [];
    return allLoss
      .map((l) => ({
        startPct: ((l.start_time - timeRange.min) / range) * 100,
        endPct: ((l.end_time - timeRange.min) / range) * 100,
      }))
      .filter((lm) => lm.endPct > lm.startPct);
  }, [allLoss, timeRange]);

  useLayoutEffect(() => {
    const canvas = tlCanvasRef.current;
    const el = timelineRef.current;
    if (!canvas || !el) return;
    // GPU2D lazy-init (캔버스가 조건부 렌더링이므로 여기서 초기화)
    // 캔버스 엘리먼트가 변경되었으면 (조건부 렌더링으로 재마운트) GPU2D 재생성
    if (tlGpuRef.current && tlGpuRef.current.canvas !== canvas) {
      tlGpuRef.current.dispose();
      tlGpuRef.current = null;
    }
    if (!tlGpuRef.current) {
      try {
        tlGpuRef.current = new GPU2D(canvas);
      } catch (e) {
        console.warn('[Timeline] WebGL2 초기화 실패:', e);
        return;
      }
    }
    const gpu = tlGpuRef.current;
    const w = el.clientWidth;
    const h = el.clientHeight;
    if (w <= 0 || h <= 0) return;
    gpu.setResolution(w, h);
    gpu.syncSize(w, h);
    gpu.clear();
    const rects: RectData[] = [];
    const bandCount = Math.max(1, timelineBands.length);
    // 밴드 세그먼트
    for (let bi = 0; bi < timelineBands.length; bi++) {
      const band = timelineBands[bi];
      const bandH = Math.max(3, h / bandCount);
      const bandY = (bi / bandCount) * h;
      for (const seg of band.segments) {
        const l = zoomRange > 0 ? ((seg.start - zoomVStart) / zoomRange) * 100 : 0;
        const r = zoomRange > 0 ? ((seg.end - zoomVStart) / zoomRange) * 100 : 0;
        if (r < -5 || l > 105) continue;
        const x = (l / 100) * w;
        const segW = Math.max(0.3 * w / 100, ((r - l) / 100) * w);
        rects.push({
          x, y: bandY, w: segW, h: bandH,
          color: [band.color[0] / 255, band.color[1] / 255, band.color[2] / 255, 0.5],
        });
      }
    }
    // Loss 마커
    for (const lm of tlLossMarkers) {
      const l = zoomRange > 0 ? ((lm.startPct - zoomVStart) / zoomRange) * 100 : 0;
      const r = zoomRange > 0 ? ((lm.endPct - zoomVStart) / zoomRange) * 100 : 0;
      if (r < -5 || l > 105) continue;
      const x = (l / 100) * w;
      const lw = Math.max(0.3 * w / 100, ((r - l) / 100) * w);
      rects.push({ x, y: h - 3, w: lw, h: 3, color: [239 / 255, 68 / 255, 68 / 255, 0.8] });
    }
    gpu.drawRects(rects);
    gpu.flush();
  }, [timelineBands, tlLossMarkers, zoomVStart, zoomRange]);

  return (
    <div className="flex h-full flex-col">
      {/* 타이틀바 포탈: 왼쪽 (드롭다운+토글+재생) */}
      {portalReady && createPortal(
        <div className="p-3 space-y-4">
        {/* 항공기 선택 */}
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">항공기</div>
          <div ref={aircraftDropRef} className="relative">
          <button
            onClick={() => { setAircraftDropOpen(!aircraftDropOpen); setRadarDropOpen(false); setModeSSearch(""); }}
            className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
              aircraftDropOpen
                ? "border-[#a60739] bg-[#a60739]/5 text-[#a60739]"
                : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
            }`}
          >
            <Plane size={14} fill="white" className="shrink-0" />
            <span className="flex-1 truncate text-left font-medium">
              {!selectedModeS ? "등록 기체" : selectedModeS === "__ALL__" ? "전체 항적" : getAircraftName(selectedModeS)}
            </span>
            <ChevronDown size={12} className={`shrink-0 transition-transform ${aircraftDropOpen ? "rotate-180" : ""}`} />
          </button>
          {aircraftDropOpen && (
            <div className="absolute left-0 right-0 top-full z-[2000] mt-1 rounded-lg border border-gray-200 bg-white/95 shadow-xl backdrop-blur-sm">
              <div className="px-2 pt-2 pb-1">
                <input
                  type="text"
                  value={modeSSearch}
                  onChange={(e) => setModeSSearch(e.target.value)}
                  placeholder="검색..."
                  className="w-full rounded border border-gray-300 bg-white px-2 py-1 text-xs text-gray-800 outline-none placeholder:text-gray-400 focus:border-[#a60739]/50"
                  autoFocus
                />
              </div>
              <div className="max-h-56 overflow-y-auto py-1 px-1 pb-2">
                <button
                  onClick={() => { setSelectedModeS(null); setSelectedFlightId(null); setAircraftDropOpen(false); }}
                  className={`w-full px-3 py-1.5 text-left text-xs rounded transition-colors ${!selectedModeS ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                >
                  등록 기체 전체
                </button>
                {aircraft.filter((a) => a.active && (!modeSSearch || a.name.toLowerCase().includes(modeSSearch.toLowerCase()) || a.mode_s_code.toLowerCase().includes(modeSSearch.toLowerCase()))).map((a) => (
                  <button
                    key={`ac-${a.id}`}
                    onClick={() => { setSelectedModeS(a.mode_s_code.toUpperCase()); setSelectedFlightId(null); setAircraftDropOpen(false); }}
                    className={`w-full px-3 py-1.5 text-left text-xs rounded transition-colors ${selectedModeS === a.mode_s_code.toUpperCase() ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                  >
                    <div className="flex items-center gap-2">
                      <span>{a.name}</span>
                      <span className={`text-[10px] ${selectedModeS === a.mode_s_code.toUpperCase() ? "text-white/60" : "text-gray-400"}`}>{a.mode_s_code}</span>
                    </div>
                  </button>
                ))}
                <div className="border-t border-gray-200 my-1 mx-2" />
                <button
                  onClick={() => { setSelectedModeS("__ALL__"); setSelectedFlightId(null); setAircraftDropOpen(false); }}
                  className={`w-full px-3 py-1.5 text-left text-xs rounded transition-colors ${selectedModeS === "__ALL__" ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                >
                  전체 항적
                </button>
                {filteredModeS.map((ms) => (
                  <button
                    key={ms}
                    onClick={() => { setSelectedModeS(ms); setSelectedFlightId(null); setAircraftDropOpen(false); }}
                    className={`w-full px-3 py-1.5 text-left text-xs rounded transition-colors ${selectedModeS === ms ? "bg-[#a60739] text-white" : "text-gray-600 hover:bg-gray-100"}`}
                  >
                    {getAircraftName(ms)}
                  </button>
                ))}
                {filteredModeS.length === 0 && aircraft.filter((a) => a.active).length === 0 && modeSSearch && (
                  <div className="px-3 py-2 text-xs text-gray-400">검색 결과 없음</div>
                )}
              </div>
            </div>
          )}
          </div>
        </div>

        {/* 레이더 선택 */}
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">레이더</div>
          <div ref={radarDropRef} className="relative">
          <button
            onClick={() => { setRadarDropOpen(!radarDropOpen); setAircraftDropOpen(false); }}
            className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-xs transition-colors ${
              radarDropOpen
                ? "border-[#a60739] bg-[#a60739]/5 text-[#a60739]"
                : "border-gray-200 bg-white text-gray-700 hover:border-gray-300"
            }`}
          >
            <Radar size={14} className="shrink-0" />
            <span className="flex-1 truncate text-left font-medium">{radarSite.name}</span>
            <ChevronDown size={12} className={`shrink-0 transition-transform ${radarDropOpen ? "rotate-180" : ""}`} />
          </button>
          {radarDropOpen && (
            <div className="absolute left-0 right-0 top-full z-[2000] mt-1 rounded-lg border border-gray-200 bg-white/95 shadow-xl backdrop-blur-sm">
              <div className="max-h-56 overflow-y-auto py-1 px-1">
                {allRadarSites.map((site) => (
                  <button
                    key={site.name}
                    onClick={() => { setRadarSite(site); setRadarDropOpen(false); }}
                    className={`w-full px-3 py-1.5 text-left text-xs rounded transition-colors ${
                      radarSite.name === site.name
                        ? "bg-[#a60739] text-white"
                        : "text-gray-600 hover:bg-gray-100"
                    }`}
                  >
                    <div className="font-medium">{site.name}</div>
                    <div className={`text-[10px] ${radarSite.name === site.name ? "text-white/60" : "text-gray-400"}`}>
                      {site.range_nm}NM
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
          </div>
        </div>

        {/* 재생 */}
        {allPoints.length > 0 && (
          <PlaybackControls
            playing={playing} setPlaying={setPlaying}
            sliderValue={sliderValue} setSliderValue={setSliderValue}
            rangeStart={rangeStart} setRangeStart={setRangeStart}
            trailDuration={trailDuration} setTrailDuration={setTrailDuration}
            timeRange={timeRange} isAllTrackMode={isAllTrackMode} maxWindowSecs={MAX_WINDOW_SECS}
          />
        )}

        {/* 표시 토글 */}
        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-400">표시</div>
          <div className="space-y-2.5">

        {/* 항적선 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={trackLine ? "text-[#a60739]" : "text-gray-400"}><TrackLineIcon size={14} /></span>
            <span className="text-xs text-gray-600">항적선</span>
          </div>
          <button
            onClick={() => setTrackLine(!trackLine)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${trackLine ? "bg-[#a60739]" : "bg-gray-300"}`}
            role="switch"
            aria-checked={trackLine}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${trackLine ? "translate-x-4.5" : "translate-x-0.5"}`} />
          </button>
        </div>

        {/* 건물 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 size={14} className={showBuildings && buildings3dData.length > 0 ? "text-[#a60739]" : "text-gray-400"} />
            <span className="text-xs text-gray-600">건물</span>
          </div>
          {buildingsLoading ? (
            <Loader2 size={16} className="animate-spin text-[#a60739]" />
          ) : (
            <button
              onClick={() => {
                if (buildings3dData.length > 0) {
                  setShowBuildings(!showBuildings);
                } else {
                  fetchBuildingOverlay();
                }
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${showBuildings && buildings3dData.length > 0 ? "bg-[#a60739]" : "bg-gray-300"}`}
              role="switch"
              aria-checked={showBuildings && buildings3dData.length > 0}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${showBuildings && buildings3dData.length > 0 ? "translate-x-4.5" : "translate-x-0.5"}`} />
            </button>
          )}
        </div>

        {/* 지형 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={`flex h-3.5 w-3.5 items-center justify-center text-[9px] font-bold ${terrainEnabled ? "text-[#a60739]" : "text-gray-400"}`}>3D</span>
            <span className="text-xs text-gray-600">지형</span>
          </div>
          <button
            onClick={() => setTerrainEnabled(!terrainEnabled)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${terrainEnabled ? "bg-[#a60739]" : "bg-gray-300"}`}
            role="switch"
            aria-checked={terrainEnabled}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${terrainEnabled ? "translate-x-4.5" : "translate-x-0.5"}`} />
          </button>
        </div>

          </div>
        </div>

        {/* ── 도구 ────────────────── */}
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">도구</div>
          <div className="space-y-2">

          {/* LoS 분석 — Collapsible */}
          <div className={`rounded-lg border transition-colors ${losExpanded ? "border-[#a60739]/30 bg-[#a60739]/5" : "border-gray-200 bg-gray-50"}`}>
            <button
              onClick={() => {
                const entering = !losExpanded;
                setLosExpanded(entering);
                if (!entering) {
                  // 패널 닫기 → LoS 모드 해제
                  setLosMode(false);
                  setLosTarget(null);
                  setLosCursor(null);
                  setLosHighlightIdx(null);
                  setLosCursorPicking(false);
                  setLosBuildingHighlight(null);
                  setDetailBuilding(null);
                  const map = mapRef.current?.getMap();
                  if (map) map.easeTo({ pitch: savedPitchRef.current, bearing: savedBearingRef.current, duration: 500 });
                }
              }}
              className="flex w-full items-center justify-between px-3 py-2.5"
            >
              <div className="flex items-center gap-2">
                <Mountain size={14} className={losExpanded ? "text-[#a60739]" : "text-gray-400"} />
                <span className={`text-xs font-medium ${losExpanded ? "text-[#a60739]" : "text-gray-600"}`}>LoS 분석</span>
              </div>
              <ChevronDown size={14} className={`transition-transform text-gray-400 ${losExpanded ? "rotate-180" : ""}`} />
            </button>

            {losExpanded && (
              <div className="px-3 pb-2.5 space-y-3">
                {/* 지점 선택 버튼 + 주소 검색 */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => {
                      const entering = !losCursorPicking;
                      setLosCursorPicking(entering);
                      if (entering && !losMode) {
                        // LoS 모드 진입: 카메라 수직 뷰로 전환
                        setLosMode(true);
                        savedPitchRef.current = viewState.pitch ?? 45;
                        savedBearingRef.current = viewState.bearing ?? 0;
                        const map = mapRef.current?.getMap();
                        if (map) map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
                      }
                    }}
                    className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border transition-colors ${losCursorPicking ? "border-[#a60739] bg-[#a60739] text-white" : "border-gray-300 text-gray-500 hover:border-gray-400"}`}
                    title="지도에서 지점 선택"
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
                      <circle cx="8" cy="8" r="5" />
                      <line x1="8" y1="1" x2="8" y2="4" />
                      <line x1="8" y1="12" x2="8" y2="15" />
                      <line x1="1" y1="8" x2="4" y2="8" />
                      <line x1="12" y1="8" x2="15" y2="8" />
                    </svg>
                  </button>
                  <LosAddressSearch onSelect={(lat, lon) => {
                    if (lat !== 0 && lon !== 0) {
                      // 주소 방향으로 30NM 지점을 기본 타겟으로 설정
                      const dLat = lat - radarSite.latitude;
                      const dLon = lon - radarSite.longitude;
                      const cosLat = Math.cos(radarSite.latitude * Math.PI / 180);
                      const az = ((Math.atan2(dLon * cosLat, dLat) * 180 / Math.PI) + 360) % 360;
                      const defaultDistKm = 30 * 1.852; // 30NM
                      setLosFromAzDist(az, defaultDistKm);
                      setLosSearchedAddress({ lat, lon });
                      setLosCursorPicking(false);
                    }
                  }} />
                </div>

                {/* 방위 선택 원 + 정보 */}
                <div className="flex items-center gap-3">
                  <AzimuthCircle
                    azimuth={losAzimuth}
                    disabled={false}
                    onChange={(az) => { setLosFromAzDist(az, losDistanceKm); setLosSearchedAddress(null); setLosAzFineCenter(az); }}
                  />
                  <div className="flex-1 space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-500">방위</span>
                      <span className="text-[10px] font-medium text-[#a60739]">{losAzimuth.toFixed(3)}°</span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] text-gray-500">거리</span>
                      <span className="text-[10px] font-medium text-[#a60739]">{(losDistanceKm / 1.852).toFixed(1)}NM</span>
                    </div>
                  </div>
                </div>

                {/* 초정밀 방위 슬라이더 (±2°, 0.001° step) */}
                <div className="space-y-1">
                  <input
                    type="range"
                    min={losAzFineCenter - 2} max={losAzFineCenter + 2} step={0.001}
                    value={Math.min(losAzFineCenter + 2, Math.max(losAzFineCenter - 2, losAzimuth))}
                    onChange={(e) => { setLosFromAzDist(Number(e.target.value), losDistanceKm); setLosSearchedAddress(null); }}
                    className="w-full accent-[#a60739]"
                  />
                  <div className="flex justify-between text-[9px] text-gray-400">
                    <span>{(losAzFineCenter - 2).toFixed(3)}°</span>
                    <span className="text-[#a60739]/60">초정밀 ±2° (0.001°)</span>
                    <span>{(losAzFineCenter + 2).toFixed(3)}°</span>
                  </div>
                </div>

                {/* 거리 슬라이더 (NM) */}
                <div className="space-y-1">
                  <input
                    type="range" min={1} max={Math.round(radarSite.range_nm)} step={1}
                    value={Math.min(Math.round(losDistanceKm / 1.852), Math.round(radarSite.range_nm))}
                    onChange={(e) => { setLosFromAzDist(losAzimuth, Number(e.target.value) * 1.852); setLosSearchedAddress(null); }}
                    disabled={false}
                    className="w-full accent-[#a60739] disabled:opacity-40"
                  />
                  <div className="flex justify-between text-[9px] text-gray-400">
                    <span>1NM</span>
                    <span>{Math.round(radarSite.range_nm)}NM</span>
                  </div>
                </div>

                {losCursorPicking && !losTarget && (
                  <div className="text-[10px] text-[#a60739]/70">
                    지도에서 분석할 지점을 클릭하세요
                  </div>
                )}
              </div>
            )}
          </div>

          {/* 레이더 커버리지 — Collapsible */}
          <CoveragePanel
            radarSite={radarSite}
            gpuCacheReady={gpuCacheReady} setGpuCacheReady={setGpuCacheReady}
            coverageAlt={coverageAlt} setCoverageAlt={setCoverageAlt}
            coverageAltMin={coverageAltMin} setCoverageAltMin={setCoverageAltMin}
            coverageOpacity={coverageOpacity} setCoverageOpacity={setCoverageOpacity}
            coverageExpanded={coverageExpanded} setCoverageExpanded={setCoverageExpanded}
            coverageRendering={coverageRendering}
            mapRef={mapRef}
          />

          </div>
        </div>
        </div>,
        document.getElementById("trackmap-sidebar")!,
      )}

      {/* 타이틀바 포탈: 오른쪽 (통계) */}
      {portalReady && createPortal(
        <div className="flex items-center gap-3 text-[10px] text-gray-400 mr-1">
          <span>{allPoints.length.toLocaleString()} pts</span>
          <span className="text-[#a60739]">Loss {signalLossPoints.length}pt/{signalLoss.length}gap</span>
          {isAllTrackMode && (timeRange.max - timeRange.min) > MAX_WINDOW_SECS && (
            <span className="text-amber-500 font-medium">24h 윈도우</span>
          )}
        </div>,
        document.getElementById("trackmap-toolbar-right")!,
      )}

      {/* LoS cursor picking indicator */}
      {losCursorPicking && !losTarget && (
        <div className="flex items-center gap-2 bg-[#a60739]/10 px-4 py-1.5 text-xs text-[#a60739]">
          <Crosshair size={12} />
          <span>지도에서 분석할 지점을 클릭하세요</span>
          <button
            onClick={() => { setLosCursorPicking(false); }}
            className="ml-auto text-[10px] text-gray-500 hover:text-gray-900"
          >
            취소
          </button>
        </div>
      )}

      {/* Map + Building Detail sidebar wrapper */}
      <div className="relative flex flex-1 min-h-0">
      {/* Map container */}
      <div className="flex flex-col flex-1 min-w-0">
        <div className="relative flex-1">
        <MapGL
          ref={mapRef}
          {...viewState}
          onMove={(evt) => {
            setViewState(evt.viewState);
            const is3d = evt.viewState.zoom >= 14;
            if (is3d !== buildings3dMode) setBuildings3dMode(is3d);
          }}
          onLoad={onMapLoad}
          onClick={handleMapClick}
          onMouseMove={handleMapMouseMove}
          mapStyle={MAP_STYLE_URL}
          maxPitch={85}
          style={{ width: "100%", height: "100%" }}
          cursor={losCursorPicking ? "crosshair" : undefined}
          attributionControl={false}
          // @ts-expect-error preserveDrawingBuffer, powerPreference are valid maplibre options but not typed in react-map-gl
          preserveDrawingBuffer={true}
          powerPreference="high-performance"
        >
          <DeckGLOverlay layers={deckLayers} />
          <NavigationControl position="top-right" showZoom={false} />
          {addressMarker && (
            <AddressMarker marker={addressMarker} onClose={() => setAddressMarker(null)} />
          )}
        </MapGL>

        <AddressSearch onSelect={handleAddressSelect} />

        {/* Hover tooltip */}
        {hoverInfo && (
          <div
            className="pointer-events-none absolute z-[9999] rounded-lg border border-gray-200 bg-white/95 px-3 py-2.5 text-xs shadow-xl backdrop-blur-sm"
            style={{ left: hoverInfo.x + 14, top: hoverInfo.y - 14 }}
          >
            {hoverInfo.lines.map((line, i) => (
              <div key={i} className={`flex items-center gap-2 ${i > 0 ? "mt-1" : ""}`}>
                {i === 0 && line.color && (
                  <span className="inline-block h-2 w-2 rounded-full" style={{ backgroundColor: line.color }} />
                )}
                <span className="text-gray-500">{line.label}</span>
                <span className={i === 0 ? "font-semibold text-gray-800" : "text-gray-600"}>
                  {line.value}
                </span>
              </div>
            ))}
          </div>
        )}

        {/* 커버리지 최저 탐지고도 tooltip */}
        {!hoverInfo && coverageTooltip && !coverageTooltip.loading && coverageTooltip.altFt !== null && (
          <div
            className="pointer-events-none absolute z-[9999] rounded-md border border-[#a60739]/20 bg-white/95 px-2.5 py-1.5 text-xs shadow-lg backdrop-blur-sm"
            style={{ left: coverageTooltip.x + 14, top: coverageTooltip.y - 14 }}
          >
            <div className="flex items-center gap-1.5">
              <Radar size={11} className="text-[#a60739]" />
              <span className="text-gray-500">최저 탐지고도</span>
              <span className="font-semibold text-[#a60739]">{coverageTooltip.altFt.toLocaleString()}ft</span>
            </div>
          </div>
        )}



        {/* 건축물정보 팝업 (건물 클릭 시) — VWorld 스타일 */}
        {bldgPopup && (
          <div
            className="absolute z-[1100] rounded-lg border border-gray-300 bg-white shadow-xl"
            style={{
              left: Math.min(bldgPopup.x + 14, window.innerWidth - 380),
              top: Math.max(bldgPopup.y - 14, 8),
              width: 360,
            }}
          >
            {/* 헤더 */}
            <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2">
              <span className="text-[12px] font-bold text-gray-800">건축물정보</span>
              <button
                onClick={() => setBldgPopup(null)}
                className="rounded p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors"
              >
                <X size={13} />
              </button>
            </div>
            {/* 본문 */}
            <div className="max-h-[420px] overflow-y-auto">
              {bldgPopup.loading ? (
                <div className="flex items-center justify-center gap-2 px-3 py-5 text-[11px] text-gray-400">
                  <Loader2 size={13} className="animate-spin" />
                  조회 중...
                </div>
              ) : (() => {
                const bi = bldgPopup.info;
                const displayName = bi?.name || bldgPopup.localName || "";
                const hasInfo = bi && (bi.name || bi.road_addr || bi.jibun_addr || bi.usage || bi.structure || bi.height);
                if (!hasInfo) {
                  return (
                    <div className="px-3 py-4">
                      <div className="text-[11px] text-gray-400 text-center mb-2">건축물정보 없음</div>
                      {(bldgPopup.localHeight || bldgPopup.localUsage) && (
                        <table className="w-full text-[11px] border-t border-gray-200">
                          <tbody>
                            {bldgPopup.localHeight != null && (
                              <tr className="border-b border-gray-100">
                                <td className="px-2 py-1.5 bg-gray-50 text-gray-500 w-[80px]">건물높이</td>
                                <td className="px-2 py-1.5 text-gray-700">{bldgPopup.localHeight.toFixed(1)} m</td>
                              </tr>
                            )}
                            {bldgPopup.localUsage && (
                              <tr>
                                <td className="px-2 py-1.5 bg-gray-50 text-gray-500">건물용도</td>
                                <td className="px-2 py-1.5 text-gray-700">{bldgPopup.localUsage}</td>
                              </tr>
                            )}
                          </tbody>
                        </table>
                      )}
                    </div>
                  );
                }
                return (
                  <>
                    {/* 건물명/주소 배너 */}
                    <div className="mx-3 mt-3 mb-2 rounded border border-gray-200 bg-gray-50 px-2.5 py-2 space-y-1">
                      {displayName && (
                        <div className="text-[12px] font-semibold text-gray-800">{displayName}</div>
                      )}
                      {bi?.road_addr && (
                        <div className="flex items-start gap-1.5 text-[10.5px]">
                          <span className="shrink-0 rounded-sm bg-[#a60739] px-1.5 py-[1px] text-[9px] font-semibold text-white">도로명</span>
                          <span className="text-gray-700 leading-[14px]">{bi.road_addr}</span>
                        </div>
                      )}
                      {bi?.jibun_addr && (
                        <div className="flex items-start gap-1.5 text-[10.5px]">
                          <span className="shrink-0 rounded-sm bg-gray-500 px-1.5 py-[1px] text-[9px] font-semibold text-white">지번</span>
                          <span className="text-gray-700 leading-[14px]">{bi.jibun_addr}</span>
                        </div>
                      )}
                    </div>
                    {/* 상세 테이블 */}
                    <table className="w-full border-t border-gray-200 text-[10.5px]">
                      <tbody>
                        <tr className="border-b border-gray-100">
                          <td className="w-[68px] bg-gray-50 px-2 py-1.5 text-gray-500">건물명칭</td>
                          <td className="px-2 py-1.5 text-gray-700" colSpan={3}>{bi?.name || "-"}</td>
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="w-[68px] bg-gray-50 px-2 py-1.5 text-gray-500">건물동명칭</td>
                          <td className="px-2 py-1.5 text-gray-700">{bi?.dong_name || "-"}</td>
                          <td className="w-[68px] bg-gray-50 px-2 py-1.5 text-gray-500">건물용도</td>
                          <td className="px-2 py-1.5 text-gray-700">{bi?.usage || "-"}</td>
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="bg-gray-50 px-2 py-1.5 text-gray-500">구조</td>
                          <td className="px-2 py-1.5 text-gray-700" colSpan={3}>{bi?.structure || "-"}</td>
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="bg-gray-50 px-2 py-1.5 text-gray-500">지상층수</td>
                          <td className="px-2 py-1.5 text-gray-700">{bi?.floors_above ? `${bi.floors_above} 층` : "-"}</td>
                          <td className="bg-gray-50 px-2 py-1.5 text-gray-500">지하층수</td>
                          <td className="px-2 py-1.5 text-gray-700">{bi?.floors_below ? `${bi.floors_below} 층` : "-"}</td>
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="bg-gray-50 px-2 py-1.5 text-gray-500">건물면적</td>
                          <td className="px-2 py-1.5 text-gray-700">{bi?.area ? `${bi.area} ㎡` : "-"}</td>
                          <td className="bg-gray-50 px-2 py-1.5 text-gray-500">건물높이</td>
                          <td className="px-2 py-1.5 text-gray-700">{bi?.height ? `${bi.height} m` : "-"}</td>
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="bg-gray-50 px-2 py-1.5 text-gray-500">용적률</td>
                          <td className="px-2 py-1.5 text-gray-700">{bi?.floor_area_ratio ? `${bi.floor_area_ratio} %` : "-"}</td>
                          <td className="bg-gray-50 px-2 py-1.5 text-gray-500">건폐율</td>
                          <td className="px-2 py-1.5 text-gray-700">{bi?.building_coverage ? `${bi.building_coverage} %` : "-"}</td>
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="bg-gray-50 px-2 py-1.5 text-gray-500">연면적</td>
                          <td className="px-2 py-1.5 text-gray-700" colSpan={3}>{bi?.total_area ? `${bi.total_area} ㎡` : "-"}</td>
                        </tr>
                        <tr className="border-b border-gray-100">
                          <td className="bg-gray-50 px-2 py-1.5 text-gray-500">대지면적</td>
                          <td className="px-2 py-1.5 text-gray-700" colSpan={3}>{bi?.site_area ? `${bi.site_area} ㎡` : "-"}</td>
                        </tr>
                        <tr>
                          <td className="bg-gray-50 px-2 py-1.5 text-gray-500">사용승인일자</td>
                          <td className="px-2 py-1.5 text-gray-700" colSpan={3}>{bi?.approval_date || "-"}</td>
                        </tr>
                      </tbody>
                    </table>
                  </>
                );
              })()}
            </div>
            {/* 좌표 푸터 */}
            <div className="border-t border-gray-200 px-3 py-1.5 text-[9px] text-gray-400">
              {bldgPopup.lat.toFixed(6)}°N, {bldgPopup.lon.toFixed(6)}°E
            </div>
          </div>
        )}

        {/* 범례 (왼쪽 하단) — 항적/건물/커버리지 중 하나라도 활성이면 표시 */}
        {(allPoints.length > 0 || showBuildings || coverageVisible) && (
          <div className="absolute bottom-3 left-3 z-[1000] rounded-lg border border-gray-200 bg-white/95 px-3 py-2.5 text-[10px] backdrop-blur-sm shadow-lg">
            <div className="mb-1.5 text-[9px] font-semibold text-gray-500 uppercase tracking-wider">범례</div>
            <div className="space-y-1">
              {/* 탐지 유형 범례 (항적 있을 때만) */}
              {allPoints.length > 0 && (() => {
                const shown = new Map<string, [number,number,number]>();
                for (const tp of trackPaths) {
                  if (!shown.has(tp.radarType)) shown.set(tp.radarType, tp.color);
                }
                return Array.from(shown.entries()).map(([rt, color]) => {
                  const hidden = hiddenLegendItems.has(rt);
                  return (
                    <label key={rt} className="flex items-center gap-1.5 cursor-pointer select-none group">
                      <input
                        type="checkbox"
                        checked={!hidden}
                        onChange={() => setHiddenLegendItems((prev) => {
                          const next = new Set(prev);
                          if (next.has(rt)) next.delete(rt); else next.add(rt);
                          return next;
                        })}
                        className="sr-only"
                      />
                      <span
                        className="inline-block h-[3px] w-4 rounded-sm transition-opacity"
                        style={{
                          backgroundColor: `rgb(${color[0]},${color[1]},${color[2]})`,
                          opacity: hidden ? 0.25 : 1,
                        }}
                      />
                      <span className={`transition-opacity ${hidden ? "text-gray-300 line-through" : "text-gray-500"} group-hover:text-gray-700`}>{radarTypeLabel(rt)}</span>
                    </label>
                  );
                });
              })()}
              {/* 고정 범례 항목 */}
              <div className={`space-y-1 ${allPoints.length > 0 ? "border-t border-gray-200 pt-1 mt-1" : ""}`}>
                {allPoints.length > 0 && (
                  <label className="flex items-center gap-1.5 cursor-pointer select-none group">
                    <input
                      type="checkbox"
                      checked={!hiddenLegendItems.has("loss")}
                      onChange={() => setHiddenLegendItems((prev) => {
                        const next = new Set(prev);
                        if (next.has("loss")) next.delete("loss"); else next.add("loss");
                        return next;
                      })}
                      className="sr-only"
                    />
                    <span className={`inline-block h-2 w-2 rounded-full bg-[#ef4444] transition-opacity ${hiddenLegendItems.has("loss") ? "opacity-25" : ""}`} />
                    <span className={`transition-opacity ${hiddenLegendItems.has("loss") ? "text-gray-300 line-through" : "text-gray-600"} group-hover:text-gray-700`}>표적소실</span>
                  </label>
                )}
                {showBuildings && (
                  <>
                    <label className="group flex cursor-pointer items-center gap-1.5 select-none">
                      <input
                        type="checkbox"
                        checked={!hiddenBuildingSources.has("manual")}
                        onChange={() => setHiddenBuildingSources(prev => {
                          const next = new Set(prev);
                          if (next.has("manual")) next.delete("manual"); else next.add("manual");
                          return next;
                        })}
                        className="sr-only"
                      />
                      <span className={`inline-block h-2 w-2 rounded-full transition-opacity ${hiddenBuildingSources.has("manual") ? "opacity-25" : ""}`} style={{ backgroundColor: "#ef4444" }} />
                      <span className={`transition-opacity ${hiddenBuildingSources.has("manual") ? "text-gray-300 line-through" : "text-gray-600"} group-hover:text-gray-700`}>수동 등록 건물</span>
                    </label>
                    <label className="group flex cursor-pointer items-center gap-1.5 select-none">
                      <input
                        type="checkbox"
                        checked={!hiddenBuildingSources.has("fac")}
                        onChange={() => setHiddenBuildingSources(prev => {
                          const next = new Set(prev);
                          if (next.has("fac")) next.delete("fac"); else next.add("fac");
                          return next;
                        })}
                        className="sr-only"
                      />
                      <span className={`inline-block h-2 w-2 rounded-full transition-opacity ${hiddenBuildingSources.has("fac") ? "opacity-25" : ""}`} style={{ backgroundColor: "#e5e7eb" }} />
                      <span className={`transition-opacity ${hiddenBuildingSources.has("fac") ? "text-gray-300 line-through" : "text-gray-600"} group-hover:text-gray-700`}>건물통합정보</span>
                    </label>
                  </>
                )}
                {coverageVisible && gpuCacheReady && coverageUsedAlts.length > 0 && (() => {
                  const fmtAlt = (ft: number) => `${ft.toLocaleString()}ft`;
                  // 화면에 실제 렌더링된 고도에서 최대 5개 대표값 선택
                  const alts = coverageUsedAlts;
                  let bands: number[];
                  if (alts.length <= 5) {
                    bands = alts;
                  } else {
                    bands = [];
                    for (let i = 0; i < 5; i++) {
                      bands.push(alts[Math.round(i * (alts.length - 1) / 4)]);
                    }
                  }
                  return (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-gray-500 text-[8px] font-medium">커버리지</span>
                      {bands.map((alt, i) => {
                        const c = altToColor(alt);
                        return (
                          <div key={i} className="flex items-center gap-1.5">
                            <span
                              className="inline-block h-2.5 w-4 rounded-sm"
                              style={{ backgroundColor: `rgb(${c})`, opacity: 0.7 }}
                            />
                            <span className="text-gray-600">{fmtAlt(alt)}</span>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* Consolidation progress / Empty state overlay */}
        {allPoints.length === 0 && (
          (consolidating || radarFilteredFlights.length > 0) ? (
            <div className="absolute inset-0 z-[500] flex items-center justify-center pointer-events-none">
              <div className="pointer-events-auto text-center rounded-xl bg-white/95 px-8 py-5 shadow-lg border border-[#a60739]/20 min-w-[280px]">
                <div className="flex items-center justify-center gap-2 mb-3">
                  <Loader2 className="w-5 h-5 text-[#a60739] animate-spin" />
                  <p className="text-sm font-semibold text-gray-700">
                    {consolidationProgress?.stage === "loading" ? "DB에서 항적 로드 중..."
                      : consolidationProgress?.stage === "history" ? "운항이력 로드 중..."
                      : consolidationProgress?.stage === "grouping" ? "항적 그룹핑 중..."
                      : consolidationProgress?.stage === "building" ? "비행 데이터 생성 중..."
                      : renderProgress?.stage === "query" ? "항적 데이터 쿼리 중..."
                      : renderProgress?.stage === "paths" ? "항적 경로 생성 중..."
                      : radarFilteredFlights.length > 0 ? "항적 렌더링 중..."
                      : "데이터 복원 준비 중..."}
                  </p>
                </div>
                {(() => {
                  const prog = consolidationProgress ?? renderProgress;
                  if (!prog || prog.total <= 0) return null;
                  const pct = Math.min(100, (prog.current / prog.total) * 100);
                  const label = consolidationProgress
                    ? (consolidationProgress.stage === "loading"
                      ? `${consolidationProgress.current} / ${consolidationProgress.total} 파일`
                      : consolidationProgress.stage === "grouping"
                      ? `${(consolidationProgress.current / 1000).toFixed(0)}K / ${(consolidationProgress.total / 1000).toFixed(0)}K 포인트`
                      : `${consolidationProgress.current} / ${consolidationProgress.total} 그룹`)
                    : renderProgress
                    ? `${(renderProgress.current / 1000).toFixed(0)}K / ${(renderProgress.total / 1000).toFixed(0)}K 포인트`
                    : "";
                  return (
                    <>
                      <div className="w-full bg-gray-100 rounded-full h-2 mb-2 overflow-hidden">
                        <div
                          className="h-full rounded-full bg-[#a60739] transition-all duration-200"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <div className="flex justify-between text-[11px] text-gray-400">
                        <span>{label}</span>
                        {consolidationProgress && consolidationProgress.flightsBuilt > 0 && (
                          <span className="text-[#a60739]/70">{consolidationProgress.flightsBuilt}개 비행 생성</span>
                        )}
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          ) : null
        )}
        </div>

      {/* LoS Profile Panel */}
      {losTarget && (
        <LoSProfilePanel
          radarSite={radarSite}
          targetLat={losTarget.lat}
          targetLon={losTarget.lon}
          onClose={() => { setLosTarget(null); setLosCursor(null); setLosHoverRatio(null); setLosHighlightIdx(null); setLosHoverIdx(null); setLosBuildingHighlight(null); setDetailBuilding(null); setLosSearchedAddress(null); setLosCursorPicking(true); }}
          searchedAddress={losSearchedAddress}
          onHoverDistance={setLosHoverRatio}
          losTrackPoints={losTrackPoints}
          onLoaded={handleLosLoaded}
          onTrackPointHighlight={setLosHighlightIdx}
          externalHighlightIdx={losHighlightIdx}
          onTrackPointHover={setLosHoverIdx}
          externalHoverIdx={losHoverIdx}
          onBuildingHover={setLosBuildingHighlight}
          onBuildingDetail={setDetailBuilding}
        />
      )}
      </div>

      {/* 건물 상세보기 사이드바 (Google Street View + Maps) */}
      <div
        className="flex-shrink-0 flex flex-col border-l border-gray-200 bg-white overflow-hidden transition-[width] duration-300 ease-in-out"
        style={{ width: detailBuilding ? 360 : 0, borderLeftWidth: detailBuilding ? 1 : 0 }}
      >
        {detailBuilding && (() => {
          const lat = detailBuilding.lat;
          const lon = detailBuilding.lon;
          const label = detailBuilding.name || detailBuilding.address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`;
          const dLon = lon - radarSite.longitude;
          const dLat = lat - radarSite.latitude;
          const headingFromRadar = ((Math.atan2(dLon * Math.cos(lat * Math.PI / 180), dLat) * 180 / Math.PI) + 360) % 360;
          const headingToBuilding = (headingFromRadar + 180) % 360;
          return (
            <>
            <div className="flex items-center justify-between border-b border-gray-200 px-3 py-2" style={{ minWidth: 360 }}>
              <div className="min-w-0 flex-1">
                <h3 className="text-xs font-semibold text-gray-800 truncate">{label}</h3>
                <p className="text-[10px] text-gray-400 mt-0.5 truncate">
                  {lat.toFixed(6)}°N, {lon.toFixed(6)}°E
                  {detailBuilding.height_m > 0 && ` · ${detailBuilding.height_m.toFixed(1)}m`}
                  {detailBuilding.usage && ` · ${detailBuilding.usage}`}
                </p>
              </div>
              <button
                onClick={() => setDetailBuilding(null)}
                className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 transition-colors ml-2"
              >
                <X size={14} />
              </button>
            </div>
            <div className="flex-1 flex flex-col min-h-0 overflow-y-auto" style={{ minWidth: 360 }}>
              <div className="flex-1 min-h-0 flex flex-col">
                <div className="px-2 py-1 text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-50">Street View</div>
                <div className="flex-1 min-h-[200px] overflow-hidden relative">
                  <iframe
                    title="Street View"
                    style={{ border: 0, position: "absolute", top: -72, left: -2, width: "calc(100% + 74px)", height: "calc(100% + 96px)" }}
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    src={`https://maps.google.com/maps?layer=c&cbll=${lat},${lon}&cbp=12,${headingToBuilding.toFixed(0)},0,0,0&output=svembed`}
                  />
                </div>
              </div>
              <div className="flex-1 min-h-0 flex flex-col border-t border-gray-100">
                <div className="px-2 py-1 text-[9px] font-medium text-gray-400 uppercase tracking-wider bg-gray-50">Google Maps</div>
                <div className="flex-1 min-h-[200px] overflow-hidden relative">
                  <iframe
                    title="Google Maps"
                    style={{ border: 0, position: "absolute", top: -2, left: -2, width: "calc(100% + 74px)", height: "calc(100% + 50px)" }}
                    loading="lazy"
                    referrerPolicy="no-referrer-when-downgrade"
                    src={`https://maps.google.com/maps?q=${lat},${lon}&z=18&t=k&output=embed`}
                  />
                </div>
              </div>
            </div>
            </>
          );
        })()}
      </div>
      </div>

      {/* Bottom control bar - 타임라인 */}
      {allPoints.length > 0 && (() => {
        return (
        <div className="border-t border-gray-200 bg-white/95 backdrop-blur-sm shadow-lg">
          <div className="flex items-center gap-3 px-4 py-2 min-h-[44px]">
            {/* 시작점 시각 (2행) */}
            <div className="min-w-[62px] text-center font-mono leading-tight">
              <div className="text-[10px] text-gray-300">{fmtDate(pctToTs(rangeStart))}</div>
              <div className="text-xs text-gray-400">{fmtTime(pctToTs(rangeStart))}</div>
            </div>

            {/* 통합 타임라인 */}
            <div
              ref={timelineRef}
              className="relative flex-1 h-6 select-none cursor-pointer self-center"
              onPointerDown={(e) => {
                if (!timelineRef.current) return;
                e.preventDefault();
                const rect = timelineRef.current.getBoundingClientRect();
                const screenPct = ((e.clientX - rect.left) / rect.width) * 100;
                const [zvs, zve] = zoomViewRef.current;
                const pct = Math.max(0, Math.min(100, zvs + (screenPct / 100) * (zve - zvs)));
                const rangeStartScreen = absToScreen(rangeStart);
                // 시작점 핸들 근처(화면 4% 이내)면 시작점 드래그
                if (Math.abs(screenPct - rangeStartScreen) < 4 && pct <= sliderValue) {
                  setDraggingStart(true);
                  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                } else {
                  // 시크 — 재생 중이면 재생 유지
                  setConstrainedSliderValue(Math.max(pct, rangeStart));
                  setDraggingStart(false);
                  const onMove = (me: PointerEvent) => {
                    const r = timelineRef.current?.getBoundingClientRect();
                    if (!r) return;
                    const sp = ((me.clientX - r.left) / r.width) * 100;
                    const [vs2, ve2] = zoomViewRef.current;
                    const p = Math.max(0, Math.min(100, vs2 + (sp / 100) * (ve2 - vs2)));
                    setConstrainedSliderValue(Math.max(p, rangeStart));
                  };
                  const onUp = () => {
                    window.removeEventListener("pointermove", onMove);
                    window.removeEventListener("pointerup", onUp);
                  };
                  window.addEventListener("pointermove", onMove);
                  window.addEventListener("pointerup", onUp);
                }
              }}
              onPointerMove={(e) => {
                if (!draggingStart || !timelineRef.current) return;
                const rect = timelineRef.current.getBoundingClientRect();
                const sp = ((e.clientX - rect.left) / rect.width) * 100;
                const [zvs, zve] = zoomViewRef.current;
                const pct = Math.max(0, Math.min(sliderValue, zvs + (sp / 100) * (zve - zvs)));
                setConstrainedRangeStart(pct);
              }}
              onPointerUp={() => setDraggingStart(false)}
              onPointerCancel={() => setDraggingStart(false)}
              onDoubleClick={() => { zoomViewRef.current = [0, 100]; setZoomView([0, 100]); }}
            >
              {/* 트랙 배경 + 시간 눈금 */}
              <div className="absolute left-0 right-0 top-0 h-6 rounded bg-gray-100 overflow-hidden">
                {/* 타겟별 데이터 띠 + Loss 마커: GPU 캔버스 렌더링 */}
                <canvas ref={tlCanvasRef} className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%' }} />
                {/* 활성 구간 (시작점 ~ 현재위치) — overflow-hidden 안에서 자동 클리핑 */}
                <div
                  className="absolute top-0 h-full bg-[#a60739]/10 pointer-events-none"
                  style={{ left: `${absToScreen(rangeStart)}%`, width: `${Math.max(0, absToScreen(sliderValue) - absToScreen(rangeStart))}%` }}
                />
              </div>
              {/* 시작점 핸들 — 줌 인 시 뷰 경계에 고정 */}
              <div
                className="absolute top-0 -translate-x-1/2 cursor-ew-resize z-[100]"
                style={{ left: `${Math.max(0, Math.min(100, absToScreen(rangeStart)))}%` }}
                onPointerDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setDraggingStart(true);
                  timelineRef.current?.setPointerCapture(e.pointerId);
                }}
              >
                <div className={`h-6 w-2.5 rounded-sm border transition-colors ${
                  draggingStart
                    ? "border-white bg-[#a60739]"
                    : "border-[#a60739]/60 bg-white/80 hover:bg-[#a60739]/20"
                }`}>
                  <div className="flex flex-col items-center justify-center h-full gap-[2px]">
                    <div className="w-1 h-px bg-[#a60739]/50 rounded" />
                    <div className="w-1 h-px bg-[#a60739]/50 rounded" />
                    <div className="w-1 h-px bg-[#a60739]/50 rounded" />
                  </div>
                </div>
              </div>
              {/* 재생 위치 인디케이터 + 현재 시각 — 줌 인 시 뷰 경계에 고정 */}
              <div
                className="absolute top-0 -translate-x-1/2 pointer-events-none z-[99]"
                style={{ left: `${Math.max(0, Math.min(100, absToScreen(sliderValue)))}%` }}
              >
                <div className="h-6 w-0.5 bg-[#a60739] rounded-full shadow-sm" />
              </div>
            </div>

            {/* 현재 재생 시각 */}
            <div className="min-w-[62px] text-center font-mono leading-tight">
              <div className="text-[10px] text-gray-300">{fmtDate(pctToTs(sliderValue))}</div>
              <div className="text-xs text-gray-400">{fmtTime(pctToTs(sliderValue))}</div>
            </div>

          </div>
        </div>
        );
      })()}
    </div>
  );
}
