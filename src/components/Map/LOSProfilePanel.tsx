import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { X, Save, Loader2 } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore } from "../../store";
import type { ElevationPoint, LOSProfileData, RadarSite, BuildingOnPath } from "../../types";
import { GPU2D, type CircleData } from "../../utils/gpu2d";

const R_EARTH_M = 6_371_000;
const R_EFF_M = R_EARTH_M * (4 / 3); // 4/3 유효 지구 반경
const LAMBDA_M = 0.1071; // S-band 2.8GHz 파장 (m)

/** 탐지 유형별 색상 (TrackMap과 동일) */
const DETECTION_TYPE_COLORS: Record<string, [number, number, number]> = {
  mode_ac:              [234, 179, 8],
  mode_ac_psr:          [234, 179, 8],
  mode_s_allcall:       [34, 197, 94],
  mode_s_allcall_psr:   [34, 197, 94],
  mode_s_rollcall:      [16, 185, 129],
  mode_s_rollcall_psr:  [16, 185, 129],
};
const PSR_TYPES = new Set(["mode_ac_psr", "mode_s_allcall_psr", "mode_s_rollcall_psr"]);
function detectionTypeColor(rt: string): [number, number, number] {
  return DETECTION_TYPE_COLORS[rt] ?? [128, 128, 128];
}

interface LOSTrackPoint {
  distRatio: number;
  altitude: number;
  mode_s: string;
  timestamp: number;
  radar_type: string;
  isLoss: boolean;
}

