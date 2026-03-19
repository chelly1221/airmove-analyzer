import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import MapGL, { NavigationControl, type MapRef } from "react-map-gl/maplibre";
import { ScatterplotLayer, LineLayer, PathLayer, PolygonLayer } from "@deck.gl/layers";
import { DeckGLOverlay } from "../components/Map/DeckGLOverlay";
import { invoke } from "@tauri-apps/api/core";
import {
  BarChart3,
  Clock,
  Ruler,
  Mountain,
  Eye,
  Loader2,
  Trash2,
  MapPin,
  Crosshair,
} from "lucide-react";
import Card from "../components/common/Card";
import { SimpleCard } from "../components/common/Card";

import { useAppStore } from "../store";
import { flightLabel } from "../utils/flightConsolidation";
import type { LossPoint, PanoramaPoint, LOSProfileData } from "../types";

interface FlatLoss {
  index: number;
  flightId: string;
  flightLabel: string;
  point: LossPoint;
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



export default function LossAnalysis() {
  const allFlights = useAppStore((s) => s.flights);
  const aircraft = useAppStore((s) => s.aircraft);
  const radarSite = useAppStore((s) => s.radarSite);
  const flights = useMemo(
    () => allFlights.filter((f) => !f.radar_name || f.radar_name === radarSite.name),
    [allFlights, radarSite.name],
  );
  const setPanoramaViewActive = useAppStore((s) => s.setPanoramaViewActive);
  const setPanoramaActivePointStore = useAppStore((s) => s.setPanoramaActivePoint);
  const setPanoramaPinnedStore = useAppStore((s) => s.setPanoramaPinned);
  const losResults = useAppStore((s) => s.losResults);
  const removeLOSResult = useAppStore((s) => s.removeLOSResult);
  const [viewMode, setViewMode] = useState<"by-flight" | "los-panorama" | "los-saved">(
    "by-flight"
  );
  const [losPreview, setLosPreview] = useState<LOSProfileData | null>(null);

  // ── LoS 파노라마 상태 ──
  const [panoramaData, setPanoramaData] = useState<PanoramaPoint[]>([]);
  const [panoramaLoading, setPanoramaLoading] = useState(false);
  const [panoramaHoverIdx, setPanoramaHoverIdx] = useState<number | null>(null);
  const [panoramaPinnedIdx, setPanoramaPinnedIdx] = useState<number | null>(null);
  const panoramaSvgRef = useRef<SVGSVGElement>(null);
  const [panoramaBldgMaxHeight, setPanoramaBldgMaxHeight] = useState<number | null>(null); // 건물 높이 필터 (null=미적용)
  const [panoramaPeakNames, setPanoramaPeakNames] = useState<Map<number, string>>(new Map()); // 파노라마 인덱스 → 산 이름
  // 파노라마 X축 줌 (방위 범위)
  const [panoramaAzRange, setPanoramaAzRange] = useState<[number, number]>([0, 360]);
  // 파노라마 미니맵 장애물 경계 오버레이 토글
  const [showBoundaryOverlay, setShowBoundaryOverlay] = useState(false);

  // 파노라마 뷰 활성 상태를 스토어에 동기화
  useEffect(() => {
    setPanoramaViewActive(viewMode === "los-panorama");
    return () => setPanoramaViewActive(false);
  }, [viewMode, setPanoramaViewActive]);

  // 파노라마 계산 함수 (GPU 우선, CPU 폴백, DB 저장 포함)
  const computePanorama = useCallback(async () => {
    setPanoramaLoading(true);
    setPanoramaPinnedIdx(null);
    setPanoramaHoverIdx(null);
    setPanoramaAzRange([0, 360]);
    const radarH = radarSite.altitude + radarSite.antenna_height;
    const azStep = 0.01;
    const rangeStep = 200.0;
    const maxRange = 100.0;

    try {
      // GPU 경로 시도
      const { computePanoramaTerrainGPU } = await import("../utils/gpuPanorama");
      const terrainResults = await computePanoramaTerrainGPU(
        radarSite.latitude, radarSite.longitude, radarH,
        maxRange, azStep, rangeStep,
      );

      if (terrainResults) {
        console.log(`[Panorama] GPU 지형 스캔 완료: ${terrainResults.length} azimuths`);
        // GPU 지형 결과에 건물 병합 (Rust)
        const data = await invoke<PanoramaPoint[]>("panorama_merge_buildings", {
          radarLat: radarSite.latitude,
          radarLon: radarSite.longitude,
          radarHeightM: radarH,
          maxRangeKm: maxRange,
          azimuthStepDeg: azStep,
          terrainResults,
        });
        setPanoramaData(data);

        invoke("save_panorama_cache", {
          radarLat: radarSite.latitude,
          radarLon: radarSite.longitude,
          radarHeightM: radarH,
          dataJson: JSON.stringify(data),
        }).catch((e) => console.error("파노라마 캐시 저장 실패:", e));
        return;
      }
    } catch (e) {
      console.warn("[Panorama] GPU 경로 실패, CPU 폴백:", e);
    }

    // CPU 폴백: 전체 Rust 계산
    try {
      const data = await invoke<PanoramaPoint[]>("calculate_los_panorama", {
        radarLat: radarSite.latitude,
        radarLon: radarSite.longitude,
        radarHeightM: radarH,
        maxRangeKm: maxRange,
        azimuthStepDeg: azStep,
        rangeStepM: rangeStep,
      });
      setPanoramaData(data);
      invoke("save_panorama_cache", {
        radarLat: radarSite.latitude,
        radarLon: radarSite.longitude,
        radarHeightM: radarH,
        dataJson: JSON.stringify(data),
      }).catch((e) => console.error("파노라마 캐시 저장 실패:", e));
    } catch (e) {
      console.error("파노라마 계산 실패:", e);
    }
  }, [radarSite]);

  // computePanorama wrapper (useEffect에서 호출 시 void 반환)
  const triggerPanorama = useCallback(() => {
    computePanorama().finally(() => setPanoramaLoading(false));
  }, [computePanorama]);

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
        triggerPanorama();
      })
      .catch(() => triggerPanorama());
  }, [viewMode, radarSite, panoramaData.length, triggerPanorama]);

  // 레이더 변경 시 파노라마 데이터 초기화
  const prevRadarRef = useRef(radarSite.name);
  useEffect(() => {
    if (prevRadarRef.current !== radarSite.name) {
      prevRadarRef.current = radarSite.name;
      setPanoramaData([]);
      setShowBoundaryOverlay(false);
      setPanoramaPinnedIdx(null);
      setPanoramaHoverIdx(null);
      setPanoramaPeakNames(new Map());
    }
  }, [radarSite.name]);

  // 파노라마 지형 장애물 산 이름 조회 (Overpass API)
  useEffect(() => {
    if (panoramaData.length === 0) return;
    let cancelled = false;

    // 지형 포인트 중 로컬 극대값(주변 ±5 bin보다 앙각이 큰 점) 추출
    const terrainPeaks: { idx: number; lat: number; lon: number; angle: number }[] = [];
    for (let i = 0; i < panoramaData.length; i++) {
      const pt = panoramaData[i];
      if (pt.obstacle_type !== "terrain" || pt.elevation_angle_deg <= 0.01) continue;
      // 로컬 극대값 검사 (±5 bin)
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
        // 인근 3km 이내 중복 제거
        const isDup = terrainPeaks.some((p) => haversineKm(p.lat, p.lon, pt.lat, pt.lon) < 3);
        if (!isDup) terrainPeaks.push({ idx: i, lat: pt.lat, lon: pt.lon, angle: pt.elevation_angle_deg });
      }
    }

    // 앙각 높은 순으로 최대 15개만 조회
    terrainPeaks.sort((a, b) => b.angle - a.angle);
    const targets = terrainPeaks.slice(0, 15);
    if (targets.length === 0) return;

    (async () => {
      const names = new Map<number, string>();
      // Overpass 배치 쿼리: 모든 대상 좌표를 하나의 union 쿼리로 처리
      const aroundClauses = targets.map((t) => `node["natural"="peak"](around:3000,${t.lat},${t.lon})`).join(";");
      try {
        const url = `https://overpass-api.de/api/interpreter?data=[out:json];(${aroundClauses};);out body;`;
        const resp = await fetch(url);
        if (!resp.ok || cancelled) return;
        const data = await resp.json();
        const peaks = data.elements ?? [];

        // 각 대상 좌표에 가장 가까운 peak 매칭
        for (const target of targets) {
          let closestName = "";
          let closestDist = Infinity;
          for (const el of peaks) {
            const d = haversineKm(target.lat, target.lon, el.lat, el.lon);
            if (d < closestDist && d < 3) {
              closestDist = d;
              closestName = el.tags?.["name:ko"] || el.tags?.name || "";
            }
          }
          if (closestName) {
            names.set(target.idx, closestName);
            // 인접 bin(같은 산을 가리키는 bin)에도 이름 전파
            for (let d = 1; d <= 10; d++) {
              for (const dir of [-1, 1]) {
                const adj = (target.idx + dir * d + panoramaData.length) % panoramaData.length;
                const adjPt = panoramaData[adj];
                if (adjPt.obstacle_type === "terrain" && haversineKm(adjPt.lat, adjPt.lon, target.lat, target.lon) < 3) {
                  names.set(adj, closestName);
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
  const panoramaSvgH = 200;
  const panoramaMargin = { top: 16, right: 30, bottom: 28, left: 50 };
  const panoramaChartW = panoramaSvgW - panoramaMargin.left - panoramaMargin.right;
  const panoramaChartH = panoramaSvgH - panoramaMargin.top - panoramaMargin.bottom;

  // 줌 범위에 해당하는 인덱스 범위
  const panoramaVisibleRange = useMemo(() => {
    const n = filteredPanoramaData.length;
    if (n === 0) return { startIdx: 0, endIdx: 0 };
    const startIdx = Math.max(0, Math.floor((panoramaAzRange[0] / 360) * (n - 1)));
    const endIdx = Math.min(n - 1, Math.ceil((panoramaAzRange[1] / 360) * (n - 1)));
    return { startIdx, endIdx };
  }, [filteredPanoramaData.length, panoramaAzRange]);

  const panoramaMaxAngle = useMemo(() => {
    if (filteredPanoramaData.length === 0) return 1.0;
    const { startIdx, endIdx } = panoramaVisibleRange;
    let maxA = 0;
    for (let i = startIdx; i <= endIdx; i++) maxA = Math.max(maxA, filteredPanoramaData[i].elevation_angle_deg);
    return Math.max(0.5, Math.ceil(maxA * 10) / 10 + 0.1);
  }, [filteredPanoramaData, panoramaVisibleRange]);

  const panoramaMinAngle = useMemo(() => {
    if (filteredPanoramaData.length === 0) return -0.2;
    const { startIdx, endIdx } = panoramaVisibleRange;
    let minA = Infinity;
    for (let i = startIdx; i <= endIdx; i++) minA = Math.min(minA, filteredPanoramaData[i].elevation_angle_deg);
    return Math.min(-0.1, Math.floor(minA * 10) / 10 - 0.1);
  }, [filteredPanoramaData, panoramaVisibleRange]);

  const panoramaActiveIdx = panoramaPinnedIdx ?? panoramaHoverIdx;
  const panoramaActivePoint = panoramaActiveIdx !== null ? filteredPanoramaData[panoramaActiveIdx] : null;

  // 활성 포인트를 스토어에 동기화 (사이드바 표시용) — 지형인 경우 산 이름 보강
  useEffect(() => {
    if (panoramaActivePoint && panoramaActivePoint.obstacle_type === "terrain" && panoramaActiveIdx !== null) {
      const peakName = panoramaPeakNames.get(panoramaActiveIdx);
      if (peakName) {
        setPanoramaActivePointStore({ ...panoramaActivePoint, name: peakName });
      } else {
        setPanoramaActivePointStore(panoramaActivePoint);
      }
    } else {
      setPanoramaActivePointStore(panoramaActivePoint);
    }
    setPanoramaPinnedStore(panoramaPinnedIdx !== null);
  }, [panoramaActivePoint, panoramaActiveIdx, panoramaPinnedIdx, panoramaPeakNames, setPanoramaActivePointStore, setPanoramaPinnedStore]);

  // 방위 → SVG x 좌표 변환 (줌 반영)
  const azToX = useCallback((az: number) => {
    const frac = (az - panoramaAzRange[0]) / (panoramaAzRange[1] - panoramaAzRange[0]);
    return panoramaMargin.left + frac * panoramaChartW;
  }, [panoramaAzRange, panoramaChartW, panoramaMargin.left]);

  // 인덱스 → SVG x 좌표
  const idxToX = useCallback((idx: number) => {
    const n = filteredPanoramaData.length;
    if (n <= 1) return panoramaMargin.left;
    const az = (idx / (n - 1)) * 360;
    return azToX(az);
  }, [filteredPanoramaData.length, azToX, panoramaMargin.left]);

  // 건물 세로선을 단일 <path>로 사전 계산 (DOM 수천 개 → 1개)
  const panoramaBuildingPaths = useMemo(() => {
    if (filteredPanoramaData.length === 0) return { gis: "", manual: "" };
    const { startIdx, endIdx } = panoramaVisibleRange;
    const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
    let gisD = "";
    let manualD = "";
    for (let i = startIdx; i <= endIdx; i++) {
      const pt = filteredPanoramaData[i];
      if (pt.obstacle_type === "terrain") continue;
      const x = idxToX(i);
      const yTop = toY(pt.elevation_angle_deg);
      const terrainAngle = Math.max(0, pt.elevation_angle_deg - (pt.obstacle_height_m / (pt.distance_km * 1000)) * (180 / Math.PI));
      const yBottom = toY(Math.max(terrainAngle, panoramaMinAngle));
      const seg = `M${x} ${yTop}L${x} ${yBottom}`;
      if (pt.obstacle_type === "manual_building") {
        manualD += seg;
      } else {
        gisD += seg;
      }
    }
    return { gis: gisD, manual: manualD };
  }, [filteredPanoramaData, panoramaVisibleRange, panoramaMinAngle, panoramaMaxAngle, panoramaMargin, panoramaChartH, idxToX]);

  // 미니맵 장애물 경계 오버레이 (폴리곤 + 유형별 세그먼트)
  const { boundaryPolygon, boundarySegments } = useMemo(() => {
    const empty = { boundaryPolygon: null as [number, number][] | null, boundarySegments: [] as { path: [number, number][]; color: [number, number, number, number] }[] };
    if (!showBoundaryOverlay || filteredPanoramaData.length < 3) return empty;
    const pts = filteredPanoramaData;
    const coords: [number, number][] = pts.map((p) => [p.lon, p.lat]);
    coords.push(coords[0]);
    const TYPE_COLORS: Record<string, [number, number, number, number]> = {
      terrain: [34, 197, 94, 200],
      gis_building: [245, 158, 11, 220],
      manual_building: [239, 68, 68, 220],
    };
    const segments: { path: [number, number][]; color: [number, number, number, number] }[] = [];
    let curType = pts[0].obstacle_type;
    let curPath: [number, number][] = [[pts[0].lon, pts[0].lat]];
    for (let i = 1; i <= pts.length; i++) {
      const pt = i < pts.length ? pts[i] : pts[0];
      const type = pt.obstacle_type;
      curPath.push([pt.lon, pt.lat]);
      if (type !== curType || i === pts.length) {
        segments.push({ path: curPath, color: TYPE_COLORS[curType] ?? [128, 128, 128, 160] });
        curType = type;
        curPath = [[pt.lon, pt.lat]];
      }
    }
    return { boundaryPolygon: coords, boundarySegments: segments };
  }, [showBoundaryOverlay, filteredPanoramaData]);

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
      // 줌 범위 기준으로 방위 계산
      const azFrac = mx / panoramaChartW;
      const az = panoramaAzRange[0] + azFrac * (panoramaAzRange[1] - panoramaAzRange[0]);
      const idx = Math.round((az / 360) * (filteredPanoramaData.length - 1));
      setPanoramaHoverIdx(Math.max(0, Math.min(filteredPanoramaData.length - 1, idx)));
    },
    [filteredPanoramaData.length, panoramaChartW, panoramaMargin.left, panoramaAzRange]
  );

  const handlePanoramaClick = useCallback(
    (_e: React.MouseEvent<SVGSVGElement>) => {
      if (panoramaHoverIdx === null) return;
      setPanoramaPinnedIdx((prev) => (prev === panoramaHoverIdx ? null : panoramaHoverIdx));
    },
    [panoramaHoverIdx]
  );


  // 파노라마 SVG에 non-passive wheel 리스너 등록 (preventDefault 사용을 위해)
  useEffect(() => {
    const svg = panoramaSvgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      e.preventDefault();
      if (filteredPanoramaData.length === 0) return;
      const rect = svg.getBoundingClientRect();
      const scaleX = panoramaSvgW / rect.width;
      const mx = (e.clientX - rect.left) * scaleX - panoramaMargin.left;
      const frac = Math.max(0, Math.min(1, mx / panoramaChartW));

      const [azMin, azMax] = panoramaAzRange;
      const azSpan = azMax - azMin;
      const azAtCursor = azMin + frac * azSpan;

      const zoomFactor = e.deltaY > 0 ? 1.15 : 1 / 1.15;
      let newSpan = Math.min(360, Math.max(10, azSpan * zoomFactor));

      let newMin = azAtCursor - frac * newSpan;
      let newMax = azAtCursor + (1 - frac) * newSpan;

      if (newMin < 0) { newMax -= newMin; newMin = 0; }
      if (newMax > 360) { newMin -= (newMax - 360); newMax = 360; }
      newMin = Math.max(0, newMin);
      newMax = Math.min(360, newMax);

      setPanoramaAzRange([newMin, newMax]);
    };
    svg.addEventListener("wheel", handler, { passive: false });
    return () => svg.removeEventListener("wheel", handler);
  }, [filteredPanoramaData.length, panoramaChartW, panoramaMargin.left, panoramaAzRange]);

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
      maxDuration: durations.reduce((m, d) => d > m ? d : m, 0),
      totalPoints: flatLoss.length,
      gapCount: gapDurations.size,
    };
  }, [flatLoss]);

  // 비행검사기 비행만 필터
  const registeredFlights = useMemo(
    () => flights.filter((f) => registeredModeSCodes.has(f.mode_s.toUpperCase())),
    [flights, registeredModeSCodes]
  );

  return (
    <div className={viewMode === "los-panorama" ? "flex h-full flex-col gap-3" : "space-y-6"}>
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-800">통계 / 분석</h1>
          {viewMode === "by-flight" && (
            <p className="mt-1 text-sm text-gray-500">
              비행검사기 항적 통계 및 표적소실 구간 분석
            </p>
          )}
          {viewMode === "los-saved" && !losPreview && (
            <p className="mt-1 text-sm text-gray-500">
              저장된 LoS 단면도 분석 결과
            </p>
          )}
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
          {(
            [
              ["by-flight", "비행별"],
              ["los-panorama", "전파 장애물"],
              ["los-saved", `LoS (${losResults.length})`],
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
              {/* 파노라마 차트 + 건물 지도 통합 카드 */}
              <SimpleCard className="flex min-h-0 flex-1 flex-col p-0">
                <div className="flex shrink-0 items-center justify-between border-b border-gray-200 px-4 py-2">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800">
                      360° LoS 파노라마 — {radarSite.name}
                      <span className="ml-2 text-xs font-normal text-gray-400">
                        0.01° ({filteredPanoramaData.length.toLocaleString()}점)
                      </span>
                      {panoramaBuildingPoints.length > 0 && (
                        <span className="ml-1 text-xs font-normal text-gray-500">
                          · 건물 {panoramaBuildingPoints.length}개
                          {panoramaBldgMaxHeight !== null && ` (≤ ${panoramaBldgMaxHeight}m)`}
                        </span>
                      )}
                    </h3>
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
                      onClick={() => setShowBoundaryOverlay(!showBoundaryOverlay)}
                      disabled={filteredPanoramaData.length < 3}
                      className={`rounded-md border px-2.5 py-1 text-xs transition-colors ${
                        showBoundaryOverlay
                          ? "border-[#a60739] bg-[#a60739] text-white"
                          : "border-gray-200 text-gray-500 hover:bg-gray-50"
                      } disabled:cursor-not-allowed disabled:opacity-40`}
                      title="장애물 경계 오버레이"
                    >
                      경계 오버레이
                    </button>
                    <button
                      onClick={() => {
                        invoke("clear_panorama_cache", {
                          radarLat: radarSite.latitude,
                          radarLon: radarSite.longitude,
                        }).catch(() => {});
                        setPanoramaData([]);
                        setShowBoundaryOverlay(false);
                        setPanoramaPeakNames(new Map());
                        triggerPanorama();
                      }}
                      className="rounded-md border border-gray-200 px-2.5 py-1 text-xs text-gray-500 hover:bg-gray-50"
                    >
                      갱신
                    </button>
                    {(panoramaAzRange[0] > 0.1 || panoramaAzRange[1] < 359.9) && (
                      <button
                        onClick={() => setPanoramaAzRange([0, 360])}
                        className="rounded-md border border-blue-200 bg-blue-50 px-2.5 py-1 text-xs text-blue-600 hover:bg-blue-100"
                      >
                        {Math.round(panoramaAzRange[0])}°–{Math.round(panoramaAzRange[1])}° 초기화
                      </button>
                    )}
                  </div>
                </div>
                <div className="shrink-0 px-4 py-2">
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

                    {/* X축 방위 그리드 (줌 반영) */}
                    {(() => {
                      const [azMin, azMax] = panoramaAzRange;
                      const azSpan = azMax - azMin;
                      // 줌 수준에 따른 그리드 간격 결정
                      const step = azSpan > 300 ? 30 : azSpan > 120 ? 15 : azSpan > 60 ? 10 : azSpan > 30 ? 5 : azSpan > 15 ? 2 : 1;
                      const labels: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W", 360: "N" };
                      const grids: React.JSX.Element[] = [];
                      const startAz = Math.ceil(azMin / step) * step;
                      for (let az = startAz; az <= azMax; az += step) {
                        const x = azToX(az);
                        const isCardinal = az % 90 === 0;
                        grids.push(
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
                      }
                      return grids;
                    })()}

                    {/* 지형/건물 면 채우기 — 모든 데이터를 <path> 4개로 통합 (DOM 최소화) */}
                    <g clipPath="url(#panorama-clip)">
                      {/* 지형 영역 (녹색 면) */}
                      <path
                        d={(() => {
                          const { startIdx, endIdx } = panoramaVisibleRange;
                          const yBase = panoramaMargin.top + panoramaChartH;
                          const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                          let d = `M ${panoramaMargin.left} ${yBase}`;
                          for (let i = startIdx; i <= endIdx; i++) {
                            const x = idxToX(i);
                            const pt = filteredPanoramaData[i];
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

                      {/* 지형 실루엣 라인 */}
                      <path
                        d={(() => {
                          const { startIdx, endIdx } = panoramaVisibleRange;
                          const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                          let d = "";
                          for (let i = startIdx; i <= endIdx; i++) {
                            const x = idxToX(i);
                            const pt = filteredPanoramaData[i];
                            const terrainAngle = pt.obstacle_type === "terrain"
                              ? pt.elevation_angle_deg
                              : Math.max(0, pt.elevation_angle_deg - (pt.obstacle_height_m / (pt.distance_km * 1000)) * (180 / Math.PI));
                            const y = toY(Math.max(terrainAngle, panoramaMinAngle));
                            d += i === startIdx ? `M ${x} ${y}` : ` L ${x} ${y}`;
                          }
                          return d;
                        })()}
                        fill="none"
                        stroke="#16a34a"
                        strokeWidth={1.2}
                      />

                      {/* GIS 건물 세로선 — 단일 <path>로 통합 */}
                      {panoramaBuildingPaths.gis && (
                        <path d={panoramaBuildingPaths.gis}
                          fill="none" stroke="#f97316" strokeWidth={2} strokeOpacity={0.7} />
                      )}

                      {/* 수동 건물 세로선 — 단일 <path>로 통합 */}
                      {panoramaBuildingPaths.manual && (
                        <path d={panoramaBuildingPaths.manual}
                          fill="none" stroke="#ef4444" strokeWidth={2} strokeOpacity={0.7} />
                      )}

                      {/* 전체 실루엣 (건물 포함, 최상단 라인) */}
                      <path
                        d={(() => {
                          const { startIdx, endIdx } = panoramaVisibleRange;
                          const toY = (angle: number) => panoramaMargin.top + panoramaChartH * (1 - (angle - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                          let d = "";
                          for (let i = startIdx; i <= endIdx; i++) {
                            const x = idxToX(i);
                            const y = toY(filteredPanoramaData[i].elevation_angle_deg);
                            d += i === startIdx ? `M ${x} ${y}` : ` L ${x} ${y}`;
                          }
                          return d;
                        })()}
                        fill="none"
                        stroke="#374151"
                        strokeWidth={0.8}
                        strokeOpacity={0.5}
                      />
                    </g>

                    {/* 호버/핀 크로스헤어 */}
                    {panoramaActiveIdx !== null && (
                      <g>
                        {(() => {
                          const pt = filteredPanoramaData[panoramaActiveIdx];
                          const x = idxToX(panoramaActiveIdx);
                          const y = panoramaMargin.top + panoramaChartH * (1 - (pt.elevation_angle_deg - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                          const isPinned = panoramaPinnedIdx === panoramaActiveIdx;
                          const peakName = pt.obstacle_type === "terrain" ? panoramaPeakNames.get(panoramaActiveIdx) : null;
                          const labelName = pt.name || peakName || null;
                          // 툴팁 내용: 방위/앙각 + 이름/거리/높이
                          const line1 = `${pt.azimuth_deg.toFixed(1)}° / ${pt.elevation_angle_deg.toFixed(3)}°`;
                          const line2Parts: string[] = [];
                          if (labelName) line2Parts.push(labelName);
                          line2Parts.push(`${pt.distance_km.toFixed(1)}km`);
                          if (pt.obstacle_type === "terrain") {
                            line2Parts.push(`${Math.round(pt.obstacle_height_m)}m`);
                          } else {
                            line2Parts.push(`${Math.round(pt.obstacle_height_m)}m(건물)`);
                          }
                          const line2 = line2Parts.join(" · ");
                          const tooltipW = Math.max(90, Math.max(line1.length, line2.length) * 6.5 + 16);
                          const tooltipH = 30;
                          // 좌우 경계 보정
                          const tooltipX = x + tooltipW + 12 > panoramaSvgW ? x - tooltipW - 8 : x + 8;
                          return (
                            <>
                              <line x1={x} y1={panoramaMargin.top} x2={x} y2={panoramaMargin.top + panoramaChartH}
                                stroke={isPinned ? "#eab308" : "#6b7280"} strokeWidth={1} strokeDasharray="3,3" />
                              <line x1={panoramaMargin.left} y1={y} x2={panoramaMargin.left + panoramaChartW} y2={y}
                                stroke={isPinned ? "#eab308" : "#6b7280"} strokeWidth={0.5} strokeDasharray="3,3" />
                              <circle cx={x} cy={y} r={4}
                                fill={pt.obstacle_type !== "terrain" ? "#f97316" : "#22c55e"}
                                stroke={isPinned ? "#eab308" : "#fff"} strokeWidth={2} />
                              {/* 상세 툴팁 */}
                              <rect x={tooltipX} y={panoramaMargin.top - 2} width={tooltipW} height={tooltipH} rx={3}
                                fill="rgba(0,0,0,0.8)" />
                              <text x={tooltipX + 6} y={panoramaMargin.top + 10} fill="white" fontSize={10}>
                                {line1}
                              </text>
                              <text x={tooltipX + 6} y={panoramaMargin.top + 22} fill="#d1d5db" fontSize={9}>
                                {line2}
                              </text>
                            </>
                          );
                        })()}
                      </g>
                    )}

                    {/* 이름 있는 산 마커 */}
                    {(() => {
                      // 중복 이름 제거: 같은 이름의 산은 가장 높은 앙각 bin만 표시
                      const shown = new Map<string, number>();
                      for (const [idx, name] of panoramaPeakNames.entries()) {
                        if (idx >= filteredPanoramaData.length) continue;
                        const pt = filteredPanoramaData[idx];
                        if (pt.obstacle_type !== "terrain") continue;
                        const prev = shown.get(name);
                        if (prev === undefined || pt.elevation_angle_deg > filteredPanoramaData[prev].elevation_angle_deg) {
                          shown.set(name, idx);
                        }
                      }
                      return Array.from(shown.entries()).map(([name, idx]) => {
                        const { startIdx: visStart, endIdx: visEnd } = panoramaVisibleRange;
                        if (idx < visStart || idx > visEnd) return null;
                        const pt = filteredPanoramaData[idx];
                        const px = idxToX(idx);
                        const py = panoramaMargin.top + panoramaChartH * (1 - (pt.elevation_angle_deg - panoramaMinAngle) / (panoramaMaxAngle - panoramaMinAngle));
                        return (
                          <g key={`peak-${idx}`}>
                            <circle cx={px} cy={py} r={2.5} fill="#f59e0b" stroke="#fff" strokeWidth={0.5} />
                            <text x={px} y={py - 6} textAnchor="middle" fill="#92400e" fontSize={8} fontWeight="bold">
                              {name}
                            </text>
                          </g>
                        );
                      });
                    })()}

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

              {/* 건물 위치 지도 (카드 내부, 나머지 공간 채움) */}
              {(panoramaBuildingPoints.length > 0 || showBoundaryOverlay) && (
                <div className="min-h-0 flex-1 border-t border-gray-200">
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
                          // 경계 오버레이 모드: 경계만 표시
                          ...(showBoundaryOverlay && boundaryPolygon && boundaryPolygon.length > 2
                            ? [
                                new PolygonLayer({
                                  id: "panorama-boundary-fill",
                                  data: [{ polygon: boundaryPolygon }],
                                  getPolygon: (d: { polygon: [number, number][] }) => d.polygon,
                                  getFillColor: [34, 197, 94, 30],
                                  getLineColor: [0, 0, 0, 0],
                                  lineWidthMinPixels: 0,
                                  pickable: false,
                                }),
                                ...(boundarySegments.length > 0
                                  ? [
                                      new PathLayer<{ path: [number, number][]; color: [number, number, number, number] }>({
                                        id: "panorama-boundary-outline",
                                        data: boundarySegments,
                                        getPath: (d) => d.path,
                                        getColor: (d) => d.color,
                                        getWidth: 2,
                                        widthMinPixels: 1.5,
                                        widthUnits: "pixels" as const,
                                        pickable: false,
                                      }),
                                    ]
                                  : []),
                              ]
                            // 기본 모드: 건물 포인트 표시
                            : [
                                new LineLayer({
                                  id: "panorama-bldg-lines",
                                  data: panoramaBuildingPoints,
                                  getSourcePosition: () => [radarSite.longitude, radarSite.latitude],
                                  getTargetPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                                  getColor: [100, 100, 100, 40],
                                  getWidth: 1,
                                }),
                                new ScatterplotLayer({
                                  id: "panorama-bldg-dots",
                                  data: panoramaBuildingPoints,
                                  getPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                                  getRadius: 5,
                                  radiusUnits: "pixels" as const,
                                  getFillColor: (d: PanoramaPoint) =>
                                    d.obstacle_type === "manual_building" ? [239, 68, 68, 180] : [249, 115, 22, 180],
                                  getLineColor: [255, 255, 255, 200],
                                  lineWidthMinPixels: 1,
                                  stroked: true,
                                  pickable: true,
                                  onHover: (info: { object?: PanoramaPoint }) => {
                                    if (panoramaPinnedIdx !== null) return;
                                    if (!info.object) {
                                      setPanoramaHoverIdx(null);
                                      return;
                                    }
                                    const hovered = info.object;
                                    let bestIdx = -1;
                                    let bestDist = Infinity;
                                    for (let i = 0; i < filteredPanoramaData.length; i++) {
                                      const pt = filteredPanoramaData[i];
                                      if (pt.obstacle_type === "terrain") continue;
                                      const dlat = pt.lat - hovered.lat;
                                      const dlon = pt.lon - hovered.lon;
                                      const dist = dlat * dlat + dlon * dlon;
                                      if (dist < bestDist) {
                                        bestDist = dist;
                                        bestIdx = i;
                                      }
                                    }
                                    if (bestIdx >= 0) {
                                      setPanoramaHoverIdx(bestIdx);
                                    }
                                  },
                                  onClick: (info: { object?: PanoramaPoint }) => {
                                    if (!info.object) return;
                                    const clicked = info.object;
                                    let bestIdx = -1;
                                    let bestDist = Infinity;
                                    for (let i = 0; i < filteredPanoramaData.length; i++) {
                                      const pt = filteredPanoramaData[i];
                                      if (pt.obstacle_type === "terrain") continue;
                                      const dlat = pt.lat - clicked.lat;
                                      const dlon = pt.lon - clicked.lon;
                                      const dist = dlat * dlat + dlon * dlon;
                                      if (dist < bestDist) {
                                        bestDist = dist;
                                        bestIdx = i;
                                      }
                                    }
                                    if (bestIdx >= 0) {
                                      setPanoramaPinnedIdx((prev) => (prev === bestIdx ? null : bestIdx));
                                      setPanoramaHoverIdx(bestIdx);
                                    }
                                  },
                                }),
                                ...(panoramaActivePoint
                                  ? [
                                      new ScatterplotLayer({
                                        id: "panorama-bldg-highlight",
                                        data: [panoramaActivePoint],
                                        getPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                                        getFillColor: panoramaActivePoint.obstacle_type === "terrain"
                                          ? [34, 197, 94, 220] : [239, 68, 68, 240],
                                        getLineColor: [255, 255, 255, 255],
                                        getRadius: 300,
                                        stroked: true,
                                        lineWidthMinPixels: 2,
                                        radiusMinPixels: 8,
                                        radiusMaxPixels: 24,
                                      }),
                                      ...(panoramaActivePoint.obstacle_type === "terrain"
                                        ? [
                                            new LineLayer({
                                              id: "panorama-terrain-line",
                                              data: [panoramaActivePoint],
                                              getSourcePosition: () => [radarSite.longitude, radarSite.latitude],
                                              getTargetPosition: (d: PanoramaPoint) => [d.lon, d.lat],
                                              getColor: [34, 197, 94, 120],
                                              getWidth: 2,
                                            }),
                                          ]
                                        : []),
                                    ]
                                  : []),
                              ]),
                          // 레이더 위치 (항상 표시)
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
                        ]}
                      />
                    </MapGL>
                </div>
              )}
              </SimpleCard>
            </>
          )}
        </>
      ) : viewMode === "los-saved" ? (
        <>
          {/* ── 저장된 LoS 분석 뷰 ── */}
          {losPreview ? (
            /* 상세 미리보기 */
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setLosPreview(null)}
                  className="rounded-md border border-gray-200 px-3 py-1.5 text-xs text-gray-600 hover:bg-gray-50"
                >
                  목록으로
                </button>
                <span className="text-sm font-medium text-gray-800">
                  {losPreview.radarSiteName} → {losPreview.bearing.toFixed(1)}° / {losPreview.totalDistance.toFixed(1)}km
                </span>
                <span className={`ml-auto rounded px-2 py-0.5 text-xs font-bold ${
                  losPreview.losBlocked ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
                }`}>
                  {losPreview.losBlocked ? "차단" : "양호"}
                </span>
              </div>
              {losPreview.mapScreenshot && (
                <SimpleCard className="!p-0 overflow-hidden">
                  <img src={losPreview.mapScreenshot} alt="맵 스크린샷" className="w-full" />
                </SimpleCard>
              )}
              {losPreview.chartScreenshot && (
                <SimpleCard className="!p-0 overflow-hidden">
                  <img src={losPreview.chartScreenshot} alt="단면도" className="w-full" />
                </SimpleCard>
              )}
              {!losPreview.mapScreenshot && !losPreview.chartScreenshot && (
                <SimpleCard>
                  <p className="py-8 text-center text-sm text-gray-400">
                    스크린샷 없음 (이전 버전에서 저장된 결과)
                  </p>
                </SimpleCard>
              )}
            </div>
          ) : losResults.length === 0 ? (
            <SimpleCard>
              <div className="flex flex-col items-center justify-center gap-2 py-16 text-sm text-gray-500">
                <Crosshair className="h-8 w-8 text-gray-300" />
                <p>저장된 LoS 분석 결과가 없습니다.</p>
                <p className="text-xs">항적 지도에서 LoS 분석 후 저장하세요.</p>
              </div>
            </SimpleCard>
          ) : (
            <div className="space-y-2">
              {[...losResults].reverse().map((r) => (
                <SimpleCard key={r.id} className="!p-0 overflow-hidden">
                  <div className="flex items-stretch">
                    {/* 썸네일 (맵 + 차트) */}
                    <button
                      onClick={() => setLosPreview(r)}
                      className="flex shrink-0 gap-0.5 bg-gray-50 hover:bg-gray-100 transition-colors"
                    >
                      {r.mapScreenshot ? (
                        <img src={r.mapScreenshot} alt="" className="h-[72px] w-[100px] object-cover" />
                      ) : (
                        <div className="flex h-[72px] w-[100px] items-center justify-center text-gray-300">
                          <MapPin size={20} />
                        </div>
                      )}
                      {r.chartScreenshot ? (
                        <img src={r.chartScreenshot} alt="" className="h-[72px] w-[120px] object-cover" />
                      ) : (
                        <div className="flex h-[72px] w-[120px] items-center justify-center text-gray-300">
                          <Crosshair size={20} />
                        </div>
                      )}
                    </button>
                    {/* 정보 */}
                    <button
                      onClick={() => setLosPreview(r)}
                      className="flex min-w-0 flex-1 flex-col justify-center gap-1 px-3 py-2 text-left hover:bg-gray-50 transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-gray-800 truncate">
                          {r.radarSiteName}
                        </span>
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          r.losBlocked ? "bg-red-100 text-red-700" : "bg-green-100 text-green-700"
                        }`}>
                          {r.losBlocked ? "차단" : "양호"}
                        </span>
                      </div>
                      <div className="flex items-center gap-3 text-[11px] text-gray-500">
                        <span>방위 <b className="text-gray-700">{r.bearing.toFixed(1)}°</b></span>
                        <span>거리 <b className="text-gray-700">{r.totalDistance.toFixed(1)}km</b></span>
                        {r.maxBlockingPoint && (
                          <span>최대차단 <b className="text-gray-700">{r.maxBlockingPoint.elevation.toFixed(0)}m</b>
                            {r.maxBlockingPoint.name && ` (${r.maxBlockingPoint.name})`}
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-gray-400">
                        {new Date(r.timestamp > 1e12 ? r.timestamp : r.timestamp * 1000).toLocaleString("ko-KR")}
                        <span className="ml-2">
                          목표 ({r.targetLat.toFixed(4)}, {r.targetLon.toFixed(4)})
                        </span>
                      </div>
                    </button>
                    {/* 삭제 */}
                    <button
                      onClick={() => removeLOSResult(r.id)}
                      className="flex shrink-0 items-center px-3 text-gray-300 hover:text-red-500 transition-colors"
                      title="삭제"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </SimpleCard>
              ))}
            </div>
          )}
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
