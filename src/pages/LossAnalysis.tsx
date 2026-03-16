import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import MapGL, { NavigationControl, type MapRef } from "react-map-gl/maplibre";
import { ScatterplotLayer, LineLayer } from "@deck.gl/layers";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { invoke } from "@tauri-apps/api/core";
import {
  BarChart3,
  Clock,
  Ruler,
  Mountain,
  Radio,
  Users,
  Zap,
  Waves,
  Eye,
  Loader2,
} from "lucide-react";
import Card from "../components/common/Card";
import { SimpleCard } from "../components/common/Card";
import DataTable from "../components/common/DataTable";
import { useAppStore } from "../store";
import { flightLabel } from "../utils/flightConsolidation";
import {
  estimateReflectorPosition,
} from "../utils/reflectorAnalysis";
import type { LossPoint, GarblePoint, PanoramaPoint } from "../types";
import type { ReflectorEstimate } from "../utils/reflectorAnalysis";
import { getWeatherAtTime, assessDuctingRisk } from "../utils/weatherFetch";

interface FlatLoss {
  index: number;
  flightId: string;
  flightLabel: string;
  point: LossPoint;
}

/** Unix timestamp → KST HH:mm:ss */
function toKST(ts: number): string {
  const d = new Date(ts * 1000);
  const m = String(d.getUTCMinutes()).padStart(2, "0");
  const s = String(d.getUTCSeconds()).padStart(2, "0");
  const hour = (d.getUTCHours() + 9) % 24;
  return `${String(hour).padStart(2, "0")}:${m}:${s}`;
}

/** Haversine 거리 (km) */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371.0;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

type GarbleDetailTab = "table" | "bearing" | "reflector";

/** Dark map style */
const GARBLE_MAP_STYLE = "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

/** Garble 지도 뷰 — deck.gl + MapLibre */
function GarbleMapView({
  garblePoints,
  selectedModeS,
  radarSite,
  reflectorEstimates,
}: {
  garblePoints: GarblePoint[];
  selectedModeS: string | null;
  radarSite: { latitude: number; longitude: number };
  reflectorEstimates: (ReflectorEstimate & { sourcePoint: GarblePoint })[];
}) {
  const mapRef = useRef<MapRef | null>(null);

  // 선택된 Mode-S의 포인트 또는 전체
  const displayPoints = useMemo(() => {
    if (selectedModeS) {
      return garblePoints.filter((p) => p.mode_s === selectedModeS);
    }
    return garblePoints;
  }, [garblePoints, selectedModeS]);

  const isFiltered = !!selectedModeS;
  const markerRadius = isFiltered ? 5 : 2.5;

  // 선택 변경 시 자동 fit bounds
  useEffect(() => {
    const map = mapRef.current;
    if (!map || displayPoints.length === 0) return;

    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    for (const p of displayPoints) {
      if (p.ghost_lat < minLat) minLat = p.ghost_lat;
      if (p.ghost_lat > maxLat) maxLat = p.ghost_lat;
      if (p.ghost_lon < minLon) minLon = p.ghost_lon;
      if (p.ghost_lon > maxLon) maxLon = p.ghost_lon;
      if (p.real_lat < minLat) minLat = p.real_lat;
      if (p.real_lat > maxLat) maxLat = p.real_lat;
      if (p.real_lon < minLon) minLon = p.real_lon;
      if (p.real_lon > maxLon) maxLon = p.real_lon;
    }
    // 레이더 포함
    if (radarSite.latitude < minLat) minLat = radarSite.latitude;
    if (radarSite.latitude > maxLat) maxLat = radarSite.latitude;
    if (radarSite.longitude < minLon) minLon = radarSite.longitude;
    if (radarSite.longitude > maxLon) maxLon = radarSite.longitude;

    map.fitBounds(
      [[minLon, minLat], [maxLon, maxLat]],
      { padding: 40, maxZoom: 14, duration: 800 }
    );
  }, [displayPoints, radarSite]);

  // Real track points (deduplicated by lat/lon key)
  const realTrackData = useMemo(() => {
    const seen = new Set<string>();
    const pts: { position: [number, number] }[] = [];
    for (const p of displayPoints) {
      const key = `${p.real_lat.toFixed(5)}_${p.real_lon.toFixed(5)}`;
      if (!seen.has(key)) {
        seen.add(key);
        pts.push({ position: [p.real_lon, p.real_lat] });
      }
    }
    return pts;
  }, [displayPoints]);

  // Ghost→Real connection lines
  const connectionData = useMemo(
    () =>
      displayPoints.map((p) => ({
        sourcePosition: [p.ghost_lon, p.ghost_lat] as [number, number],
        targetPosition: [p.real_lon, p.real_lat] as [number, number],
      })),
    [displayPoints]
  );

  // deck.gl layers
  const layers = useMemo(() => {
    const result: (ScatterplotLayer | LineLayer)[] = [];

    // 1. Ghost→Real 접속선 (red, thin)
    if (connectionData.length > 0) {
      result.push(
        new LineLayer({
          id: "garble-connections",
          data: connectionData,
          getSourcePosition: (d: { sourcePosition: [number, number] }) => d.sourcePosition,
          getTargetPosition: (d: { targetPosition: [number, number] }) => d.targetPosition,
          getColor: [239, 68, 68, isFiltered ? 120 : 60],
          getWidth: 1,
          widthMinPixels: 1,
        })
      );
    }

    // 2. Real track points (white, small)
    if (realTrackData.length > 0) {
      result.push(
        new ScatterplotLayer({
          id: "garble-real-tracks",
          data: realTrackData,
          getPosition: (d: { position: [number, number] }) => d.position,
          getFillColor: [255, 255, 255, 180],
          getRadius: isFiltered ? 3 : 1.5,
          radiusUnits: "pixels" as const,
          radiusMinPixels: 1,
        })
      );
    }

    // 3. Sidelobe ghost points (yellow)
    const sidelobeData = displayPoints.filter((p) => p.garble_type === "sidelobe");
    if (sidelobeData.length > 0) {
      result.push(
        new ScatterplotLayer({
          id: "garble-sidelobe",
          data: sidelobeData,
          getPosition: (d: GarblePoint) => [d.ghost_lon, d.ghost_lat],
          getFillColor: [234, 179, 8, 160],
          getRadius: markerRadius,
          radiusUnits: "pixels" as const,
          radiusMinPixels: 2,
        })
      );
    }

    // 4. Multipath ghost points (orange)
    const multipathData = displayPoints.filter((p) => p.garble_type === "multipath");
    if (multipathData.length > 0) {
      result.push(
        new ScatterplotLayer({
          id: "garble-multipath",
          data: multipathData,
          getPosition: (d: GarblePoint) => [d.ghost_lon, d.ghost_lat],
          getFillColor: [249, 115, 22, 160],
          getRadius: markerRadius,
          radiusUnits: "pixels" as const,
          radiusMinPixels: 2,
        })
      );
    }

    // 5. Radar site (cyan)
    result.push(
      new ScatterplotLayer({
        id: "garble-radar",
        data: [{ position: [radarSite.longitude, radarSite.latitude] }],
        getPosition: (d: { position: [number, number] }) => d.position,
        getFillColor: [6, 182, 212, 255],
        getLineColor: [6, 182, 212, 255],
        getRadius: 6,
        radiusUnits: "pixels" as const,
        radiusMinPixels: 4,
        stroked: true,
        lineWidthMinPixels: 2,
      })
    );

    // 6. Reflector estimates (magenta, with border)
    if (isFiltered && reflectorEstimates.length > 0) {
      result.push(
        new ScatterplotLayer({
          id: "garble-reflectors",
          data: reflectorEstimates,
          getPosition: (d: ReflectorEstimate) => [d.lon, d.lat],
          getFillColor: [236, 72, 153, 200],
          getLineColor: [255, 255, 255, 200],
          getRadius: 7,
          radiusUnits: "pixels" as const,
          radiusMinPixels: 5,
          stroked: true,
          lineWidthMinPixels: 2,
        })
      );
    }

    return result;
  }, [displayPoints, connectionData, realTrackData, reflectorEstimates, isFiltered, markerRadius, radarSite]);

  // 초기 뷰 상태
  const initialViewState = useMemo(
    () => ({
      longitude: radarSite.longitude,
      latitude: radarSite.latitude,
      zoom: 7,
    }),
    [] // 최초 1회만
  );

  const onMapRef = useCallback((ref: MapRef | null) => {
    mapRef.current = ref;
  }, []);

  if (garblePoints.length === 0) {
    return (
      <SimpleCard>
        <div className="flex items-center justify-center py-12 text-sm text-gray-500">
          Garble 데이터가 없습니다. 자료를 파싱하세요.
        </div>
      </SimpleCard>
    );
  }

  return (
    <SimpleCard className="p-0 overflow-hidden">
      <div className="relative" style={{ height: 400 }}>
        <MapGL
          ref={onMapRef}
          initialViewState={initialViewState}
          style={{ width: "100%", height: "100%" }}
          mapStyle={GARBLE_MAP_STYLE}
          attributionControl={false}
        >
          <DeckGLOverlay layers={layers} />
          <NavigationControl position="top-right" showCompass={false} />
        </MapGL>
        {/* 범례 */}
        <div className="absolute bottom-3 left-3 flex flex-col gap-1 rounded-lg bg-black/60 px-3 py-2 text-[10px] text-white/80 backdrop-blur-sm">
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-yellow-400" />
            사이드로브
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-orange-500" />
            다중경로
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-white" />
            실제 항적
          </div>
          <div className="flex items-center gap-1.5">
            <div className="h-2 w-2 rounded-full bg-cyan-400" />
            레이더
          </div>
          {isFiltered && reflectorEstimates.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="h-2 w-2 rounded-full bg-pink-400" />
              반사체 추정
            </div>
          )}
        </div>
        {/* 선택 정보 */}
        {selectedModeS && (
          <div className="absolute top-3 left-3 rounded-lg bg-black/60 px-3 py-1.5 text-[11px] font-medium text-white/90 backdrop-blur-sm">
            {selectedModeS} — {displayPoints.length}건
          </div>
        )}
      </div>
    </SimpleCard>
  );
}