interface Props {
  radarSite: RadarSite;
  targetLat: number;
  targetLon: number;
  onClose: () => void;
  /** 차트 호버 시 거리 비율(0~1) 콜백, null이면 호버 해제 */
  onHoverDistance?: (ratio: number | null) => void;
  /** LOS 선상 항적/Loss 포인트 전체 */
  losTrackPoints?: LOSTrackPoint[];
  /** 고도 프로파일 로딩 완료 시 콜백 */
  onLoaded?: () => void;
  /** 차트에서 항적 포인트 하이라이트 시 인덱스 콜백 (null이면 해제) */
  onTrackPointHighlight?: (idx: number | null) => void;
  /** 맵에서 클릭한 항적 포인트 인덱스 (외부→차트 하이라이트) */
  externalHighlightIdx?: number | null;
  /** 차트에서 항적 포인트 호버 시 인덱스 콜백 (null이면 해제) */
  onTrackPointHover?: (idx: number | null) => void;
  /** 맵에서 호버한 항적 포인트 인덱스 (외부→차트 호버) */
  externalHoverIdx?: number | null;
  /** 차트에서 건물 호버/클릭 시 건물 정보 콜백 (null이면 해제) */
  onBuildingHover?: (building: { lat: number; lon: number; height_m: number; name: string | null; address: string | null; usage: string | null } | null) => void;
  /** 건물 상세보기 요청 콜백 */
  onBuildingDetail?: (building: BuildingOnPath & { isBlocking?: boolean }) => void;
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
  const x =
    Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
    Math.sin((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.cos(dLon);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function interpolate(
  lat1: number, lon1: number, lat2: number, lon2: number, t: number
): [number, number] {
  return [lat1 + (lat2 - lat1) * t, lon1 + (lon2 - lon1) * t];
}

/** 디스플레이 프레임 곡률 보정량 (m): 실제 지구반경 기준
 *  → 직선 LOS가 직선으로, 4/3 굴절선이 아래로 휘어 보임 */
function curvDrop(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EARTH_M);
}

/** 4/3 유효지구 곡률 보정량 (m): 굴절 전파 계산용 */
function curvDrop43(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EFF_M);
}



export default function LOSProfilePanel({ radarSite, targetLat, targetLon, onClose, onHoverDistance, losTrackPoints, onLoaded, onTrackPointHighlight, externalHighlightIdx, onTrackPointHover, externalHoverIdx, onBuildingHover, onBuildingDetail }: Props) {
  const addLOSResult = useAppStore((s) => s.addLOSResult);
  const [loading, setLoading] = useState(true);
  const [profile, setProfile] = useState<ElevationPoint[]>([]);
  const [peakNames, setPeakNames] = useState<Map<number, string>>(new Map());
  const [saved, setSaved] = useState(false);
  const [buildings, setBuildings] = useState<BuildingOnPath[]>([]);
  const [showBuildings, setShowBuildings] = useState(true);
  const [hoverX, setHoverX] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // X축 줌: [시작%, 끝%] (0~100)
  const [xZoom, setXZoom] = useState<[number, number]>([0, 100]);
  const xZoomRef = useRef<[number, number]>([0, 100]);
  // ── SVG 차트 상수 ──
  const W = 900;
  const H = 280;
  const PAD = { top: 20, right: 30, bottom: 30, left: 65 };
  const cw = W - PAD.left - PAD.right;
  const ch = H - PAD.top - PAD.bottom;
  const [hoveredTrackIdx, setHoveredTrackIdx] = useState<number | null>(null);
  const [pinnedTrackIdx, setPinnedTrackIdx] = useState<number | null>(null);
  const [hoveredBldgIdx, setHoveredBldgIdx] = useState<number | null>(null);
  const [clickedBldgIdx, setClickedBldgIdx] = useState<number | null>(null);
  // GPU 렌더링 (항적 포인트)
  const trackCanvasRef = useRef<HTMLCanvasElement>(null);
  const gpu2dRef = useRef<GPU2D | null>(null);
  // 안정적인 콜백 ref (useCallback 의존성 최소화)
  const hoveredTrackIdxRef = useRef<number | null>(null);
  const pinnedTrackIdxRef = useRef<number | null>(null);
  const trackPointPosRef = useRef<{ x: number; y: number; idx: number }[]>([]);
  const onTrackPointHoverRef = useRef(onTrackPointHover);
  const onTrackPointHighlightRef = useRef(onTrackPointHighlight);
  // 맵에서 클릭한 포인트 → 차트 핀 동기화
  const prevExternalIdx = useRef<number | null | undefined>(undefined);
  useEffect(() => {
    if (externalHighlightIdx === prevExternalIdx.current) return;
    prevExternalIdx.current = externalHighlightIdx;
    if (externalHighlightIdx != null && externalHighlightIdx !== pinnedTrackIdx) {
      setPinnedTrackIdx(externalHighlightIdx);
    } else if (externalHighlightIdx == null && pinnedTrackIdx !== null) {
      setPinnedTrackIdx(null);
    }
  }, [externalHighlightIdx]);
  // Ref 동기화 (안정적 콜백용)
  hoveredTrackIdxRef.current = hoveredTrackIdx;
  pinnedTrackIdxRef.current = pinnedTrackIdx;
  onTrackPointHoverRef.current = onTrackPointHover;
  onTrackPointHighlightRef.current = onTrackPointHighlight;
  // 드래그 패닝
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartZoom = useRef<[number, number]>([0, 100]);

  const totalDist = haversine(radarSite.latitude, radarSite.longitude, targetLat, targetLon);
  const bearing = bearingDeg(radarSite.latitude, radarSite.longitude, targetLat, targetLon);
  const radarHeight = radarSite.altitude + radarSite.antenna_height;

  // 고도 프로파일 API 호출
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;
  useEffect(() => {
    let cancelled = false;
    const fetchElevation = async () => {
      // 이전 데이터 초기화 (stale 데이터 방지)
      gpu2dRef.current?.dispose();
      gpu2dRef.current = null;
      setProfile([]);
      setPeakNames(new Map());
      setBuildings([]);
      setLoading(true);
      setSaved(false);
      setPinnedTrackIdx(null);
      setHoveredTrackIdx(null);
      setHoveredBldgIdx(null);
      setClickedBldgIdx(null);
      onBuildingHover?.(null);
      setXZoom([0, 100]);
      xZoomRef.current = [0, 100];
      const numSamples = 150;
      const lats: number[] = [];
      const lons: number[] = [];
      for (let i = 0; i <= numSamples; i++) {
        const t = i / numSamples;
        const [lat, lon] = interpolate(
          radarSite.latitude, radarSite.longitude, targetLat, targetLon, t
        );
        lats.push(lat);
        lons.push(lon);
      }

      try {
        // Rust 백엔드 경유 (DB 캐시 우선, 미스분만 API 호출)
        const allElevations: number[] = await invoke("fetch_elevation", {
          latitudes: lats,
          longitudes: lons,
        });

        if (cancelled) return;

        const points: ElevationPoint[] = lats.map((lat, i) => ({
          distance: haversine(radarSite.latitude, radarSite.longitude, lat, lons[i]),
          elevation: Math.max(0, allElevations[i] ?? 0),
          latitude: lat,
          longitude: lons[i],
        }));
        setProfile(points);

        // 건물 데이터 조회 (LOS 경로 ±100m 코리도)
        try {
          const bldgs: BuildingOnPath[] = await invoke("query_buildings_along_path", {
            radarLat: radarSite.latitude,
            radarLon: radarSite.longitude,
            targetLat,
            targetLon,
            corridorWidthM: 100.0,
          });
          if (!cancelled && bldgs.length > 0) {
            // 각 건물의 지형 고도를 프로파일에서 보간
            const enriched = bldgs.map((b) => {
              let groundElev = 0;
              for (let i = 1; i < points.length; i++) {
                if (points[i].distance >= b.distance_km) {
                  const t = (b.distance_km - points[i - 1].distance) / (points[i].distance - points[i - 1].distance);
                  groundElev = points[i - 1].elevation + t * (points[i].elevation - points[i - 1].elevation);
                  break;
                }
              }
              return { ...b, ground_elev_m: groundElev, total_height_m: groundElev + b.height_m };
            });
            setBuildings(enriched);
          }
        } catch {
          // 건물 데이터 없으면 무시
        }

        // 최저 탐지가능 높이 선(굴절)을 실질적으로 가장 크게 올린 산 1개 찾기
        // = 조정 프레임에서 가장 큰 그림자를 만드는 지형점
        let dominantPeakIdx = -1;
        let dominantShadowArea = 0;
        for (let i = 1; i < points.length - 1; i++) {
          const di = points[i].distance;
          if (di <= 0) continue;
          // 건물을 포함한 effective elevation 사용
          let elev = points[i].elevation;
          if (showBuildings) {
            for (const b of buildings) {
              const nearD = b.near_dist_km ?? b.distance_km;
              const farD = b.far_dist_km ?? b.distance_km;
              if (di >= nearD - 0.05 && di <= farD + 0.05) {
                const bTop = b.ground_elev_m + b.height_m;
                if (bTop > elev) elev = bTop;
              }
            }
          }
          const adjH = elev - curvDrop(di);
          if (adjH <= radarHeight) continue;
          // 이 지형점이 만드는 그림자: 뒤쪽 포인트들에서 얼마나 최저선을 올리는지 합산
          let shadowSum = 0;
          for (let j = i + 1; j < points.length; j++) {
            const dj = points[j].distance;
            const shadow = radarHeight + (adjH - radarHeight) * (dj / di);
            const adjTj = points[j].elevation - curvDrop(dj);
            const baseline = Math.max(radarHeight, adjTj);
            if (shadow > baseline) shadowSum += shadow - baseline;
          }
          if (shadowSum > dominantShadowArea) {
            dominantShadowArea = shadowSum;
            dominantPeakIdx = i;
          }
        }

        // 가장 영향력 있는 산 1개만 이름 조회
        if (dominantPeakIdx >= 0 && !cancelled) {
          const peakLat = points[dominantPeakIdx].latitude;
          const peakLon = points[dominantPeakIdx].longitude;
          try {
            const overpassUrl = `https://overpass-api.de/api/interpreter?data=[out:json];node["natural"="peak"](around:3000,${peakLat},${peakLon});out body;`;
            const peakResp = await fetch(overpassUrl);
            if (peakResp.ok) {
              const peakData = await peakResp.json();
              if (peakData.elements?.length > 0) {
                let closest = peakData.elements[0];
                let closestDist = Infinity;
                for (const el of peakData.elements) {
                  const d2 = haversine(peakLat, peakLon, el.lat, el.lon);
                  if (d2 < closestDist) { closestDist = d2; closest = el; }
                }
                const name = closest.tags?.["name:ko"] || closest.tags?.name;
                if (name && !cancelled) setPeakNames(new Map([[dominantPeakIdx, name]]));
              }
            }
          } catch {
            // 산 이름 조회 실패 - 비치명적
          }
        }
      } catch (err) {
        console.error("Elevation fetch failed:", err);
        if (!cancelled) {
          const points: ElevationPoint[] = lats.map((lat, i) => ({
            distance: haversine(radarSite.latitude, radarSite.longitude, lat, lons[i]),
            elevation: 0,
            latitude: lat,
            longitude: lons[i],
          }));
          setProfile(points);
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          onLoadedRef.current?.();
        }
      }
    };

    fetchElevation();
    return () => { cancelled = true; };
  }, [radarSite, targetLat, targetLon]);

  // ── 차트 데이터: 실제 지구(R) 조정 프레임 — 직선 LOS가 직선으로 표시 ──
  const chartData = useMemo(() => {
    if (profile.length === 0) return null;

    const D = totalDist;
    const targetElev = profile[profile.length - 1].elevation;
    const adjTarget = targetElev - curvDrop(D);

    // 1) 조정 지형 (실제 지구곡률 반영 → 지형이 거리에 따라 아래로 처짐)
    const adjTerrain = profile.map((p) => ({
      distance: p.distance,
      height: p.elevation - curvDrop(p.distance),
    }));

    // 1.5) 통합 장애물 배열: 지형 프로파일 + 건물을 거리순 병합
    //    shadow-casting에서 건물을 정확한 위치의 독립 장애물로 처리
    interface Obstacle { distance: number; elevation: number; }
    const obstacles: Obstacle[] = [];
    for (const p of profile) {
      obstacles.push({ distance: p.distance, elevation: p.elevation });
    }
    if (showBuildings && buildings.length > 0) {
      for (const b of buildings) {
        const bTop = b.ground_elev_m + b.height_m;
        const nearD = b.near_dist_km ?? b.distance_km;
        const farD = b.far_dist_km ?? b.distance_km;
        // 건물 양쪽 끝에 장애물 추가 (도형 건물의 경우 양쪽 경계)
        obstacles.push({ distance: nearD, elevation: bTop });
        if (farD - nearD > 0.001) {
          obstacles.push({ distance: farD, elevation: bTop });
        }
      }
    }
    obstacles.sort((a, b) => a.distance - b.distance);

    // 건물 경계 거리 목록 (쉐도잉 라인에 건물 경계점 삽입용)
    interface BuildingEdge { nearD: number; farD: number; topElev: number; groundElev: number; }
    const buildingEdges: BuildingEdge[] = [];
    if (showBuildings && buildings.length > 0) {
      for (const b of buildings) {
        const nearD = b.near_dist_km ?? b.distance_km;
        const farD = b.far_dist_km ?? b.distance_km;
        buildingEdges.push({
          nearD,
          farD,
          topElev: b.ground_elev_m + b.height_m,
          groundElev: b.ground_elev_m,
        });
      }
    }

    // 프로파일에서 특정 거리의 지형 고도 보간
    const interpTerrainElev = (d: number): number => {
      if (d <= profile[0].distance) return profile[0].elevation;
      if (d >= profile[profile.length - 1].distance) return profile[profile.length - 1].elevation;
      for (let i = 1; i < profile.length; i++) {
        if (profile[i].distance >= d) {
          const t = (d - profile[i - 1].distance) / (profile[i].distance - profile[i - 1].distance);
          return profile[i - 1].elevation + t * (profile[i].elevation - profile[i - 1].elevation);
        }
      }
      return 0;
    };

    // 통합 샘플 거리: 프로파일 포인트 + 건물 경계 (쉐도잉 라인이 건물에서 수직으로 오르도록)
    const sampleDists: number[] = profile.map(p => p.distance);
    for (const be of buildingEdges) {
      // 건물 바로 앞에도 포인트 삽입 (수직 전환 보장)
      const eps = 0.0005; // ~0.5m
      if (be.nearD > eps) sampleDists.push(be.nearD - eps);
      sampleDists.push(be.nearD);
      if (be.farD - be.nearD > 0.001) {
        sampleDists.push(be.farD);
        sampleDists.push(be.farD + eps);
      } else {
        sampleDists.push(be.nearD + eps);
      }
    }
    // 중복 제거 & 정렬
    const uniqueDists = [...new Set(sampleDists)].sort((a, b) => a - b);

    // 특정 거리에서 건물 높이를 포함한 유효 고도 (곡률 미보정 AMSL)
    const effectiveElevAt = (d: number): number => {
      let elev = interpTerrainElev(d);
      for (const be of buildingEdges) {
        if (d >= be.nearD && d <= be.farD + 0.0001) {
          if (be.topElev > elev) elev = be.topElev;
        }
      }
      return elev;
    };

    // 2) 최저 탐지가능 높이 - 직선 LOS (디스플레이 프레임에서 직접 shadow-casting → 직선)
    const minDetStraight = uniqueDists.map((d) => {
      if (d <= 0) return { distance: d, height: radarHeight };

      let maxShadow = radarHeight;
      for (const ob of obstacles) {
        if (ob.distance <= 0 || ob.distance >= d) continue;
        const adjH = ob.elevation - curvDrop(ob.distance);
        const shadow = radarHeight + (adjH - radarHeight) * (d / ob.distance);
        if (shadow > maxShadow) maxShadow = shadow;
      }

      const terrElev = effectiveElevAt(d);
      const adjH = terrElev - curvDrop(d);
      return {
        distance: d,
        height: Math.max(adjH, maxShadow),
      };
    });

    // 2.5) 최저 탐지가능 높이 - 직선 LOS + 프레넬존 80% 클리어런스
    const minDetFresnel = uniqueDists.map((d) => {
      if (d <= 0) return { distance: d, height: radarHeight };
      const dM = d * 1000;

      let maxShadow = radarHeight;
      for (const ob of obstacles) {
        if (ob.distance <= 0 || ob.distance >= d) continue;
        const diM = ob.distance * 1000;
        const adjH = ob.elevation - curvDrop(ob.distance);
        const f1 = Math.sqrt(LAMBDA_M * diM * (dM - diM) / dM);
        const adjHFresnel = adjH + 0.8 * f1;
        const shadow = radarHeight + (adjHFresnel - radarHeight) * (d / ob.distance);
        if (shadow > maxShadow) maxShadow = shadow;
      }

      const terrElev = effectiveElevAt(d);
      const adjH = terrElev - curvDrop(d);
      return {
        distance: d,
        height: Math.max(adjH, maxShadow),
      };
    });

    // 3) 최저 탐지가능 높이 - 4/3 굴절 적용
    const minDetRefracted = uniqueDists.map((d) => {
      if (d <= 0) return { distance: d, height: radarHeight };

      let maxShadow = radarHeight;
      for (const ob of obstacles) {
        if (ob.distance <= 0 || ob.distance >= d) continue;
        const adjH = ob.elevation - curvDrop43(ob.distance);
        const shadow = radarHeight + (adjH - radarHeight) * (d / ob.distance);
        if (shadow > maxShadow) maxShadow = shadow;
      }

      const terrElev = effectiveElevAt(d);
      const adjTerrain43 = terrElev - curvDrop43(d);
      const h43 = Math.max(adjTerrain43, maxShadow);
      const amslH = h43 + curvDrop43(d);
      return { distance: d, height: amslH - curvDrop(d) };
    });

    // 4) CoS (Cone of Silence) 70° 기준선
    const COS_DEG = 70;
    const cosLine = profile.map((p) => ({
      distance: p.distance,
      height: radarHeight + p.distance * 1000 * Math.tan((COS_DEG * Math.PI) / 180),
    }));

    // 5) 0.25° BRA 기준선 (실제 앙각 기준 직선)
    const BRA_DEG = 0.25;
    const braLine = profile.map((p) => ({
      distance: p.distance,
      height: radarHeight + p.distance * 1000 * Math.tan((BRA_DEG * Math.PI) / 180),
    }));

    // 차단 판정 (4/3 프레임에서 지형 vs 레이더→타겟 직선)
    const adjTarget43 = targetElev - curvDrop43(D);
    const losRefracted43H = (d: number) =>
      radarHeight + (adjTarget43 - radarHeight) * (d / D);
    let blocked = false;
    let maxBlockPoint: {
      distance: number;
      adjHeight: number;
      realElevation: number;
      name?: string;
    } | null = null;
    let maxExcess = 0;
    // 통합 장애물로 차단 판정 (지형 + 건물)
    for (const ob of obstacles) {
      if (ob.distance <= 0 || ob.distance >= D) continue;
      const adjH43 = ob.elevation - curvDrop43(ob.distance);
      const excess = adjH43 - losRefracted43H(ob.distance);
      if (excess > maxExcess) {
        maxExcess = excess;
        blocked = true;
        maxBlockPoint = {
          distance: ob.distance,
          adjHeight: ob.elevation - curvDrop(ob.distance), // 디스플레이 프레임 좌표
          realElevation: ob.elevation,
        };
      }
    }
    // 최대 차단점에 산 이름 매칭 (프로파일 인덱스 기반)
    if (maxBlockPoint) {
      for (const [idx, name] of peakNames.entries()) {
        if (idx >= 0 && idx < profile.length &&
            Math.abs(profile[idx].distance - maxBlockPoint.distance) < 0.1) {
          maxBlockPoint.name = name;
          break;
        }
      }
    }

    // 이름이 있는 모든 산 (차트에 표시용)
    const namedPeaks: { idx: number; distance: number; adjHeight: number; realElevation: number; name: string }[] = [];
    for (const [idx, name] of peakNames.entries()) {
      if (idx >= 0 && idx < profile.length) {
        namedPeaks.push({
          idx,
          distance: profile[idx].distance,
          adjHeight: adjTerrain[idx].height,
          realElevation: profile[idx].elevation,
          name,
        });
      }
    }

    // Y축 범위 (CoS는 매우 가파르므로 maxY에 포함하지 않음 - 차트 가독성)
    const allHeights = [
      radarHeight,
      ...adjTerrain.map((p) => p.height),
      ...minDetRefracted.map((p) => p.height),
      ...minDetStraight.map((p) => p.height),
      ...minDetFresnel.map((p) => p.height),
      ...braLine.map((p) => p.height),
    ];
    let maxY = -Infinity;
    for (const h of allHeights) if (h > maxY) maxY = h;
    maxY += 100;
    let minY = 0;
    for (const p of adjTerrain) if (p.height < minY) minY = p.height;
    minY -= 50;
    // 0ft가 차트 40% 지점보다 위로 오지 않도록 maxY를 능동 조절
    // 0ft 위치 = (0 - minY) / (maxY - minY) → 아래에서 위로의 비율
    // 차트에서 40% 높이 이하에 0ft가 오려면: (0 - minY) / (maxY - minY) <= 0.4
    // → maxY >= -minY / 0.4 + minY = minY * (1 - 1/0.4) + 0 = -1.5 * minY
    // 즉 0이 40% 이하에 오려면 maxY >= -minY * 1.5
    if (minY < 0) {
      const minMaxYFor40Pct = -minY * 1.5;
      if (maxY < minMaxYFor40Pct) maxY = minMaxYFor40Pct;
    }

    // 차폐에 영향을 주는 건물만 필터링:
    // 건물 꼭대기가 지형만으로 생성된 shadow보다 높으면 = 실질 차폐 기여
    const significantBuildings: (BuildingOnPath & { isBlocking: boolean })[] = [];
    if (showBuildings && buildings.length > 0) {
      for (const b of buildings) {
        const bDist = b.distance_km;
        if (bDist <= 0 || bDist >= D) continue;
        const bTop = b.ground_elev_m + b.height_m;
        const bAdj = bTop - curvDrop(bDist);

        // 지형만으로 생성된 shadow (실제지구 프레임)
        let terrainShadow = radarHeight;
        for (const p of profile) {
          if (p.distance <= 0 || p.distance >= bDist) continue;
          const adjH = p.elevation - curvDrop(p.distance);
          const shadow = radarHeight + (adjH - radarHeight) * (bDist / p.distance);
          if (shadow > terrainShadow) terrainShadow = shadow;
        }
        if (bAdj > terrainShadow) {
          // 이 건물이 최대 차단점 근처인지 판정
          const isBlk = !!(maxBlockPoint &&
            Math.abs(bDist - maxBlockPoint.distance) < 0.1 &&
            bAdj > maxBlockPoint.adjHeight - 5);
          significantBuildings.push({ ...b, isBlocking: isBlk });
        }
      }
    }

    return {
      adjTerrain,
      minDetRefracted,
      minDetStraight,
      minDetFresnel,
      braLine,
      cosLine,
      blocked,
      maxBlockPoint,
      namedPeaks,
      significantBuildings,
      minY,
      maxY,
      maxDistance: D,
      adjTarget,
      targetElev,
    };
  }, [profile, radarHeight, totalDist, peakNames, buildings, showBuildings]);

  // ── Y축 가시 범위 자동조정 (줌인 시 보이는 구간의 데이터만 기준) ──
  const visibleYRange = useMemo(() => {
    if (!chartData) return null;
    const { adjTerrain, minDetRefracted, minDetStraight, minDetFresnel, braLine,
            significantBuildings, maxDistance, minY: fullMinY, maxY: fullMaxY } = chartData;
    // 전체 줌이면 기존 범위 그대로
    if (xZoom[0] === 0 && xZoom[1] === 100) return { minY: fullMinY, maxY: fullMaxY };

    const zoomStart = (xZoom[0] / 100) * maxDistance;
    const zoomEnd = (xZoom[1] / 100) * maxDistance;
    const inRange = (d: number) => d >= zoomStart && d <= zoomEnd;

    // 보이는 구간 내 높이값 수집
    const heights: number[] = [];
    for (const p of adjTerrain) if (inRange(p.distance)) heights.push(p.height);
    for (const p of minDetRefracted) if (inRange(p.distance)) heights.push(p.height);
    for (const p of minDetStraight) if (inRange(p.distance)) heights.push(p.height);
    for (const p of minDetFresnel) if (inRange(p.distance)) heights.push(p.height);
    for (const p of braLine) if (inRange(p.distance)) heights.push(p.height);
    // 건물 꼭대기
    for (const b of significantBuildings) {
      const nearD = b.near_dist_km ?? b.distance_km;
      const farD = b.far_dist_km ?? b.distance_km;
      if (inRange(nearD) || inRange(farD) || (nearD <= zoomStart && farD >= zoomEnd)) {
        heights.push((b.ground_elev_m + b.height_m) - curvDrop(b.distance_km));
        heights.push(b.ground_elev_m - curvDrop(b.distance_km));
      }
    }
    // 레이더 높이 (시작점이 보이면)
    if (zoomStart <= 0.1) heights.push(radarHeight);

    if (heights.length === 0) return { minY: fullMinY, maxY: fullMaxY };

    let rawMin = Infinity, rawMax = -Infinity;
    for (const h of heights) { if (h < rawMin) rawMin = h; if (h > rawMax) rawMax = h; }
    const range = rawMax - rawMin;
    const padding = Math.max(range * 0.12, 50); // 최소 50m 여유
    let visMinY = rawMin - padding;
    let visMaxY = rawMax + padding;
    // 0ft가 차트 40% 이하에 오도록 보장 (기존 로직과 동일)
    if (visMinY < 0) {
      const minMaxYFor40Pct = -visMinY * 1.5;
      if (visMaxY < minMaxYFor40Pct) visMaxY = minMaxYFor40Pct;
    }
    return { minY: visMinY, maxY: visMaxY };
  }, [chartData, xZoom, radarHeight]);

  // ── GPU: 항적 포인트 좌표 사전계산 (히트테스트 + 렌더링 공용) ──
  const trackPointPositions = useMemo(() => {
    if (!losTrackPoints || !chartData || !visibleYRange) return [];
    const { maxDistance } = chartData;
    const { minY, maxY } = visibleYRange;
    const zoomStart = (xZoom[0] / 100) * maxDistance;
    const zoomEnd = (xZoom[1] / 100) * maxDistance;
    const zoomRange = zoomEnd - zoomStart;
    if (zoomRange <= 0) return [];
    const result: { x: number; y: number; idx: number }[] = [];
    for (let i = 0; i < losTrackPoints.length; i++) {
      const tp = losTrackPoints[i];
      const dist = tp.distRatio * maxDistance;
      const adjAlt = tp.altitude - curvDrop(dist);
      const x = PAD.left + ((dist - zoomStart) / zoomRange) * cw;
      const y = PAD.top + ch - ((adjAlt - minY) / (maxY - minY)) * ch;
      if (x < PAD.left - 10 || x > W - PAD.right + 10) continue;
      result.push({ x, y, idx: i });
    }
    return result;
  }, [losTrackPoints, chartData, visibleYRange, xZoom, cw, ch]);
  trackPointPosRef.current = trackPointPositions;

  // GPU 정리 (컴포넌트 언마운트 시)
  useEffect(() => {
    return () => { gpu2dRef.current?.dispose(); gpu2dRef.current = null; };
  }, []);

  // ── GPU: 항적 포인트 렌더링 (lazy-init: 캔버스가 조건부 렌더링이므로 여기서 초기화) ──
  const gpuCanvasElRef = useRef<HTMLCanvasElement | null>(null);
  useEffect(() => {
    const canvas = trackCanvasRef.current;
    const svg = svgRef.current;
    if (!canvas || !svg || !losTrackPoints) return;
    // 캔버스 엘리먼트가 변경되면 GPU2D 재생성 (로딩 후 새 캔버스)
    if (gpu2dRef.current && gpuCanvasElRef.current !== canvas) {
      gpu2dRef.current.dispose();
      gpu2dRef.current = null;
    }
    if (!gpu2dRef.current) {
      try {
        gpu2dRef.current = new GPU2D(canvas);
        gpu2dRef.current.setResolution(W, H);
        gpuCanvasElRef.current = canvas;
      } catch (e) {
        console.warn('[LOS] WebGL2 초기화 실패:', e);
        return;
      }
    }
    const gpu = gpu2dRef.current;
    // 캔버스 크기를 SVG 렌더 크기에 동기화
    const rect = svg.getBoundingClientRect();
    gpu.syncSize(rect.width, rect.height);
    gpu.clear();
    if (trackPointPositions.length === 0) { gpu.flush(); return; }
    // 차트 영역 클리핑
    gpu.scissor(PAD.left, PAD.top, cw, ch);
    const circles: CircleData[] = [];
    for (const pos of trackPointPositions) {
      const tp = losTrackPoints[pos.idx];
      const isPinned = pinnedTrackIdx === pos.idx;
      const isExtHover = externalHoverIdx === pos.idx && hoveredTrackIdx !== pos.idx;
      const isHovered = hoveredTrackIdx === pos.idx;
      const isActive = isHovered || isPinned || isExtHover;
      const col = tp.isLoss
        ? [1, 0.09, 0.27] as [number, number, number]
        : (() => { const c = detectionTypeColor(tp.radar_type); return [c[0]/255, c[1]/255, c[2]/255] as [number, number, number]; })();
      const fillA = isActive ? 1 : tp.isLoss ? 0.9 : 0.7;
      let strokeCol: [number, number, number, number] = [0, 0, 0, 0];
      let sw = 0;
      if (isPinned)        { strokeCol = [0.98, 0.8, 0.08, 1]; sw = 2; }
      else if (isExtHover) { strokeCol = [0.22, 0.74, 0.97, 1]; sw = 2; }
      else if (isHovered)  { strokeCol = [1, 1, 1, 1]; sw = 1.5; }
      else if (tp.isLoss)  { strokeCol = [1, 0.09, 0.27, 0.5]; sw = 0.5; }
      else if (PSR_TYPES.has(tp.radar_type)) { strokeCol = [1, 1, 1, 0.6]; sw = 1; }
      circles.push({
        x: pos.x, y: pos.y,
        r: isActive ? 4 : tp.isLoss ? 2.5 : 1.5,
        fill: [col[0], col[1], col[2], fillA],
        stroke: strokeCol,
        strokeWidth: sw,
      });
    }
    gpu.drawCircles(circles);
    gpu.noScissor();
    gpu.flush();
  }, [trackPointPositions, losTrackPoints, hoveredTrackIdx, pinnedTrackIdx, externalHoverIdx, chartData]);

  const handleSave = async () => {
    if (!chartData) return;

    // 맵 스크린샷 캡처 (MapLibre 네이티브 캔버스 + deck.gl 오버레이 합성)
    let mapScreenshot: string | undefined;
    try {
      const map = (window as any).__maplibreInstance;
      if (map) {
        // MapLibre 강제 리페인트 후 캔버스 캡처 (preserveDrawingBuffer 불필요)
        map.triggerRepaint();
        await new Promise<void>((resolve) => {
          map.once("render", () => resolve());
        });
        const mapCanvas = map.getCanvas() as HTMLCanvasElement;
        const w = mapCanvas.width;
        const h = mapCanvas.height;
        const offscreen = document.createElement("canvas");
        offscreen.width = w;
        offscreen.height = h;
        const ctx = offscreen.getContext("2d");
        if (ctx) {
          // MapLibre 기본 캔버스 (타일)
          ctx.drawImage(mapCanvas, 0, 0);
          // deck.gl 오버레이 캔버스 합성
          const mapContainer = document.querySelector(".maplibregl-map");
          if (mapContainer) {
            const canvases = mapContainer.querySelectorAll("canvas");
            for (const c of canvases) {
              if (c !== mapCanvas) ctx.drawImage(c, 0, 0);
            }
          }
          mapScreenshot = offscreen.toDataURL("image/jpeg", 0.7);
        }
      }
    } catch (e) {
      console.warn("[LOS] 맵 스크린샷 실패:", e);
    }

    // SVG 차트 스크린샷 캡처
    let chartScreenshot: string | undefined;
    try {
      const svg = svgRef.current;
      if (svg) {
        const serializer = new XMLSerializer();
        const svgStr = serializer.serializeToString(svg);
        const svgBlob = new Blob([svgStr], { type: "image/svg+xml;charset=utf-8" });
        const url = URL.createObjectURL(svgBlob);
        const img = new Image();
        chartScreenshot = await new Promise<string | undefined>((resolve) => {
          img.onload = () => {
            const canvas = document.createElement("canvas");
            canvas.width = W * 2;
            canvas.height = H * 2;
            const ctx = canvas.getContext("2d");
            if (ctx) {
              ctx.fillStyle = "#fafafa";
              ctx.fillRect(0, 0, canvas.width, canvas.height);
              // GPU 캔버스 (항적 포인트) — SVG 아래에 합성
              const trackCvs = trackCanvasRef.current;
              if (trackCvs && trackCvs.width > 0) {
                ctx.drawImage(trackCvs, 0, 0, canvas.width, canvas.height);
              }
              // SVG (범례/툴팁 포함) — 위에 합성
              ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
              resolve(canvas.toDataURL("image/png"));
            } else {
              resolve(undefined);
            }
            URL.revokeObjectURL(url);
          };
          img.onerror = () => { URL.revokeObjectURL(url); resolve(undefined); };
          img.src = url;
        });
      }
    } catch (e) {
      console.warn("[LOS] 차트 스크린샷 실패:", e);
    }

    const result: LOSProfileData = {
      id: `los-${Date.now()}`,
      radarSiteName: radarSite.name,
      radarLat: radarSite.latitude,
      radarLon: radarSite.longitude,
      radarHeight,
      targetLat,
      targetLon,
      bearing,
      totalDistance: totalDist,
      elevationProfile: profile,
      losBlocked: chartData.blocked,
      maxBlockingPoint: chartData.maxBlockPoint
        ? {
            distance: chartData.maxBlockPoint.distance,
            elevation: chartData.maxBlockPoint.realElevation,
            name: chartData.maxBlockPoint.name,
          }
        : undefined,
      mapScreenshot,
      chartScreenshot,
      timestamp: Date.now(),
    };
    addLOSResult(result);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  // X축 줌 네이티브 휠 핸들러 (passive: false 필수)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * W;
      // 차트 영역 밖이면 무시
      if (svgX < PAD.left || svgX > W - PAD.right) return;
      const cursorRatio = (svgX - PAD.left) / cw; // 0~1 in chart area
      const [s, en] = xZoomRef.current;
      const range = en - s;
      // 커서가 가리키는 절대 위치 (%)
      const pivot = s + cursorRatio * range;
      const factor = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      let newRange = Math.min(100, Math.max(1, range * factor));
      let newStart = pivot - cursorRatio * newRange;
      let newEnd = pivot + (1 - cursorRatio) * newRange;
      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > 100) { newStart -= (newEnd - 100); newEnd = 100; }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(100, newEnd);
      const next: [number, number] = [newStart, newEnd];
      xZoomRef.current = next;
      setXZoom(next);
    };
    const onMouseDown = (e: MouseEvent) => {
      // 줌 상태가 아니면 드래그 패닝 불필요
      const [s, en] = xZoomRef.current;
      if (s === 0 && en === 100) return;
      const rect = svg.getBoundingClientRect();
      const svgX = ((e.clientX - rect.left) / rect.width) * W;
      if (svgX < PAD.left || svgX > W - PAD.right) return;
      isDragging.current = true;
      dragStartX.current = e.clientX;
      dragStartZoom.current = [...xZoomRef.current];
      svg.style.cursor = "grabbing";
      e.preventDefault();
    };
    const onMouseMoveGlobal = (e: MouseEvent) => {
      if (!isDragging.current) return;
      const rect = svg.getBoundingClientRect();
      const dx = e.clientX - dragStartX.current;
      const [origS, origE] = dragStartZoom.current;
      const range = origE - origS;
      // dx 픽셀을 줌 %로 변환 (차트 영역 폭 기준)
      const chartPxWidth = rect.width * (cw / W);
      const shift = -(dx / chartPxWidth) * range;
      let newStart = origS + shift;
      let newEnd = origE + shift;
      if (newStart < 0) { newEnd -= newStart; newStart = 0; }
      if (newEnd > 100) { newStart -= (newEnd - 100); newEnd = 100; }
      newStart = Math.max(0, newStart);
      newEnd = Math.min(100, newEnd);
      const next: [number, number] = [newStart, newEnd];
      xZoomRef.current = next;
      setXZoom(next);
    };
    const onMouseUpGlobal = () => {
      if (isDragging.current) {
        isDragging.current = false;
        svg.style.cursor = "";
      }
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMoveGlobal);
    document.addEventListener("mouseup", onMouseUpGlobal);
    return () => {
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMoveGlobal);
      document.removeEventListener("mouseup", onMouseUpGlobal);
    };
  }, [cw, loading]);

  // 줌 리셋 (프로파일 변경 시)
  useEffect(() => {
    xZoomRef.current = [0, 100];
    setXZoom([0, 100]);
  }, [profile]);

  // 마우스 이동 핸들러 (SVG 좌표 → 거리 + 항적 포인트 히트테스트)
  const handleSvgMouseMove = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    if (isDragging.current) return;
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const svgY = ((e.clientY - rect.top) / rect.height) * H;
    setHoverX(svgX);
    // 항적 포인트 히트테스트 (GPU 캔버스 대응)
    const positions = trackPointPosRef.current;
    let nearIdx: number | null = null;
    let nearDist = 100; // 10px threshold²
    for (const p of positions) {
      const dx = p.x - svgX, dy = p.y - svgY;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearDist) { nearDist = d2; nearIdx = p.idx; }
    }
    if (nearIdx !== hoveredTrackIdxRef.current) {
      hoveredTrackIdxRef.current = nearIdx;
      setHoveredTrackIdx(nearIdx);
      onTrackPointHoverRef.current?.(nearIdx);
    }
  }, []); // refs만 사용하므로 의존성 없음
  const handleSvgMouseLeave = useCallback(() => {
    setHoverX(null);
    onHoverDistance?.(null);
    // 항적 포인트 호버 해제
    if (hoveredTrackIdxRef.current !== null) {
      hoveredTrackIdxRef.current = null;
      setHoveredTrackIdx(null);
      onTrackPointHoverRef.current?.(null);
    }
  }, [onHoverDistance]);
  // 항적 포인트 클릭 → 핀 토글
  const handleSvgClick = useCallback((e: React.MouseEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const svgX = ((e.clientX - rect.left) / rect.width) * W;
    const svgY = ((e.clientY - rect.top) / rect.height) * H;
    const positions = trackPointPosRef.current;
    let nearIdx: number | null = null;
    let nearDist = 100;
    for (const p of positions) {
      const dx = p.x - svgX, dy = p.y - svgY;
      const d2 = dx * dx + dy * dy;
      if (d2 < nearDist) { nearDist = d2; nearIdx = p.idx; }
    }
    if (nearIdx !== null) {
      const prev = pinnedTrackIdxRef.current;
      if (prev === nearIdx) {
        setPinnedTrackIdx(null);
        onTrackPointHighlightRef.current?.(null);
      } else {
        setPinnedTrackIdx(nearIdx);
        onTrackPointHighlightRef.current?.(nearIdx);
      }
    }
  }, []);

  // 호버 위치의 상세 데이터 계산
  const hoverData = useMemo(() => {
    if (hoverX === null || !chartData || profile.length === 0) return null;
    const { adjTerrain, minDetRefracted, minDetStraight, minDetFresnel, maxDistance } = chartData;

    const PAD_LEFT = 65;
    const PAD_RIGHT = 30;
    const cw = 900 - PAD_LEFT - PAD_RIGHT;
    // 줌 뷰포트 반영
    const zoomStart = xZoom[0] / 100 * maxDistance;
    const zoomEnd = xZoom[1] / 100 * maxDistance;
    const zoomRange = zoomEnd - zoomStart;
    const dist = zoomStart + ((hoverX - PAD_LEFT) / cw) * zoomRange;
    if (dist < zoomStart || dist > zoomEnd) return null;

    // 프로파일에서 보간하여 값 계산
    let terrainH = 0;
    let realElev = 0;
    let refractedH = 0;
    let straightH = 0;
    let fresnelH = 0;
    for (let i = 1; i < adjTerrain.length; i++) {
      if (adjTerrain[i].distance >= dist) {
        const t = (dist - adjTerrain[i - 1].distance) / (adjTerrain[i].distance - adjTerrain[i - 1].distance);
        terrainH = adjTerrain[i - 1].height + t * (adjTerrain[i].height - adjTerrain[i - 1].height);
        realElev = profile[i - 1].elevation + t * (profile[i].elevation - profile[i - 1].elevation);
        refractedH = minDetRefracted[i - 1].height + t * (minDetRefracted[i].height - minDetRefracted[i - 1].height);
        straightH = minDetStraight[i - 1].height + t * (minDetStraight[i].height - minDetStraight[i - 1].height);
        fresnelH = minDetFresnel[i - 1].height + t * (minDetFresnel[i].height - minDetFresnel[i - 1].height);
        break;
      }
    }

    // AGL (Above Ground Level): 실제 지표면 기준 최저탐지 높이
    const refractedAGL = refractedH - terrainH;
    const straightAGL = straightH - terrainH;
    const fresnelAGL = fresnelH - terrainH;
    // 실제 AMSL (조정 프레임 → 실제 고도 복원)
    const refractedAMSL = refractedH + curvDrop(dist);
    const straightAMSL = straightH + curvDrop(dist);
    const fresnelAMSL = fresnelH + curvDrop(dist);

    // BRA 0.25° 기준선 높이 (AMSL)
    const BRA_DEG = 0.25;
    const braH = radarHeight + dist * 1000 * Math.tan((BRA_DEG * Math.PI) / 180);
    const braAMSL = braH + curvDrop(dist);

    // CoS 최고 탐지 고도 (AMSL)
    const cosH = radarHeight + dist * 1000 * Math.tan((70 * Math.PI) / 180);
    const cosAMSL = cosH + curvDrop(dist);

    return { dist, terrainH, realElev, refractedH, straightH, fresnelH, refractedAGL, straightAGL, fresnelAGL, refractedAMSL, straightAMSL, fresnelAMSL, braAMSL, cosAMSL };
  }, [hoverX, chartData, profile, xZoom]);

  // 호버 거리 비율을 부모에 전달
  useEffect(() => {
    if (hoverData && totalDist > 0) {
      onHoverDistance?.(hoverData.dist / totalDist);
    } else {
      onHoverDistance?.(null);
    }
  }, [hoverData, totalDist, onHoverDistance]);

  const renderChart = () => {
    if (!chartData || !visibleYRange) return null;
    const {
      adjTerrain, minDetRefracted, minDetStraight, minDetFresnel, braLine, cosLine,
      maxBlockPoint, maxDistance,
    } = chartData;
    const { minY, maxY } = visibleYRange;

    const zoomStart = (xZoom[0] / 100) * maxDistance;
    const zoomEnd = (xZoom[1] / 100) * maxDistance;
    const zoomRange = zoomEnd - zoomStart;
    const xScale = (d: number) => PAD.left + ((d - zoomStart) / zoomRange) * cw;
    const yScale = (h: number) => PAD.top + ch - ((h - minY) / (maxY - minY)) * ch;

    // 지형 채우기
    const terrainFill =
      `M ${xScale(0)} ${yScale(minY)} ` +
      adjTerrain.map((p) => `L ${xScale(p.distance)} ${yScale(p.height)}`).join(" ") +
      ` L ${xScale(maxDistance)} ${yScale(minY)} Z`;

    // 지형 윤곽선
    const terrainLine = adjTerrain
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // 최저 탐지가능 높이 (4/3 굴절)
    const minDetRefPath = minDetRefracted
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // 최저 탐지가능 높이 (직선 LOS)
    const minDetStrPath = minDetStraight
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // 최저 탐지가능 높이 (직선 LOS + 프레넬존 80% 클리어런스)
    const minDetFresnelPath = minDetFresnel
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // BRA 0.25° 기준선
    const braPath = braLine
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // CoS 70° 기준선
    const cosPath = cosLine
      .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
      .join(" ");

    // 단위 변환 상수
    const M_TO_FT = 3.28084;
    const KM_TO_NM = 1 / 1.852;

    // Y축 눈금 (ft 기준)
    const yRangeFt = (maxY - minY) * M_TO_FT;
    const yStepFt = yRangeFt > 30000 ? 5000 : yRangeFt > 15000 ? 2000 : yRangeFt > 5000 ? 1000 : yRangeFt > 2000 ? 500 : 200;
    const yTicks: number[] = [];
    const minYft = minY * M_TO_FT;
    const maxYft = maxY * M_TO_FT;
    for (let yf = Math.ceil(minYft / yStepFt) * yStepFt; yf <= maxYft; yf += yStepFt) yTicks.push(yf / M_TO_FT); // m으로 저장 (yScale은 m 기준)

    // X축 눈금 (NM 기준, 줌 뷰포트 적용)
    const visibleDistNm = zoomRange * KM_TO_NM;
    const xStepNm = visibleDistNm > 80 ? 20 : visibleDistNm > 40 ? 10 : visibleDistNm > 15 ? 5 : visibleDistNm > 5 ? 2 : 1;
    const xTicks: number[] = []; // km 값으로 저장
    const zoomStartNm = zoomStart * KM_TO_NM;
    const zoomEndNm = zoomEnd * KM_TO_NM;
    const xTickStartNm = Math.ceil(zoomStartNm / xStepNm) * xStepNm;
    for (let xn = xTickStartNm; xn <= zoomEndNm; xn += xStepNm) xTicks.push(xn / KM_TO_NM); // km으로 변환

    return (
      <div className="relative">
      {/* GPU 캔버스: 항적 포인트 (SVG 아래에 배치, 범례/툴팁이 위에 표시) */}
      <canvas ref={trackCanvasRef} className="absolute inset-0 pointer-events-none" style={{ width: '100%', height: '100%' }} />
      <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} className="w-full relative"
        style={{ minHeight: 220, cursor: xZoom[0] !== 0 || xZoom[1] !== 100 ? "grab" : undefined }}
        onMouseMove={handleSvgMouseMove} onMouseLeave={handleSvgMouseLeave} onClick={handleSvgClick}>
        <defs>
          <linearGradient id="terrainGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.05" />
          </linearGradient>
          <clipPath id="chart-clip">
            <rect x={PAD.left} y={PAD.top} width={cw} height={ch} />
          </clipPath>
        </defs>

        {/* Y축 라벨 (클립 밖) */}
        {yTicks.map((y) => {
          const labelY = yScale(y - curvDrop(zoomStart));
          return (
            <text key={`yl-${y}`} x={PAD.left - 5} y={labelY + 3} textAnchor="end"
              fill="#6b7280" fontSize={9}>
              {Math.round(y * M_TO_FT).toLocaleString()}ft
            </text>
          );
        })}
        {/* X축 라벨 (클립 밖) */}
        {xTicks.map((x) => (
          <text key={`xl-${x}`} x={xScale(x)} y={H - PAD.bottom + 14} textAnchor="middle"
            fill="#6b7280" fontSize={9}>
            {(x * KM_TO_NM).toFixed(x * KM_TO_NM >= 10 ? 0 : 1)}NM
          </text>
        ))}

        {/* 클리핑 영역 내 차트 요소 */}
        <g clipPath="url(#chart-clip)">
        {/* 수평 격자: 일정 AMSL 고도를 지구곡률 반영 곡선으로 표현 */}
        {yTicks.map((y) => {
          const numSeg = 50;
          const parts: string[] = [];
          for (let s = 0; s <= numSeg; s++) {
            const dist = zoomStart + (s / numSeg) * zoomRange;
            parts.push(`${s === 0 ? 'M' : 'L'} ${xScale(dist)} ${yScale(y - curvDrop(dist))}`);
          }
          return (
            <path key={`yg-${y}`} d={parts.join(' ')} fill="none"
              stroke={y === 0 ? "rgba(0,0,0,0.15)" : "rgba(0,0,0,0.06)"}
              strokeWidth={y === 0 ? 1 : 0.5} />
          );
        })}
        {/* 수직 격자 */}
        {xTicks.map((x) => (
          <line key={`xg-${x}`} x1={xScale(x)} y1={PAD.top} x2={xScale(x)} y2={H - PAD.bottom}
            stroke="rgba(0,0,0,0.06)" strokeWidth={0.5} />
        ))}
        {/* 지형 채우기 */}
        <path d={terrainFill} fill="url(#terrainGrad)" />

        {/* 지형 윤곽선 */}
        <path d={terrainLine} fill="none" stroke="#22c55e" strokeWidth={1.5} />

        {/* 건물 실루엣 (차폐 기여 건물만) — 점 건물: 세로선, 도형 건물: 채워진 사각형 */}
        {showBuildings && chartData.significantBuildings.map((b, bi) => {
          const nearD = b.near_dist_km ?? b.distance_km;
          const farD = b.far_dist_km ?? b.distance_km;
          const hasExtent = (farD - nearD) > 0.001;
          // 도형 건물: 양 끝의 곡률 보정 적용
          const nearGroundAdj = b.ground_elev_m - curvDrop(nearD);
          const nearTopAdj = (b.ground_elev_m + b.height_m) - curvDrop(nearD);
          const farGroundAdj = hasExtent ? (b.ground_elev_m - curvDrop(farD)) : nearGroundAdj;
          const farTopAdj = hasExtent ? ((b.ground_elev_m + b.height_m) - curvDrop(farD)) : nearTopAdj;
          const bxNear = xScale(nearD);
          const bxFar = hasExtent ? xScale(farD) : bxNear;
          const byBottomNear = yScale(nearGroundAdj);
          const byTopNear = yScale(nearTopAdj);
          const byBottomFar = hasExtent ? yScale(farGroundAdj) : byBottomNear;
          const byTopFar = hasExtent ? yScale(farTopAdj) : byTopNear;
          const bHeight = byBottomNear - byTopNear;
          if (bHeight < 1) return null;
          const isHovered = hoveredBldgIdx === bi;
          const isClicked = clickedBldgIdx === bi;
          const baseColor = isClicked ? "#f59e0b" : isHovered ? "#facc15" : b.isBlocking ? "rgba(239, 68, 68, 0.8)" : "rgba(71, 85, 105, 0.7)";
          const fillColor = isClicked ? "rgba(245,158,11,0.3)" : isHovered ? "rgba(250,204,21,0.25)" : b.isBlocking ? "rgba(239,68,68,0.15)" : "rgba(71,85,105,0.12)";

          if (hasExtent) {
            // 도형 건물: 채워진 사각형 (사다리꼴 — 곡률 보정으로 양쪽 높이 다름)
            const pathD = `M ${bxNear} ${byBottomNear} L ${bxNear} ${byTopNear} L ${bxFar} ${byTopFar} L ${bxFar} ${byBottomFar} Z`;
            return (
              <g key={`bld-${bi}`}>
                {/* 투명 히트영역 */}
                <path d={pathD} fill="transparent" stroke="transparent" strokeWidth={4}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={() => { setHoveredBldgIdx(bi); onBuildingHover?.({ lat: b.lat, lon: b.lon, height_m: b.height_m, name: b.name, address: b.address, usage: b.usage }); }}
                  onMouseLeave={() => { setHoveredBldgIdx(null); if (clickedBldgIdx === null) onBuildingHover?.(null); }}
                  onClick={(e) => {
                    e.stopPropagation();
                    const toggling = clickedBldgIdx === bi;
                    setClickedBldgIdx(toggling ? null : bi);
                    onBuildingHover?.(toggling ? null : { lat: b.lat, lon: b.lon, height_m: b.height_m, name: b.name, address: b.address, usage: b.usage });
                  }}
                />
                {/* 채워진 사각형 + 윤곽선 */}
                <path d={pathD} fill={fillColor} stroke={baseColor}
                  strokeWidth={isClicked ? 2.5 : isHovered ? 2 : 1.5}
                  pointerEvents="none"
                />
              </g>
            );
          }

          // 점 건물: 기존 세로선 방식
          return (
            <g key={`bld-${bi}`}>
              <line
                x1={bxNear} y1={byBottomNear} x2={bxNear} y2={byTopNear}
                stroke="transparent"
                strokeWidth={14}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => { setHoveredBldgIdx(bi); onBuildingHover?.({ lat: b.lat, lon: b.lon, height_m: b.height_m, name: b.name, address: b.address, usage: b.usage }); }}
                onMouseLeave={() => { setHoveredBldgIdx(null); if (clickedBldgIdx === null) onBuildingHover?.(null); }}
                onClick={(e) => {
                  e.stopPropagation();
                  const toggling = clickedBldgIdx === bi;
                  setClickedBldgIdx(toggling ? null : bi);
                  onBuildingHover?.(toggling ? null : { lat: b.lat, lon: b.lon, height_m: b.height_m, name: b.name, address: b.address, usage: b.usage });
                }}
              />
              <line
                x1={bxNear} y1={byBottomNear} x2={bxNear} y2={byTopNear}
                stroke={baseColor}
                strokeWidth={isClicked ? 3.5 : isHovered ? 3 : 2}
                pointerEvents="none"
              />
            </g>
          );
        })}

        {/* 최저 탐지가능 높이 - 직선 LOS (굴절 미적용, 실제 지구반경) */}
        <path d={minDetStrPath} fill="none"
          stroke="rgba(107,114,128,0.6)" strokeWidth={1.8} />

        {/* 최저 탐지가능 높이 - 직선 LOS + 프레넬존 80% 클리어런스 */}
        <path d={minDetFresnelPath} fill="none"
          stroke="#ec4899" strokeWidth={1.2} strokeDasharray="6 3" />

        {/* 최저 탐지가능 높이 - 4/3 굴절 적용 */}
        <path d={minDetRefPath} fill="none"
          stroke="#f59e0b" strokeWidth={1.8} />

        {/* 0.25° BRA 기준선 */}
        <path d={braPath} fill="none"
          stroke="#22d3ee" strokeWidth={1} strokeDasharray="8 4" />
        <text
          x={xScale(maxDistance) - 4}
          y={yScale(braLine[braLine.length - 1].height) - 5}
          textAnchor="end" fill="#22d3ee" fontSize={9} fontWeight="bold">
          BRA
        </text>

        {/* CoS 70° 기준선 */}
        <path d={cosPath} fill="none"
          stroke="#a855f7" strokeWidth={1} strokeDasharray="4 3" />

        {/* 레이더 위치 라벨 (Y축 상단) */}
        <text x={xScale(0) + 4} y={PAD.top + 12}
          fill="#6b7280" fontSize={8}>
          {radarSite.name} ({Math.round(radarHeight * M_TO_FT).toLocaleString()}ft)
        </text>

        {/* 이름 있는 산들 */}
        {chartData.namedPeaks.map((peak, i) => {
          const isMaxBlock = maxBlockPoint && Math.abs(peak.distance - maxBlockPoint.distance) < 0.5;
          return (
            <g key={`peak-${i}`}>
              <circle
                cx={xScale(peak.distance)}
                cy={yScale(peak.adjHeight)}
                r={isMaxBlock ? 4 : 3}
                fill={isMaxBlock ? "#a60739" : "#f59e0b"}
                stroke="white" strokeWidth={1} />
              <text
                x={xScale(peak.distance)}
                y={yScale(peak.adjHeight) - 10}
                textAnchor="middle" fill="#374151" fontSize={9} fontWeight="bold">
                {`${peak.name} (${Math.round(peak.realElevation * M_TO_FT).toLocaleString()}ft)`}
              </text>
            </g>
          );
        })}

        {/* LOS 선상 항적/Loss 포인트: GPU 캔버스에서 렌더링 (아래 trackCanvasRef) */}

        </g>{/* /chart-clip */}

        {/* 범례 (왼쪽 위) */}
        <g transform={`translate(${PAD.left + 8}, ${PAD.top + 5})`}>
          <rect x={-4} y={-6} width={270} height={chartData.significantBuildings.length > 0 ? 94 : 80} rx={4} fill="rgba(255,255,255,0.9)" stroke="rgba(0,0,0,0.1)" strokeWidth={0.5} />
          <line x1={0} y1={0} x2={20} y2={0}
            stroke="#f59e0b" strokeWidth={1.8} />
          <text x={24} y={3} fill="#374151" fontSize={8}>
            최저 탐지가능 높이 (4/3 전파굴절 적용)
          </text>
          <line x1={0} y1={14} x2={20} y2={14}
            stroke="rgba(107,114,128,0.6)" strokeWidth={1.8} />
          <text x={24} y={17} fill="#374151" fontSize={8}>
            최저 탐지가능 높이 (직선 LOS, 굴절 미적용)
          </text>
          <line x1={0} y1={28} x2={20} y2={28}
            stroke="#ec4899" strokeWidth={1.2} strokeDasharray="6 3" />
          <text x={24} y={31} fill="#374151" fontSize={8}>
            최저 탐지가능 높이 (직선 LOS, 프레넬존 80% 클리어런스)
          </text>
          <line x1={0} y1={42} x2={20} y2={42}
            stroke="#22d3ee" strokeWidth={1} strokeDasharray="8 4" />
          <text x={24} y={45} fill="#374151" fontSize={8}>
            BRA (0.25° 기준선)
          </text>
          <line x1={0} y1={56} x2={20} y2={56}
            stroke="#a855f7" strokeWidth={1} strokeDasharray="4 3" />
          <text x={24} y={59} fill="#374151" fontSize={8}>
            CoS (70° 최고 탐지고도)
          </text>
          <line x1={0} y1={70} x2={20} y2={70} stroke="#22c55e" strokeWidth={1.5} />
          <text x={24} y={73} fill="#374151" fontSize={8}>
            지형 (지구곡률 보정)
          </text>
          {chartData.significantBuildings.length > 0 && (
            <>
              <rect x={2} y={80} width={16} height={8} fill="rgba(100, 116, 139, 0.5)" stroke="rgba(71, 85, 105, 0.7)" strokeWidth={0.5} />
              <text x={24} y={87} fill="#374151" fontSize={8}>
                차폐 건물 ({chartData.significantBuildings.length}동)
              </text>
            </>
          )}
        </g>

        {/* 인터랙티브 크로스헤어 + 호버 툴팁 */}
        {hoverData && hoveredTrackIdx === null && externalHoverIdx == null && pinnedTrackIdx === null && hoveredBldgIdx === null && (() => {
          const hXPos = xScale(hoverData.dist);
          const tooltipW = 195;
          const tooltipH = 118;
          const tooltipX = hXPos + tooltipW + 12 > W ? hXPos - tooltipW - 8 : hXPos + 8;
          const tooltipY = PAD.top + 4;
          return (
            <g>
              {/* 차트 Y축 크로스헤어 (보조) */}
              <line x1={hXPos} y1={PAD.top} x2={hXPos} y2={H - PAD.bottom}
                stroke="rgba(156,163,175,0.2)" strokeWidth={0.5} strokeDasharray="2 3" />
              {/* 지형 위 인디케이터 */}
              <circle cx={hXPos} cy={yScale(hoverData.terrainH)} r={3}
                fill="#22c55e" stroke="white" strokeWidth={0.8} />
              {/* 굴절선: 지면→포인트 수직 가이드 */}
              <line x1={hXPos} y1={yScale(hoverData.terrainH)} x2={hXPos} y2={yScale(hoverData.refractedH)}
                stroke="#f59e0b" strokeWidth={0.8} strokeDasharray="2 2" strokeOpacity={0.5} />
              <circle cx={hXPos} cy={yScale(hoverData.refractedH)} r={3}
                fill="#f59e0b" stroke="white" strokeWidth={0.8} />
              {/* 직선 LOS: 지면→포인트 수직 가이드 */}
              <line x1={hXPos} y1={yScale(hoverData.terrainH)} x2={hXPos} y2={yScale(hoverData.straightH)}
                stroke="rgba(107,114,128,0.5)" strokeWidth={0.8} strokeDasharray="2 2" strokeOpacity={0.5} />
              <circle cx={hXPos} cy={yScale(hoverData.straightH)} r={2.5}
                fill="rgba(107,114,128,0.6)" stroke="white" strokeWidth={0.8} />
              {/* 프레넬존 클리어런스 인디케이터 */}
              <circle cx={hXPos} cy={yScale(hoverData.fresnelH)} r={2.5}
                fill="#ec4899" stroke="white" strokeWidth={0.8} />
              {/* 툴팁 배경 */}
              <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH}
                rx={4} fill="rgba(255,255,255,0.95)" stroke="rgba(0,0,0,0.1)" strokeWidth={0.5} />
              {/* 툴팁 내용 */}
              <text x={tooltipX + 8} y={tooltipY + 14} fill="#6b7280" fontSize={8}>
                거리: <tspan fill="#374151" fontWeight="bold">{(hoverData.dist / 1.852).toFixed(1)}NM</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 28} fill="#22c55e" fontSize={8}>
                지형고도: <tspan fill="#374151">{Math.round(hoverData.realElev * 3.28084).toLocaleString()}ft AMSL</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 42} fill="#f59e0b" fontSize={8}>
                최저탐지(굴절): <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.refractedAMSL * 3.28084).toLocaleString()}ft</tspan>
                <tspan fill="#6b7280" fontSize={7}> (AGL {Math.round(hoverData.refractedAGL * 3.28084).toLocaleString()}ft)</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 56} fill="rgba(107,114,128,0.6)" fontSize={8}>
                직선LOS: <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.straightAMSL * 3.28084).toLocaleString()}ft</tspan>
                <tspan fill="#6b7280" fontSize={7}> (AGL {Math.round(hoverData.straightAGL * 3.28084).toLocaleString()}ft)</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 70} fill="#ec4899" fontSize={8}>
                프레넬80%: <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.fresnelAMSL * 3.28084).toLocaleString()}ft</tspan>
                <tspan fill="#6b7280" fontSize={7}> (AGL {Math.round(hoverData.fresnelAGL * 3.28084).toLocaleString()}ft)</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 84} fill="#22d3ee" fontSize={8}>
                BRA 0.25°: <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.braAMSL * 3.28084).toLocaleString()}ft</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 98} fill="#a855f7" fontSize={8}>
                최고탐지(CoS): <tspan fill="#374151" fontWeight="bold">{Math.round(hoverData.cosAMSL * 3.28084).toLocaleString()}ft</tspan>
              </text>
            </g>
          );
        })()}

        {/* 건물 호버/클릭 툴팁 */}
        {(() => {
          const activeBldgIdx = clickedBldgIdx ?? hoveredBldgIdx;
          if (activeBldgIdx === null || !chartData.significantBuildings[activeBldgIdx]) return null;
          const b = chartData.significantBuildings[activeBldgIdx];
          const bTopAdj = (b.ground_elev_m + b.height_m) - curvDrop(b.distance_km);
          const bx = xScale(b.distance_km);
          const by = yScale(bTopAdj);
          const tooltipW = 190;
          const hasName = !!b.name;
          const hasAddr = !!b.address;
          const hasUsage = !!b.usage;
          const headerLines = (hasName ? 1 : 0) + (hasAddr ? 1 : 0) + (hasUsage ? 1 : 0);
          const isClicked = clickedBldgIdx === activeBldgIdx;
          const tooltipH = 62 + headerLines * 13;
          const tooltipX = bx + tooltipW + 12 > W ? bx - tooltipW - 8 : bx + 8;
          const tooltipY = Math.max(PAD.top + 4, by - tooltipH / 2);
          let lineY = tooltipY;
          return (
            <g>
              <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH}
                rx={4} fill="rgba(255,255,255,0.95)" stroke={isClicked ? "rgba(245,158,11,0.6)" : "rgba(0,0,0,0.15)"} strokeWidth={isClicked ? 1 : 0.5} />
              {hasName && (
                <text x={tooltipX + 8} y={(lineY += 13, lineY)} fill="#374151" fontSize={9} fontWeight="bold">
                  {b.name}
                </text>
              )}
              {hasUsage && (
                <text x={tooltipX + 8} y={(lineY += 13, lineY)} fill="#6366f1" fontSize={8}>
                  {b.usage}
                </text>
              )}
              {hasAddr && (
                <text x={tooltipX + 8} y={(lineY += 13, lineY)} fill="#9ca3af" fontSize={7.5}>
                  {b.address}
                </text>
              )}
              <text x={tooltipX + 8} y={(lineY += 14, lineY)} fill="#6b7280" fontSize={8}>
                거리: <tspan fill="#374151" fontWeight="bold">{(b.distance_km / 1.852).toFixed(1)}NM</tspan>
                <tspan fill="#6b7280"> ({b.distance_km.toFixed(1)}km)</tspan>
              </text>
              <text x={tooltipX + 8} y={(lineY += 14, lineY)} fill="#6b7280" fontSize={8}>
                건물높이: <tspan fill="#374151" fontWeight="bold">{b.height_m.toFixed(1)}m</tspan>
                <tspan fill="#6b7280"> ({Math.round(b.height_m * 3.28084)}ft)</tspan>
              </text>
              <text x={tooltipX + 8} y={(lineY += 14, lineY)} fill="#6b7280" fontSize={8}>
                지반고: <tspan fill="#374151">{Math.round(b.ground_elev_m)}m</tspan>
                <tspan fill="#6b7280">  꼭대기: </tspan>
                <tspan fill="#374151" fontWeight="bold">{Math.round(b.ground_elev_m + b.height_m)}m AMSL</tspan>
              </text>
              <text x={tooltipX + 8} y={(lineY += 14, lineY)} fill={b.isBlocking ? "#ef4444" : "#6b7280"} fontSize={8} fontWeight={b.isBlocking ? "bold" : "normal"}>
                {b.isBlocking ? "⚠ LOS 차단 기여" : "차폐 영향"}
              </text>
              {isClicked && (
                <text x={tooltipX + tooltipW - 8} y={lineY} textAnchor="end"
                  fill="#3b82f6" fontSize={7.5} style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => { (e.target as SVGTextElement).style.textDecoration = "underline"; }}
                  onMouseLeave={(e) => { (e.target as SVGTextElement).style.textDecoration = "none"; }}
                  onClick={(e) => { e.stopPropagation(); onBuildingDetail?.(b); }}
                >
                  상세보기
                </text>
              )}
            </g>
          );
        })()}

        {/* 항적/Loss 포인트 호버/핀 툴팁 */}
        {(() => {
          const activeIdx = hoveredTrackIdx ?? externalHoverIdx ?? pinnedTrackIdx;
          if (activeIdx === null || !losTrackPoints || !losTrackPoints[activeIdx]) return null;
          const tp = losTrackPoints[activeIdx];
          const tpDist = tp.distRatio * maxDistance;
          const tpAdjAlt = tp.altitude - curvDrop(tpDist);
          const tpX = xScale(tpDist);
          const tpY = yScale(tpAdjAlt);
          const tooltipW = 160;
          const tooltipH = 62;
          const tooltipX = tpX + tooltipW + 12 > W ? tpX - tooltipW - 8 : tpX + 8;
          const tooltipY = Math.max(PAD.top, Math.min(tpY - tooltipH / 2, H - PAD.bottom - tooltipH));
          const date = new Date(tp.timestamp * 1000);
          const timeStr = `${String(date.getUTCHours()).padStart(2, "0")}:${String(date.getUTCMinutes()).padStart(2, "0")}:${String(date.getUTCSeconds()).padStart(2, "0")}`;
          return (
            <g>
              <rect x={tooltipX} y={tooltipY} width={tooltipW} height={tooltipH}
                rx={4} fill="rgba(255,255,255,0.95)" stroke={tp.isLoss ? "#ff1744" : (() => { const c = detectionTypeColor(tp.radar_type); return `rgb(${c[0]},${c[1]},${c[2]})`; })()} strokeWidth={0.8} />
              <text x={tooltipX + 8} y={tooltipY + 14} fill="#374151" fontSize={8} fontWeight="bold">
                {tp.mode_s} {tp.isLoss ? "(Loss)" : ""}
              </text>
              <text x={tooltipX + 8} y={tooltipY + 28} fill="#6b7280" fontSize={8}>
                시각: <tspan fill="#374151">{timeStr} UTC</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 42} fill="#6b7280" fontSize={8}>
                고도: <tspan fill="#374151" fontWeight="bold">{Math.round(tp.altitude * 3.28084).toLocaleString()}ft</tspan>
                <tspan fill="#6b7280" fontSize={7}> ({tp.altitude.toFixed(0)}m)</tspan>
              </text>
              <text x={tooltipX + 8} y={tooltipY + 56} fill="#6b7280" fontSize={8}>
                거리: <tspan fill="#374151">{(tpDist / 1.852).toFixed(1)}NM</tspan>
              </text>
            </g>
          );
        })()}
      </svg>
      </div>
    );
  };

  return (
    <div className="border-t border-gray-200 bg-white/95 backdrop-blur-sm shadow-lg">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-gray-200 px-4 py-2">
        <span className="text-xs font-semibold text-gray-800">LOS 단면도</span>
        <span className="text-[10px] text-gray-500">
          {radarSite.name} → {targetLat.toFixed(4)}°N {targetLon.toFixed(4)}°E
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-2 text-[10px] text-gray-500">
          <span>거리: {(totalDist / 1.852).toFixed(1)}NM</span>
          <span>방위: {bearing.toFixed(0)}°</span>
          {chartData && (
            <span className={chartData.blocked ? "text-[#a60739]" : "text-emerald-600"}>
              {chartData.blocked ? "LOS 차단" : "LOS 양호"}
            </span>
          )}
          {xZoom[0] !== 0 || xZoom[1] !== 100 ? (
            <button
              onClick={() => { xZoomRef.current = [0, 100]; setXZoom([0, 100]); }}
              className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-500 hover:bg-gray-200 transition-colors"
            >
              {Math.round(100 / ((xZoom[1] - xZoom[0]) / 100))}% ✕
            </button>
          ) : null}
          {buildings.length > 0 && (
            <button
              onClick={() => setShowBuildings(!showBuildings)}
              className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                showBuildings
                  ? "bg-slate-200 text-slate-700"
                  : "bg-gray-100 text-gray-400"
              }`}
            >
              건물 {showBuildings ? "ON" : "OFF"}
            </button>
          )}
          {chartData && chartData.namedPeaks.length > 0 && (
            <span className="text-yellow-600">
              산: {chartData.namedPeaks.map((p) => p.name).join(", ")}
            </span>
          )}
        </div>
        <button onClick={handleSave} disabled={loading || saved}
          className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800 disabled:opacity-50"
          title="보고서에 저장">
          <Save size={12} />
          {saved ? "저장됨" : "저장"}
        </button>
        <button onClick={onClose}
          className="rounded p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-800">
          <X size={14} />
        </button>
      </div>

      {/* Chart */}
      <div className="px-4 py-2">
        {loading ? (
          <div className="flex h-[220px] items-center justify-center">
            <Loader2 size={20} className="animate-spin text-gray-500" />
            <span className="ml-2 text-xs text-gray-500">고도 데이터 로딩 중...</span>
          </div>
        ) : (
          renderChart()
        )}
      </div>

    </div>
  );
}
