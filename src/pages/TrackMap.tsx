import { useState, useMemo, useEffect, useRef, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import MapGL, { NavigationControl, type MapRef } from "react-map-gl/maplibre";
import type maplibregl from "maplibre-gl";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { PathLayer, ScatterplotLayer, LineLayer, IconLayer, BitmapLayer, PolygonLayer, SolidPolygonLayer } from "@deck.gl/layers";
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
  CloudRain,
  Settings,
} from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { ToolButton, HeadingTape, Toggle as DsToggle, Check, Swatch, DsSlider } from "../components/Map/drawerPrimitives";

/** 표시 행 설정 톱니 버튼 (우측 설정 드로어 토글) */
const GearButton = ({ active, onClick }: { active: boolean; onClick: () => void }) => (
  <button
    onClick={onClick} title="설정"
    className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-md transition-colors ${
      active ? "bg-[#a60739]/5 text-[#a60739]" : "text-gray-400 hover:bg-gray-100 hover:text-gray-600"
    }`}
  >
    <Settings size={14} />
  </button>
);

/** MapLibre terrain 과장 배율 — setTerrain(2곳)과 LoS 커튼 z 배율(EX)이 공유해야
 *  커튼 지형선이 1.5배 과장된 지형 메시 표면과 일치. 값 변경 시 커튼도 자동 정합. */
const TERRAIN_EXAGGERATION = 1.5;

/** LoS 단면도 레이어 정의 (LoSProfilePanel 범례와 동일 색/의미) */
const LOS_LAYERS = [
  { key: "terrain", label: "지형", sub: "지구곡률 보정", color: "#22c55e", dash: false },
  { key: "los43", label: "최저탐지 LoS", sub: "4/3 유효지구 굴절", color: "#f59e0b", dash: false },
  { key: "fresnel", label: "프레넬존", sub: "80% 클리어런스", color: "#ec4899", dash: true },
  { key: "bra", label: "BRA", sub: "0.25° 기준선", color: "#22d3ee", dash: true },
  { key: "cos", label: "CoS", sub: "70° 최고탐지고도", color: "#a855f7", dash: true },
] as const;

/** 항적선 아이콘 (꺾인 경로선) */
const TrackLineIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="2,12 6,5 10,9 14,3" />
  </svg>
);

/** 항적점 아이콘 (경로상 점들) */
const TrackPointIcon = ({ size = 16 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 16 16" fill="currentColor" stroke="none">
    <circle cx="2" cy="12" r="1.6" />
    <circle cx="6" cy="5" r="1.6" />
    <circle cx="10" cy="9" r="1.6" />
    <circle cx="14" cy="3" r="1.6" />
  </svg>
);


import { format } from "date-fns";
import { useAppStore } from "../store";
import type { TrackPoint, LossSegment, LossPoint, Building3D, ManualBuilding, BuildingGroup, FacBuildingDetail, AddressBuildingHit, LosCurtainSample, BuildingOnPath } from "../types";
import { queryViewportPoints, ViewportQuerySuperseded } from "../utils/flightConsolidationWorker";
import { LOS_PROFILE_MAX_KM, haversineKm } from "../utils/geo";
import LoSProfileTabs from "../components/Map/LoSProfileTabs";
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

/** 등록 건물의 footprint 꼭짓점 [[lat,lon],...] 추출 (polygon/multi 도형 모두 평탄화). 도형이 없으면 빈 배열. */
function buildingFootprintVertices(b: ManualBuilding): [number, number][] {
  if (!b.geometry_json) return [];
  try {
    if (b.geometry_type === "multi") {
      const subs: { type: string; json: string }[] = JSON.parse(b.geometry_json);
      const verts: [number, number][] = [];
      for (const s of subs) {
        const pts: [number, number][] = JSON.parse(s.json);
        for (const p of pts) verts.push(p);
      }
      return verts;
    }
    return JSON.parse(b.geometry_json) as [number, number][];
  } catch {
    return [];
  }
}

/** CAT008 기상 강도(1~6) → 색상 (NWS 스타일 강수 램프). 인덱스 0 미사용. */
const WEATHER_COLORS: [number, number, number][] = [
  [0, 0, 0],
  [40, 180, 99],   // 1 약
  [30, 132, 73],   // 2
  [241, 196, 15],  // 3 중
  [230, 126, 34],  // 4
  [231, 76, 60],   // 5 강
  [155, 30, 150],  // 6 매우 강
];
/** 기상 강도 범례 라벨 */
const WEATHER_LEVEL_LABELS = ["", "약", "", "중", "", "강", "매우강"];

/** LoS 분석용 등록 장애물(수동 건물) 선택 — 그룹별 + 이름 검색 */
function LosObstaclePicker({ buildings, groups, onSelect }: {
  buildings: ManualBuilding[];
  groups: BuildingGroup[];
  onSelect: (b: ManualBuilding) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // 검색 필터 + 그룹별 묶기 (미분류는 마지막)
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q ? buildings.filter((b) => b.name.toLowerCase().includes(q)) : buildings;
    const byGroup = new Map<number | null, ManualBuilding[]>();
    for (const b of filtered) {
      const key = b.group_id ?? null;
      const arr = byGroup.get(key);
      if (arr) arr.push(b); else byGroup.set(key, [b]);
    }
    const order: { id: number | null; name: string; color: string; items: ManualBuilding[] }[] = [];
    for (const g of groups) {
      const items = byGroup.get(g.id);
      if (items && items.length > 0) order.push({ id: g.id, name: g.name, color: g.color, items });
    }
    const unclassified = byGroup.get(null);
    if (unclassified && unclassified.length > 0) {
      order.push({ id: null, name: "미분류", color: "#9ca3af", items: unclassified });
    }
    return order;
  }, [buildings, groups, query]);

  const total = buildings.length;

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        disabled={total === 0}
        className={`flex w-full items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] transition-colors ${
          total === 0
            ? "border-gray-200 bg-gray-50 text-gray-300"
            : open
              ? "border-[#a60739] text-[#a60739]"
              : "border-gray-200 bg-white text-gray-600 hover:border-gray-300"
        }`}
        title={total === 0 ? "등록된 장애물이 없습니다 (자료관리에서 등록)" : "등록 장애물 선택"}
      >
        <Building2 size={11} className="shrink-0" />
        <span className="flex-1 text-left truncate">{total === 0 ? "등록 장애물 없음" : "등록 장애물 선택"}</span>
        {total > 0 && <span className="shrink-0 text-[9px] text-gray-400">{total}</span>}
        <ChevronDown size={11} className={`shrink-0 text-gray-400 transition-transform ${open ? "rotate-180" : ""}`} />
      </button>

      {open && total > 0 && (
        <div className="absolute left-0 right-0 z-20 mt-1 rounded-md border border-gray-200 bg-white shadow-lg">
          <div className="flex items-center gap-1 border-b border-gray-100 px-2 py-1">
            <Search size={11} className="shrink-0 text-gray-400" />
            <input
              type="text" value={query} autoFocus
              onChange={(e) => setQuery(e.target.value)}
              placeholder="건물명 검색..."
              className="flex-1 min-w-0 bg-transparent text-[11px] text-gray-700 outline-none placeholder:text-gray-400"
            />
            {query && (
              <button onClick={() => setQuery("")} className="text-gray-400 hover:text-gray-600"><X size={10} /></button>
            )}
          </div>
          <div className="max-h-[200px] overflow-y-auto py-0.5">
            {grouped.length === 0 ? (
              <div className="px-2 py-2 text-center text-[10px] text-gray-400">검색 결과 없음</div>
            ) : grouped.map((g) => (
              <div key={g.id ?? "none"}>
                <div className="flex items-center gap-1.5 px-2 pt-1 pb-0.5">
                  <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ backgroundColor: g.color }} />
                  <span className="text-[9px] font-medium uppercase tracking-wide text-gray-400">{g.name}</span>
                </div>
                {g.items.map((b) => (
                  <button
                    key={b.id}
                    onClick={() => { onSelect(b); setOpen(false); setQuery(""); }}
                    className="flex w-full items-center gap-1.5 px-2.5 py-1 text-left text-[11px] text-gray-700 hover:bg-gray-50"
                  >
                    <span className="min-w-0 flex-1 truncate">{b.name}</span>
                    <span className="shrink-0 text-[9px] text-gray-400">{b.height.toFixed(0)}m</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
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
  // CAT008 기상
  const weatherVectors = useAppStore((s) => s.weatherVectors);
  const weatherVisible = useAppStore((s) => s.weatherVisible);
  const setWeatherVisible = useAppStore((s) => s.setWeatherVisible);
  const weatherNmPerBin = useAppStore((s) => s.weatherNmPerBin);
  const setWeatherNmPerBin = useAppStore((s) => s.setWeatherNmPerBin);
  const weatherOpacity = useAppStore((s) => s.weatherOpacity);
  const setWeatherOpacity = useAppStore((s) => s.setWeatherOpacity);

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
  /** 항적 표시 모드: 항적선 / 항적점 / 끄기 */
  const [trackDisplay, setTrackDisplay] = useState<"line" | "points" | "off">("line");
  const [hiddenLegendItems, setHiddenLegendItems] = useState<Set<string>>(new Set());
  const [showBuildings, setShowBuildings] = useState(true);
  const [buildingsLoading, setBuildingsLoading] = useState(false);
  const [buildings3dData, setBuildings3dData] = useState<Building3D[]>([]);
  /** 건물 3D↔점 전환 경계 (줌 15+: 3D, 14 이하: 점) */
  const [buildings3dMode, setBuildings3dMode] = useState(false);
  /** 비활성화된 건물 출처 (건물통합정보/수동 개별 토글) */
  const [hiddenBuildingSources, setHiddenBuildingSources] = useState<Set<string>>(new Set());
  const [losBuildingHighlight, setLosBuildingHighlight] = useState<{ lat: number; lon: number; height_m: number; name: string | null; address: string | null; usage: string | null } | null>(null);
  const [detailBuilding, setDetailBuilding] = useState<{ lat: number; lon: number; height_m: number; ground_elev_m: number; name: string | null; address: string | null; usage: string | null; distance_km: number; isBlocking?: boolean } | null>(null);
  // 건물 클릭 시 건축물정보 팝업 (로컬 기하 + 로컬 FAC 대장 + 온라인 VWorld)
  const [bldgPopup, setBldgPopup] = useState<{
    x: number; y: number; lat: number; lon: number;
    /** 온라인 VWorld 조회 진행 중 */
    loading: boolean;
    info: {
      name: string; dong_name: string; road_addr: string; jibun_addr: string;
      usage: string; structure: string; floors_above: string; floors_below: string;
      height: string; area: string; total_area: string; site_area: string;
      floor_area_ratio: string; building_coverage: string; approval_date: string;
    } | null;
    /** 로컬 FAC 대장 상세 (undefined=조회 전, null=없음) */
    facDetail?: FacBuildingDetail | null;
    localName?: string; localHeight?: number; localUsage?: string;
    /** 지반 표고(AMSL, m) + 출처(fac/manual) — 클릭 시점 로컬 값 */
    localBase?: number; localSource?: string;
    /** true: 클릭으로 고정됨 (호버로 닫히지 않음) */
    pinned: boolean;
  } | null>(null);
  /** 건축물 팝업 DOM ref + 계산된 위치 (가장자리 자동 회피) */
  const bldgPopupRef = useRef<HTMLDivElement>(null);
  const [bldgPopupPos, setBldgPopupPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  /** 호버 디바운스 타이머 — 250ms 머무르면 팝업 표시 */
  const bldgHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showBldgPopupForHover = useCallback((args: {
    x: number; y: number; lat: number; lon: number;
    name?: string; height?: number; usage?: string; base?: number; source?: string;
  }) => {
    setBldgPopup((prev) => {
      if (prev?.pinned) return prev;
      // 같은 좌표면 위치만 갱신
      if (prev && Math.abs(prev.lat - args.lat) < 1e-6 && Math.abs(prev.lon - args.lon) < 1e-6) {
        return { ...prev, x: args.x, y: args.y };
      }
      return {
        x: args.x, y: args.y, lat: args.lat, lon: args.lon,
        loading: true, info: null, facDetail: undefined,
        localName: args.name, localHeight: args.height, localUsage: args.usage,
        localBase: args.base, localSource: args.source,
        pinned: false,
      };
    });
  }, []);
  const scheduleBldgHover = useCallback((args: {
    x: number; y: number; lat: number; lon: number;
    name?: string; height?: number; usage?: string; base?: number; source?: string;
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

  // bldgPopup 좌표 설정 시 건물정보 조회 — 로컬 FAC 대장(오프라인) + 온라인 VWorld 병렬
  useEffect(() => {
    if (!bldgPopup) return;
    const lat = bldgPopup.lat, lon = bldgPopup.lon;
    let cancelled = false;
    // 로컬 건물통합정보 대장 (오프라인 가능, 빠름)
    if (bldgPopup.facDetail === undefined) {
      invoke<FacBuildingDetail | null>("get_fac_building_detail", { lat, lon })
        .then((res) => { if (!cancelled) setBldgPopup((prev) => prev ? { ...prev, facDetail: res ?? null } : null); })
        .catch(() => { if (!cancelled) setBldgPopup((prev) => prev ? { ...prev, facDetail: null } : null); });
    }
    // 온라인 VWorld 상세 (보조)
    if (bldgPopup.loading) {
      invoke<typeof bldgPopup.info>("get_vworld_building_info", { lat, lon })
        .then((res) => { if (!cancelled) setBldgPopup((prev) => prev ? { ...prev, loading: false, info: res ?? null } : null); })
        .catch(() => { if (!cancelled) setBldgPopup((prev) => prev ? { ...prev, loading: false, info: null } : null); });
    }
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

  // 등록 장애물(수동 건물) — LoS 분석에서 빠르게 선택
  const manualBuildings = useAppStore((s) => s.manualBuildings);
  const buildingGroups = useAppStore((s) => s.buildingGroups);
  const loadManualBuildings = useAppStore((s) => s.loadManualBuildings);
  const loadBuildingGroups = useAppStore((s) => s.loadBuildingGroups);

  // LoS Analysis state
  const [losMode, setLosMode] = useState(false);
  const [losTarget, setLosTarget] = useState<{ lat: number; lon: number } | null>(null);
  const [losCursor, setLosCursor] = useState<{ lat: number; lon: number } | null>(null);
  const [losHoverRatio, setLosHoverRatio] = useState<number | null>(null);
  const [losHighlightIdx, setLosHighlightIdx] = useState<number | null>(null);
  const [losHoverIdx, setLosHoverIdx] = useState<number | null>(null);
  // 주소 검색으로 LoS 분석 시작한 경우, 해당 좌표를 단면도에 전달해 건물 선택 표시
  const [losSearchedAddress, setLosSearchedAddress] = useState<{ lat: number; lon: number } | null>(null);
  // 특정 건물 LoS 분석 시 해당 건물 footprint([lat,lon][]) 보관 → 단면도 항적을 건물 실측 방위폭으로 한정 + 양끝 방위 계산.
  // (등록 장애물·툴팁·주소검색 모든 진입점 단일화)
  const [losFootprint, setLosFootprint] = useState<[number, number][] | null>(null);
  // 건물 LoS 단면도 탭: 중앙/좌끝/우끝 방위별 타겟. null이면 단일 단면도.
  const [losAzViews, setLosAzViews] = useState<{ lat: number; lon: number; label: string; az: number }[] | null>(null);
  const savedPitchRef = useRef(45);
  const savedBearingRef = useRef(0);
  const losPointClickedRef = useRef(false); // deck.gl LoS 포인트 클릭 여부 (빈 영역 클릭 구분용)
  const [losCursorPicking, setLosCursorPicking] = useState(false);
  // ── 도구 드로어 (좌측 도킹) — LoS 분석 / 커버리지 맵 택1 ──
  const [activeTool, setActiveTool] = useState<"los" | "coverage" | null>(null);
  const lastToolRef = useRef<"los" | "coverage">("los");
  if (activeTool) lastToolRef.current = activeTool;
  // ── 표시 설정 드로어 (우측 도킹) — 건물 / 기상 ──
  const [settingsDrawer, setSettingsDrawer] = useState<"building" | "weather" | null>(null);
  const lastSettingsRef = useRef<"building" | "weather">("building");
  if (settingsDrawer) lastSettingsRef.current = settingsDrawer;

  // 건축물 팝업 위치 — 맵 박스 밖으로 안 나가게 가장자리에서 자동 플립/클램프 (열린 드로어도 회피)
  useLayoutEffect(() => {
    if (!bldgPopup) return;
    const el = bldgPopupRef.current;
    const map = mapRef.current?.getMap();
    if (!el || !map) return;
    const cont = map.getContainer().getBoundingClientRect();
    const W = cont.width, H = cont.height;
    const w = el.offsetWidth, h = el.offsetHeight;
    const GAP = 14, M = 8;
    const leftBound = activeTool ? 308 : M;              // 좌측 도구 드로어(300) 회피
    const rightBound = settingsDrawer ? W - 232 : W - M; // 우측 설정 드로어(224) 회피
    // 가로: 기본 커서 오른쪽, 우측 경계 넘치면 왼쪽으로 플립
    let left = bldgPopup.x + GAP;
    if (left + w > rightBound) left = bldgPopup.x - GAP - w;
    left = Math.max(leftBound, Math.min(left, rightBound - w));
    // 세로: 기본 살짝 위, 하단 넘치면 위로 올림
    let top = bldgPopup.y - GAP;
    if (top + h > H - M) top = H - M - h;
    top = Math.max(M, top);
    setBldgPopupPos({ left, top });
  }, [bldgPopup?.x, bldgPopup?.y, bldgPopup?.loading, bldgPopup?.info, bldgPopup?.facDetail, activeTool, settingsDrawer]); // eslint-disable-line react-hooks/exhaustive-deps

  // LoS 단면도 레이어 표시 / 프레넬 클리어런스 / 사용자 각도선 (드로어에서 제어)
  const [losLayers, setLosLayers] = useState({ terrain: true, los43: true, fresnel: true, bra: true, cos: false });
  const [fresnelPct, setFresnelPct] = useState(80);
  const [losShowBuildings, setLosShowBuildings] = useState(true);
  const [showCustomAngle, setShowCustomAngle] = useState(false);
  const [customAngleDeg, setCustomAngleDeg] = useState(0.5);
  const [losPrecise, setLosPrecise] = useState(false);
  // LoSProfilePanel → 드로어 보고 (차단 여부 + 건물 차단/비차단 수)
  const [losStats, setLosStats] = useState<{ blocked: boolean; blocking: number; nonBlocking: number }>({ blocked: false, blocking: 0, nonBlocking: 0 });
  const handleLosStats = useCallback((s: { blocked: boolean; blocking: number; nonBlocking: number }) => setLosStats(s), []);
  // 건물 채움 투명도 (3D fill-extrusion + 2D 점 alpha) / 3D 입체 허용 (줌 15+)
  const [buildingOpacity, setBuildingOpacity] = useState(0.85);
  const [allow3d, setAllow3d] = useState(true);

  const mapRef = useRef<MapRef>(null);
  const terrainAdded = useRef(false);
  const aircraftDropRef = useRef<HTMLDivElement>(null);
  const radarDropRef = useRef<HTMLDivElement>(null);
  const fittedRef = useRef(false);
  const prevPointsLen = useRef(0);
  const allPointsRef = useRef<TrackPoint[]>([]);

  // 주소 검색 마커 (AddressSearch 컴포넌트에서 관리, 마커만 부모에서 유지)
  const [addressMarker, setAddressMarker] = useState<{ lat: number; lon: number; label: string } | null>(null);
  // 주소검색 좌표 인근 로컬 건물(3D 자동 표출) — 없으면 지반 2D 폴백
  const [addressBuilding, setAddressBuilding] = useState<AddressBuildingHit | null>(null);
  // 연속 검색 레이스 방지: 최신 요청 결과만 반영
  const addressReqSeq = useRef(0);
  // 주소검색 건물 LoS 시뮬레이션 — 카드 입력(지반고/높이)으로 평가할 대상
  const [losSimBuilding, setLosSimBuilding] = useState<{ lat: number; lon: number; groundElevM: number; heightM: number; name: string | null } | null>(null);
  // 시뮬레이션 결과(허용높이·초과량) — LoSProfilePanel onSimStats 수신
  const [losSimStats, setLosSimStats] = useState<{ allowableAglM: number; allowableTopAmslM: number; excessM: number; distKm: number } | null>(null);
  // LoS 수직 단면 커튼 샘플 — LoSProfilePanel onCurtainData 수신 (차트 가시 구간 3D 표출)
  const [losCurtain, setLosCurtain] = useState<LosCurtainSample[] | null>(null);
  // 단면도 경로상 건물 — 대상(파랑)/차단(빨강) 지도 하이라이트. LoSProfilePanel onPathBuildings 수신
  //   all = 드로어 리스트 입력용 전체 목록(최저탐지선 꺾음 기여(비차단) + 차단). 리스트는 차단만 필터해 표시
  const [losPathBldgs, setLosPathBldgs] = useState<{ target: BuildingOnPath | null; blocking: BuildingOnPath[]; all: (BuildingOnPath & { isBlocking: boolean })[] } | null>(null);
  // 건물모드 방위 한계 — 건물 양끝 방위(offset 도메인, 0/360 랩 안전). launchBuildingLoS valid 시 설정
  const [losBldgAzBounds, setLosBldgAzBounds] = useState<{ center: number; minOff: number; maxOff: number } | null>(null);
  // 건물 스윕 최초 1회 줌인 플래그 (launchBuildingLoS 시 리셋)
  const bldgSweepZoomedRef = useRef(false);
  // 카드 입력값 (문자열) — 지반고 / 건물높이
  const [simGroundInput, setSimGroundInput] = useState("");
  const [simHeightInput, setSimHeightInput] = useState("");
  const handleAddressSelect = useCallback((lat: number, lon: number, label: string) => {
    // 새 검색·클리어 모두 이전 시뮬레이션 초기화 (건물 문맥 전환)
    setLosSimBuilding(null);
    setLosSimStats(null);
    setLosBldgAzBounds(null);
    if (lat !== 0 && lon !== 0) {
      setViewState((v) => ({ ...v, latitude: lat, longitude: lon, zoom: 15 }));
      setAddressMarker({ lat, lon, label });
      // 검색 좌표 인근 로컬 건물(footprint) 비동기 조회 → 히트 시 3D 표출 + 접근
      const seq = ++addressReqSeq.current;
      setAddressBuilding(null);
      invoke<AddressBuildingHit | null>("find_building_near_point", { lat, lon })
        .then((hit) => {
          if (seq !== addressReqSeq.current) return; // 최신 요청만 반영
          if (hit) {
            setAddressBuilding(hit);
            const map = mapRef.current?.getMap();
            if (map) {
              const curZoom = map.getZoom();
              map.easeTo({ center: [hit.lon, hit.lat], zoom: Math.max(curZoom, 16.5), duration: 600 });
            }
          } else {
            setAddressBuilding(null);
          }
        })
        .catch(() => {
          if (seq === addressReqSeq.current) setAddressBuilding(null);
        });
    } else {
      addressReqSeq.current++;
      setAddressMarker(null);
      setAddressBuilding(null);
    }
  }, []);

  // 카드 입력 프리필: 히트면 DB 지반고/높이, 미히트면 SRTM 지반고·높이 빈칸
  useEffect(() => {
    if (!addressMarker) { setSimGroundInput(""); setSimHeightInput(""); return; }
    if (addressBuilding) {
      setSimGroundInput(addressBuilding.ground_elev_m.toFixed(1));
      setSimHeightInput(addressBuilding.height_m > 0 ? addressBuilding.height_m.toFixed(1) : "");
      return;
    }
    // 미히트: 지반고 SRTM 1점 프리필, 높이 빈칸
    setSimHeightInput("");
    let cancelled = false;
    invoke<number[]>("fetch_elevation", { latitudes: [addressMarker.lat], longitudes: [addressMarker.lon] })
      .then((elevs) => { if (!cancelled) setSimGroundInput(String(Math.round(elevs[0] ?? 0))); })
      .catch(() => { if (!cancelled) setSimGroundInput("0"); });
    return () => { cancelled = true; };
  }, [addressMarker, addressBuilding]);

  // 카드 입력 수정 → 즉시 반영하지 않고 dirty 시 입력 행 끝 "적용" 버튼 노출, 클릭 시 반영
  // (2026-08-03 300ms 라이브 디바운스 교체 — 타이핑 중 무거운 단면도 재계산 방지).
  // 단면도 열기 전(losSimBuilding null)에는 handleOpenSimLoS 가 클릭 시점 입력값을 직접 읽으므로 버튼 불필요.
  const simDirty = useMemo(() => {
    if (!losSimBuilding) return false;
    const g = parseFloat(simGroundInput);
    const h = parseFloat(simHeightInput);
    const groundElevM = isNaN(g) ? 0 : g; // 기존 디바운스와 동일 시맨틱 (NaN → 0)
    const heightM = isNaN(h) ? 0 : h;
    return groundElevM !== losSimBuilding.groundElevM || heightM !== losSimBuilding.heightM;
  }, [simGroundInput, simHeightInput, losSimBuilding]);

  const applySimInputs = useCallback(() => {
    const g = parseFloat(simGroundInput);
    const h = parseFloat(simHeightInput);
    const groundElevM = isNaN(g) ? 0 : g;
    const heightM = isNaN(h) ? 0 : h;
    setLosSimBuilding((prev) => (prev ? { ...prev, groundElevM, heightM } : prev));
  }, [simGroundInput, simHeightInput]);

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
      const queryResult = await queryViewportPoints({
        radarName: radarSite.name,
        selectedModeS: queryModeS,
        registeredModeS: registeredMS,
        timeRange,
        paddingPoints: true,
        onProgress: (loaded) => setRenderProgress({ stage: "query", current: loaded, total: totalPtsEst }),
      }).catch((err) => {
        // 새 쿼리로 교체됨 — 정상 취소이므로 조용히 중단
        if (err instanceof ViewportQuerySuperseded) return null;
        throw err;
      });
      if (cancelled || !queryResult) return;
      const { points: pts } = queryResult;

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
      map.setTerrain({ source: "terrain-dem", exaggeration: TERRAIN_EXAGGERATION });
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
      map.setTerrain({ source: "terrain-dem", exaggeration: TERRAIN_EXAGGERATION });
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

    const zoom = map.getZoom();

    if (initial) setBuildingsLoading(true);

    const seq = ++buildingFetchAbortRef.current;
    try {
      const bounds = map.getBounds();

      // ── 카메라 앵커 계산 (근접 정렬 기준, 줌 무관) ─────────────
      // 카메라 지상점(앵커) — buildingTileCache 의 근접 우선 정렬/거리 링 필터 기준.
      // ※ Mapbox 의 getFreeCameraOptions() 는 MapLibre GL 5 에 없어, 화면 하단 중앙을 unproject 해
      //    근경 지상점을 앵커로 삼는다(동일 의미). 피치 0(평면)·unproject 실패 시 getCenter 폴백.
      let anchorLat: number, anchorLon: number;
      const c = map.getCenter();
      anchorLat = c.lat;
      anchorLon = c.lng;
      if (map.getPitch() > 1) {
        const container = map.getContainer();
        const w = container.clientWidth, h = container.clientHeight;
        if (w > 0 && h > 0) {
          try {
            const ground = map.unproject([w / 2, h]); // 화면 하단 중앙 = 근경 지상점
            if (Number.isFinite(ground.lat) && Number.isFinite(ground.lng)) {
              anchorLat = ground.lat;
              anchorLon = ground.lng;
            }
          } catch { /* unproject 실패 시 getCenter 유지 */ }
        }
      }

      // ── 뷰포트 클램프 (3D fill-extrusion 렉 방지 전용, 줌 ≥ 14) ──
      // 3D 모드에서 지도를 피치(기울임)하면 MapLibre bounds 가 지평선까지 확장(maxPitch 85)되어
      // 수백 km² 타일을 전부 fetch → fill-extrusion 에 수만 건물이 들어가 렌더 렉을 유발한다.
      // 카메라 앵커를 중심으로 줌별 최대 반경 박스와 bounds 를 교집합해 fetch 범위를 제한.
      // 피치 0 이면 앵커≈화면중심, 고피치면 화면 하단(근경)이라 근거리 우선 로드에 자연스럽게 맞는다.
      // 줌 14 미만(2D 점 모드)은 렌더가 가벼워 원래대로 무클램프(bounds 그대로) — 타일 상한만으로 충분.
      let box = {
        south: bounds.getSouth(), north: bounds.getNorth(),
        west: bounds.getWest(), east: bounds.getEast(),
      };
      if (zoom >= 14) {
        // 줌별 최대 반경(km) — 클램프는 줌 14+ 에서만 적용되므로 14 미만 구간은 불필요
        const maxRadiusKm = (z: number): number => {
          if (z >= 17) return 3;
          if (z >= 16) return 4;
          if (z >= 15) return 6;
          return 8; // 14~15
        };

        // 앵커 ±반경 박스와 현재 bounds 의 교집합
        const clampBox = (aLat: number, aLon: number) => {
          const R = maxRadiusKm(zoom);
          const dLat = R / 111.32;
          const dLon = R / (111.32 * Math.cos(aLat * Math.PI / 180));
          return {
            south: Math.max(bounds.getSouth(), aLat - dLat),
            north: Math.min(bounds.getNorth(), aLat + dLat),
            west: Math.max(bounds.getWest(), aLon - dLon),
            east: Math.min(bounds.getEast(), aLon + dLon),
          };
        };
        // 앵커 ±반경 박스 자체 (교집합이 비었을 때 폴백)
        const anchorBox = (aLat: number, aLon: number) => {
          const R = maxRadiusKm(zoom);
          const dLat = R / 111.32;
          const dLon = R / (111.32 * Math.cos(aLat * Math.PI / 180));
          return { south: aLat - dLat, north: aLat + dLat, west: aLon - dLon, east: aLon + dLon };
        };
        const isEmpty = (b: { south: number; north: number; west: number; east: number }) =>
          b.south > b.north || b.west > b.east;

        box = clampBox(anchorLat, anchorLon);
        if (isEmpty(box)) {
          // 교집합이 비면(앵커가 화면 밖 = 극단적 피치) 앵커를 bounds 중심으로 바꿔 재계산
          const bc = bounds.getCenter();
          anchorLat = bc.lat;
          anchorLon = bc.lng;
          box = clampBox(anchorLat, anchorLon);
          // 그래도 비면 앵커 박스 자체 사용 (한반도 영역이라 경도 180° 랩 미고려)
          if (isEmpty(box)) box = anchorBox(anchorLat, anchorLon);
        }
      }

      await fetchBuildingsForViewport(
        { south: box.south, north: box.north, west: box.west, east: box.east, zoom },
        [...hiddenBuildingSources],
        // 점진적 콜백: 타일 배치 완료마다 UI 업데이트
        (buildings) => {
          if (seq !== buildingFetchAbortRef.current) return;
          setBuildings3dData(buildings);
        },
        { lat: anchorLat, lon: anchorLon },
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

  // 지도 로드 후 건물 토글이 켜져 있으면 초기 1회 로드 (mapLoaded 는 한 번만 전환되므로 중복 없음)
  // initial=false 로 백그라운드 점진 로드 — initial=true 면 fetch 완료까지 레전드에서 스피너가
  // 토글 스위치를 대체해(buildingsLoading 렌더) 사용자가 건물을 끌 수 없게 잠기는 문제 방지.
  useEffect(() => {
    if (mapLoaded && showBuildings) {
      loadBuildingsForViewport(false);
    }
  }, [mapLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

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
    // mapLoaded 를 deps 에 포함 — 기본 ON 상태에선 이 effect 의 첫 실행이 마운트 직후라
    // map 이 아직 없어(getMap()===null) 리스너가 안 붙을 수 있으므로, map 준비 후 재실행해 부착.
    // (cleanup 이 map.off 하므로 재부착 안전)
  }, [showBuildings, loadBuildingsForViewport, mapLoaded]);

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
            // base/height 는 지도면(terrain 시 지형 표면) 위 상대 오프셋 — AMSL 지반고(base 프로퍼티)는 팝업 표시용으로만 유지
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": 0,
            "fill-extrusion-opacity": buildingOpacity,
          },
        });
      }
      // 레이어 표시 + 채움 투명도 반영
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", "visible");
        map.setPaintProperty(layerId, "fill-extrusion-opacity", buildingOpacity);
      }
    } else {
      // 3D 모드 아닐 때 레이어 숨김
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, "visibility", "none");
      }
    }
  }, [buildings3dGeoJSON, buildings3dMode, buildingOpacity]);

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
          base: p.base != null ? Number(p.base) : undefined,
          source: p.source || undefined,
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
              loading: true, info: null, facDetail: undefined,
              localName: p.name || undefined,
              localHeight: p.height ? Number(p.height) : undefined,
              localUsage: p.usage || undefined,
              localBase: p.base != null ? Number(p.base) : undefined,
              localSource: p.source || undefined,
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
        "fill-extrusion-height": ["get", "height"],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.9,
      },
    });

    return () => {
      if (map.getLayer(hlLayerId)) map.removeLayer(hlLayerId);
      if (map.getSource(hlSourceId)) map.removeSource(hlSourceId);
    };
  }, [losBuildingHighlight, buildings3dMode, buildings3dData]);

  // 클릭(고정) 건물 → 3D 골드 glow (채움 + 외곽선)
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;

    const selSourceId = "buildings-3d-sel-src";
    const selFillId = "buildings-3d-sel-fill";
    const selLineId = "buildings-3d-sel-line";
    const cleanup = () => {
      if (map.getLayer(selLineId)) map.removeLayer(selLineId);
      if (map.getLayer(selFillId)) map.removeLayer(selFillId);
      if (map.getSource(selSourceId)) map.removeSource(selSourceId);
    };
    cleanup();

    if (!bldgPopup?.pinned || !buildings3dMode || buildings3dData.length === 0) return;

    const matched = buildings3dData.find(
      (b) => Math.abs(b.lat - bldgPopup.lat) < 0.0001 && Math.abs(b.lon - bldgPopup.lon) < 0.0001
    );
    if (!matched || matched.polygon.length < 3) return;

    const geoJSON = buildingsToGeoJSON([matched]);
    map.addSource(selSourceId, { type: "geojson", data: geoJSON });
    map.addLayer({
      id: selFillId,
      type: "fill-extrusion",
      source: selSourceId,
      paint: {
        "fill-extrusion-color": "#fbbf24", // 골드 glow
        "fill-extrusion-height": ["get", "height"],
        "fill-extrusion-base": 0,
        "fill-extrusion-opacity": 0.95,
      },
    });
    map.addLayer({
      id: selLineId,
      type: "line",
      source: selSourceId,
      paint: { "line-color": "#fde68a", "line-width": 2.5, "line-blur": 1.5, "line-opacity": 0.95 },
    });

    return cleanup;
  }, [bldgPopup?.pinned, bldgPopup?.lat, bldgPopup?.lon, buildings3dMode, buildings3dData]);

  // 주소검색 건물 → 3D 골드 표출(히트) / 지반 2D 폴백(미히트).
  //   buildings3dMode·showBuildings·줌 게이트와 무관하게 addressMarker 존재 동안 항상 표시.
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;

    const srcId = "address-bldg-src";
    const fillId = "address-bldg-fill";
    const lineId = "address-bldg-line";
    const groundSrcId = "address-ground-src";
    const groundFillId = "address-ground-fill";
    const groundLineId = "address-ground-line";
    const cleanup = () => {
      if (map.getLayer(lineId)) map.removeLayer(lineId);
      if (map.getLayer(fillId)) map.removeLayer(fillId);
      if (map.getSource(srcId)) map.removeSource(srcId);
      if (map.getLayer(groundLineId)) map.removeLayer(groundLineId);
      if (map.getLayer(groundFillId)) map.removeLayer(groundFillId);
      if (map.getSource(groundSrcId)) map.removeSource(groundSrcId);
    };
    cleanup();

    if (!addressMarker) return;

    const hasFootprint = !!addressBuilding && addressBuilding.polygons.length > 0;

    if (hasFootprint && addressBuilding) {
      // 3D 골드 fill-extrusion — 링별 폴리곤 폐합. base/height 는 terrain 표면 위 상대 오프셋(MapLibre 가 centroid 지형고를 자동 가산)이라 base=0·height=건물높이 — AMSL 지반고를 주면 그만큼 부양됨
      const features: GeoJSON.Feature[] = [];
      for (const ring of addressBuilding.polygons) {
        if (ring.length < 3) continue;
        const coords = ring.map(([lat, lon]) => [lon, lat]);
        const first = coords[0], last = coords[coords.length - 1];
        if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
        features.push({
          type: "Feature",
          properties: { height: addressBuilding.height_m },
          geometry: { type: "Polygon", coordinates: [coords] },
        });
      }
      if (features.length === 0) return;
      const data: GeoJSON.FeatureCollection = { type: "FeatureCollection", features };
      map.addSource(srcId, { type: "geojson", data });
      map.addLayer({
        id: fillId,
        type: "fill-extrusion",
        source: srcId,
        paint: {
          "fill-extrusion-color": "#fbbf24", // 검색 건물 골드 (선택 하이라이트와 동일 컨벤션)
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.9,
        },
      });
      map.addLayer({
        id: lineId,
        type: "line",
        source: srcId,
        paint: { "line-color": "#fde68a", "line-width": 2.5, "line-blur": 1.5, "line-opacity": 0.95 },
      });
    } else {
      // 2D 폴백 — 폴리곤 없음(미히트/도형 없는 수동건물): 검색점 중심 반경 14m 원형을 지반에 표출(terrain 위 드레이프)
      const R_M = 14;
      const lat0 = addressMarker.lat, lon0 = addressMarker.lon;
      const dLat = R_M / 111_000;
      const dLon = R_M / (111_000 * Math.cos((lat0 * Math.PI) / 180)); // 위도보정 lon 스케일
      const ring: number[][] = [];
      for (let i = 0; i <= 40; i++) {
        const a = (i / 40) * 2 * Math.PI;
        ring.push([lon0 + dLon * Math.cos(a), lat0 + dLat * Math.sin(a)]);
      }
      const data: GeoJSON.Feature = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [ring] } };
      map.addSource(groundSrcId, { type: "geojson", data });
      map.addLayer({
        id: groundFillId,
        type: "fill",
        source: groundSrcId,
        paint: { "fill-color": "#a60739", "fill-opacity": 0.25 },
      });
      map.addLayer({
        id: groundLineId,
        type: "line",
        source: groundSrcId,
        paint: { "line-color": "#a60739", "line-width": 2, "line-dasharray": [4, 3] },
      });
    }

    return cleanup;
  }, [addressMarker, addressBuilding]);

  // ── LoS 단면도 경로상 건물 → 지도 3D 하이라이트 (대상=파랑 #3b82f6, 차단=빨강 #ef4444) ──
  //   단면도 차트의 대상/차단 건물 색과 1:1 대응. 주소검색 골드 건물과 동일하게
  //   buildings3dMode·showBuildings·줌 게이트와 무관하게 LoS 분석 중엔 상시 표출.
  //   base/height 는 지도면(terrain 활성 시 지형 표면) 위 상대 오프셋이므로 base=0·height=건물높이 —
  //   AMSL 지반고를 base 로 주면 그만큼 공중부양(커밋 16e137c 불변식).
  useEffect(() => {
    const map = mapRef.current?.getMap();
    if (!map || !map.isStyleLoaded()) return;

    const tgtSrcId = "los-path-target-src", tgtFillId = "los-path-target-fill";
    const blkSrcId = "los-path-block-src", blkFillId = "los-path-block-fill";
    const fpSrcId = "los-path-fp-src", fpFillId = "los-path-fp-fill", fpLineId = "los-path-fp-line";
    const cleanup = () => {
      for (const id of [tgtFillId, blkFillId, fpFillId, fpLineId]) if (map.getLayer(id)) map.removeLayer(id);
      for (const id of [tgtSrcId, blkSrcId, fpSrcId]) if (map.getSource(id)) map.removeSource(id);
    };
    cleanup();

    if (!losMode || !losPathBldgs) return;

    // BuildingOnPath.polygon 은 [[lat,lon],...] — GeoJSON 은 [lon,lat] 이므로 뒤집고 링 폐합
    const toFeature = (b: BuildingOnPath): GeoJSON.Feature | null => {
      if (!b.polygon || b.polygon.length < 3) return null;
      const coords = b.polygon.map(([lat, lon]) => [lon, lat]);
      const first = coords[0], last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
      return {
        type: "Feature",
        properties: { height: b.height_m },
        geometry: { type: "Polygon", coordinates: [coords] },
      };
    };

    const target = losPathBldgs.target;
    const tgtFeat = target ? toFeature(target) : null;
    if (tgtFeat) {
      map.addSource(tgtSrcId, { type: "geojson", data: { type: "FeatureCollection", features: [tgtFeat] } });
      map.addLayer({
        id: tgtFillId,
        type: "fill-extrusion",
        source: tgtSrcId,
        paint: {
          "fill-extrusion-color": "#3b82f6", // 대상 건물 파랑 (단면도 차트와 동일)
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.9,
        },
      });
    }

    // 차단 건물 — polygon 없는 건물(선형 수동건물 등)은 스킵
    const blkFeats: GeoJSON.Feature[] = [];
    for (const b of losPathBldgs.blocking) {
      const f = toFeature(b);
      if (f) blkFeats.push(f);
    }
    if (blkFeats.length > 0) {
      map.addSource(blkSrcId, { type: "geojson", data: { type: "FeatureCollection", features: blkFeats } });
      map.addLayer({
        id: blkFillId,
        type: "fill-extrusion",
        source: blkSrcId,
        paint: {
          "fill-extrusion-color": "#ef4444", // 차단 건물 빨강
          "fill-extrusion-height": ["get", "height"],
          "fill-extrusion-base": 0,
          "fill-extrusion-opacity": 0.9,
        },
      });
    }

    // 대상 건물이 목록에 없으면(코리도 조회 미포함·polygon 없음) 분석 대상 footprint 를 2D 파란 면으로 폴백
    if (!tgtFeat && losFootprint && losFootprint.length >= 3) {
      const coords = losFootprint.map(([lat, lon]) => [lon, lat]);
      const first = coords[0], last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push([...first]);
      const data: GeoJSON.Feature = { type: "Feature", properties: {}, geometry: { type: "Polygon", coordinates: [coords] } };
      map.addSource(fpSrcId, { type: "geojson", data });
      map.addLayer({ id: fpFillId, type: "fill", source: fpSrcId, paint: { "fill-color": "#3b82f6", "fill-opacity": 0.35 } });
      map.addLayer({ id: fpLineId, type: "line", source: fpSrcId, paint: { "line-color": "#3b82f6", "line-width": 2 } });
    }

    return cleanup;
  }, [losPathBldgs, losFootprint, losMode, mapLoaded]);


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

  // 원시 탐지점 (항적점 모드에서만 표시)
  const dotPoints = useMemo(() => {
    if (trackDisplay !== "points") return [];
    return allPoints.filter(
      (p) => p.timestamp >= visibleMinTs && p.timestamp <= visibleMaxTs
    );
  }, [trackDisplay, allPoints, visibleMinTs, visibleMaxTs]);

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
      setLosFootprint(null);
      setLosAzViews(null);
      setLosSimBuilding(null);
      setLosSimStats(null);
      setLosBldgAzBounds(null);
      setLosCursorPicking(false);
    },
    [losMode, losCursorPicking, losTarget]
  );

  // LoS 단면도 로딩 완료 → 카메라 자동 정렬
  const losTargetRef = useRef(losTarget);
  losTargetRef.current = losTarget;
  const losFootprintRef = useRef(losFootprint);
  losFootprintRef.current = losFootprint;
  const losBldgAzBoundsRef = useRef(losBldgAzBounds);
  losBldgAzBoundsRef.current = losBldgAzBounds;
  const handleLosLoaded = useCallback(() => {
    const map = mapRef.current?.getMap();
    const target = losTargetRef.current;
    if (!map || !target) return;
    // 건물 스윕 중(이미 건물 줌인 후)에는 카메라 재정렬 억제 — 슬라이더 스윕이 건물 줌을 유지.
    //   (losAzViews=null 로 단일뷰 전환 시 viewsKey 변화가 onLoaded 게이트를 재무장해 매 스윕 재정렬되는 것 차단)
    if (losFootprintRef.current && losBldgAzBoundsRef.current && bldgSweepZoomedRef.current) return;
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

  // 특정 건물에 대한 LoS 분석 진입 (등록 장애물 / 툴팁 / 주소검색 공용).
  // footprint([lat,lon][])로 ① 항적 코리도(건물 실측 방위폭) ② 중앙/좌끝/우끝 3탭 단면도 방위를 계산.
  const launchBuildingLoS = useCallback((footprint: [number, number][], centerLat: number, centerLon: number) => {
    const rLat = radarSite.latitude, rLon = radarSite.longitude;
    const DEG2RAD = Math.PI / 180, R = 6_371_000;
    const cosLat = Math.cos(rLat * DEG2RAD);
    const dLat = centerLat - rLat, dLon = centerLon - rLon;
    const centerAz = ((Math.atan2(dLon * cosLat, dLat) * 180 / Math.PI) + 360) % 360;
    const distKm = Math.sqrt((dLat * 111.32) ** 2 + (dLon * 111.32 * cosLat) ** 2);
    const rangeKm = radarSite.range_nm > 0 ? radarSite.range_nm * 1.852 : Infinity;
    const targetKm = Math.min(distKm * 1.08 + 1, rangeKm);

    // 방위(°)→타겟 좌표 투영 (setLosFromAzDist와 동일 공식)
    const proj = (azDeg: number) => {
      const azRad = azDeg * DEG2RAD;
      return { lat: rLat + (targetKm / 111.32) * Math.cos(azRad), lon: rLon + (targetKm / (111.32 * cosLat)) * Math.sin(azRad) };
    };
    const wrap = (a: number) => ((a % 360) + 360) % 360;

    // footprint 각 꼭짓점의 radar→center축 기준 좌우 각도(rad) min/max → 양끝 방위
    const mPerDegLat = DEG2RAD * R, mPerDegLon = DEG2RAD * R * cosLat;
    const cb = Math.cos(centerAz * DEG2RAD), sb = Math.sin(centerAz * DEG2RAD);
    let angMin = Infinity, angMax = -Infinity;
    for (const [vLat, vLon] of footprint) {
      const dx = (vLat - rLat) * mPerDegLat, dy = (vLon - rLon) * mPerDegLon;
      const along = dx * cb + dy * sb;
      if (along <= 0) continue;
      const across = -dx * sb + dy * cb;
      const ang = Math.atan2(across, along);
      if (ang < angMin) angMin = ang;
      if (ang > angMax) angMax = ang;
    }
    const valid = Number.isFinite(angMin) && angMin < angMax && (angMax - angMin) > 2e-4; // ≳0.01°
    // 좌/우끝 방위는 footprint 꼭짓점 '접선' — 그대로 쓰면 Rust line_polygon_intersections 의 정확 교차가
    //   수치오차로 빗나가 대상 건물이 코리도 조회에서 통째로 탈락한다(단면도에 대상 건물 미표시).
    //   방위를 도형 안쪽으로 미세 인셋해 접선 스침 대신 확실히 관통시킨다(폭의 1%, 최소 2e-5 rad ≈ 0.001°).
    const span = angMax - angMin;
    const inset = Math.min(span * 0.25, Math.max(2e-5, span * 0.01));
    const azLeft = wrap(centerAz + (angMin + inset) * 180 / Math.PI);
    const azRight = wrap(centerAz + (angMax - inset) * 180 / Math.PI);
    const views = valid ? [
      { ...proj(azLeft), label: "좌끝", az: azLeft },
      { ...proj(centerAz), label: "중앙", az: centerAz },
      { ...proj(azRight), label: "우끝", az: azRight },
    ] : null;

    setLosFromAzDist(centerAz, targetKm); // losMode 진입 + losTarget=중앙
    setLosFootprint(footprint.length >= 3 ? footprint : null);
    setLosAzViews(views);
    setLosSearchedAddress({ lat: centerLat, lon: centerLon });
    setLosAzFineCenter(centerAz);
    // 건물 양끝 방위(offset)로 방위 슬라이더 한계 설정 — valid(폴리곤 좌우폭 유효) 일 때만.
    //   스윕 한계는 실제 건물 경계여야 하므로 위 인셋을 적용하지 않은 원래 접선값 사용
    setLosBldgAzBounds(valid ? { center: centerAz, minOff: angMin * 180 / Math.PI, maxOff: angMax * 180 / Math.PI } : null);
    bldgSweepZoomedRef.current = false; // 새 건물 → 최초 스윕 줌인 재무장
    setLosCursorPicking(false);
  }, [radarSite.latitude, radarSite.longitude, radarSite.range_nm, setLosFromAzDist]);

  // 등록 장애물 선택 → 해당 건물 footprint로 LoS 분석
  const setLosToObstacle = useCallback((b: ManualBuilding) => {
    launchBuildingLoS(buildingFootprintVertices(b), b.latitude, b.longitude);
  }, [launchBuildingLoS]);

  // 주소검색 카드의 "LoS 단면도" — 검색 건물로 LoS 진입 + 시뮬레이션 대상 설정 (카드가 sim 유지하는 예외 경로)
  const handleOpenSimLoS = useCallback(() => {
    const g = parseFloat(simGroundInput);
    const h = parseFloat(simHeightInput);
    const groundElevM = isNaN(g) ? 0 : g;
    const heightM = isNaN(h) ? 0 : h;
    setActiveTool("los"); // 좌측 LoS 도구 드로어 자동 오픈 (건물 팝업 경로와 동일)
    if (addressBuilding && addressBuilding.polygons.length > 0) {
      launchBuildingLoS(addressBuilding.polygons[0], addressBuilding.lat, addressBuilding.lon);
      setLosSimBuilding({ lat: addressBuilding.lat, lon: addressBuilding.lon, groundElevM, heightM, name: addressBuilding.name ?? addressMarker?.label ?? null });
    } else if (addressMarker) {
      // 폴리곤 없음 → 빈 footprint(valid=false, 단일 중앙 뷰). 마커 좌표를 sim 기준점으로.
      launchBuildingLoS([], addressMarker.lat, addressMarker.lon);
      setLosSimBuilding({ lat: addressMarker.lat, lon: addressMarker.lon, groundElevM, heightM, name: addressMarker.label });
    }
  }, [simGroundInput, simHeightInput, addressBuilding, addressMarker, launchBuildingLoS]);

  // LoS 도구 드로어 열 때 등록 장애물/그룹 최신화 (자료관리에서 추가/수정된 내용 반영)
  useEffect(() => {
    if (activeTool === "los") { loadManualBuildings(); loadBuildingGroups(); }
  }, [activeTool, loadManualBuildings, loadBuildingGroups]);

  // LoS 모드 완전 해제 (드로어 닫힘 / 다른 도구로 전환 시) — 카메라 복원
  const teardownLoS = useCallback(() => {
    setLosMode(false);
    setLosTarget(null);
    setLosCursor(null);
    setLosHighlightIdx(null);
    setLosCursorPicking(false);
    setLosBuildingHighlight(null);
    setDetailBuilding(null);
    setLosSearchedAddress(null);
    setLosFootprint(null);
    setLosAzViews(null);
    setLosSimBuilding(null);
    setLosSimStats(null);
    setLosBldgAzBounds(null);
    setLosCurtain(null);
    setLosPathBldgs(null);
    const map = mapRef.current?.getMap();
    if (map) map.easeTo({ pitch: savedPitchRef.current, bearing: savedBearingRef.current, duration: 500 });
  }, []);

  // 도구 버튼 클릭 — 같은 도구 재클릭 시 닫힘, LoS 떠날 때 정리
  const handleToolClick = useCallback((tool: "los" | "coverage") => {
    const next = activeTool === tool ? null : tool;
    if (activeTool === "los" && next !== "los") teardownLoS();
    setActiveTool(next);
  }, [activeTool, teardownLoS]);

  // 3D 입체 허용 토글 ↔ 현재 줌에 맞춰 buildings3dMode 재조정
  useEffect(() => {
    const map = mapRef.current?.getMap();
    const z = map ? map.getZoom() : 0;
    const want = allow3d && z >= 14;
    setBuildings3dMode((prev) => (prev !== want ? want : prev));
  }, [allow3d]);

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
    if (lineLen === 0) return []; // 타겟=레이더 동일좌표 → 0 나눗셈(NaN) 방지
    // distRatio = haversine 거리 / max(200NM, haversine 타겟거리) — 패널 maxDistance(profileMaxKm)와
    //   동일 분모 → 차트 x = 실제 haversine 거리로, 지형 축(평면 보간점의 haversine 라벨)과 정확히 일치.
    //   코리도 멤버십 판정(along·across)만 평면 투영 유지(전수 포인트 핫루프 — 통과 포인트에만 haversine 계산).
    //   코리도는 타겟 너머 200NM까지 연장(스크롤 줌아웃 시 원거리 항적/Loss도 표시).
    const profileMaxM = Math.max(LOS_PROFILE_MAX_KM * 1000, lineLen); // 평면 cap 전용
    const profileMaxKm = Math.max(LOS_PROFILE_MAX_KM, haversineKm(rLat, rLon, tLat, tLon));
    const cosB = lineDxM / lineLen;
    const sinB = lineDyM / lineLen;
    const TOLERANCE_M = 1000; // 일반 모드: 수직 1km 여유 코리도

    // 건물 기반 분석이면 건물 footprint의 실측 좌우(방위) 범위로 한정.
    // 레이더→타겟 축(=건물 중심 방위)을 기준으로 각 꼭짓점의 좌우 각도 편차[rad] min/max를 구한다.
    // (losTarget은 setLosToObstacle에서 건물 중심 방위로 설정되므로 이 축이 곧 건물 중심 방위)
    let angMin = Infinity;
    let angMax = -Infinity;
    if (losFootprint) {
      const verts = losFootprint;
      for (const [vLat, vLon] of verts) {
        const dx = (vLat - rLat) * mPerDegLat;
        const dy = (vLon - rLon) * mPerDegLon;
        const along = dx * cosB + dy * sinB;
        if (along <= 0) continue; // 레이더 뒤쪽 꼭짓점 무시
        const across = -dx * sinB + dy * cosB;
        const ang = Math.atan2(across, along); // 축 기준 좌우 각도(rad)
        if (ang < angMin) angMin = ang;
        if (ang > angMax) angMax = ang;
      }
    }
    // 유효한 방위 윈도우가 잡혔을 때만 건물폭 모드 사용 (수치오차 방지용 극소 epsilon만 가산)
    const useAzWindow = angMin <= angMax && Number.isFinite(angMin);
    const ANG_EPS = 1e-5; // ≈0.0006°, 경계 꼭짓점 부동소수 손실 방지
    const loMin = angMin - ANG_EPS;
    const loMax = angMax + ANG_EPS;
    // 코리도 판정 함수를 루프 밖에서 1회 선택 (전수 포인트 핫루프 — 호출당 클로저 생성 회피).
    // 꼭짓점·항적점 모두 along>0로 한정되므로 atan2 각도는 (-π/2, +π/2)에 갇혀 ±π 경계 wrap 불가 → 단순 [loMin,loMax] 비교로 충분.
    const inCorridor = useAzWindow
      ? (along: number, across: number): boolean => { const a = Math.atan2(across, along); return a >= loMin && a <= loMax; }
      : (_along: number, across: number): boolean => Math.abs(across) < TOLERANCE_M;

    const pts: { distRatio: number; altitude: number; mode_s: string; timestamp: number; radar_type: string; isLoss: boolean; latitude: number; longitude: number }[] = [];
    // 항적 포인트 (타임라인 슬라이더 범위 적용)
    for (const p of allPoints) {
      if (p.timestamp < visibleMinTs || p.timestamp > visibleMaxTs) continue;
      const dx = (p.latitude - rLat) * mPerDegLat;
      const dy = (p.longitude - rLon) * mPerDegLon;
      const along = dx * cosB + dy * sinB;
      const across = -dx * sinB + dy * cosB;
      if (along > 0 && along <= profileMaxM && inCorridor(along, across)) {
        pts.push({ distRatio: haversineKm(rLat, rLon, p.latitude, p.longitude) / profileMaxKm, altitude: p.altitude, mode_s: p.mode_s, timestamp: p.timestamp, radar_type: p.radar_type, isLoss: false, latitude: p.latitude, longitude: p.longitude });
      }
    }
    // Loss 포인트
    for (const lp of signalLossPoints) {
      const dx = (lp.latitude - rLat) * mPerDegLat;
      const dy = (lp.longitude - rLon) * mPerDegLon;
      const along = dx * cosB + dy * sinB;
      const across = -dx * sinB + dy * cosB;
      if (along > 0 && along <= profileMaxM && inCorridor(along, across)) {
        pts.push({ distRatio: haversineKm(rLat, rLon, lp.latitude, lp.longitude) / profileMaxKm, altitude: lp.altitude, mode_s: lp.mode_s, timestamp: lp.timestamp, radar_type: "loss", isLoss: true, latitude: lp.latitude, longitude: lp.longitude });
      }
    }
    return pts;
  }, [losTarget, radarSite, allPoints, signalLossPoints, visibleMinTs, visibleMaxTs, losFootprint]);

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

    // ── LoS 수직 단면 커튼 (차트 가시 구간) ── 단면도 프로파일 로드 후 상시 표출.
    //   단면도 차트의 각 선(지형·최저탐지 LoS·프레넬·BRA·CoS)을 3D 수직 리본면(커튼 월)+상단
    //   강조선으로 재현: 인접 샘플쌍마다 불투명 수직 quad(SolidPolygonLayer)를 먼저 깔고, 기존 PathLayer 선을
    //   그 위에 상단 모서리로 얹음. 지형 메시가 1.5배 과장이라 커튼 전체 z 에 동일 배율(EX)을 곱해 지형 표면과 정합.
    //   수직 폴리곤은 2D 테셀레이터에서 선으로 퇴화하므로 SolidPolygonLayer 는 _full3d:true 필수(최대면적 평면 테셀레이션).
    //   pitch 0(탑다운)에선 면·선 모두 자연히 모서리시점(선)으로 퇴화 → 별도 토글 없음. 색·게이트는 LOS_LAYERS 칩과 동일.
    //   점선은 @deck.gl/extensions(PathStyleExtension) 미설치로 미지원 — 실선+가는 두께로 구분(의존성 추가 금지).
    const curtain = losCurtain && losCurtain.length > 1 ? losCurtain : null;
    if (curtain) {
      const EX = terrainEnabled ? TERRAIN_EXAGGERATION : 1;
      // 커튼 천장(ceilM) — CoS 보완면의 상단이자 CoS 상단선 절단 기준.
      //   CoS(70°) 선은 20km 에서 5만 m 를 넘게 발산하므로 천장 산출에서 제외하고, 나머지 컨텐츠
      //   최대고(지형·4/3 LoS·프레넬·BRA) 위로 고저차의 15%(최소 200m) 여유를 얹는다.
      let ceilContent = -Infinity;
      let ceilMinTerrain = Infinity;
      for (const s of curtain) {
        const m = Math.max(s.terrainM, s.los43M, s.fresnelM, s.braM);
        if (m > ceilContent) ceilContent = m;
        if (s.terrainM < ceilMinTerrain) ceilMinTerrain = s.terrainM;
      }
      const ceilM = ceilContent + Math.max(200, (ceilContent - ceilMinTerrain) * 0.15);
      // 라인별 PathLayer 빌더 — positions [lon, lat, hM·EX], widthUnits pixels
      const pushCurtainLine = (
        id: string,
        height: (s: LosCurtainSample) => number,
        color: [number, number, number, number],
        width: number,
      ) => {
        layers.push(
          new PathLayer<{ path: [number, number, number][] }>({
            id,
            data: [{ path: curtain.map((s) => [s.lon, s.lat, height(s) * EX] as [number, number, number]) }],
            getPath: (d) => d.path,
            getColor: color,
            getWidth: width,
            widthUnits: "pixels" as const,
            pickable: false,
          })
        );
      };
      // 면별 SolidPolygonLayer 빌더 — 완성된 수직 quad 목록을 그대로 레이어로 push.
      //   quad 생성(밴드 분할·클램프·퇴화 skip)은 아래 동적 적층 루프가 담당하고 여기선 레이어 옵션만 책임진다.
      //   z 는 선과 동일 EX 배율. 수직 폴리곤은 2D 테셀레이션에서 퇴화하므로 _full3d 필수,
      //   material:false 로 조명 음영 없이 플랫 색.
      //   전 월 불투명(α=255)이되 서로 겹치지 않는 비중첩 밴드로 쌓으므로 프래그먼트마다 속하는 월이
      //   유일 → depth 경합 없음. depthCompare:"less-equal" 은 인접 밴드가 공유하는 모서리(경계 픽셀)
      //   이음새용으로만 유지.
      type CurtainQuad = { polygon: [number, number, number][] };
      const pushCurtainWallQuads = (
        id: string,
        quads: CurtainQuad[],
        color: [number, number, number, number],
      ) => {
        if (quads.length === 0) return;
        layers.push(
          new SolidPolygonLayer<CurtainQuad>({
            id,
            data: quads,
            getPolygon: (d) => d.polygon,
            getFillColor: color,
            filled: true,
            extruded: false,
            _full3d: true,   // 수직 폴리곤 필수 — 미지정 시 2D 테셀레이터가 선으로 퇴화
            material: false, // 조명 음영 없이 플랫 색
            pickable: false,
            // 인접 밴드가 공유하는 경계 모서리 픽셀 이음새 대비 — 동률 depth 허용
            parameters: { depthCompare: "less-equal" as const },
          })
        );
      };
      // 면들을 먼저(아래층), 선들을 나중(위 상단 강조선)에 push — 게이트는 대응 선과 동일.
      //   겹침 없는 비중첩 밴드 — 각 프래그먼트가 정확히 한 월에만 속한다. 밴드 배분은 아래 동적
      //   최하선 우선(lowest-first) 적층 루프가 refined 구간마다 실제 높이 순으로 수행하므로 이 배열
      //   순서는 더 이상 적층 우선순위가 아니다: push 순서(이음새 less-equal 동률)와 높이 동률 시
      //   tiebreak 에만 관여(2026-08-03).
      //   겹침 의존 depth 트릭(전 월 bottom=지형 + less-equal 로 낮은 월이 앞을 차지)은 월마다 top 정점이
      //   달라 프래그먼트 보간 depth 가 미세하게 갈리고, 특정 줌(투영행렬)에서 판정이 뒤집혀 밴드 전체가
      //   z-fighting 으로 뒤섞여 폐기(2026-08-03).
      //   샘플 사이에서 두 곡선이 교차하는 세그먼트는 per-sample max 보간만으로는 밴드 경계가 어긋나므로
      //   아래 refined(교차점 세그먼트 분할)로 해소 — 슬리버 틈·잘못된 색 쐐기 제거(2026-08-03).
      //   지형 면(초록)은 지형 메시와 겹쳐 이중 표출되므로 미표출 — 지형 상단선(los-curtain-line-terrain)만 유지.
      //   BRA 를 배열 맨 뒤(구 최하층)에 둔 고정 순서 배치는 동적 정렬로 대체 — 산악 지형에서 bra 가
      //   상층이면 밴드가 퇴화·소실되던 문제도, 레이더 근방에서 bra 가 최하층이면 실제 최하선(los43)이
      //   소실되던 문제도 이제 구간별 실제 높이 순서로 함께 해소된다(2026-08-03).
      //   CoS 는 침묵원추 보완면 — 70° 선 "위쪽"(cosM ~ 천장 ceilM)이 원추 내부이므로 bottomLine 으로
      //   자기 바닥을 cosM 에 고정하고 top 은 상수 ceilM(정렬 제외·항상 최상단). bottomLine 은 ceilM 로
      //   클램프 — 미클램프 시 천장 교차 세그먼트에서 top=max(top,bottom) 상향 클램프가 다음 샘플 cosM
      //   높이(샘플 간격만큼 천장 위 수 km)까지 스파이크 삼각형을 만든다. 클램프하면 교차 세그먼트가
      //   천장에서 평평하게 잘리고 그 너머는 bottom=top=ceilM 퇴화 skip → 레이더 근방 쐐기면만 남는다(의도).
      const wallDefs: { key: string; top: (s: LosCurtainSample) => number; color: [number, number, number, number]; on: boolean; bottomLine?: (s: LosCurtainSample) => number }[] = [
        { key: "cos",     top: () => ceilM,       color: [168, 85, 247, 255], on: losLayers.cos, bottomLine: (s) => Math.min(s.cosM, ceilM) },
        { key: "fresnel", top: (s) => s.fresnelM, color: [236, 72, 153, 255], on: losLayers.fresnel },
        { key: "los43",   top: (s) => s.los43M,   color: [245, 158, 11, 255], on: losLayers.los43 },
        { key: "bra",     top: (s) => s.braM,     color: [34, 211, 238, 255], on: losLayers.bra },
      ];
      const activeWalls = wallDefs.filter((w) => w.on);
      // ── 밴드 경계 교차점 세그먼트 분할 (refined) ──
      //   비중첩 밴드의 bottom 은 per-sample max(지형, 아래층 top들)이고 인접 샘플 사이는 quad 로 직선
      //   보간된다. 그런데 샘플 사이에서 두 선의 상하 순서가 뒤바뀌면(교차) max 선택이 샘플점에서만
      //   갱신되어 ① 밴드 경계가 코너를 잘라 슬리버 틈/겹침이 생기고, ② 자기 top 이 아래층 top 밑으로
      //   내려가는 퇴화 세그먼트에선 top=max(top,bottom) 클램프 삼각형의 상단 모서리가 교차점이 아닌
      //   다음 샘플까지 이어져 아래층 상단선 위로 잘못된 색 쐐기가 그려졌다.
      //   → 밴드 경계에 관여하는 선들의 쌍별 교차점에서 세그먼트를 미리 쪼개 두면 분할 구간 내에선 어떤
      //   두 선도 교차하지 않아 max 선택이 구간 전체에서 일정 → 밴드 경계가 정확한 직선이 되고 퇴화 클램프
      //   삼각형은 정확히 교차점에서 끝난다. 상하 순서가 중간에 몇 번이고 뒤바뀌어도(예: fresnel↔los43,
      //   지형↔bra) 각 교차마다 밴드가 정확히 넘겨진다(2026-08-03).
      //   비용: 샘플은 차트 가시 구간만 방출(수백 개)이고 관련 선 ≤7개 → 쌍 ≤21/세그먼트라 부하 무시 수준.
      const boundaryLines: ((s: LosCurtainSample) => number)[] = [
        (s) => s.terrainM,                // 모든 월 bottom 의 하한
        ...activeWalls.map((w) => w.top), // 활성 월 top (cos 는 상수 ceilM)
      ];
      // CoS bottomLine = min(cosM, ceilM) 구성요소 — ceilM 은 cos top 으로 이미 포함(클램프 꺾임점도 분할됨).
      if (losLayers.cos) boundaryLines.push((s) => s.cosM);
      const lerpSample = (a: LosCurtainSample, b: LosCurtainSample, t: number): LosCurtainSample => ({
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
        distKm: a.distKm + (b.distKm - a.distKm) * t,
        terrainM: a.terrainM + (b.terrainM - a.terrainM) * t,
        los43M: a.los43M + (b.los43M - a.los43M) * t,
        fresnelM: a.fresnelM + (b.fresnelM - a.fresnelM) * t,
        braM: a.braM + (b.braM - a.braM) * t,
        cosM: a.cosM + (b.cosM - a.cosM) * t,
      });
      const refined: LosCurtainSample[] = [curtain[0]];
      for (let i = 0; i < curtain.length - 1; i++) {
        const a = curtain[i], b = curtain[i + 1];
        const ts: number[] = [];
        for (let p = 0; p < boundaryLines.length - 1; p++) {
          for (let q = p + 1; q < boundaryLines.length; q++) {
            const da = boundaryLines[p](a) - boundaryLines[q](a);
            const db = boundaryLines[p](b) - boundaryLines[q](b);
            // 부호가 실제로 뒤집힌 쌍만 (접촉만 하는 da·db=0 은 순서가 안 바뀌므로 분할 불필요)
            if (da * db < 0) ts.push(da / (da - db));
          }
        }
        if (ts.length > 0) {
          ts.sort((x, y) => x - y);
          let prev = 0; // 직전 채택 t (초기 0 = 세그먼트 시작점)
          for (const t of ts) {
            if (t - prev < 1e-4 || 1 - t < 1e-4) continue; // 근접·양끝 t 제거 — 제로폭 quad 방지
            refined.push(lerpSample(a, b, t));
            prev = t;
          }
        }
        refined.push(b); // 세그먼트 끝은 원본 객체 참조 그대로 (교차 없으면 복사 0)
      }
      // ── 동적 최하선 우선(lowest-first) 밴드 적층 ──
      //   각 refined 구간에서 컨텐츠 선(fresnel/los43/bra 중 활성)을 실제 높이 오름차순으로 정렬해
      //   낮은 선부터 [floor, top] 밴드를 채운다 → 프래그먼트 색 = 바로 위에 있는 "가장 낮은 활성 선"의 색.
      //   고정 순서(cos→fresnel→los43→bra, 뒤=아래층) 적층은 bra≤los43≤fresnel 전제가 깨지는
      //   구간에서 무너진다: 레이더 근방 초반부는 지형 그림자가 작아 los43M 이 0.25° braM 보다 낮은데,
      //   bra 풀 밴드 [지형, braM]이 아래를 통째로 덮고 실제 최하선(los43) 밴드는 bottom≥top 퇴화로
      //   skip 되어 사라졌다(2026-08-03 수정). 실제 순서가 고정 순서와 일치하는 구간에선 결과 동일.
      //   refined 는 관련 선들의 쌍별 교차점에서 이미 쪼개져 있어 구간 내 높이 순서가 불변 → 구간마다 1회 정렬로 충분.
      const wallQuads = new Map<string, CurtainQuad[]>(activeWalls.map((w): [string, CurtainQuad[]] => [w.key, []]));
      const contentWalls = activeWalls.filter((w) => !w.bottomLine); // 동적 정렬 대상
      const cosWall = activeWalls.find((w) => w.bottomLine);         // CoS 보완면 — 정렬 제외·항상 최상단
      const wallOrder = new Map(wallDefs.map((w, i) => [w.key, i]));  // 높이 동률 tiebreak 용 원본 순서
      for (let i = 0; i < refined.length - 1; i++) {
        const a = refined[i], b = refined[i + 1];
        // 구간 내 순서 불변(refined 전제) — 양끝 평균 높이로 오름차순 정렬. 동률(선 일치)은 wallDefs
        //   뒤쪽(구 최하층 우선권)이 먼저 오도록 → 아래 밴드를 차지하고 위쪽 동률 월은 퇴화 skip (기존 거동 보존).
        const sorted = contentWalls.slice().sort((w1, w2) => {
          const h1 = (w1.top(a) + w1.top(b)) / 2, h2 = (w2.top(a) + w2.top(b)) / 2;
          return (h1 - h2) || (wallOrder.get(w2.key)! - wallOrder.get(w1.key)!);
        });
        let floorA = a.terrainM, floorB = b.terrainM; // 누적 하한 = max(지형, 지금까지 처리한 선 top 들)
        for (const w of sorted) {
          const tA = w.top(a), tB = w.top(b);
          const topA = Math.max(tA, floorA), topB = Math.max(tB, floorB); // 하한 밑 선은 클램프 → 퇴화
          if (topA - floorA >= 0.5 || topB - floorB >= 0.5) { // 양끝 모두 퇴화(높이차<0.5m)면 quad skip
            wallQuads.get(w.key)!.push({ polygon: [
              [a.lon, a.lat, floorA * EX],
              [b.lon, b.lat, floorB * EX],
              [b.lon, b.lat, topB * EX],
              [a.lon, a.lat, topA * EX],
            ] });
          }
          if (tA > floorA) floorA = tA; // skip 여부와 무관하게 하한 누적 (밴드 연속성)
          if (tB > floorB) floorB = tB;
        }
        if (cosWall) {
          // 보완면: bottom = max(전 컨텐츠 상한, min(cosM, ceilM)), top = 상수 ceilM
          const blA = Math.max(floorA, cosWall.bottomLine!(a)), blB = Math.max(floorB, cosWall.bottomLine!(b));
          const topA = Math.max(ceilM, blA), topB = Math.max(ceilM, blB);
          if (topA - blA >= 0.5 || topB - blB >= 0.5) {
            wallQuads.get(cosWall.key)!.push({ polygon: [
              [a.lon, a.lat, blA * EX],
              [b.lon, b.lat, blB * EX],
              [b.lon, b.lat, topB * EX],
              [a.lon, a.lat, topA * EX],
            ] });
          }
        }
      }
      // push 순서는 기존 wallDefs 순서 유지 — 비중첩이라 순서는 이음새 less-equal 동률에만 관여
      for (const w of activeWalls) pushCurtainWallQuads(`los-curtain-wall-${w.key}`, wallQuads.get(w.key)!, w.color);
      if (losLayers.terrain) pushCurtainLine("los-curtain-line-terrain", (s) => s.terrainM, [34, 197, 94, 255], 2);
      if (losLayers.los43)   pushCurtainLine("los-curtain-line-los43", (s) => s.los43M, [245, 158, 11, 255], 2);
      if (losLayers.fresnel) pushCurtainLine("los-curtain-line-fresnel", (s) => s.fresnelM, [236, 72, 153, 200], 1.5);
      if (losLayers.bra)     pushCurtainLine("los-curtain-line-bra", (s) => s.braM, [34, 211, 238, 200], 1.5);
      if (losLayers.cos) {
        // CoS(70°) 상단선은 천장(ceilM) 교차점에서 절단 — 그대로 두면 수 km 만에 수만 m 로 발산해 화면 밖으로 뻗는다.
        //   cosM < ceilM 인 동안 경로에 담고, 처음 천장을 넘는 샘플에서 직전 샘플과 선형보간(lat/lon 동일 t)한
        //   교차점(높이 ceilM)을 마지막 점으로 넣고 중단. 보완면(los-curtain-wall-cos) 상단 모서리와 일치.
        const cosPath: [number, number, number][] = [];
        for (let i = 0; i < curtain.length; i++) {
          const s = curtain[i];
          if (s.cosM < ceilM) { cosPath.push([s.lon, s.lat, s.cosM * EX]); continue; }
          const p = i > 0 ? curtain[i - 1] : null;
          if (p) {
            const t = (ceilM - p.cosM) / (s.cosM - p.cosM); // p.cosM < ceilM ≤ s.cosM 이라 분모 > 0
            cosPath.push([p.lon + (s.lon - p.lon) * t, p.lat + (s.lat - p.lat) * t, ceilM * EX]);
          }
          break;
        }
        if (cosPath.length >= 2) layers.push(
          new PathLayer<{ path: [number, number, number][] }>({
            id: "los-curtain-line-cos",
            data: [{ path: cosPath }],
            getPath: (d) => d.path,
            getColor: [168, 85, 247, 200],
            getWidth: 1.5,
            widthUnits: "pixels" as const,
            pickable: false,
          })
        );
      }
    }

    if (losPreviewTarget) {
      // 커튼 로드 시 평면 기준선(los-preview-line)은 3D 커튼(면·상단선)으로 대체.
      //   커튼 로딩 전·커서 프리뷰(타겟 미확정)는 기존 2D 직선 유지(깜빡임 방지).
      if (!curtain) layers.push(
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

      // LoS 단면도 호버 위치 → 지도 위 점 (ratio는 타겟 거리 기준 → 타겟 너머(>1)면 방위선상 연장)
      if (losTarget && losHoverRatio !== null) {
        const rLat = radarSite.latitude;
        const rLon = radarSite.longitude;
        // 차트 x축은 haversine 거리 프레임 — 선형 분율(lat/lon×ratio) 배치는 분율점의 실제 haversine
        //   거리가 목표와 달라 중간 구간에서 수백 m 편차. 선형 직선상에서 목표 haversine 거리
        //   dKm 에 정확히 도달하는 t 를 고정점 반복으로 역산 (h(t)≈t 비례라 2회면 sub-meter 수렴).
        const dKm = losHoverRatio * haversineKm(rLat, rLon, losTarget.lat, losTarget.lon);
        let t = losHoverRatio; // 초기값: 선형 근사 (레이더 근방 dKm≈0이면 그대로 사용)
        if (dKm > 1e-6) {
          for (let i = 0; i < 2; i++) {
            const h = haversineKm(rLat, rLon, rLat + (losTarget.lat - rLat) * t, rLon + (losTarget.lon - rLon) * t);
            if (h > 1e-9) t *= dKm / h;
          }
        }
        const hoverLat = rLat + (losTarget.lat - rLat) * t;
        const hoverLon = rLon + (losTarget.lon - rLon) * t;
        // 타겟 너머를 호버하면(단면도가 200NM까지 확장) 타겟→호버점 연장선으로 점을 방위선에 연결
        if (losHoverRatio > 1) {
          layers.push(
            new LineLayer({
              id: "los-hover-extension",
              data: [{ from: [losTarget.lon, losTarget.lat], to: [hoverLon, hoverLat] }],
              getSourcePosition: (d: any) => d.from,
              getTargetPosition: (d: any) => d.to,
              getColor: [233, 69, 96, 110],
              getWidth: 1,
              widthUnits: "pixels" as const,
            })
          );
        }
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
  }, [losMode, losTarget, losCursor, radarInfo, radarSite.latitude, radarSite.longitude, losHoverRatio, losHighlightIdx, losHoverIdx, losTrackPoints, losCurtain, losLayers, terrainEnabled]);

  // Loss 포인트 전용 deck.gl 레이어 (Loss 데이터 변경 시에만 재생성)
  const lossDeckLayers = useMemo(() => {
    // 항적 표시 '끄기' 시 Loss 마커도 함께 숨김
    if (signalLossPoints.length === 0 || hiddenLegendItems.has("loss") || trackDisplay === "off") return [];
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
  }, [signalLossPoints, hiddenLegendItems, losMode, altScale, aircraft, trackDisplay]);

  // 건물 2D 오버레이 전용 deck.gl 레이어
  const buildingDeckLayers = useMemo(() => {
    if (!showBuildings || buildings3dData.length === 0 || buildings3dMode) return [];
    const hexToRgb = (hex: string): [number, number, number] => {
      const h = hex.replace("#", "");
      return [parseInt(h.substring(0, 2), 16), parseInt(h.substring(2, 4), 16), parseInt(h.substring(4, 6), 16)];
    };
    const isHighlighted = (d: Building3D) =>
      losBuildingHighlight && Math.abs(d.lat - losBuildingHighlight.lat) < 0.0001 && Math.abs(d.lon - losBuildingHighlight.lon) < 0.0001;
    const sel = bldgPopup?.pinned ? bldgPopup : null;
    const isSelected = (d: Building3D) =>
      sel && Math.abs(d.lat - sel.lat) < 0.0001 && Math.abs(d.lon - sel.lon) < 0.0001;
    const a = (base: number) => Math.round(base * buildingOpacity);
    const fillColor = (d: Building3D): [number, number, number, number] => {
      if (isHighlighted(d)) return [249, 115, 22, 255]; // 주황색 하이라이트 (전체 불투명)
      if (isSelected(d)) return [251, 191, 36, 255]; // 골드 선택 glow
      if (d.group_color) { const c = hexToRgb(d.group_color); return [c[0], c[1], c[2], a(200)]; }
      return d.source === "fac" ? [229, 231, 235, a(220)]
        : d.source === "manual" ? [239, 68, 68, a(220)]
        : [209, 213, 219, a(220)];
    };
    const selObj = sel ? buildings3dData.find((d) => isSelected(d)) : null;
    const buildingHover = (info: { object?: Building3D; x: number; y: number }) => {
      if (info.object) {
        const d = info.object;
        scheduleBldgHover({
          x: info.x, y: info.y, lat: d.lat, lon: d.lon,
          name: d.name || undefined, height: d.height_m, usage: d.usage || undefined,
          base: d.ground_elev_m, source: d.source,
        });
      } else {
        clearBldgHover();
      }
    };
    return [
      // 선택 건물 골드 헤일로 (glow)
      ...(selObj ? [new ScatterplotLayer({
        id: "buildings-sel-halo",
        data: [selObj],
        getPosition: (d: Building3D) => [d.lon, d.lat],
        getRadius: 13,
        radiusUnits: "pixels" as const,
        getFillColor: [251, 191, 36, 90] as [number, number, number, number],
        pickable: false,
      })] : []),
      new ScatterplotLayer({
        id: "buildings-dots",
        data: buildings3dData,
        getPosition: (d: Building3D) => [d.lon, d.lat],
        getRadius: (d: Building3D) => isHighlighted(d) || isSelected(d) ? 6 : 3,
        radiusUnits: "pixels" as const,
        getFillColor: fillColor,
        updateTriggers: { getFillColor: [losBuildingHighlight, buildingOpacity, sel?.lat, sel?.lon], getRadius: [losBuildingHighlight, sel?.lat, sel?.lon] },
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
                loading: true, info: null, facDetail: undefined,
                localName: d.name || undefined,
                localHeight: d.height_m,
                localUsage: d.usage || undefined,
                localBase: d.ground_elev_m,
                localSource: d.source,
                pinned: true,
              };
            });
          }
        },
        onHover: buildingHover,
      }),
    ];
  }, [showBuildings, buildings3dData, buildings3dMode, losBuildingHighlight, buildingOpacity, bldgPopup?.pinned, bldgPopup?.lat, bldgPopup?.lon]);

  // CAT008 기상 극좌표 벡터 → 부채꼴 폴리곤 레이어.
  // 시간은 NEC 프레임 분 단위로 양자화 → 재생 시점(visibleMaxTs) 이하의 최신 1분 스냅샷만 표시.
  // (전체 표시 시 44만개 누적 블롭 방지 + 실제 레이더 기상화면처럼 "현재 강수" 표현)
  const weatherDeckLayers = useMemo(() => {
    if (!weatherVisible || weatherVectors.length === 0 || !radarInfo) return [];

    // 표시 상한 시각 (전체 보기면 마지막 데이터 시각)
    const lastT = weatherVectors[weatherVectors.length - 1].time;
    const upper = visibleMaxTs === Infinity ? lastT : visibleMaxTs;

    // upper 이하 최신 인덱스 (시간 오름차순 정렬 → 이진탐색)
    let lo = 0, hi = weatherVectors.length; // [lo, hi)
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (weatherVectors[mid].time <= upper) lo = mid + 1; else hi = mid;
    }
    const lastIdx = lo - 1;
    if (lastIdx < 0) return [];

    // 동일 타임스탬프(같은 분)의 벡터 = 한 스냅샷
    const T = weatherVectors[lastIdx].time;
    let start = lastIdx;
    while (start > 0 && weatherVectors[start - 1].time === T) start--;
    const snapshot = weatherVectors.slice(start, lastIdx + 1);
    if (snapshot.length === 0) return [];

    // 구면 destination (polar_to_latlon과 동일 공식, mag_dec는 azimuth에 이미 반영됨)
    const R = 6371.0;
    const rlat = radarInfo.lat, rlon = radarInfo.lon;
    const la1 = (rlat * Math.PI) / 180;
    const lo1 = (rlon * Math.PI) / 180;
    const sinLa1 = Math.sin(la1), cosLa1 = Math.cos(la1);
    const dest = (azDeg: number, nm: number): [number, number] => {
      const d = (nm * 1.852) / R;
      const th = (azDeg * Math.PI) / 180;
      const sinD = Math.sin(d), cosD = Math.cos(d);
      const la2 = Math.asin(sinLa1 * cosD + cosLa1 * sinD * Math.cos(th));
      const lo2 = lo1 + Math.atan2(Math.sin(th) * sinD * cosLa1, cosD - sinLa1 * Math.sin(la2));
      return [(lo2 * 180) / Math.PI, (la2 * 180) / Math.PI];
    };

    const HALF_BEAM = 360 / 256 / 2; // 방위 분해능 절반 (deg)
    const nmPerBin = weatherNmPerBin;
    const data = snapshot.map((w) => {
      const az0 = w.azimuth - HALF_BEAM;
      const az1 = w.azimuth + HALF_BEAM;
      const r0 = w.start_bin * nmPerBin;
      const r1 = (w.end_bin + 1) * nmPerBin; // end bin 포함 → +1
      return {
        polygon: [dest(az0, r0), dest(az0, r1), dest(az1, r1), dest(az1, r0)],
        intensity: w.intensity,
      };
    });

    const alpha = Math.round(Math.max(0, Math.min(1, weatherOpacity)) * 255);
    return [
      new PolygonLayer<{ polygon: [number, number][]; intensity: number }>({
        id: "weather-sectors",
        data,
        getPolygon: (d) => d.polygon,
        getFillColor: (d) => {
          const c = WEATHER_COLORS[d.intensity] || WEATHER_COLORS[1];
          return [c[0], c[1], c[2], alpha];
        },
        stroked: false,
        filled: true,
        extruded: false,
        pickable: false,
        updateTriggers: { getFillColor: [alpha] },
      }),
    ];
  }, [weatherVisible, weatherVectors, radarInfo, weatherNmPerBin, weatherOpacity, visibleMaxTs]);

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
            "fill-extrusion-height": ["get", "height"],
            "fill-extrusion-base": 0,
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

    // 기상 레이어 (항적 아래에 깔리도록 가장 먼저 합성)
    layers.push(...weatherDeckLayers);

    // 항적 표시 모드: 항적점(원시 탐지점) / 항적선 / 끄기
    if (trackDisplay === "points") {
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
    } else if (trackDisplay === "line") {
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

    // 1포인트 항적 (ScatterplotLayer) — 끄기 모드에서는 숨김
    if (trackDisplay !== "off" && filteredSinglePoints.length > 0) {
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
  }, [filteredTrackPaths, filteredSinglePoints, filteredDotPoints, altScale, radarInfo, losMode, trackDisplay, aircraft, selectedModeS, losDeckLayers, coverageDeckLayers, buildingDeckLayers, lossDeckLayers, panoramaDeckLayers, weatherDeckLayers, losBuildingHighlight, airplaneMarkers]);

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

  // ── 좌측 도구 드로어 본문: LoS 분석 ──
  const renderLoSToolBody = () => {
    const micro: React.CSSProperties = { fontSize: 8.5, fontWeight: 700, letterSpacing: ".06em", color: "#9ca3af", textTransform: "uppercase" };
    const num: React.CSSProperties = { fontFamily: "ui-monospace, monospace", fontVariantNumeric: "tabular-nums", fontWeight: 700 };
    const card: React.CSSProperties = { borderRadius: 9, border: "1px solid #e5e7eb", background: "#fff", padding: "9px 10px" };
    const head: React.CSSProperties = { fontSize: 11, fontWeight: 700, color: "#374151" };
    const big: React.CSSProperties = { ...num, fontSize: 16, color: "#a60739", lineHeight: 1 };
    const unit: React.CSSProperties = { fontSize: 9, color: "#9ca3af", fontWeight: 700, marginLeft: 1 };
    const distNM = losDistanceKm / 1.852;
    const status = !losTarget ? { t: "대기중", c: "#6b7280", bg: "#f3f4f6" }
      : losStats.blocked ? { t: "LoS 차단", c: "#a60739", bg: "rgba(166,7,57,.10)" }
      : { t: "LoS 양호", c: "#059669", bg: "rgba(5,150,105,.10)" };
    return (
      <>
        {/* 헤더 */}
        <div style={{ padding: "10px 12px", borderBottom: "1px solid #e5e7eb", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
              <span style={{ fontSize: 13, fontWeight: 700, color: "#1f2937", lineHeight: 1.15 }}>LoS 단면도</span>
              <span style={{ fontSize: 9.5, color: "#9ca3af", lineHeight: 1.2 }}>{distNM.toFixed(1)}NM · 방위 {losAzimuth.toFixed(0)}° · {radarSite.name}</span>
            </span>
            <span style={{ fontSize: 9.5, fontWeight: 700, padding: "3px 7px", borderRadius: 5, flexShrink: 0, color: status.c, background: status.bg }}>{status.t}</span>
            <button onClick={() => handleToolClick("los")} title="닫기"
              style={{ width: 24, height: 24, borderRadius: 6, border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "#9ca3af" }}
              onMouseEnter={(e) => { e.currentTarget.style.background = "#f3f4f6"; e.currentTarget.style.color = "#4b5563"; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#9ca3af"; }}>
              <X size={14} />
            </button>
          </div>
        </div>

        <div style={{ flex: 1, display: "flex", flexDirection: "column", overflowY: "auto" }}>
          {/* 분석 대상 */}
          <div style={{ padding: "9px 11px", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ ...micro, marginBottom: 7 }}>Target · 분석 대상</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 9 }}>
              {/* 지점 선택 + 등록 장애물 선택 (한 줄) — 주소검색은 지도 위 전역 AddressSearch 로 단일화 */}
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  onClick={() => {
                    const entering = !losCursorPicking;
                    setLosCursorPicking(entering);
                    if (entering && !losMode) {
                      setLosMode(true);
                      savedPitchRef.current = viewState.pitch ?? 45;
                      savedBearingRef.current = viewState.bearing ?? 0;
                      const map = mapRef.current?.getMap();
                      if (map) map.easeTo({ pitch: 0, bearing: 0, duration: 500 });
                    }
                  }}
                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 9px", borderRadius: 6, whiteSpace: "nowrap", flexShrink: 0, fontSize: 10.5, fontWeight: 600, cursor: "pointer",
                    border: losCursorPicking ? "1px solid #a60739" : "1px solid rgba(166,7,57,.30)",
                    background: losCursorPicking ? "#a60739" : "rgba(166,7,57,.06)", color: losCursorPicking ? "#fff" : "#a60739" }}>
                  <Crosshair size={12} color={losCursorPicking ? "#fff" : "#a60739"} /> 지점 선택
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <LosObstaclePicker buildings={manualBuildings} groups={buildingGroups} onSelect={setLosToObstacle} />
                </div>
              </div>
              {/* 방위 카드 — 건물 선택 상태(losFootprint+bounds)면 자동 건물모드 */}
              {(() => {
                const bldgMode = !!(losFootprint && losBldgAzBounds);
                return (
                <div style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={head}>방위</span>
                    {bldgMode ? (
                      <>
                        <span title="건물 양끝 방위로 한계·정밀 조정"
                          style={{ padding: "3px 9px", borderRadius: 6, fontSize: 9.5, fontWeight: 700, letterSpacing: ".02em", lineHeight: 1.4,
                            border: "1px solid #a60739", background: "#a60739", color: "#fff" }}>건물</span>
                        <span style={{ fontSize: 9, color: "#9ca3af", fontWeight: 600 }}>폭 {(losBldgAzBounds!.maxOff - losBldgAzBounds!.minOff).toFixed(2)}°</span>
                      </>
                    ) : (
                      <button onClick={() => setLosPrecise((p) => !p)} title="정밀 조정"
                        style={{ padding: "3px 9px", borderRadius: 6, cursor: "pointer", fontSize: 9.5, fontWeight: 700, letterSpacing: ".02em", lineHeight: 1.4,
                          border: losPrecise ? "1px solid #a60739" : "1px solid #d1d5db", background: losPrecise ? "#a60739" : "#fff", color: losPrecise ? "#fff" : "#6b7280" }}>정밀</button>
                    )}
                  </div>
                  <span style={big}>{bldgMode ? losAzimuth.toFixed(2) : losAzimuth.toFixed(losPrecise ? 2 : 1)}<span style={unit}>°</span></span>
                </div>
                <HeadingTape azimuth={losAzimuth} precise={losPrecise} bounds={bldgMode ? losBldgAzBounds : null}
                  onChange={(v) => {
                    if (bldgMode && losFootprint && losBldgAzBounds) {
                      // 건물모드: 컨텍스트 유지, 랩 안전 클램프 후 단일 단면도 연속 스윕
                      const { center, minOff, maxOff } = losBldgAzBounds;
                      const dLt = ((v - center) % 360 + 540) % 360 - 180; // wrapDelta ∈ (−180,180]
                      const delta = Math.max(minOff, Math.min(maxOff, dLt));
                      const az = (((center + delta) % 360) + 360) % 360;
                      setLosFromAzDist(+az.toFixed(2), losDistanceKm);
                      setLosAzViews(null);       // 탭 → 단일뷰(슬라이더 추종) 전환
                      setLosAzFineCenter(az);
                      // 최초 1회만 해당 건물로 줌인 (현재 방위·피치 유지)
                      if (!bldgSweepZoomedRef.current) {
                        bldgSweepZoomedRef.current = true;
                        const map = mapRef.current?.getMap();
                        if (map) {
                          let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
                          for (const [la, lo] of losFootprint) { if (la < minLat) minLat = la; if (la > maxLat) maxLat = la; if (lo < minLon) minLon = lo; if (lo > maxLon) maxLon = lo; }
                          if (minLat !== Infinity) {
                            map.fitBounds([[minLon, minLat], [maxLon, maxLat]], { padding: 80, maxZoom: 17.5, duration: 600, bearing: map.getBearing(), pitch: map.getPitch() });
                          }
                        }
                      }
                      // losFootprint/losSearchedAddress/losSimBuilding/losSimStats/losBldgAzBounds 유지
                    } else {
                      // 비건물모드: 기존 그대로 전부 클리어
                      setLosFromAzDist(+v.toFixed(losPrecise ? 2 : 1), losDistanceKm);
                      setLosSearchedAddress(null); setLosFootprint(null); setLosAzViews(null);
                      setLosSimBuilding(null); setLosSimStats(null); setLosBldgAzBounds(null); setLosAzFineCenter(v);
                    }
                  }} />
              </div>
                );
              })()}
            </div>
          </div>

          {/* 레이어 */}
          <div style={{ padding: "9px 11px", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ ...micro, marginBottom: 6 }}>Layers</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 1 }}>
              {LOS_LAYERS.map((L) => {
                const on = losLayers[L.key];
                return (
                  <div key={L.key}>
                    <button onClick={() => setLosLayers((s) => ({ ...s, [L.key]: !s[L.key] }))}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 5px", border: "none", background: "transparent", cursor: "pointer", width: "100%", borderRadius: 4 }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                      <Check on={on} color={L.color} />
                      <Swatch color={on ? L.color : "#d1d5db"} dash={L.dash} w={18} />
                      <span style={{ fontSize: 11, fontWeight: 500, color: on ? "#374151" : "#9ca3af", flex: 1, textAlign: "left" }}>{L.label}</span>
                      <span style={{ fontSize: 8, fontWeight: 700, color: on ? L.color : "#d1d5db", letterSpacing: ".04em" }}>{on ? "ON" : "OFF"}</span>
                    </button>
                    {L.key === "fresnel" && on && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "2px 0 4px", paddingLeft: 28 }}>
                        <DsSlider value={fresnelPct} min={0} max={100} step={5} onChange={setFresnelPct} color="#ec4899" />
                        <span style={{ ...num, fontSize: 10, color: "#ec4899", width: 30, textAlign: "right" }}>{fresnelPct}%</span>
                      </div>
                    )}
                  </div>
                );
              })}
              {/* 커스텀 각도선 */}
              <button onClick={() => setShowCustomAngle((v) => !v)}
                style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 5px", border: "none", background: "transparent", cursor: "pointer", width: "100%", borderRadius: 4 }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#f9fafb")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <Check on={showCustomAngle} color="#f43f5e" />
                <Swatch color={showCustomAngle ? "#f43f5e" : "#d1d5db"} dash w={18} />
                <span style={{ fontSize: 11, fontWeight: 500, color: showCustomAngle ? "#374151" : "#9ca3af", flex: 1, textAlign: "left" }}>커스텀 각도선</span>
                <span style={{ fontSize: 8, fontWeight: 700, color: showCustomAngle ? "#f43f5e" : "#d1d5db", letterSpacing: ".04em" }}>{showCustomAngle ? "ON" : "OFF"}</span>
              </button>
              {showCustomAngle && (
                <div style={{ display: "flex", alignItems: "center", gap: 8, margin: "2px 0 4px", paddingLeft: 28 }}>
                  <DsSlider value={customAngleDeg} min={-1} max={5} step={0.05} onChange={(v) => setCustomAngleDeg(+v.toFixed(2))} color="#f43f5e" />
                  <span style={{ ...num, fontSize: 10, color: "#f43f5e", width: 34, textAlign: "right" }}>{customAngleDeg.toFixed(2)}°</span>
                </div>
              )}
            </div>
          </div>

          {/* 건물 */}
          <div style={{ padding: "9px 11px", borderBottom: "1px solid #e5e7eb" }}>
            <button onClick={() => setLosShowBuildings((v) => !v)}
              style={{ display: "flex", alignItems: "center", gap: 8, border: "none", background: "transparent", cursor: "pointer", width: "100%", padding: 0 }}>
              <Check on={losShowBuildings} color="#a60739" />
              <Building2 size={13} color={losShowBuildings ? "#a60739" : "#9ca3af"} />
              <span style={{ ...micro, color: "#4b5563", flex: 1, textAlign: "left" }}>건물 표시</span>
              <span style={{ ...num, fontSize: 9.5, color: "#ef4444" }}>차단 {losStats.blocking}</span>
              <span style={{ ...num, fontSize: 9.5, color: "#9ca3af" }}>비차단 {losStats.nonBlocking}</span>
            </button>
          </div>

          {/* LoS 차단 건물 — 출처: LoSProfilePanel chartData.significantBuildings → onPathBuildings.all
              (최저탐지선 꺾음 기여(비차단) + 차단 건물) 중 차단(isBlocking)만 필터해 표시.
              색 계약은 지도/차트와 동일: 대상=파랑(#3b82f6) · 차단=빨강(#ef4444). */}
          {(() => {
            const list = losPathBldgs?.all ?? [];
            const target = losPathBldgs?.target ?? null;
            // 차단 건물만, 거리 오름차순 (filter 가 새 배열 — 원본 mutate 없음)
            const sorted = list.filter((b) => b.isBlocking).sort((a, b) => a.distance_km - b.distance_km);
            const empty = !losTarget ? "분석 지점을 선택하세요"
              : !losShowBuildings ? "건물 표시를 켜면 목록이 계산됩니다"
              : sorted.length === 0 ? "LoS 차단 건물 없음"
              : null;
            return (
              <div style={{ padding: "9px 11px", flex: 1, minHeight: 150, display: "flex", flexDirection: "column" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                  <span style={{ ...micro, flex: 1, minWidth: 0 }}>Blocking Buildings · LoS 차단 건물</span>
                  <span style={{ ...num, fontSize: 9.5, color: "#ef4444" }}>차단 {sorted.length}</span>
                </div>
                {empty ? (
                  <div style={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center", fontSize: 10, color: "#9ca3af" }}>{empty}</div>
                ) : (
                  <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                    {sorted.map((b) => {
                      const dot = b === target ? "#3b82f6" : "#ef4444";
                      return (
                        <div key={`${b.lat},${b.lon},${b.distance_km}`}
                          onClick={() => setDetailBuilding(b)}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background = "#f9fafb";
                            setLosBuildingHighlight({ lat: b.lat, lon: b.lon, height_m: b.height_m, name: b.name, address: b.address, usage: b.usage });
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "transparent";
                            setLosBuildingHighlight(null);
                          }}
                          style={{ padding: "4px 5px", borderRadius: 4, cursor: "pointer" }}>
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ width: 6, height: 6, borderRadius: 3, background: dot, flexShrink: 0 }} />
                            <span style={{ fontSize: 10.5, fontWeight: 600, color: "#374151", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {b.name ?? b.address ?? "이름 없음"}
                            </span>
                            <span style={{ ...num, fontSize: 9.5, color: "#6b7280", flexShrink: 0 }}>{(b.distance_km / 1.852).toFixed(1)}NM</span>
                          </div>
                          <div style={{ fontSize: 9, color: "#9ca3af", paddingLeft: 12 }}>
                            높이 {b.height_m.toFixed(0)}m · 꼭대기 {Math.round(b.ground_elev_m + b.height_m)}m AMSL{b.is_manual ? " · 수동" : ""}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </>
    );
  };

  // ── 우측 표시 설정 드로어 본문: 건물 / 기상 ──
  const renderSettingsBody = () => {
    const kind = settingsDrawer ?? lastSettingsRef.current;
    const micro: React.CSSProperties = { fontSize: 8.5, fontWeight: 700, letterSpacing: ".06em", color: "#9ca3af", textTransform: "uppercase" };
    const num: React.CSSProperties = { fontFamily: "ui-monospace, monospace", fontVariantNumeric: "tabular-nums", fontWeight: 700 };
    const header = (title: string, sub: string) => (
      <div style={{ padding: "12px 13px", borderBottom: "1px solid #e5e7eb", flexShrink: 0, display: "flex", alignItems: "center", gap: 8 }}>
        <Settings size={15} color="#a60739" />
        <span style={{ display: "flex", flexDirection: "column", flex: 1, minWidth: 0 }}>
          <span style={{ fontSize: 13, fontWeight: 700, color: "#1f2937", lineHeight: 1.15 }}>{title}</span>
          <span style={{ fontSize: 9.5, color: "#9ca3af", lineHeight: 1.2 }}>{sub}</span>
        </span>
        <button onClick={() => setSettingsDrawer(null)} title="닫기"
          style={{ width: 24, height: 24, borderRadius: 6, border: "none", background: "transparent", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: "#9ca3af" }}
          onMouseEnter={(e) => { e.currentTarget.style.background = "#f3f4f6"; e.currentTarget.style.color = "#4b5563"; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = "transparent"; e.currentTarget.style.color = "#9ca3af"; }}>
          <X size={14} />
        </button>
      </div>
    );
    const toggleSource = (src: string) => setHiddenBuildingSources((prev) => {
      const next = new Set(prev);
      if (next.has(src)) next.delete(src); else next.add(src);
      return next;
    });
    const srcRow = (label: string, note: string, on: boolean, onClick: () => void) => (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 12, color: "#4b5563" }}>{label}</span>
          <span style={{ fontSize: 9, color: "#d1d5db" }}>{note}</span>
        </span>
        <DsToggle on={on} onClick={onClick} size={0.9} />
      </div>
    );

    if (kind === "building") {
      return (
        <>
          {header("건물 설정", "3D 건물 오버레이")}
          <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
            <div style={{ padding: "11px 13px", borderBottom: "1px solid #e5e7eb", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={micro}>건물 출처</div>
              {srcRow("건물통합정보", "GIS", !hiddenBuildingSources.has("fac"), () => toggleSource("fac"))}
              {srcRow("수동 건물", "등록", !hiddenBuildingSources.has("manual"), () => toggleSource("manual"))}
            </div>
            <div style={{ padding: "11px 13px", borderBottom: "1px solid #e5e7eb", display: "flex", flexDirection: "column", gap: 10 }}>
              <div style={micro}>표현 방식</div>
              {srcRow("3D 입체", "줌 15+", allow3d, () => setAllow3d((v) => !v))}
            </div>
            <div style={{ padding: "11px 13px" }}>
              <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 5 }}>
                <span style={{ fontSize: 11, color: "#6b7280" }}>불투명도</span>
                <span style={{ ...num, fontSize: 10.5, color: "#a60739" }}>{Math.round(buildingOpacity * 100)}%</span>
              </div>
              <DsSlider value={buildingOpacity} min={0.1} max={1} step={0.05} onChange={setBuildingOpacity} />
            </div>
          </div>
        </>
      );
    }
    // 기상
    const maxRange = (123 * weatherNmPerBin).toFixed(0);
    return (
      <>
        {header("기상 설정", "CAT008 강수 표시")}
        <div style={{ flex: 1, overflowY: "auto", display: "flex", flexDirection: "column" }}>
          <div style={{ padding: "11px 13px", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ ...micro, marginBottom: 8 }}>강도 범례</div>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 4 }}>
              {[1, 2, 3, 4, 5, 6].map((lv) => (
                <div key={lv} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
                  <div style={{ height: 10, width: "100%", borderRadius: 2, background: `rgb(${WEATHER_COLORS[lv][0]},${WEATHER_COLORS[lv][1]},${WEATHER_COLORS[lv][2]})` }} />
                  <span style={{ fontSize: 8, color: "#9ca3af" }}>{WEATHER_LEVEL_LABELS[lv] || lv}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ padding: "11px 13px", borderBottom: "1px solid #e5e7eb" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 5 }}>
              <span style={{ fontSize: 11, color: "#6b7280" }}>거리 스케일</span>
              <span style={{ ...num, fontSize: 10.5, color: "#374151" }}>{weatherNmPerBin.toFixed(2)} NM/bin</span>
            </div>
            <DsSlider value={weatherNmPerBin} min={0.25} max={2} step={0.25} onChange={setWeatherNmPerBin} />
            <div style={{ marginTop: 4, fontSize: 8.5, color: "#9ca3af" }}>최대 {maxRange} NM · SOP f 미전송 추정값</div>
          </div>
          <div style={{ padding: "11px 13px" }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 5 }}>
              <span style={{ fontSize: 11, color: "#6b7280" }}>투명도</span>
              <span style={{ ...num, fontSize: 10.5, color: "#a60739" }}>{Math.round(weatherOpacity * 100)}%</span>
            </div>
            <DsSlider value={weatherOpacity} min={0.1} max={1} step={0.05} onChange={setWeatherOpacity} />
          </div>
        </div>
      </>
    );
  };

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

        {/* 항적 표시: 항적선 / 항적점 / 끄기 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className={trackDisplay !== "off" ? "text-[#a60739]" : "text-gray-400"}>{trackDisplay === "points" ? <TrackPointIcon size={14} /> : <TrackLineIcon size={14} />}</span>
            <span className="text-xs text-gray-600">항적</span>
          </div>
          <div className="inline-flex items-center gap-0.5 rounded-md bg-gray-100 p-0.5" role="radiogroup" aria-label="항적 표시 모드">
            {([["line", "선"], ["points", "점"], ["off", "끄기"]] as const).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setTrackDisplay(mode)}
                role="radio"
                aria-checked={trackDisplay === mode}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  trackDisplay === mode ? "bg-[#a60739] text-white shadow-sm" : "text-gray-500 hover:text-gray-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {/* 건물 */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Building2 size={14} className={showBuildings ? "text-[#a60739]" : "text-gray-400"} />
            <span className="text-xs text-gray-600">건물</span>
            <GearButton active={settingsDrawer === "building"} onClick={() => { setSettingsDrawer(settingsDrawer === "building" ? null : "building"); setAircraftDropOpen(false); setRadarDropOpen(false); }} />
          </div>
          {buildingsLoading ? (
            <Loader2 size={16} className="animate-spin text-[#a60739]" />
          ) : (
            <button
              onClick={() => {
                if (showBuildings) {
                  setShowBuildings(false);
                } else {
                  fetchBuildingOverlay();
                }
              }}
              className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${showBuildings ? "bg-[#a60739]" : "bg-gray-300"}`}
              role="switch"
              aria-checked={showBuildings}
            >
              <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${showBuildings ? "translate-x-4.5" : "translate-x-0.5"}`} />
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

        {/* 기상 (CAT008) */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <CloudRain size={14} className={weatherVisible ? "text-[#a60739]" : "text-gray-400"} />
            <span className="text-xs text-gray-600">기상</span>
            <GearButton active={settingsDrawer === "weather"} onClick={() => { setSettingsDrawer(settingsDrawer === "weather" ? null : "weather"); setAircraftDropOpen(false); setRadarDropOpen(false); }} />
          </div>
          <button
            onClick={() => setWeatherVisible(!weatherVisible)}
            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${weatherVisible ? "bg-[#a60739]" : "bg-gray-300"}`}
            role="switch"
            aria-checked={weatherVisible}
          >
            <span className={`inline-block h-3.5 w-3.5 rounded-full bg-white shadow transition-transform ${weatherVisible ? "translate-x-4.5" : "translate-x-0.5"}`} />
          </button>
        </div>

          </div>
        </div>

        {/* ── 도구 ────────────────── */}
        <div>
          <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400">도구</div>
          <div className="space-y-1.5">
            <ToolButton icon={Mountain} label="LoS 분석" active={activeTool === "los"} onClick={() => handleToolClick("los")} />
            <ToolButton icon={Radar} label="커버리지 맵" active={activeTool === "coverage"} onClick={() => handleToolClick("coverage")} />
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
      {/* Map container — 드로어를 지도+단면도 전체 높이에 오버레이하기 위해 relative */}
      <div className="relative flex flex-col flex-1 min-w-0">
        <div className="relative flex-1">
        <MapGL
          ref={mapRef}
          {...viewState}
          onMove={(evt) => {
            setViewState(evt.viewState);
            const is3d = allow3d && evt.viewState.zoom >= 14;
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
            <AddressMarker marker={addressMarker} onClose={() => { addressReqSeq.current++; setAddressMarker(null); setAddressBuilding(null); setLosSimBuilding(null); setLosSimStats(null); setLosBldgAzBounds(null); }} />
          )}
        </MapGL>

        <AddressSearch onSelect={handleAddressSelect} offsetLeft={activeTool ? 312 : 8} withManualBuildings />

        {/* 주소검색 건물 상세 카드 — 지반고/높이 입력 + LoS 단면도 진입 + 허용높이 결과 */}
        {addressMarker && (
          <div className="absolute z-[650]" style={{ top: 52, left: activeTool ? 312 : 8, width: 280 }}>
            <div className="rounded-lg border border-gray-200 bg-white/95 shadow-lg backdrop-blur-sm p-2.5 text-xs text-gray-700">
              {/* 헤더: 건물명 + 출처 배지 */}
              <div className="mb-2 flex items-center justify-between gap-2">
                <span className="truncate font-semibold text-gray-800" title={addressBuilding?.name ?? addressMarker.label}>
                  {addressBuilding?.name ?? addressMarker.label}
                </span>
                <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium ${addressBuilding ? "bg-[#a60739]/10 text-[#a60739]" : "bg-gray-100 text-gray-500"}`}>
                  {addressBuilding ? (addressBuilding.source === "fac" ? "GIS" : "수동") : "미등록"}
                </span>
              </div>
              {/* 입력: 지반고 / 건물높이 — 수정(dirty) 시 행 끝에 작은 적용 버튼 노출 */}
              <div className="mb-2 flex gap-2">
                <label className="flex-1">
                  <span className="mb-0.5 block text-[10px] text-gray-500">지반고 (m)</span>
                  <input type="number" value={simGroundInput} onChange={(e) => setSimGroundInput(e.target.value)}
                    className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-800 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/30" />
                </label>
                <label className="flex-1">
                  <span className="mb-0.5 block text-[10px] text-gray-500">건물높이 (m)</span>
                  <input type="number" value={simHeightInput} onChange={(e) => setSimHeightInput(e.target.value)} placeholder="0"
                    className="w-full rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs text-gray-800 placeholder:text-gray-400 focus:border-[#a60739] focus:outline-none focus:ring-1 focus:ring-[#a60739]/30" />
                </label>
                {simDirty && (
                  <button onClick={applySimInputs}
                    className="self-end shrink-0 rounded-md bg-[#a60739] px-2 py-1 text-[11px] font-medium text-white transition-colors hover:bg-[#85062e]">
                    적용
                  </button>
                )}
              </div>
              {/* LoS 단면도 버튼 */}
              <button onClick={handleOpenSimLoS}
                className="w-full rounded-md bg-[#a60739] px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-[#85062e]">
                LoS 단면도
              </button>
              {/* 결과: 허용높이 / 초과·여유 */}
              {losSimBuilding ? (
                losSimStats ? (() => {
                  // 카드 전체 AMSL(지반고포함) 기준 통일 — 허용높이(지반고포함) = 허용 상한 AMSL 동일값이므로 별도 상한 행은 삭제(중복).
                  const ground = losSimBuilding.groundElevM;
                  const bTop = ground + (isNaN(losSimBuilding.heightM) ? 0 : losSimBuilding.heightM); // NaN 높이 0 처리 (LoSProfilePanel sim 계산과 동일)
                  return (
                  <div className="mt-2 space-y-0.5 border-t border-gray-100 pt-2">
                    <div>LoS 허용높이(지반고포함): <b className="text-gray-900">{losSimStats.allowableTopAmslM.toFixed(1)} m</b></div>
                    <div>
                      {losSimStats.excessM > 0
                        ? <span style={{ color: "#e94560" }} className="font-semibold">현재 초과높이 +{losSimStats.excessM.toFixed(1)} m</span>
                        : <span className="font-semibold text-emerald-600">여유 {(-losSimStats.excessM).toFixed(1)} m</span>}
                    </div>
                    <div className="text-[10px] text-gray-400">건물 상단 {bTop.toFixed(1)} m · 지반고 {ground.toFixed(1)} m · {(losSimStats.distKm / 1.852).toFixed(1)} NM</div>
                  </div>
                  );
                })() : (
                  <div className="mt-2 border-t border-gray-100 pt-2 text-gray-400">허용높이 계산 중…</div>
                )
              ) : (
                <div className="mt-2 border-t border-gray-100 pt-2 text-[11px] text-gray-400">단면도를 열면 허용높이가 계산됩니다</div>
              )}
            </div>
          </div>
        )}

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
            ref={bldgPopupRef}
            className="absolute z-[1100] rounded-lg border border-gray-300 bg-white shadow-xl"
            style={{ left: bldgPopupPos.left, top: bldgPopupPos.top, width: 360 }}
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
            {/* 본문 — 기하 정보(항상) + 대장 정보(로컬 FAC + 온라인 VWorld) */}
            <div className="max-h-[440px] overflow-y-auto">
              {(() => {
                const bi = bldgPopup.info;
                const fac = bldgPopup.facDetail;
                const pick = (...vals: (string | null | undefined)[]): string => {
                  for (const v of vals) if (v != null && v !== "") return v;
                  return "-";
                };
                const displayName = pick(fac?.name, bi?.name, bldgPopup.localName);
                // 레이더 기준 거리/방위
                const cosLat = Math.cos(radarSite.latitude * Math.PI / 180);
                const dLat = bldgPopup.lat - radarSite.latitude;
                const dLon = bldgPopup.lon - radarSite.longitude;
                const az = ((Math.atan2(dLon * cosLat, dLat) * 180 / Math.PI) + 360) % 360;
                const distKm = Math.sqrt((dLat * 111.32) ** 2 + (dLon * 111.32 * cosLat) ** 2);
                const height = bldgPopup.localHeight ?? fac?.height_m;
                const base = bldgPopup.localBase ?? fac?.ground_elev_m;
                const src = bldgPopup.localSource ?? (fac ? "fac" : undefined);
                const srcLabel = src === "fac" ? "건물통합정보" : src === "manual" ? "수동 등록" : "-";
                const row = (k: string, v: React.ReactNode, k2?: string, v2?: React.ReactNode) => (
                  <tr className="border-b border-gray-100">
                    <td className="w-[64px] bg-gray-50 px-2 py-1.5 text-gray-500">{k}</td>
                    <td className="px-2 py-1.5 text-gray-700" colSpan={k2 != null ? 1 : 3}>{v}</td>
                    {k2 != null && <td className="w-[64px] bg-gray-50 px-2 py-1.5 text-gray-500">{k2}</td>}
                    {k2 != null && <td className="px-2 py-1.5 text-gray-700">{v2}</td>}
                  </tr>
                );
                const secLabel = "px-3 pt-2.5 pb-0.5 text-[9px] font-semibold uppercase tracking-wider text-gray-400";
                return (
                  <>
                    {/* 건물명/주소 배너 */}
                    {(displayName !== "-" || bi?.road_addr || bi?.jibun_addr) && (
                      <div className="mx-3 mt-3 mb-2 rounded border border-gray-200 bg-gray-50 px-2.5 py-2 space-y-1">
                        {displayName !== "-" && <div className="text-[12px] font-semibold text-gray-800">{displayName}</div>}
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
                    )}
                    {/* 기하 정보 (레이더 기준 — 항상 표시) */}
                    <div className={secLabel + " pt-1"}>기하 정보</div>
                    <table className="w-full border-t border-gray-200 text-[10.5px]">
                      <tbody>
                        {row("출처", srcLabel, "건물높이", height != null ? `${height.toFixed(1)} m` : "-")}
                        {row("지반표고", base != null ? `${base.toFixed(1)} m` : "-", "옥상표고", (base != null && height != null) ? `${(base + height).toFixed(1)} m` : "-")}
                        {row("레이더거리", `${(distKm / 1.852).toFixed(1)} NM`, "레이더방위", `${az.toFixed(1)}°`)}
                      </tbody>
                    </table>
                    {/* 대장 정보 (로컬 건물통합정보 + 온라인 VWorld) */}
                    <div className={secLabel + " flex items-center gap-1.5"}>
                      대장 정보
                      {bldgPopup.loading && <Loader2 size={9} className="animate-spin text-gray-300" />}
                    </div>
                    <table className="w-full border-t border-gray-200 text-[10.5px]">
                      <tbody>
                        {row("건물명칭", pick(fac?.name, bi?.name))}
                        {row("동명칭", pick(fac?.dong_name, bi?.dong_name), "용도", pick(fac?.usage, bi?.usage, bldgPopup.localUsage))}
                        {row("구조", pick(bi?.structure))}
                        {row("지상층수", bi?.floors_above ? `${bi.floors_above} 층` : "-", "지하층수", bi?.floors_below ? `${bi.floors_below} 층` : "-")}
                        {row("건물면적", bi?.area ? `${bi.area} ㎡` : "-", "연면적", bi?.total_area ? `${bi.total_area} ㎡` : "-")}
                        {row("대지면적", bi?.site_area ? `${bi.site_area} ㎡` : "-", "용적률", bi?.floor_area_ratio ? `${bi.floor_area_ratio} %` : "-")}
                        {row("건폐율", bi?.building_coverage ? `${bi.building_coverage} %` : "-", "승인일", pick(bi?.approval_date))}
                        {row("PNU", pick(fac?.pnu))}
                        {row("관리번호", pick(fac?.bd_mgt_sn))}
                      </tbody>
                    </table>
                  </>
                );
              })()}
            </div>
            {/* LoS 단면도 진입 */}
            <div className="border-t border-gray-200 px-3 py-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const lat = bldgPopup.lat, lon = bldgPopup.lon;
                  const matched = buildings3dData.find(
                    (b) => Math.abs(b.lat - lat) < 0.0001 && Math.abs(b.lon - lon) < 0.0001
                  );
                  setActiveTool("los");
                  launchBuildingLoS(matched?.polygon ?? [], lat, lon);
                  setBldgPopup(null);
                }}
                className="flex w-full items-center justify-center gap-1.5 rounded-md bg-[#a60739] px-3 py-2 text-[11px] font-semibold text-white transition-colors hover:bg-[#8a052f]"
              >
                <Mountain size={13} /> LoS 단면도 분석
              </button>
            </div>
            {/* 좌표 푸터 */}
            <div className="border-t border-gray-200 px-3 py-1.5 text-[9px] text-gray-400">
              {bldgPopup.lat.toFixed(6)}°N, {bldgPopup.lon.toFixed(6)}°E
            </div>
          </div>
        )}

        {/* 범례 (왼쪽 하단) — 항적/건물/커버리지 중 하나라도 활성이면 표시 */}
        {(allPoints.length > 0 || showBuildings || coverageVisible) && (
          <div
            className="absolute z-[1000] rounded-lg border border-gray-200 bg-white/95 px-3 py-2.5 text-[10px] backdrop-blur-sm shadow-lg"
            style={{ bottom: 12, left: activeTool ? 312 : 12, transition: "left .4s cubic-bezier(.4,0,.2,1)" }}
          >
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

      {/* LoS Profile Panel (건물 분석 시 중앙/좌끝/우끝 3탭) — 드로어가 열리면 좌/우로 밀려남(드로어 우선) */}
      {losTarget && (
        <div style={{
          marginLeft: activeTool ? 300 : 0,
          marginRight: settingsDrawer ? 224 : 0,
          transition: "margin .4s cubic-bezier(.4,0,.2,1)",
        }}>
        <LoSProfileTabs
          views={losAzViews ?? [{ lat: losTarget.lat, lon: losTarget.lon, label: "중앙", az: losAzimuth }]}
          radarSite={radarSite}
          onClose={() => { setLosTarget(null); setLosCursor(null); setLosHoverRatio(null); setLosHighlightIdx(null); setLosHoverIdx(null); setLosBuildingHighlight(null); setDetailBuilding(null); setLosSearchedAddress(null); setLosFootprint(null); setLosAzViews(null); setLosSimBuilding(null); setLosSimStats(null); setLosBldgAzBounds(null); setLosCurtain(null); setLosPathBldgs(null); setLosCursorPicking(true); }}
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
          layers={losLayers}
          fresnelClearance={fresnelPct / 100}
          showBuildings={losShowBuildings}
          onToggleBuildings={() => setLosShowBuildings((v) => !v)}
          showCustomAngle={showCustomAngle}
          onToggleCustomAngle={() => setShowCustomAngle((v) => !v)}
          customAngleDeg={customAngleDeg}
          onCustomAngleChange={setCustomAngleDeg}
          showLegend={false}
          onStats={handleLosStats}
          simBuilding={losSimBuilding}
          onSimStats={setLosSimStats}
          onCurtainData={setLosCurtain}
          onPathBuildings={setLosPathBldgs}
        />
        </div>
      )}

        {/* ── 좌측 도구 드로어 (LoS / 커버리지) — 지도+단면도 전체 높이 오버레이 ── */}
        <div
          className="absolute top-0 bottom-0 left-0 z-[700] flex flex-col bg-white"
          style={{
            width: 300, borderRight: "1px solid #e5e7eb",
            boxShadow: activeTool ? "6px 0 28px rgba(0,0,0,.13)" : "none",
            transform: activeTool ? "translateX(0)" : "translateX(-314px)",
            transition: "transform .4s cubic-bezier(.4,0,.2,1), box-shadow .3s",
            pointerEvents: activeTool ? "auto" : "none",
          }}
        >
          {activeTool === "los" && renderLoSToolBody()}
          {activeTool === "coverage" && (
            <CoveragePanel
              radarSite={radarSite}
              gpuCacheReady={gpuCacheReady} setGpuCacheReady={setGpuCacheReady}
              coverageAlt={coverageAlt} setCoverageAlt={setCoverageAlt}
              coverageAltMin={coverageAltMin} setCoverageAltMin={setCoverageAltMin}
              coverageOpacity={coverageOpacity} setCoverageOpacity={setCoverageOpacity}
              coverageRendering={coverageRendering}
              mapRef={mapRef}
              onClose={() => handleToolClick("coverage")}
            />
          )}
        </div>

        {/* ── 우측 표시 설정 드로어 (건물 / 기상) — 전체 높이 오버레이 ── */}
        <div
          className="absolute top-0 bottom-0 right-0 z-[750] flex flex-col bg-white"
          style={{
            width: 224, borderLeft: "1px solid #e5e7eb",
            boxShadow: settingsDrawer ? "-6px 0 28px rgba(0,0,0,.14)" : "none",
            transform: settingsDrawer ? "translateX(0)" : "translateX(240px)",
            transition: "transform .4s cubic-bezier(.4,0,.2,1), box-shadow .3s",
            pointerEvents: settingsDrawer ? "auto" : "none",
          }}
        >
          {renderSettingsBody()}
        </div>
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