export default function LossAnalysis() {
  const flights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);
  const garblePoints = useAppStore((s) => s.garblePoints);
  const radarSite = useAppStore((s) => s.radarSite);
  const garbleSelectedModeS = useAppStore((s) => s.garbleSelectedModeS);
  const setGarbleViewActive = useAppStore((s) => s.setGarbleViewActive);
  const setPanoramaViewActive = useAppStore((s) => s.setPanoramaViewActive);
  const setPanoramaActivePointStore = useAppStore((s) => s.setPanoramaActivePoint);
  const setPanoramaPinnedStore = useAppStore((s) => s.setPanoramaPinned);
  const weatherData = useAppStore((s) => s.weatherData);
  const [viewMode, setViewMode] = useState<"by-flight" | "garble" | "los-panorama">(
    "by-flight"
  );

  // ── Garble 뷰 상태 ──
  const [garbleActiveTab, setGarbleActiveTab] = useState<GarbleDetailTab>("table");

  // ── LoS 파노라마 상태 ──
  const [panoramaData, setPanoramaData] = useState<PanoramaPoint[]>([]);
  const [panoramaLoading, setPanoramaLoading] = useState(false);
  const [panoramaHoverIdx, setPanoramaHoverIdx] = useState<number | null>(null);
  const [panoramaPinnedIdx, setPanoramaPinnedIdx] = useState<number | null>(null);
  const panoramaSvgRef = useRef<SVGSVGElement>(null);
  const [panoramaBldgMaxHeight, setPanoramaBldgMaxHeight] = useState<number | null>(null); // 건물 높이 필터 (null=미적용)

  // Garble 뷰 활성 상태를 스토어에 동기화
  useEffect(() => {
    setGarbleViewActive(viewMode === "garble");
    return () => setGarbleViewActive(false);
  }, [viewMode, setGarbleViewActive]);

  // 파노라마 뷰 활성 상태를 스토어에 동기화
  useEffect(() => {
    setPanoramaViewActive(viewMode === "los-panorama");
    return () => setPanoramaViewActive(false);
  }, [viewMode, setPanoramaViewActive]);

  // 파노라마 계산 함수 (DB 저장 포함)
  const computePanorama = useCallback(() => {
    setPanoramaLoading(true);
    setPanoramaPinnedIdx(null);
    setPanoramaHoverIdx(null);
    const radarH = radarSite.altitude + radarSite.antenna_height;
    invoke<PanoramaPoint[]>("calculate_los_panorama", {
      radarLat: radarSite.latitude,
      radarLon: radarSite.longitude,
      radarHeightM: radarH,
      maxRangeKm: 100.0,
      azimuthStepDeg: 0.5,
      rangeStepM: 200.0,
    })
      .then((data) => {
        setPanoramaData(data);
        // DB에 캐시 저장
        invoke("save_panorama_cache", {
          radarLat: radarSite.latitude,
          radarLon: radarSite.longitude,
          radarHeightM: radarH,
          dataJson: JSON.stringify(data),
        }).catch((e) => console.error("파노라마 캐시 저장 실패:", e));
      })
      .catch((e) => console.error("파노라마 계산 실패:", e))
      .finally(() => setPanoramaLoading(false));
  }, [radarSite]);

  // LoS 파노라마 탭 선택 시 DB 캐시 로드 또는 계산
  useEffect(() => {
    if (viewMode !== "los-panorama") return;
    if (panoramaData.length > 0) return;
    setPanoramaLoading(true);
    invoke<string | null>("load_panorama_cache", {
      radarLat: radarSite.latitude,
      radarLon: radarSite.longitude,
    })
      .then((cached) => {
        if (cached) {
          try {
            const data = JSON.parse(cached) as PanoramaPoint[];
            if (data.length > 0) {
              setPanoramaData(data);
              setPanoramaLoading(false);
              return;
            }
          } catch { /* 파싱 실패 시 재계산 */ }
        }
        // 캐시 없으면 계산
        computePanorama();
      })
      .catch(() => computePanorama());
  }, [viewMode, radarSite, panoramaData.length, computePanorama]);

  // 레이더 변경 시 파노라마 데이터 초기화
  const prevRadarRef = useRef(radarSite.name);
  useEffect(() => {
    if (prevRadarRef.current !== radarSite.name) {
      prevRadarRef.current = radarSite.name;
      setPanoramaData([]);
      setPanoramaPinnedIdx(null);
      setPanoramaHoverIdx(null);
    }
  }, [radarSite.name]);

  // 건물 높이 필터 적용된 파노라마 데이터
  const filteredPanoramaData = useMemo(() => {
    if (panoramaBldgMaxHeight === null || panoramaData.length === 0) return panoramaData;
    return panoramaData.map((pt) => {
      if (pt.obstacle_type === "terrain") return pt;
      if (pt.obstacle_height_m <= panoramaBldgMaxHeight) return pt;
      // 초과 건물 → 지형으로 대체 (건물 높이 제거한 앙각 추정)
      const terrainAngle = Math.max(0, pt.elevation_angle_deg - (pt.obstacle_height_m / (pt.distance_km * 1000)) * (180 / Math.PI));
      return { ...pt, obstacle_type: "terrain" as const, elevation_angle_deg: terrainAngle, obstacle_height_m: 0, name: null, address: null, usage: null };
    });
  }, [panoramaData, panoramaBldgMaxHeight]);

  // 파노라마에 표시되는 건물 포인트 (지도 표시용)
  const panoramaBuildingPoints = useMemo(() => {
    if (filteredPanoramaData.length === 0) return [];
    const seen = new Set<string>();
    const buildings: PanoramaPoint[] = [];
    for (const pt of filteredPanoramaData) {
      if (pt.obstacle_type === "terrain") continue;
      // 같은 좌표 중복 제거
      const key = `${pt.lat.toFixed(5)}_${pt.lon.toFixed(5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      buildings.push(pt);
    }
    return buildings;
  }, [filteredPanoramaData]);

  // 파노라마 건물 지도용 ref
  const panoramaMapRef = useRef<MapRef>(null);

  // 파노라마 SVG 마우스 핸들러
  const panoramaSvgW = 1200;
  const panoramaSvgH = 400;
  const panoramaMargin = { top: 20, right: 30, bottom: 40, left: 60 };
  const panoramaChartW = panoramaSvgW - panoramaMargin.left - panoramaMargin.right;
  const panoramaChartH = panoramaSvgH - panoramaMargin.top - panoramaMargin.bottom;

  const panoramaMaxAngle = useMemo(() => {
    if (filteredPanoramaData.length === 0) return 1.0;
    const maxA = Math.max(...filteredPanoramaData.map((p) => p.elevation_angle_deg));
    return Math.max(0.5, Math.ceil(maxA * 10) / 10 + 0.1);
  }, [filteredPanoramaData]);

  const panoramaMinAngle = useMemo(() => {
    if (filteredPanoramaData.length === 0) return -0.2;
    const minA = Math.min(...filteredPanoramaData.map((p) => p.elevation_angle_deg));
    return Math.min(-0.1, Math.floor(minA * 10) / 10 - 0.1);
  }, [filteredPanoramaData]);

  const panoramaActiveIdx = panoramaPinnedIdx ?? panoramaHoverIdx;
  const panoramaActivePoint = panoramaActiveIdx !== null ? filteredPanoramaData[panoramaActiveIdx] : null;

  // 활성 포인트를 스토어에 동기화 (사이드바 표시용)
  useEffect(() => {
    setPanoramaActivePointStore(panoramaActivePoint);
    setPanoramaPinnedStore(panoramaPinnedIdx !== null);
  }, [panoramaActivePoint, panoramaPinnedIdx, setPanoramaActivePointStore, setPanoramaPinnedStore]);

  const handlePanoramaMouseMove = useCallback(
    (e: React.MouseEvent<SVGSVGElement>) => {
      if (filteredPanoramaData.length === 0) return;
      const svg = panoramaSvgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const scaleX = panoramaSvgW / rect.width;
      const mx = (e.clientX - rect.left) * scaleX - panoramaMargin.left;
      if (mx < 0 || mx > panoramaChartW) {
        setPanoramaHoverIdx(null);
        return;
      }
      const azFrac = mx / panoramaChartW;
      const idx = Math.round(azFrac * (filteredPanoramaData.length - 1));
      setPanoramaHoverIdx(Math.max(0, Math.min(filteredPanoramaData.length - 1, idx)));
    },
    [filteredPanoramaData.length, panoramaChartW, panoramaMargin.left]
  );

  const handlePanoramaClick = useCallback(
    (_e: React.MouseEvent<SVGSVGElement>) => {
      if (panoramaHoverIdx === null) return;
      setPanoramaPinnedIdx((prev) => (prev === panoramaHoverIdx ? null : panoramaHoverIdx));
    },
    [panoramaHoverIdx]
  );

  // 등록된 비행검사기 Mode-S 코드 집합
  const registeredModeSCodes = useMemo(() => {
    const codes = new Set<string>();
    for (const a of aircraft) {
      if (a.active && a.mode_s_code) {
        codes.add(a.mode_s_code.toUpperCase());
      }
    }
    return codes;
  }, [aircraft]);

  // 비행검사기 Loss 포인트 평탄화
  const flatLoss: FlatLoss[] = useMemo(() => {
    const items: FlatLoss[] = [];
    let idx = 0;
    for (const f of flights) {
      if (!registeredModeSCodes.has(f.mode_s.toUpperCase())) continue;
      const label = flightLabel(f, aircraft);
      for (const lp of f.loss_points) {
        items.push({
          index: idx++,
          flightId: f.id,
          flightLabel: label,
          point: lp,
        });
      }
    }
    return items;
  }, [flights, registeredModeSCodes, aircraft]);

  // 통계
  const stats = useMemo(() => {
    if (flatLoss.length === 0)
      return { totalDuration: 0, avgDuration: 0, maxDuration: 0, totalPoints: 0, gapCount: 0 };
    // gap별 고유 지속시간 합산
    const gapDurations = new Map<string, number>();
    for (const f of flatLoss) {
      const key = `${f.point.mode_s}_${f.point.gap_start_time}`;
      if (!gapDurations.has(key)) gapDurations.set(key, f.point.gap_duration_secs);
    }
    const durations = Array.from(gapDurations.values());
    const totalDuration = durations.reduce((s, d) => s + d, 0);
    return {
      totalDuration,
      avgDuration: durations.length > 0 ? totalDuration / durations.length : 0,
      maxDuration: durations.length > 0 ? Math.max(...durations) : 0,
      totalPoints: flatLoss.length,
      gapCount: gapDurations.size,
    };
  }, [flatLoss]);

  // 비행검사기 비행만 필터
  const registeredFlights = useMemo(
    () => flights.filter((f) => registeredModeSCodes.has(f.mode_s.toUpperCase())),
    [flights, registeredModeSCodes]
  );

  // ── Garble 관련 memo ──
  const garbleAircraftMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of aircraft) {
      if (a.mode_s_code) {
        m.set(a.mode_s_code.toUpperCase(), a.name);
      }
    }
    return m;
  }, [aircraft]);

  const garbleStats = useMemo(() => {
    const uniqueModeS = new Set(garblePoints.map((p) => p.mode_s));
    const sidelobe = garblePoints.filter((p) => p.garble_type === "sidelobe").length;
    const multipath = garblePoints.filter((p) => p.garble_type === "multipath").length;
    return {
      total: garblePoints.length,
      uniqueModeS: uniqueModeS.size,
      sidelobe,
      multipath,
    };
  }, [garblePoints]);

  const garbleSelectedPoints = useMemo(() => {
    if (!garbleSelectedModeS) return [];
    return garblePoints.filter((p) => p.mode_s === garbleSelectedModeS);
  }, [garblePoints, garbleSelectedModeS]);

  const garbleReflectorEstimates = useMemo(() => {
    if (!garbleSelectedModeS) return [];
    const multipathPts = garbleSelectedPoints.filter((p) => p.garble_type === "multipath");
    const estimates: (ReflectorEstimate & { sourcePoint: GarblePoint })[] = [];
    for (const p of multipathPts) {
      const est = estimateReflectorPosition(
        radarSite.latitude,
        radarSite.longitude,
        p.rho_nm,
        p.theta_deg,
        p.real_lat,
        p.real_lon
      );
      if (est) {
        estimates.push({ ...est, sourcePoint: p });
      }
    }
    return estimates;
  }, [garbleSelectedModeS, garbleSelectedPoints, radarSite]);

  const garbleReflectorClusters = useMemo(() => {
    if (garbleReflectorEstimates.length === 0) return [];
    const buckets = new Map<number, typeof garbleReflectorEstimates>();
    for (const e of garbleReflectorEstimates) {
      const bucket = Math.round(e.bearing / 5) * 5;
      const arr = buckets.get(bucket) || [];
      arr.push(e);
      buckets.set(bucket, arr);
    }
    return [...buckets.entries()]
      .map(([bearing, pts]) => ({
        bearing,
        count: pts.length,
        avgDistanceNm: pts.reduce((s, p) => s + p.distanceNm, 0) / pts.length,
        avgConfidence: pts.reduce((s, p) => s + p.confidence, 0) / pts.length,
      }))
      .sort((a, b) => b.count - a.count);
  }, [garbleReflectorEstimates]);

  const garbleBearingHistogram = useMemo(() => {
    const bins: { center: number; sidelobe: number; multipath: number }[] = [];
    for (let deg = -175; deg <= 175; deg += 10) {
      bins.push({ center: deg, sidelobe: 0, multipath: 0 });
    }
    for (const p of garbleSelectedPoints) {
      const idx = Math.round((p.bearing_diff_deg + 175) / 10);
      const clampedIdx = Math.max(0, Math.min(bins.length - 1, idx));
      if (p.garble_type === "sidelobe") {
        bins[clampedIdx].sidelobe++;
      } else {
        bins[clampedIdx].multipath++;
      }
    }
    return bins;
  }, [garbleSelectedPoints]);

  const garbleMaxBinCount = useMemo(
    () => Math.max(1, ...garbleBearingHistogram.map((b) => b.sidelobe + b.multipath)),
    [garbleBearingHistogram]
  );

  const garbleDetailColumns = [
    {
      key: "time",
      header: "시각(KST)",
      render: (row: GarblePoint) => (
        <span className="font-mono text-xs">{toKST(row.timestamp)}</span>
      ),
    },
    {
      key: "track_number",
      header: "TRK#",
      align: "right" as const,
      render: (row: GarblePoint) => row.track_number,
    },
    {
      key: "garble_type",
      header: "유형",
      render: (row: GarblePoint) => (
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-medium ${
            row.garble_type === "sidelobe"
              ? "bg-yellow-500/20 text-yellow-400"
              : "bg-orange-500/20 text-orange-400"
          }`}
        >
          {row.garble_type === "sidelobe" ? "사이드로브" : "다중경로"}
        </span>
      ),
    },
    {
      key: "theta_deg",
      header: "방위",
      align: "right" as const,
      render: (row: GarblePoint) => row.theta_deg.toFixed(1),
    },
    {
      key: "rho_nm",
      header: "거리(NM)",
      align: "right" as const,
      render: (row: GarblePoint) => row.rho_nm.toFixed(1),
    },
    {
      key: "bearing_diff_deg",
      header: "방위차",
      align: "right" as const,
      render: (row: GarblePoint) => row.bearing_diff_deg.toFixed(1),
    },
    {
      key: "range_diff_nm",
      header: "거리차(NM)",
      align: "right" as const,
      render: (row: GarblePoint) => row.range_diff_nm.toFixed(2),
    },
    {
      key: "alt_diff",
      header: "고도차(m)",
      align: "right" as const,
      render: (row: GarblePoint) => Math.round(Math.abs(row.ghost_altitude - row.real_altitude)),
    },
    {
      key: "ghost_real_dist",
      header: "Ghost→Real(km)",
      align: "right" as const,
      render: (row: GarblePoint) =>
        haversineKm(row.ghost_lat, row.ghost_lon, row.real_lat, row.real_lon).toFixed(2),
    },
    {
      key: "weather",
      header: "기상",
      render: (row: GarblePoint) => {
        if (!weatherData) return <span className="text-gray-500">-</span>;
        const w = getWeatherAtTime(weatherData, row.timestamp);
        if (!w) return <span className="text-gray-500">-</span>;
        const ducting = assessDuctingRisk(w);
        return (
          <span className="text-[10px]">
            {w.cloud_cover}% {(w.visibility / 1000).toFixed(0)}km{" "}
            {ducting !== "low" && (
              <span className={ducting === "high" ? "text-red-400 font-bold" : "text-yellow-400"}>
                {ducting === "high" ? "덕팅!" : "덕팅?"}
              </span>
            )}
          </span>
        );
      },
    },
  ];

  // SVG 차트 크기
  const svgW = 600;
  const svgH = 280;
  const margin = { top: 20, right: 20, bottom: 40, left: 50 };
  const chartW = svgW - margin.left - margin.right;
  const chartH = svgH - margin.top - margin.bottom;
  const barW = chartW / garbleBearingHistogram.length;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">통계 / 분석</h1>
          <p className="mt-1 text-sm text-gray-500">
            비행검사기 항적 통계 및 표적소실 구간 분석
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
          {(
            [
              ["by-flight", "비행별"],
              ["garble", "Garble 분석"],
              ["los-panorama", "전파 장애물"],
            ] as const
          ).map(([mode, label]) => (
            <button
              key={mode}
              onClick={() => setViewMode(mode)}
              className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                viewMode === mode
                  ? "bg-[#a60739] text-white"
                  : "text-gray-500 hover:text-gray-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* ── LoS 파노라마 뷰 ── */}
      {viewMode === "los-panorama" ? (
        <>
          {panoramaLoading ? (
            <SimpleCard>
              <div className="flex items-center justify-center gap-3 py-16 text-sm text-gray-500">
                <Loader2 className="h-5 w-5 animate-spin" />
                파노라마 계산 중... (지형 + 건물 스캔)
              </div>
            </SimpleCard>
          ) : panoramaData.length === 0 ? (
            <SimpleCard>
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-gray-500">
                <Eye className="h-8 w-8 text-gray-300" />
                <p>SRTM 지형 데이터가 필요합니다.</p>
                <p className="text-xs">설정에서 SRTM 타일을 다운로드하세요.</p>
              </div>
            </SimpleCard>
          ) : (
            <>
              {/* Row 1: 파노라마 차트 */}
              <SimpleCard className="p-0">
                <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800">
                      360° LoS 파노라마 — {radarSite.name}
                    </h3>
                    <p className="mt-0.5 text-xs text-gray-500">
                      레이더 안테나 ({(radarSite.altitude + radarSite.antenna_height).toFixed(0)}m ASL) 기준 전방위 최대 장애물 앙각
                    </p>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1.5">
                      <label className="text-xs text-gray-500 whitespace-nowrap">건물 높이 필터</label>
                      <select
                        value={panoramaBldgMaxHeight === null ? "" : String(panoramaBldgMaxHeight)}
                        onChange={(e) => {
                          const v = e.target.value;
                          setPanoramaBldgMaxHeight(v === "" ? null : Number(v));
                          setPanoramaPinnedIdx(null);
                        }}
                        className="rounded border border-gray-200 bg-white px-2 py-1 text-xs text-gray-700"
                      >
                        <option value="">전체</option>
                        <option value="200">≤ 200m</option>
                        <option value="150">≤ 150m</option>
                        <option value="100">≤ 100m</option>
                        <option value="50">≤ 50m</option>
                        <option value="30">≤ 30m</option>
                      </select>
                      {panoramaBldgMaxHeight !== null && (() => {
                        const excluded = panoramaData.filter((p) => p.obstacle_type !== "terrain" && p.obstacle_height_m > panoramaBldgMaxHeight).length;
                        return excluded > 0 ? (
                          <span className="text-[10px] text-orange-500">{excluded}건 제외</span>
                        ) : null;
                      })()}
                    </div>
                    <button
                      onClick={() => {
                        invoke("clear_panorama_cache", {
                          radarLat: radarSite.latitude,
                          radarLon: radarSite.longitude,
                        }).catch(() => {});
                        setPanoramaData([]);
                        computePanorama();
                      }}
                      className="rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-50"
                    >
                      갱신
                    </button>
                  </div>
                </div>
                <div className="p-4">
                  <svg
                    ref={panoramaSvgRef}
                    viewBox={`0 0 ${panoramaSvgW} ${panoramaSvgH}`}
                    className="w-full cursor-crosshair"
                    onMouseMove={handlePanoramaMouseMove}
                    onMouseLeave={() => setPanoramaHoverIdx(null)}
                    onClick={handlePanoramaClick}
                  >
                    {/* 배경 */}
                    <rect x={0} y={0} width={panoramaSvgW} height={panoramaSvgH} fill="#fafafa" rx={4} />

                    {/* 차트 영역 클리핑 */}
                    <defs>
                      <clipPath id="panorama-clip">
                        <rect x={panoramaMargin.left} y={panoramaMargin.top} width={panoramaChartW} height={panoramaChartH} />
                      </clipPath>
                    </defs>

                    {/* Y축 그리드 */}
                    {(() => {
                      const range = panoramaMaxAngle - panoramaMinAngle;
                      const step = range > 2 ? 0.5 : range > 1 ? 0.2 : 0.1;
                      const lines: React.JSX.Element[] = [];
                      for (let v = Math.ceil(panoramaMinAngle / step) * step; v <= panoramaMaxAngle; v += step) {
                        const y = panoramaMargin.top + panoramaChartH * (1 - (v - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                        lines.push(
                          <g key={`ygrid-${v.toFixed(2)}`}>
                            <line x1={panoramaMargin.left} y1={y} x2={panoramaMargin.left + panoramaChartW} y2={y}
                              stroke={Math.abs(v) < 0.001 ? "#9ca3af" : "#e5e7eb"} strokeWidth={Math.abs(v) < 0.001 ? 1 : 0.5}
                              strokeDasharray={Math.abs(v) < 0.001 ? undefined : "3,3"} />
                            <text x={panoramaMargin.left - 6} y={y + 3} textAnchor="end" fill="#6b7280" fontSize={10}>
                              {v.toFixed(1)}°
                            </text>
                          </g>
                        );
                      }
                      return lines;
                    })()}

                    {/* X축 방위 그리드 */}
                    {[0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330, 360].map((az) => {
                      const x = panoramaMargin.left + (az / 360) * panoramaChartW;
                      const labels: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W", 360: "N" };
                      const isCardinal = az % 90 === 0;
                      return (
                        <g key={`xgrid-${az}`}>
                          <line x1={x} y1={panoramaMargin.top} x2={x} y2={panoramaMargin.top + panoramaChartH}
                            stroke={isCardinal ? "#d1d5db" : "#e5e7eb"} strokeWidth={isCardinal ? 0.8 : 0.5}
                            strokeDasharray={isCardinal ? undefined : "2,4"} />
                          <text x={x} y={panoramaMargin.top + panoramaChartH + 16} textAnchor="middle"
                            fill={isCardinal ? "#374151" : "#9ca3af"} fontSize={isCardinal ? 11 : 9} fontWeight={isCardinal ? 600 : 400}>
                            {labels[az] ?? `${az}°`}
                          </text>
                        </g>
                      );
                    })}

                    {/* 지형/건물 면 채우기 */}
                    <g clipPath="url(#panorama-clip)">
                      {/* 지형 영역 (녹색) */}
                      <path
                        d={(() => {
                          const yBase = panoramaMargin.top + panoramaChartH;
                          const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                          let d = `M ${panoramaMargin.left} ${yBase}`;
                          for (let i = 0; i < filteredPanoramaData.length; i++) {
                            const x = panoramaMargin.left + (i / (filteredPanoramaData.length - 1)) * panoramaChartW;
                            const pt = filteredPanoramaData[i];
                            // 지형 부분만: 건물인 경우 건물 없는 지면 앙각 추정 (지면표고 사용)
                            const terrainAngle = pt.obstacle_type === "terrain"
                              ? pt.elevation_angle_deg
                              : Math.max(0, pt.elevation_angle_deg - (pt.obstacle_height_m / (pt.distance_km * 1000)) * (180 / Math.PI));
                            d += ` L ${x} ${toY(Math.max(terrainAngle, panoramaMinAngle))}`;
                          }
                          d += ` L ${panoramaMargin.left + panoramaChartW} ${yBase} Z`;
                          return d;
                        })()}
                        fill="#22c55e"
                        fillOpacity={0.2}
                      />

                      {/* 전체 실루엣 (건물 포함, 라인) */}
                      <path
                        d={(() => {
                          const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                          let d = "";
                          for (let i = 0; i < filteredPanoramaData.length; i++) {
                            const x = panoramaMargin.left + (i / (filteredPanoramaData.length - 1)) * panoramaChartW;
                            const y = toY(filteredPanoramaData[i].elevation_angle_deg);
                            d += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
                          }
                          return d;
                        })()}
                        fill="none"
                        stroke="#16a34a"
                        strokeWidth={1.2}
                      />

                      {/* 건물 포인트 (건물인 경우 오렌지 세로선) */}
                      {filteredPanoramaData.map((pt, i) => {
                        if (pt.obstacle_type === "terrain") return null;
                        const x = panoramaMargin.left + (i / (filteredPanoramaData.length - 1)) * panoramaChartW;
                        const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                        const yTop = toY(pt.elevation_angle_deg);
                        // 지면 앙각 추정
                        const terrainAngle = Math.max(0, pt.elevation_angle_deg - (pt.obstacle_height_m / (pt.distance_km * 1000)) * (180 / Math.PI));
                        const yBottom = toY(Math.max(terrainAngle, panoramaMinAngle));
                        const color = pt.obstacle_type === "manual_building" ? "#ef4444" : "#f97316";
                        return (
                          <line key={`bld-${i}`} x1={x} y1={yTop} x2={x} y2={yBottom}
                            stroke={color} strokeWidth={2} strokeOpacity={0.7} />
                        );
                      })}
                    </g>

                    {/* 호버/핀 크로스헤어 */}
                    {panoramaActiveIdx !== null && (
                      <g>
                        {(() => {
                          const pt = filteredPanoramaData[panoramaActiveIdx];
                          const x = panoramaMargin.left + (panoramaActiveIdx / (filteredPanoramaData.length - 1)) * panoramaChartW;
                          const y = panoramaMargin.top + panoramaChartH * (1 - (pt.elevation_angle_deg - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                          const isPinned = panoramaPinnedIdx === panoramaActiveIdx;
                          return (
                            <>
                              <line x1={x} y1={panoramaMargin.top} x2={x} y2={panoramaMargin.top + panoramaChartH}
                                stroke={isPinned ? "#eab308" : "#6b7280"} strokeWidth={1} strokeDasharray="3,3" />
                              <line x1={panoramaMargin.left} y1={y} x2={panoramaMargin.left + panoramaChartW} y2={y}
                                stroke={isPinned ? "#eab308" : "#6b7280"} strokeWidth={0.5} strokeDasharray="3,3" />
                              <circle cx={x} cy={y} r={4}
                                fill={pt.obstacle_type !== "terrain" ? "#f97316" : "#22c55e"}
                                stroke={isPinned ? "#eab308" : "#fff"} strokeWidth={2} />
                              {/* 방위/앙각 라벨 */}
                              <rect x={x + 8} y={panoramaMargin.top - 2} width={80} height={16} rx={3}
                                fill="rgba(0,0,0,0.75)" />
                              <text x={x + 12} y={panoramaMargin.top + 10} fill="white" fontSize={10}>
                                {pt.azimuth_deg.toFixed(1)}° / {pt.elevation_angle_deg.toFixed(3)}°
                              </text>
                            </>
                          );
                        })()}
                      </g>
                    )}

                    {/* 축 라벨 */}
                    <text x={panoramaSvgW / 2} y={panoramaSvgH - 4} textAnchor="middle" fill="#6b7280" fontSize={11}>
                      방위 (°)
                    </text>
                    <text x={14} y={panoramaMargin.top + panoramaChartH / 2} textAnchor="middle" fill="#6b7280" fontSize={11}
                      transform={`rotate(-90, 14, ${panoramaMargin.top + panoramaChartH / 2})`}>
                      앙각 (°)
                    </text>

                    {/* 범례 */}
                    <g transform={`translate(${panoramaMargin.left + 10}, ${panoramaMargin.top + 8})`}>
                      <rect x={0} y={0} width={8} height={8} fill="#22c55e" fillOpacity={0.5} rx={1} />
                      <text x={12} y={8} fill="#374151" fontSize={9}>지형</text>
                      <rect x={50} y={0} width={8} height={8} fill="#f97316" fillOpacity={0.7} rx={1} />
                      <text x={62} y={8} fill="#374151" fontSize={9}>GIS 건물</text>
                      <rect x={115} y={0} width={8} height={8} fill="#ef4444" fillOpacity={0.7} rx={1} />
                      <text x={127} y={8} fill="#374151" fontSize={9}>수동 건물</text>
                    </g>
                  </svg>
                </div>
              </SimpleCard>

              {/* Row 2: 상세 패널 */}
              <SimpleCard>
                {panoramaActivePoint ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3">
                      <span className={`rounded px-2 py-0.5 text-xs font-medium ${
                        panoramaActivePoint.obstacle_type === "terrain"
                          ? "bg-green-100 text-green-700"
                          : panoramaActivePoint.obstacle_type === "gis_building"
                          ? "bg-orange-100 text-orange-700"
                          : "bg-red-100 text-red-700"
                      }`}>
                        {panoramaActivePoint.obstacle_type === "terrain" ? "지형"
                          : panoramaActivePoint.obstacle_type === "gis_building" ? "GIS 건물"
                          : "수동 건물"}
                      </span>
                      {panoramaActivePoint.name && (
                        <span className="text-sm font-semibold text-gray-800">
                          {panoramaActivePoint.name}
                        </span>
                      )}
                      {panoramaPinnedIdx !== null && (
                        <span className="ml-auto rounded bg-yellow-100 px-1.5 py-0.5 text-[10px] text-yellow-700">
                          고정됨 (클릭하여 해제)
                        </span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm sm:grid-cols-4">
                      <div>
                        <span className="text-xs text-gray-400">방위</span>
                        <p className="font-mono font-medium text-gray-800">{panoramaActivePoint.azimuth_deg.toFixed(1)}°</p>
                      </div>
                      <div>
                        <span className="text-xs text-gray-400">앙각</span>
                        <p className="font-mono font-medium text-gray-800">{panoramaActivePoint.elevation_angle_deg.toFixed(3)}°</p>
                      </div>
                      <div>
                        <span className="text-xs text-gray-400">거리</span>
                        <p className="font-mono font-medium text-gray-800">{panoramaActivePoint.distance_km.toFixed(2)} km</p>
                      </div>
                      <div>
                        <span className="text-xs text-gray-400">지면 표고</span>
                        <p className="font-mono font-medium text-gray-800">{panoramaActivePoint.ground_elev_m.toFixed(0)} m</p>
                      </div>
                      {panoramaActivePoint.obstacle_type !== "terrain" && (
                        <>
                          <div>
                            <span className="text-xs text-gray-400">건물 높이</span>
                            <p className="font-mono font-medium text-gray-800">{panoramaActivePoint.obstacle_height_m.toFixed(1)} m</p>
                          </div>
                          <div>
                            <span className="text-xs text-gray-400">총 높이 (ASL)</span>
                            <p className="font-mono font-medium text-gray-800">
                              {(panoramaActivePoint.ground_elev_m + panoramaActivePoint.obstacle_height_m).toFixed(0)} m
                            </p>
                          </div>
                        </>
                      )}
                      {panoramaActivePoint.obstacle_type === "terrain" && (
                        <div>
                          <span className="text-xs text-gray-400">지형 표고</span>
                          <p className="font-mono font-medium text-gray-800">{panoramaActivePoint.obstacle_height_m.toFixed(0)} m</p>
                        </div>
                      )}
                      <div>
                        <span className="text-xs text-gray-400">좌표</span>
                        <p className="font-mono text-xs text-gray-600">
                          {panoramaActivePoint.lat.toFixed(5)}°N {panoramaActivePoint.lon.toFixed(5)}°E
                        </p>
                      </div>
                    </div>
                    {panoramaActivePoint.obstacle_type !== "terrain" && (
                      <div className="flex gap-6 border-t border-gray-100 pt-2 text-sm">
                        {panoramaActivePoint.address && (
                          <div>
                            <span className="text-xs text-gray-400">주소</span>
                            <p className="text-gray-700">{panoramaActivePoint.address}</p>
                          </div>
                        )}
                        {panoramaActivePoint.usage && (
                          <div>
                            <span className="text-xs text-gray-400">용도</span>
                            <p className="text-gray-700">{panoramaActivePoint.usage}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                ) : (
                  <div className="flex items-center justify-center py-8 text-sm text-gray-400">
                    <Eye className="mr-2 h-4 w-4" />
                    차트 위를 호버하거나 클릭하여 장애물 상세 정보를 확인하세요
                  </div>
                )}
              </SimpleCard>

              {/* Row 3: 건물 위치 지도 */}
              {panoramaBuildingPoints.length > 0 && (
                <SimpleCard className="p-0">
                  <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-800">
                        파노라마 건물 위치
                      </h3>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {panoramaBuildingPoints.length}개 건물 표시
                        {panoramaBldgMaxHeight !== null && ` (≤ ${panoramaBldgMaxHeight}m 필터 적용)`}
                      </p>
                    </div>
                  </div>
                  <div className="h-[400px]">
                    <MapGL
                      ref={panoramaMapRef}
                      initialViewState={{
                        latitude: radarSite.latitude,
                        longitude: radarSite.longitude,
                        zoom: 10,
                      }}
                      style={{ width: "100%", height: "100%" }}
                      mapStyle="https://basemaps.cartocdn.com/gl/positron-gl-style/style.json"
                    >
                      <NavigationControl position="top-right" />
                      <DeckGLOverlay
                        layers={[
                          // 레이더 → 건물 연결선
                          new LineLayer({
                            id: "panorama-bldg-lines",
                            data: panoramaBuildingPoints,
                            getSourcePosition: () => [radarSite.longitude, radarSite.latitude],
                            getTargetPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                            getColor: [100, 100, 100, 40],
                            getWidth: 1,
                          }),
                          // 건물 포인트
                          new ScatterplotLayer({
                            id: "panorama-bldg-dots",
                            data: panoramaBuildingPoints,
                            getPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                            getRadius: (d: PanoramaPoint) => Math.max(30, d.obstacle_height_m * 2),
                            getFillColor: (d: PanoramaPoint) =>
                              d.obstacle_type === "manual_building" ? [239, 68, 68, 180] : [249, 115, 22, 180],
                            getLineColor: [255, 255, 255, 200],
                            lineWidthMinPixels: 1,
                            stroked: true,
                            pickable: true,
                            radiusMinPixels: 4,
                            radiusMaxPixels: 20,
                          }),
                          // 레이더 위치
                          new ScatterplotLayer({
                            id: "panorama-radar-dot",
                            data: [radarSite],
                            getPosition: (d: typeof radarSite) => [d.longitude, d.latitude],
                            getFillColor: [14, 165, 233, 220],
                            getLineColor: [255, 255, 255, 255],
                            getRadius: 200,
                            stroked: true,
                            lineWidthMinPixels: 2,
                            radiusMinPixels: 8,
                            radiusMaxPixels: 12,
                          }),
                          // 활성 건물 하이라이트
                          ...(panoramaActivePoint && panoramaActivePoint.obstacle_type !== "terrain"
                            ? [
                                new ScatterplotLayer({
                                  id: "panorama-bldg-highlight",
                                  data: [panoramaActivePoint],
                                  getPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                                  getFillColor: [234, 179, 8, 220],
                                  getLineColor: [255, 255, 255, 255],
                                  getRadius: 300,
                                  stroked: true,
                                  lineWidthMinPixels: 2,
                                  radiusMinPixels: 8,
                                  radiusMaxPixels: 24,
                                }),
                              ]
                            : []),
                        ]}
                      />
                    </MapGL>
                  </div>
                </SimpleCard>
              )}
            </>
          )}
        </>
      ) : viewMode === "garble" ? (
        <>
          {/* Garble Summary Cards */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card
              title="총 Garble 탐지"
              value={garbleStats.total}
              icon={Radio}
              accent="#e94560"
            />
            <Card
              title="영향 Mode-S"
              value={garbleStats.uniqueModeS}
              icon={Users}
              accent="#3b82f6"
            />
            <Card
              title="사이드로브"
              value={garbleStats.sidelobe}
              icon={Zap}
              accent="#eab308"
            />
            <Card
              title="다중경로"
              value={garbleStats.multipath}
              icon={Waves}
              accent="#f97316"
            />
          </div>

          {/* Garble Map (full width) */}
          <GarbleMapView
            garblePoints={garblePoints}
            selectedModeS={garbleSelectedModeS}
            radarSite={radarSite}
            reflectorEstimates={garbleReflectorEstimates}
          />

          {/* Garble Detail Panel (full width) */}
          <div>
            {!garbleSelectedModeS ? (
              <SimpleCard>
                <div className="flex items-center justify-center py-12 text-sm text-gray-500">
                  사이드바에서 항공기를 선택하면 상세 분석이 표시됩니다
                </div>
              </SimpleCard>
            ) : (
                <SimpleCard className="p-0">
                  {/* Tab header */}
                  <div className="flex items-center justify-between border-b border-gray-200 px-4 py-3">
                    <div>
                      <h3 className="text-sm font-semibold text-gray-800">
                        상세 분석 — {garbleSelectedModeS}
                        {garbleAircraftMap.get(garbleSelectedModeS.toUpperCase()) &&
                          ` (${garbleAircraftMap.get(garbleSelectedModeS.toUpperCase())})`}
                      </h3>
                      <p className="mt-0.5 text-xs text-gray-500">
                        {garbleSelectedPoints.length}건 탐지
                      </p>
                    </div>
                    <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
                      {(
                        [
                          ["table", "상세 테이블"],
                          ["bearing", "방위 분포"],
                          ["reflector", "반사체 추정"],
                        ] as [GarbleDetailTab, string][]
                      ).map(([tab, label]) => (
                        <button
                          key={tab}
                          onClick={() => setGarbleActiveTab(tab)}
                          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                            garbleActiveTab === tab
                              ? "bg-[#e94560] text-white"
                              : "text-gray-500 hover:text-gray-900"
                          }`}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div className="p-4">
                    {/* 상세 테이블 */}
                    {garbleActiveTab === "table" && (
                      <DataTable
                        columns={garbleDetailColumns}
                        data={garbleSelectedPoints}
                        rowKey={(_, idx) => `detail-${idx}`}
                        emptyMessage="해당 Mode-S의 Garble 포인트가 없습니다."
                        maxHeight="max-h-[460px]"
                      />
                    )}

                    {/* 방위 분포 히스토그램 */}
                    {garbleActiveTab === "bearing" && (
                      <div>
                        <p className="mb-3 text-xs text-gray-500">
                          방위차 분포 (10° 단위)
                        </p>
                        <svg
                          viewBox={`0 0 ${svgW} ${svgH}`}
                          className="w-full"
                          style={{ maxWidth: svgW }}
                        >
                          {/* Grid lines */}
                          {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
                            const y = margin.top + chartH * (1 - frac);
                            return (
                              <g key={`grid-${frac}`}>
                                <line
                                  x1={margin.left}
                                  y1={y}
                                  x2={margin.left + chartW}
                                  y2={y}
                                  stroke="#374151"
                                  strokeWidth={0.5}
                                  strokeDasharray={frac === 0 ? undefined : "2,2"}
                                />
                                <text
                                  x={margin.left - 6}
                                  y={y + 3}
                                  textAnchor="end"
                                  fill="#9ca3af"
                                  fontSize={10}
                                >
                                  {Math.round(garbleMaxBinCount * frac)}
                                </text>
                              </g>
                            );
                          })}

                          {/* Bars */}
                          {garbleBearingHistogram.map((bin, i) => {
                            const x = margin.left + i * barW;
                            const totalH =
                              ((bin.sidelobe + bin.multipath) / garbleMaxBinCount) * chartH;
                            const sideH = (bin.sidelobe / garbleMaxBinCount) * chartH;
                            const multiH = (bin.multipath / garbleMaxBinCount) * chartH;
                            const baseY = margin.top + chartH;

                            return (
                              <g key={`bar-${bin.center}`}>
                                {/* Multipath (bottom) */}
                                {bin.multipath > 0 && (
                                  <rect
                                    x={x + 1}
                                    y={baseY - multiH}
                                    width={Math.max(barW - 2, 1)}
                                    height={multiH}
                                    fill="#f97316"
                                    rx={1}
                                  />
                                )}
                                {/* Sidelobe (stacked on top) */}
                                {bin.sidelobe > 0 && (
                                  <rect
                                    x={x + 1}
                                    y={baseY - totalH}
                                    width={Math.max(barW - 2, 1)}
                                    height={sideH}
                                    fill="#eab308"
                                    rx={1}
                                  />
                                )}
                              </g>
                            );
                          })}

                          {/* X axis labels */}
                          {garbleBearingHistogram
                            .filter((_, i) => i % 6 === 0 || i === garbleBearingHistogram.length - 1)
                            .map((bin, _) => {
                              const i = garbleBearingHistogram.indexOf(bin);
                              const x = margin.left + i * barW + barW / 2;
                              return (
                                <text
                                  key={`xlabel-${bin.center}`}
                                  x={x}
                                  y={margin.top + chartH + 18}
                                  textAnchor="middle"
                                  fill="#9ca3af"
                                  fontSize={10}
                                >
                                  {bin.center}°
                                </text>
                              );
                            })}

                          {/* Axis labels */}
                          <text
                            x={svgW / 2}
                            y={svgH - 4}
                            textAnchor="middle"
                            fill="#9ca3af"
                            fontSize={11}
                          >
                            방위차 (°)
                          </text>
                          <text
                            x={12}
                            y={margin.top + chartH / 2}
                            textAnchor="middle"
                            fill="#9ca3af"
                            fontSize={11}
                            transform={`rotate(-90, 12, ${margin.top + chartH / 2})`}
                          >
                            건수
                          </text>
                        </svg>

                        {/* Legend */}
                        <div className="mt-3 flex items-center justify-center gap-6 text-xs text-gray-500">
                          <div className="flex items-center gap-1.5">
                            <div className="h-3 w-3 rounded-sm bg-yellow-500" />
                            사이드로브
                          </div>
                          <div className="flex items-center gap-1.5">
                            <div className="h-3 w-3 rounded-sm bg-orange-500" />
                            다중경로
                          </div>
                        </div>
                      </div>
                    )}

                    {/* 반사체 추정 */}
                    {garbleActiveTab === "reflector" && (
                      <div className="space-y-4">
                        {garbleReflectorEstimates.length === 0 ? (
                          <div className="py-12 text-center text-sm text-gray-500">
                            {garbleSelectedPoints.filter((p) => p.garble_type === "multipath")
                              .length === 0
                              ? "선택된 Mode-S에 다중경로 포인트가 없습니다."
                              : "반사체 위치를 추정할 수 없습니다."}
                          </div>
                        ) : (
                          <>
                            {/* 추정 결과 테이블 */}
                            <div>
                              <p className="mb-2 text-xs font-medium text-gray-500">
                                추정 반사체 위치 ({garbleReflectorEstimates.length}건)
                              </p>
                              <div className="max-h-[280px] overflow-auto rounded-lg border border-gray-200">
                                <table className="w-full text-sm">
                                  <thead className="sticky top-0 z-10 bg-gray-100 text-gray-600">
                                    <tr>
                                      <th className="whitespace-nowrap px-4 py-2 text-left font-medium">
                                        #
                                      </th>
                                      <th className="whitespace-nowrap px-4 py-2 text-right font-medium">
                                        방위(°)
                                      </th>
                                      <th className="whitespace-nowrap px-4 py-2 text-right font-medium">
                                        거리(NM)
                                      </th>
                                      <th className="whitespace-nowrap px-4 py-2 text-right font-medium">
                                        신뢰도
                                      </th>
                                      <th className="whitespace-nowrap px-4 py-2 text-left font-medium">
                                        좌표
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody className="divide-y divide-gray-100">
                                    {garbleReflectorEstimates.map((est, i) => (
                                      <tr
                                        key={`ref-${i}`}
                                        className="bg-white hover:bg-gray-100"
                                      >
                                        <td className="px-4 py-2 text-gray-500">
                                          {i + 1}
                                        </td>
                                        <td className="px-4 py-2 text-right text-gray-600">
                                          {est.bearing.toFixed(1)}
                                        </td>
                                        <td className="px-4 py-2 text-right text-gray-600">
                                          {est.distanceNm.toFixed(1)}
                                        </td>
                                        <td className="px-4 py-2 text-right">
                                          <span
                                            className={`font-medium ${
                                              est.confidence > 0.7
                                                ? "text-green-500"
                                                : est.confidence > 0.4
                                                ? "text-yellow-500"
                                                : "text-red-400"
                                            }`}
                                          >
                                            {(est.confidence * 100).toFixed(0)}%
                                          </span>
                                        </td>
                                        <td className="px-4 py-2 font-mono text-xs text-gray-500">
                                          {est.lat.toFixed(4)}°N{" "}
                                          {est.lon.toFixed(4)}°E
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            </div>

                            {/* 클러스터 요약 */}
                            {garbleReflectorClusters.length > 0 && (
                              <div>
                                <p className="mb-2 text-xs font-medium text-gray-500">
                                  반사체 클러스터 요약 (방위 5° 그룹)
                                </p>
                                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                                  {garbleReflectorClusters.slice(0, 6).map((cl) => (
                                    <div
                                      key={`cl-${cl.bearing}`}
                                      className="rounded-lg border border-gray-200 bg-gray-50 p-3"
                                    >
                                      <div className="flex items-center justify-between">
                                        <span className="text-sm font-medium text-gray-800">
                                          방위 {cl.bearing}°
                                        </span>
                                        <span className="rounded bg-orange-500/20 px-1.5 py-0.5 text-xs font-medium text-orange-400">
                                          {cl.count}건
                                        </span>
                                      </div>
                                      <div className="mt-1.5 flex gap-4 text-xs text-gray-500">
                                        <span>
                                          평균 거리:{" "}
                                          <span className="font-medium text-gray-700">
                                            {cl.avgDistanceNm.toFixed(1)} NM
                                          </span>
                                        </span>
                                        <span>
                                          신뢰도:{" "}
                                          <span
                                            className={`font-medium ${
                                              cl.avgConfidence > 0.7
                                                ? "text-green-500"
                                                : cl.avgConfidence > 0.4
                                                ? "text-yellow-500"
                                                : "text-red-400"
                                            }`}
                                          >
                                            {(cl.avgConfidence * 100).toFixed(0)}%
                                          </span>
                                        </span>
                                      </div>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </SimpleCard>
              )}
          </div>
        </>
      ) : (
        <>
          {/* ── Loss 비행별 뷰 ── */}
          {/* Stats */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Card
              title="미탐지 포인트"
              value={`${flatLoss.length}pt / ${stats.gapCount}gap`}
              icon={BarChart3}
              accent="#a60739"
            />
            <Card
              title="총 소실 시간"
              value={`${stats.totalDuration.toFixed(1)}초`}
              icon={Clock}
              accent="#f59e0b"
            />
            <Card
              title="평균 gap 시간"
              value={`${stats.avgDuration.toFixed(1)}초`}
              icon={Ruler}
              accent="#3b82f6"
            />
            <Card
              title="최대 gap 시간"
              value={`${stats.maxDuration.toFixed(1)}초`}
              icon={Mountain}
              accent="#10b981"
            />
          </div>

          {/* 비행별 뷰 */}
          {registeredFlights.length === 0 ? (
            <SimpleCard>
              <p className="text-center text-sm text-gray-500 py-8">
                분석 결과가 없습니다
              </p>
            </SimpleCard>
          ) : (
            <div className="space-y-2">
              {registeredFlights.map((f) => {
                const pct = f.loss_percentage;
                const typeCounts: Record<string, number> = {};
                for (const p of f.track_points) {
                  typeCounts[p.radar_type] = (typeCounts[p.radar_type] ?? 0) + 1;
                }
                const typeLabels: Record<string, string> = {
                  mode_ac: "Mode A/C",
                  mode_ac_psr: "A/C+PSR",
                  mode_s_allcall: "S All-Call",
                  mode_s_rollcall: "S Roll-Call",
                  mode_s_allcall_psr: "S AC+PSR",
                  mode_s_rollcall_psr: "S RC+PSR",
                };

                // 60NM 이내 PSR 탐지율 계산
                const NM60_KM = 60 * 1.852; // 111.12 km
                const psrTypes = new Set(["mode_ac_psr", "mode_s_allcall_psr", "mode_s_rollcall_psr"]);
                let within60Total = 0;
                let within60Psr = 0;
                for (const p of f.track_points) {
                  const dist = haversineKm(radarSite.latitude, radarSite.longitude, p.latitude, p.longitude);
                  if (dist <= NM60_KM) {
                    within60Total++;
                    if (psrTypes.has(p.radar_type)) within60Psr++;
                  }
                }
                const psrRate = within60Total > 0 ? (within60Psr / within60Total) * 100 : null;

                return (
                  <SimpleCard key={`flight-${f.id}`} className="!py-2.5 !px-3">
                    {/* 1행: 비행라벨 + 핵심 수치 */}
                    <div className="flex items-center gap-3">
                      <h3 className="min-w-0 flex-1 truncate text-sm font-medium text-gray-800">
                        {flightLabel(f, aircraft)}
                      </h3>
                      <div className="flex shrink-0 items-center gap-3 text-[11px] text-gray-500">
                        <span><b className="text-gray-700">{f.loss_points.length}</b>pt / <b className="text-gray-700">{f.loss_segments.length}</b>gap</span>
                        <span>소실 <b className="text-gray-700">{f.total_loss_time.toFixed(1)}</b>초</span>
                        <span>추적 <b className="text-gray-700">{(f.total_track_time / 60).toFixed(1)}</b>분</span>
                      </div>
                      {psrRate !== null && (
                        <span className="shrink-0 rounded px-2 py-0.5 text-xs font-bold bg-blue-100 text-blue-700" title={`60NM 이내 SSR 대비 PSR 탐지율 (${within60Psr}/${within60Total})`}>
                          PSR {psrRate.toFixed(1)}%
                        </span>
                      )}
                      <span className="shrink-0 rounded px-2 py-0.5 text-xs font-bold bg-[#a60739]/15 text-[#a60739]">
                        {pct.toFixed(1)}%
                      </span>
                    </div>
                    {/* 2행: 소실비율 바 + 레이더 유형 */}
                    <div className="mt-1.5 flex items-center gap-3">
                      <div className="h-2 flex-1 overflow-hidden rounded-full bg-gray-100">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(pct, 100)}%`,
                            backgroundColor: "#a60739",
                          }}
                        />
                      </div>
                      {Object.keys(typeCounts).length > 0 && (
                        <div className="flex shrink-0 items-center gap-2 text-[10px] text-gray-400">
                          {Object.entries(typeCounts).map(([type, count]) => (
                            <span key={type}>{typeLabels[type] ?? type} <b className="text-gray-600">{count.toLocaleString()}</b></span>
                          ))}
                        </div>
                      )}
                    </div>
                  </SimpleCard>
                );
              })}
            </div>
          )}
        </>
      )}
    </div>
  );
}
