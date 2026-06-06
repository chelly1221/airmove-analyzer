import React, { useMemo, useRef, useState, useEffect, useCallback } from "react";
import type { ManualBuilding, LoSProfileData, BuildingOnPath, ElevationPoint } from "../../types";
import type { LossPointGeo, TrackPointGeo } from "../../types/obstacle";
import { useOMChartZoom, type ChartZoom } from "./OMEditable";
import { detectionTypeColor, PSR_TYPES } from "../../utils/radarConstants";
import { bearingDeg, haversineKm } from "../../utils/geo";
import { calcBuildingAzExtent, isTargetBuildingOnPath } from "../../utils/obstacleAnalysisHelpers";

// ── 물리 상수 ──
const R_EARTH_M = 6_371_000;
const R_EFF_M = (R_EARTH_M * 4) / 3; // 4/3 유효지구반경 (표준 대기 굴절 k=4/3)

/** 디스플레이 프레임 곡률 보정량 (m): 실제 지구반경 기준
 *  → 직선 LoS 가 직선으로, 지형이 거리에 따라 아래로 처져 보임 */
function curvDrop(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EARTH_M);
}

/** 4/3 유효지구 곡률 보정량 (m): 표준 대기 굴절 적용 시 레이더 빔이 직선이 되는 프레임.
 *  최저 탐지가능 높이(레이더 빔)를 이 프레임에서 직선 전파 후
 *  디스플레이(실제지구) 프레임으로 변환: h_display = h43 + curvDrop43(d) - curvDrop(d) */
function curvDrop43(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EFF_M);
}

// ── SVG 차트 상수 (TrackMap LoSProfilePanel 과 동일) ──
const W = 900;
const H = 280;
const PAD = { top: 20, right: 30, bottom: 30, left: 65 };
const cw = W - PAD.left - PAD.right;
const ch = H - PAD.top - PAD.bottom;
const M_TO_FT = 3.28084;
const KM_TO_NM = 1 / 1.852;

/** 차트 X축 풀 스케일 (NM) — 보고서 LoS 단면도는 빌딩 거리와 무관하게 100NM 고정.
 *  obstacleAnalysisHelpers.EXTEND_PROFILE_MIN_KM 와 일치해야 한다 (profile 이 100NM 까지 샘플링). */
const FULL_X_NM = 100;
const FULL_X_KM = FULL_X_NM * 1.852;

const LOSS_COLOR: [number, number, number] = [255, 23, 69]; // #ff1745

export interface ChartTrackPoint {
  distKm: number;
  altM: number; // 곡률 보정 전 AMSL
  radarType: string;
  isLoss: boolean;
}

/**
 * LoS 단면도 — TrackMap LoSProfilePanel 의 chartData/렌더링을 보고서용으로 그대로 이식.
 *
 *  TrackMap 과 동일한 요소:
 *   - LoS (4/3 유효지구 굴절, running max angle, 통합 obstacle 배열) — 주황 실선
 *   - 지형 (지구곡률 보정) — 녹색 솔리드
 *   - 경로상 빌딩: polygon 은 사다리꼴, point 는 세로선; 차폐 기여(빨강) / 비차단(회색) / 수동(주황)
 *   - 범례 좌상단 + 빌딩 카운트
 *
 *  보고서 한정 — 정적 렌더링이라 제거:
 *   - GPU 캔버스 트랙 → SVG circles
 *   - 호버/툴팁/줌/사용자 각도선
 *   - peak DB 쿼리 (배치 부담)
 *   - BRA / CoS / 프레넬 기준선 (단순화)
 *
 *  X축은 100NM 고정 (FULL_X_KM). los.elevationProfile 은 obstacleAnalysisHelpers 에서 100NM 까지 샘플링됨.
 */
export function LosCrossSection({
  los, radarName, building, buildingGroup, trackPoints, lossPoints,
}: {
  los: LoSProfileData;
  radarName: string;
  building: ManualBuilding;
  /** 이 빌딩의 소속 그룹 — 제목 옆 인라인 배지 표시용. 없으면 미표시 */
  buildingGroup?: import("../../types").BuildingGroup | null;
  trackPoints: ChartTrackPoint[];
  lossPoints: ChartTrackPoint[];
}) {
  const chartData = useMemo(() => {
    const profile = los.elevationProfile;
    if (profile.length === 0) return null;

    const radarHeight = los.radarHeight;
    const D = los.totalDistance;
    const targetElev = building.ground_elev + building.height;
    const adjTarget = targetElev - curvDrop(D);
    const buildings: BuildingOnPath[] = los.pathBuildings ?? [];

    // 1) 조정 지형 (실제 지구곡률 반영)
    const adjTerrain = profile.map((p) => ({
      distance: p.distance,
      height: p.elevation - curvDrop(p.distance),
    }));

    // 1.5) 통합 장애물 배열: 지형 + 빌딩 — 차단 판정용 (min-det 는 computeMinDet 가 자체 구성)
    interface Obstacle { distance: number; elevation: number; }
    const obstacles: Obstacle[] = [];
    for (const p of profile) {
      obstacles.push({ distance: p.distance, elevation: p.elevation });
    }
    for (const b of buildings) {
      const bTop = b.ground_elev_m + b.height_m;
      const nearD = b.near_dist_km ?? b.distance_km;
      const farD = b.far_dist_km ?? b.distance_km;
      obstacles.push({ distance: nearD, elevation: bTop });
      if (farD - nearD > 0.001) {
        obstacles.push({ distance: farD, elevation: bTop });
      }
    }
    obstacles.sort((a, b) => a.distance - b.distance);

    // 2) 최저 탐지가능선 (4/3 유효지구 굴절, Running Max Angle) — TrackMap minDetStraight 와 동일.
    //    지형 base(terrainPts) + 건물(blds) 통합 obstacle 에 대해 running-max 앙각 계산.
    //    레이더 빔은 4/3 프레임에서 직선 → 앙각을 4/3 프레임에서 계산 후
    //    디스플레이(실제지구) 프레임으로 변환: h_display = h43 + curvDrop43(d) - curvDrop(d).
    //    동일 알고리즘을 (지형+모든건물) / (순수지형+대상제외건물) 두 입력으로 호출.
    const computeMinDet = (terrainPts: ElevationPoint[], blds: BuildingOnPath[]) => {
      if (terrainPts.length === 0) return [] as { distance: number; height: number }[];
      const edges = blds.map((b) => ({
        nearD: b.near_dist_km ?? b.distance_km,
        farD: b.far_dist_km ?? b.distance_km,
        topElev: b.ground_elev_m + b.height_m,
      }));
      const obs: Obstacle[] = [];
      for (const p of terrainPts) obs.push({ distance: p.distance, elevation: p.elevation });
      for (const e of edges) {
        obs.push({ distance: e.nearD, elevation: e.topElev });
        if (e.farD - e.nearD > 0.001) obs.push({ distance: e.farD, elevation: e.topElev });
      }
      obs.sort((a, b) => a.distance - b.distance);

      const interpElev = (d: number): number => {
        if (d <= terrainPts[0].distance) return terrainPts[0].elevation;
        const last = terrainPts[terrainPts.length - 1];
        if (d >= last.distance) return last.elevation;
        for (let i = 1; i < terrainPts.length; i++) {
          if (terrainPts[i].distance >= d) {
            const denom = terrainPts[i].distance - terrainPts[i - 1].distance;
            const t = denom > 1e-9 ? (d - terrainPts[i - 1].distance) / denom : 0;
            return terrainPts[i - 1].elevation + t * (terrainPts[i].elevation - terrainPts[i - 1].elevation);
          }
        }
        return 0;
      };

      // 통합 샘플 거리 (지형 샘플 + 건물 경계 ± eps)
      const sd: number[] = terrainPts.map((p) => p.distance);
      for (const e of edges) {
        const eps = 0.0005;
        if (e.nearD > eps) sd.push(e.nearD - eps);
        sd.push(e.nearD);
        if (e.farD - e.nearD > 0.001) { sd.push(e.farD); sd.push(e.farD + eps); }
        else sd.push(e.nearD + eps);
      }
      const dists = [...new Set(sd)].sort((a, b) => a - b);

      const effElevAt = (d: number): number => {
        let elev = interpElev(d);
        for (const e of edges) {
          if (d >= e.nearD && d <= e.farD + 0.0001) { if (e.topElev > elev) elev = e.topElev; }
        }
        return elev;
      };

      let maxAngle43 = -Infinity;
      let obIdx = 0;
      return dists.map((d) => {
        if (d <= 0) return { distance: d, height: radarHeight };
        const dM = d * 1000;
        while (obIdx < obs.length && obs[obIdx].distance <= d + 1e-9) {
          const ob = obs[obIdx];
          if (ob.distance > 0) {
            const adjH43 = ob.elevation - curvDrop43(ob.distance);
            const angle = (adjH43 - radarHeight) / (ob.distance * 1000);
            if (angle > maxAngle43) maxAngle43 = angle;
          }
          obIdx++;
        }
        const terrElev = effElevAt(d);
        const terrAngle = (terrElev - curvDrop43(d) - radarHeight) / dM;
        if (terrAngle > maxAngle43) maxAngle43 = terrAngle;
        // 4/3 프레임 빔 높이 → 디스플레이(실제지구) 프레임 변환, 디스플레이 지형을 floor 로
        const losDisplay = radarHeight + maxAngle43 * dM + curvDrop43(d) - curvDrop(d);
        const adjTerrainDisplay = terrElev - curvDrop(d);
        return { distance: d, height: Math.max(adjTerrainDisplay, losDisplay) };
      });
    };

    // 2a) 현재 선 (지형+모든 건물, combinedElev base) — 기존과 동일 결과
    const minDetStraight = computeMinDet(profile, buildings);

    // 2b) 분석 대상 건물 제외 선 — base 를 실선과 동일한 profile(combinedElev: 지형+모든건물)에서 출발시키고,
    //     대상 건물 footprint 구간만 구조물 height 를 제거(지반/언덕은 유지)한다. → 점선 base = 실선 base,
    //     유일한 차이 = 대상 구조물뿐이라 두 선은 대상 전까지 완전히 동일하고 대상 후방서만 벌어진다.
    //     (이전엔 raw SRTM 에서 출발 → 녹색 지형에 묻혀 실루엣 없이 보이는 비대상 건물 봉우리(combinedElev 스파이크)가
    //      점선 base 에서 빠져, 실선·녹색지형은 그 위를 타고 넘는데 점선만 봉우리를 '무시'하던 시각 불일치가 있었음.
    //      비대상 건물은 엣지로만 들어가 interpElev 보간 봉우리를 만들지 못해 floor 가 raw SRTM 으로 가라앉던 게 원인.)
    //     대상 식별: 수동건물 + 치수 일치 + far_dist 가 타겟 거리(D)까지 도달 (코리도 끝 = 대상).
    //     point 형 대상은 Rust 가 pathBuildings 에서 제외 → 매칭 0 건이면 미표시(두 선 동일).
    const buildingsWithoutTarget = buildings.filter((b) => !isTargetBuildingOnPath(b, building, D));
    const targetBuildings = buildings.filter((b) => isTargetBuildingOnPath(b, building, D));
    const rawTerrain = los.terrainProfile; // 순수 SRTM — 대상 footprint 의 지반 복원용 (index 는 profile 과 정렬)
    let dashedTerrain: ElevationPoint[] | undefined;
    if (targetBuildings.length > 0) {
      const merged = profile.map((p) => ({ ...p }));
      for (const tb of targetBuildings) {
        const near = tb.near_dist_km ?? tb.distance_km;
        const far = tb.far_dist_km ?? tb.distance_km;
        const grnd = tb.ground_elev_m;
        for (let i = 0; i < merged.length; i++) {
          const p = merged[i];
          if (p.distance < near - 1e-9 || p.distance > far + 1e-9) continue;
          // 대상 구조물 height 제거: 순수지형과 대상 지반고 중 높은 값으로 내림(rawTerrain 없으면 지반고로 폴백).
          //   중앙선 SRTM 이 언덕 옆을 스쳐 낮게 샘플링된 경우는 ground_elev 가 언덕을 복원.
          const floorElev = Math.max(rawTerrain?.[i]?.elevation ?? grnd, grnd);
          if (floorElev < p.elevation) p.elevation = floorElev;
        }
      }
      dashedTerrain = merged;
    }
    const minDetWithout = dashedTerrain
      ? computeMinDet(dashedTerrain, buildingsWithoutTarget)
      : null;

    // 차단 판정 (TrackMap 와 동일 — 빌딩까지 직선 LoS 와 통합 장애물 비교)
    const losStraightH = (d: number) =>
      radarHeight + (adjTarget - radarHeight) * (d / D);
    let blocked = false;
    let maxBlockPoint: { distance: number; adjHeight: number; realElevation: number } | null = null;
    let maxExcess = 0;
    for (const ob of obstacles) {
      if (ob.distance <= 0 || ob.distance >= D) continue;
      const adjH = ob.elevation - curvDrop(ob.distance);
      const excess = adjH - losStraightH(ob.distance);
      if (excess > maxExcess) {
        maxExcess = excess;
        blocked = true;
        maxBlockPoint = {
          distance: ob.distance,
          adjHeight: adjH,
          realElevation: ob.elevation,
        };
      }
    }

    // 5) 차폐 기여 빌딩 — 지형만 shadow 보다 빌딩 꼭대기가 높으면 실질 차폐 기여.
    //    단, 분석 대상 건물은 음영 여부와 무관하게 항상 포함(앞쪽 지형에 가려도 표시) — isTarget 표시.
    const significantBuildings: (BuildingOnPath & { isBlocking: boolean; isTarget: boolean })[] = [];
    for (const b of buildings) {
      const bDist = b.distance_km;
      if (bDist <= 0 || bDist >= D) continue;
      const isTarget = isTargetBuildingOnPath(b, building, D);
      const bTop = b.ground_elev_m + b.height_m;
      const bAdj = bTop - curvDrop(bDist);
      let terrainShadow = radarHeight;
      for (const p of profile) {
        if (p.distance <= 0 || p.distance >= bDist) continue;
        const adjH = p.elevation - curvDrop(p.distance);
        const shadow = radarHeight + (adjH - radarHeight) * (bDist / p.distance);
        if (shadow > terrainShadow) terrainShadow = shadow;
      }
      if (bAdj > terrainShadow || isTarget) {
        const isBlk = !!(maxBlockPoint &&
          Math.abs(bDist - maxBlockPoint.distance) < 0.1 &&
          bAdj > maxBlockPoint.adjHeight - 5);
        significantBuildings.push({ ...b, isBlocking: isBlk, isTarget });
      }
    }
    // 분석 대상 건물을 마지막에 그려 다른 건물·지형 위로(높은 z-index) 올린다. (Array.sort 는 안정 정렬)
    significantBuildings.sort((a, b) => Number(a.isTarget) - Number(b.isTarget));

    // Y축 범위
    const allHeights = [
      radarHeight,
      ...adjTerrain.map((p) => p.height),
      ...minDetStraight.map((p) => p.height),
    ];
    let maxY = -Infinity;
    for (const h of allHeights) if (h > maxY) maxY = h;
    maxY += 100;
    let minY = 0;
    for (const p of adjTerrain) if (p.height < minY) minY = p.height;
    minY -= 50;
    if (minY < 0) {
      const minMaxYFor40Pct = -minY * 1.5;
      if (maxY < minMaxYFor40Pct) maxY = minMaxYFor40Pct;
    }

    return {
      adjTerrain, minDetStraight, minDetWithout,
      blocked, maxBlockPoint, significantBuildings,
      minY, maxY, maxDistance: FULL_X_KM,
      adjTarget, targetElev, radarHeight,
    };
  }, [los, building]);

  // ── 줌 편집 (클릭 → 줌모드, 휠 확대/축소 + 드래그 패닝). obstacle_monthly 편집 컨텍스트에서만 활성 ──
  const svgRef = useRef<SVGSVGElement>(null);
  // 항적/소실 포인트 전용 canvas 오버레이 — 수천~수만 점을 <circle> DOM 노드 없이 래스터로 그려
  //   PDF 캡처(WebView2 PrintToPdf) 병목을 제거한다. SVG(축/그리드/선/건물/범례)는 그대로 유지.
  const pointCanvasRef = useRef<HTMLCanvasElement>(null);
  // canvas 의 실제 렌더 픽셀 크기 — SVG(viewBox 0 0 W H, w-full)가 컨테이너 폭에 맞춰 스케일되므로
  //   ResizeObserver 로 렌더 박스를 추적해 viewBox→픽셀 스케일을 정확히 재현(1px 정합).
  const [canvasPx, setCanvasPx] = useState<{ w: number; h: number }>({ w: W, h: H });
  const zoomKey = `loscs.${radarName}_${building.id}`;
  const { editable, zoom, setZoom } = useOMChartZoom(zoomKey);
  const [zoomMode, setZoomMode] = useState(false);
  // 라이브 줌(로컬) — 드래그/휠 중 전역 omData 갱신에 따른 전체 트리 리렌더 방지.
  //   상호작용이 끝나면(또는 휠 정지 200ms 후) persist(setZoom) 로 1회 커밋한다.
  const [liveZoom, setLiveZoom] = useState<ChartZoom>(zoom);
  const liveZoomRef = useRef<ChartZoom>(liveZoom);
  liveZoomRef.current = liveZoom;
  const interactingRef = useRef(false);
  const setZoomRef = useRef(setZoom);
  setZoomRef.current = setZoom;

  // 외부(초기화·재로딩)로 persist 값이 바뀌면 로컬 동기화 (상호작용 중에는 무시)
  useEffect(() => {
    if (interactingRef.current) return;
    setLiveZoom(zoom);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom[0], zoom[1]]);

  const resetZoom = useCallback(() => {
    interactingRef.current = false;
    liveZoomRef.current = [0, 100];
    setLiveZoom([0, 100]);
    setZoomRef.current(null);
  }, []);
  const exitZoomMode = useCallback(() => {
    const [s, e] = liveZoomRef.current;
    setZoomRef.current(s === 0 && e === 100 ? null : [s, e]);
    interactingRef.current = false;
    setZoomMode(false);
  }, []);

  // 휠 줌 + 드래그 패닝 — 줌모드에서만 네이티브 리스너 부착 (wheel preventDefault 위해 passive:false)
  useEffect(() => {
    if (!editable || !zoomMode) return;
    const svg = svgRef.current;
    if (!svg) return;
    let commitTimer: ReturnType<typeof setTimeout> | null = null;
    const commit = () => {
      const [s, e] = liveZoomRef.current;
      setZoomRef.current(s === 0 && e === 100 ? null : [s, e]);
      interactingRef.current = false;
    };
    const scheduleCommit = () => {
      if (commitTimer) clearTimeout(commitTimer);
      commitTimer = setTimeout(commit, 200);
    };
    const onWheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const rect = svg.getBoundingClientRect();
      const svgX = ((ev.clientX - rect.left) / rect.width) * W;
      if (svgX < PAD.left || svgX > W - PAD.right) return;
      const cursorRatio = (svgX - PAD.left) / cw;
      const [s, e] = liveZoomRef.current;
      const range = e - s;
      const pivot = s + cursorRatio * range;
      const factor = ev.deltaY > 0 ? 1.2 : 1 / 1.2;
      const newRange = Math.min(100, Math.max(1, range * factor));
      let ns = pivot - cursorRatio * newRange;
      let ne = pivot + (1 - cursorRatio) * newRange;
      if (ns < 0) { ne -= ns; ns = 0; }
      if (ne > 100) { ns -= ne - 100; ne = 100; }
      ns = Math.max(0, ns); ne = Math.min(100, ne);
      interactingRef.current = true;
      const next: ChartZoom = [ns, ne];
      liveZoomRef.current = next;
      setLiveZoom(next);
      scheduleCommit();
    };
    let dragging = false;
    let dragStartClientX = 0;
    let dragStartZoom: ChartZoom = [0, 100];
    const onMouseDown = (ev: MouseEvent) => {
      const [s, e] = liveZoomRef.current;
      if (s === 0 && e === 100) return; // 줌 안 됨 → 패닝 불필요
      const rect = svg.getBoundingClientRect();
      const svgX = ((ev.clientX - rect.left) / rect.width) * W;
      if (svgX < PAD.left || svgX > W - PAD.right) return;
      dragging = true;
      interactingRef.current = true;
      dragStartClientX = ev.clientX;
      dragStartZoom = [...liveZoomRef.current];
      svg.style.cursor = "grabbing";
      ev.preventDefault();
    };
    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging) return;
      const rect = svg.getBoundingClientRect();
      const dx = ev.clientX - dragStartClientX;
      const [origS, origE] = dragStartZoom;
      const range = origE - origS;
      const chartPxWidth = rect.width * (cw / W);
      const shift = -(dx / chartPxWidth) * range;
      let ns = origS + shift, ne = origE + shift;
      if (ns < 0) { ne -= ns; ns = 0; }
      if (ne > 100) { ns -= ne - 100; ne = 100; }
      ns = Math.max(0, ns); ne = Math.min(100, ne);
      const next: ChartZoom = [ns, ne];
      liveZoomRef.current = next;
      setLiveZoom(next);
    };
    const onMouseUp = () => {
      if (!dragging) return;
      dragging = false;
      svg.style.cursor = "";
      if (commitTimer) { clearTimeout(commitTimer); commitTimer = null; }
      commit();
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    svg.addEventListener("mousedown", onMouseDown);
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      if (commitTimer) clearTimeout(commitTimer);
      svg.removeEventListener("wheel", onWheel);
      svg.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      svg.style.cursor = "";
    };
  }, [editable, zoomMode]);

  // ── Y축 가시 범위 — X 줌 윈도우에 맞춰 세로도 자동 맞춤 (TrackMap LoSProfilePanel 과 동일) ──
  //    줌인 시 보이는 구간(지형·LoS·대상제외선·건물)의 데이터만으로 minY/maxY 재계산.
  //    전체 줌([0,100])이면 chartData 의 전체 범위를 그대로 사용 → 줌 진입/이탈 시 점프 없음.
  const visibleYRange = useMemo(() => {
    if (!chartData) return null;
    const { adjTerrain, minDetStraight, minDetWithout, significantBuildings,
            maxDistance, minY: fullMinY, maxY: fullMaxY, radarHeight } = chartData;
    if (liveZoom[0] === 0 && liveZoom[1] === 100) return { minY: fullMinY, maxY: fullMaxY };

    const zoomStart = (liveZoom[0] / 100) * maxDistance;
    const zoomEnd = (liveZoom[1] / 100) * maxDistance;
    const inRange = (d: number) => d >= zoomStart && d <= zoomEnd;

    // 보이는 구간 내 높이값 수집 (곡률 보정 후 디스플레이 높이)
    const heights: number[] = [];
    for (const p of adjTerrain) if (inRange(p.distance)) heights.push(p.height);
    for (const p of minDetStraight) if (inRange(p.distance)) heights.push(p.height);
    if (minDetWithout) for (const p of minDetWithout) if (inRange(p.distance)) heights.push(p.height);
    // 건물 꼭대기·바닥 (윈도우에 걸치는 건물 포함)
    for (const b of significantBuildings) {
      const nearD = b.near_dist_km ?? b.distance_km;
      const farD = b.far_dist_km ?? b.distance_km;
      if (inRange(nearD) || inRange(farD) || (nearD <= zoomStart && farD >= zoomEnd)) {
        heights.push((b.ground_elev_m + b.height_m) - curvDrop(b.distance_km));
        heights.push(b.ground_elev_m - curvDrop(b.distance_km));
      }
    }
    // 레이더 높이 (시작점이 보일 때만)
    if (zoomStart <= 0.1) heights.push(radarHeight);

    if (heights.length === 0) return { minY: fullMinY, maxY: fullMaxY };

    let rawMin = Infinity, rawMax = -Infinity;
    for (const h of heights) { if (h < rawMin) rawMin = h; if (h > rawMax) rawMax = h; }
    const range = rawMax - rawMin;
    const padding = Math.max(range * 0.12, 50); // 최소 50m 여유
    const visMinY = rawMin - padding;
    let visMaxY = rawMax + padding;
    // 0ft 가 차트 40% 이하에 오도록 보장 (chartData 전체범위 로직과 동일)
    if (visMinY < 0) {
      const minMaxYFor40Pct = -visMinY * 1.5;
      if (visMaxY < minMaxYFor40Pct) visMaxY = minMaxYFor40Pct;
    }
    return { minY: visMinY, maxY: visMaxY };
  }, [chartData, liveZoom]);

  // ── canvas 렌더 픽셀 크기 추적 — SVG 는 viewBox(0 0 W H) + w-full 이라 렌더 폭이 동적.
  //    SVG 실제 렌더 박스를 ResizeObserver 로 관측해 canvas CSS/픽셀 크기를 일치시킨다(viewBox→px 스케일 보존).
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const update = () => {
      const r = svg.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setCanvasPx((prev) =>
          prev.w === r.width && prev.h === r.height ? prev : { w: r.width, h: r.height },
        );
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  // ── 항적/소실 포인트 canvas 렌더 ──
  //    SVG <circle> 전수 렌더를 대체. SVG 와 동일한 좌표계(viewBox 0 0 W H)에서 cx/cy 를 계산한 뒤
  //    canvas 의 viewBox→픽셀 스케일(sx, sy)·DPR 을 곱해 그린다 → SVG path/축과 1px 정합.
  //    의존성에 liveZoom·visibleYRange·canvasPx 가 포함되어 줌/패닝/리사이즈 시 자동 재그리기.
  useEffect(() => {
    const canvas = pointCanvasRef.current;
    if (!canvas || !chartData) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const { minY, maxY } = visibleYRange ?? chartData;
    const { maxDistance } = chartData;

    // SVG 와 동일한 X/Y 스케일 재현 (viewBox 좌표계, 0~W / 0~H)
    const zoomStartKm = (liveZoom[0] / 100) * maxDistance;
    const zoomEndKm = (liveZoom[1] / 100) * maxDistance;
    const zoomRangeKm = Math.max(1e-6, zoomEndKm - zoomStartKm);
    const xScaleV = (d: number) => PAD.left + ((d - zoomStartKm) / zoomRangeKm) * cw;
    const yScaleV = (h: number) => PAD.top + ch - ((h - minY) / (maxY - minY)) * ch;

    // viewBox(W×H) → 렌더 픽셀(canvasPx) → 물리 픽셀(DPR) 변환.
    //   SVG 기본 preserveAspectRatio="xMidYMid meet" 와 동일하게 맞춘다:
    //   maxHeight(230) 로 높이가 클램프되면 SVG 는 균일 스케일(min) + 중앙 정렬(레터박스)로 그려지므로
    //   canvas 도 동일 스케일 s = min(boxW/W, boxH/H) 와 중앙 오프셋(ox, oy)을 적용해야 1px 정합.
    const dpr = window.devicePixelRatio || 1;
    const s = Math.min(canvasPx.w / W, canvasPx.h / H);
    const ox = (canvasPx.w - W * s) / 2; // 가로 레터박스 오프셋(px)
    const oy = (canvasPx.h - H * s) / 2; // 세로 레터박스 오프셋(px)
    // backing store 픽셀 크기 (DPR 적용) — 멈춤 없이 매 그리기마다 동기화
    const bw = Math.round(canvasPx.w * dpr);
    const bh = Math.round(canvasPx.h * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;

    // 이후 좌표는 viewBox(0..W, 0..H) 그대로 사용 — DPR·균일스케일·레터박스 오프셋 합성
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    ctx.clearRect(-ox / s, -oy / s, canvasPx.w / s, canvasPx.h / s);

    // SVG clipPath(plot rect)와 동일 클립 — 줌 시 윈도우 밖 포인트가 축 영역을 넘지 않게
    ctx.save();
    ctx.beginPath();
    ctx.rect(PAD.left, PAD.top, cw, ch);
    ctx.clip();

    // 항적 포인트 — <circle r=1.5 fillOpacity=0.7> + PSR 흰 테두리. SVG 와 동일 cx/cy.
    for (const tp of trackPoints) {
      const adjAlt = tp.altM - curvDrop(tp.distKm);
      const px = xScaleV(tp.distKm);
      const py = yScaleV(adjAlt);
      const col = detectionTypeColor(tp.radarType);
      ctx.beginPath();
      ctx.arc(px, py, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.7)`;
      ctx.fill();
      if (PSR_TYPES.has(tp.radarType)) {
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.6)";
        ctx.stroke();
      }
    }

    // 소실표적 포인트 — <circle r=2.5 fillOpacity=0.9> + 반투명 테두리. SVG 와 동일 cx/cy.
    const lr = LOSS_COLOR[0], lg = LOSS_COLOR[1], lb = LOSS_COLOR[2];
    for (const lp of lossPoints) {
      const adjAlt = lp.altM - curvDrop(lp.distKm);
      const px = xScaleV(lp.distKm);
      const py = yScaleV(adjAlt);
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${lr},${lg},${lb},0.9)`;
      ctx.fill();
      ctx.lineWidth = 0.5;
      ctx.strokeStyle = `rgba(${lr},${lg},${lb},0.5)`;
      ctx.stroke();
    }

    ctx.restore();
  }, [chartData, visibleYRange, liveZoom, canvasPx, trackPoints, lossPoints]);

  if (!chartData) return null;

  const {
    adjTerrain, minDetStraight, minDetWithout,
    blocked, significantBuildings, maxDistance, radarHeight,
  } = chartData;
  // X 줌 윈도우에 맞춰 자동조정된 세로 범위 (전체 줌이면 chartData 전체범위와 동일)
  const { minY, maxY } = visibleYRange ?? chartData;

  // X축 줌 윈도우 (liveZoom: [시작%, 끝%]). [0,100] 이면 전체.
  const zoomStartKm = (liveZoom[0] / 100) * maxDistance;
  const zoomEndKm = (liveZoom[1] / 100) * maxDistance;
  const zoomRangeKm = Math.max(1e-6, zoomEndKm - zoomStartKm);
  const xScale = (d: number) => PAD.left + ((d - zoomStartKm) / zoomRangeKm) * cw;
  const yScale = (h: number) => PAD.top + ch - ((h - minY) / (maxY - minY)) * ch;

  // 지형 채우기 (마지막 profile 포인트까지)
  const lastTerrainD = adjTerrain[adjTerrain.length - 1]?.distance ?? maxDistance;
  const terrainFill =
    `M ${xScale(0)} ${yScale(minY)} ` +
    adjTerrain.map((p) => `L ${xScale(p.distance)} ${yScale(p.height)}`).join(" ") +
    ` L ${xScale(lastTerrainD)} ${yScale(minY)} Z`;
  const terrainLine = adjTerrain
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
    .join(" ");

  const minDetStrPath = minDetStraight
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
    .join(" ");

  // 분석 대상 건물 제외 최저탐지선 (청록 점선) — 대상 후방에서 주황선과 벌어짐
  const minDetWithoutPath = minDetWithout
    ? minDetWithout
        .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
        .join(" ")
    : null;

  // Y축 눈금 (ft)
  const yRangeFt = (maxY - minY) * M_TO_FT;
  const yStepFt = yRangeFt > 30000 ? 5000 : yRangeFt > 15000 ? 2000 : yRangeFt > 5000 ? 1000 : yRangeFt > 2000 ? 500 : 200;
  const yTicks: number[] = [];
  const minYft = minY * M_TO_FT;
  const maxYft = maxY * M_TO_FT;
  for (let yf = Math.ceil(minYft / yStepFt) * yStepFt; yf <= maxYft; yf += yStepFt) yTicks.push(yf / M_TO_FT);

  // X축 눈금 (NM) — 줌 윈도우 기준
  const zoomStartNm = zoomStartKm * KM_TO_NM;
  const zoomEndNm = zoomEndKm * KM_TO_NM;
  const visNm = zoomEndNm - zoomStartNm;
  const xStepNm = visNm > 80 ? 20 : visNm > 40 ? 10 : visNm > 15 ? 5 : visNm > 5 ? 2 : visNm > 2 ? 1 : 0.5;
  const xTicks: number[] = [];
  for (let xn = Math.ceil(zoomStartNm / xStepNm) * xStepNm; xn <= zoomEndNm + 1e-9; xn += xStepNm) {
    if (xn >= zoomStartNm - 1e-9) xTicks.push(xn / KM_TO_NM);
  }

  // 제목용 빌딩 메타
  const D = los.totalDistance;
  const targetElev = building.ground_elev + building.height;
  const buildingName = building.name || `건물 ${building.id}`;
  const bDistNm = D * KM_TO_NM;

  // 빌딩 카운트 — 분석 대상은 별도 집계(다른 범주서 제외해 중복 라벨 방지)
  const targetCount = significantBuildings.filter((b) => b.isTarget).length;
  const nonTargetBuildings = significantBuildings.filter((b) => !b.isTarget);
  const blockingCount = nonTargetBuildings.filter((b) => b.isBlocking).length;
  const manualCount = nonTargetBuildings.filter((b) => b.is_manual).length;
  const nonBlockingCount = nonTargetBuildings.length - blockingCount;

  // 범례 박스 높이 — LoS + 지형 (2줄, 28px) [+ 대상제외선] + 대상/차폐/비차폐/수동 + 항적/소실표적
  let legendH = 24;
  if (minDetWithout) legendH += 14;
  if (targetCount > 0) legendH += 14;
  if (blockingCount > 0) legendH += 14;
  if (nonBlockingCount > 0) legendH += 14;
  if (manualCount > 0) legendH += 14;
  legendH += 14 + 14; // 항적 + 소실표적

  // clipPath id 안전화 — los.id(레이더명 포함)에 공백·괄호·한글 등이 있으면 url(#id) 참조가 깨져
  //   클리핑이 무력화되고, 줌 시 윈도우 밖 지형·LoS·항적이 차트 축 영역(plot rect)을 넘어 그려진다.
  //   영숫자/_/- 외 문자는 _ 로 치환(클립 rect 는 모든 차트가 동일하므로 충돌해도 무해).
  const idSuffix = `${los.id}-${building.id}`.replace(/[^A-Za-z0-9_-]/g, "_");

  return (
    <div className="mb-3">
      {/* 제목 */}
      <div className="mb-1 flex items-center gap-2">
        {buildingGroup && (
          <span
            className="inline-flex items-center gap-1 rounded px-1.5 py-px text-[10px] font-semibold"
            style={{
              background: `${buildingGroup.color}1a`,
              border: `1px solid ${buildingGroup.color}55`,
              color: buildingGroup.color,
            }}
          >
            <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: 1, background: buildingGroup.color }} />
            {buildingGroup.name}
          </span>
        )}
        <span className="text-[13px] font-bold text-gray-800">{buildingName}</span>
        <span className="text-[11px] text-gray-500">
          {radarName} → 방위 {los.bearing.toFixed(1)}° / 거리 {bDistNm.toFixed(1)}NM ({D.toFixed(1)}km)
          / 높이 {Math.round(targetElev * M_TO_FT).toLocaleString()}ft ({targetElev.toFixed(0)}m)
        </span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium ${
          blocked ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"
        }`}>
          {blocked ? "차단" : "양호"}
        </span>
      </div>

      <div className="relative group">
        {editable && (
          <div className="absolute right-1 top-1 z-10 flex items-center gap-1 print:hidden">
            {zoomMode ? (
              <>
                <span className="rounded bg-blue-500/90 px-1.5 py-0.5 text-[9px] font-medium text-white">
                  휠 확대/축소 · 드래그 이동
                </span>
                <button type="button" onClick={resetZoom}
                  className="rounded border border-gray-300 bg-white px-1.5 py-0.5 text-[9px] text-gray-600 hover:bg-gray-100">
                  초기화
                </button>
                <button type="button" onClick={exitZoomMode}
                  className="rounded border border-blue-400 bg-blue-50 px-1.5 py-0.5 text-[9px] font-medium text-blue-600 hover:bg-blue-100">
                  완료
                </button>
              </>
            ) : (
              <button type="button" onClick={() => setZoomMode(true)}
                className="rounded bg-black/40 px-1.5 py-0.5 text-[9px] text-white opacity-0 transition-opacity group-hover:opacity-100">
                클릭하여 줌 편집
              </button>
            )}
          </div>
        )}
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className={`w-full ${zoomMode ? "rounded ring-2 ring-blue-400" : ""}`}
        style={{
          maxHeight: 230,
          cursor: editable
            ? (zoomMode
                ? (liveZoom[0] !== 0 || liveZoom[1] !== 100 ? "grab" : "crosshair")
                : "zoom-in")
            : undefined,
          touchAction: zoomMode ? "none" : undefined,
        }}
        onClick={editable && !zoomMode ? () => setZoomMode(true) : undefined}
      >
        <defs>
          <clipPath id={`cc-${idSuffix}`}>
            <rect x={PAD.left} y={PAD.top} width={cw} height={ch} />
          </clipPath>
        </defs>

        {/* Y축 라벨 (클립 밖) */}
        {yTicks.map((y) => {
          const labelY = yScale(y - curvDrop(zoomStartKm));
          return (
            <text key={`yl-${y}`} x={PAD.left - 5} y={labelY + 3} textAnchor="end"
              fill="#6b7280" fontSize={9}>
              {Math.round(y * M_TO_FT).toLocaleString()}ft
            </text>
          );
        })}
        {/* X축 라벨 */}
        {xTicks.map((x) => (
          <text key={`xl-${x.toFixed(3)}`} x={xScale(x)} y={H - PAD.bottom + 14} textAnchor="middle"
            fill="#6b7280" fontSize={9}>
            {(x * KM_TO_NM).toFixed(x * KM_TO_NM >= 10 ? 0 : 1)}NM
          </text>
        ))}

        <g clipPath={`url(#cc-${idSuffix})`}>
          {/* 수평 격자 (곡률 반영 곡선) */}
          {yTicks.map((y) => {
            const parts: string[] = [];
            for (let s = 0; s <= 50; s++) {
              const dist = zoomStartKm + (s / 50) * zoomRangeKm;
              parts.push(`${s === 0 ? "M" : "L"} ${xScale(dist)} ${yScale(y - curvDrop(dist))}`);
            }
            return (
              <path key={`yg-${y}`} d={parts.join(" ")} fill="none"
                stroke={y === 0 ? "rgba(0,0,0,0.15)" : "rgba(0,0,0,0.06)"}
                strokeWidth={y === 0 ? 1 : 0.5} />
            );
          })}
          {/* 수직 격자 */}
          {xTicks.map((x) => (
            <line key={`xg-${x.toFixed(3)}`} x1={xScale(x)} y1={PAD.top} x2={xScale(x)} y2={H - PAD.bottom}
              stroke="rgba(0,0,0,0.06)" strokeWidth={0.5} />
          ))}

          {/* 지형 — 솔리드 녹색 (그라데이션 제거: 바닥이 검게 보이는 문제 회피) */}
          <path d={terrainFill} fill="#22c55e" fillOpacity={0.35} />
          <path d={terrainLine} fill="none" stroke="#22c55e" strokeWidth={1.5} />

          {/* 항적/소실표적 포인트는 SVG 가 아닌 canvas 오버레이로 렌더(아래 pointCanvasRef).
              수천~수만 <circle> DOM 노드를 제거해 PDF 캡처(WebView2 PrintToPdf) 병목을 없앤다. */}

          {/* 건물 실루엣 — TrackMap 방식 (사다리꼴 / 세로선) */}
          {significantBuildings.map((b, bi) => {
            const nearD = b.near_dist_km ?? b.distance_km;
            const farD = b.far_dist_km ?? b.distance_km;
            const hasExtent = (farD - nearD) > 0.001;
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
            // 분석 대상은 1px 미만이라도 항상 표시 (분석 주체이므로 누락 금지)
            if (bHeight < 1 && !b.isTarget) return null;

            const baseColor = b.isTarget
              ? "#ea580c"
              : b.is_manual
                ? "#f97316"
                : b.isBlocking
                  ? "rgba(239, 68, 68, 0.8)"
                  : "rgba(148, 163, 184, 0.5)";
            const fillColor = b.isTarget
              ? "rgba(249,115,22,0.35)"
              : b.is_manual
                ? "rgba(249,115,22,0.15)"
                : b.isBlocking
                  ? "rgba(239,68,68,0.15)"
                  : "rgba(148,163,184,0.08)";
            const bStrokeW = b.isTarget ? 1.6 : 1;

            if (hasExtent) {
              const pathD = `M ${bxNear} ${byBottomNear} L ${bxNear} ${byTopNear} L ${bxFar} ${byTopFar} L ${bxFar} ${byBottomFar} Z`;
              return (
                <path key={`bld-${bi}`} d={pathD} fill={fillColor} stroke={baseColor} strokeWidth={bStrokeW} />
              );
            }
            return (
              <line key={`bld-${bi}`}
                x1={bxNear} y1={byBottomNear}
                x2={bxNear} y2={byTopNear}
                stroke={baseColor} strokeWidth={bStrokeW} />
            );
          })}

          {/* 분석 대상 건물 제외 최저탐지선 (청록 점선) — 대상 후방에서 주황선 아래로 벌어짐 */}
          {minDetWithoutPath && (
            <path d={minDetWithoutPath} fill="none"
              stroke="#14b8a6" strokeWidth={1.5} strokeDasharray="5 3" />
          )}

          {/* LoS (4/3 유효지구 굴절, 메인) */}
          <path d={minDetStrPath} fill="none"
            stroke="#f59e0b" strokeWidth={1.8} />

          {/* 레이더 위치 라벨 */}
          <text x={xScale(0) + 4} y={PAD.top + 12}
            fill="#6b7280" fontSize={8}>
            {radarName} ({Math.round(radarHeight * M_TO_FT).toLocaleString()}ft)
          </text>

          {/* 소실표적 포인트도 canvas 오버레이(pointCanvasRef)에서 그린다 — 위 항적 포인트와 동일 사유. */}
        </g>

        {/* 범례 (좌상단 — TrackMap 방식) */}
        <g transform={`translate(${PAD.left + 8}, ${PAD.top + 5})`}>
          <rect x={-4} y={-6} width={200} height={legendH} rx={4}
            fill="rgba(255,255,255,0.9)" stroke="rgba(0,0,0,0.1)" strokeWidth={0.5} />
          <line x1={0} y1={0} x2={20} y2={0} stroke="#f59e0b" strokeWidth={1.8} />
          <text x={24} y={3} fill="#374151" fontSize={8}>
            최저 탐지가능 높이 (LoS, 4/3 굴절)
          </text>
          <line x1={0} y1={14} x2={20} y2={14} stroke="#22c55e" strokeWidth={1.5} />
          <text x={24} y={17} fill="#374151" fontSize={8}>
            지형 (지구곡률 보정)
          </text>
          {minDetWithout && (
            <>
              <line x1={0} y1={28} x2={20} y2={28} stroke="#14b8a6" strokeWidth={1.5} strokeDasharray="5 3" />
              <text x={24} y={31} fill="#374151" fontSize={8}>
                최저 탐지가능 (분석 대상 제외)
              </text>
            </>
          )}
          {(() => {
            let legendY = minDetWithout ? 38 : 24;
            const items: React.ReactNode[] = [];
            if (targetCount > 0) {
              items.push(
                <g key="leg-tgt">
                  <rect x={2} y={legendY - 4} width={16} height={8}
                    fill="rgba(249,115,22,0.35)" stroke="#ea580c" strokeWidth={0.6} />
                  <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                    분석 대상 건물 ({targetCount}동)
                  </text>
                </g>,
              );
              legendY += 14;
            }
            if (blockingCount > 0) {
              items.push(
                <g key="leg-blk">
                  <rect x={2} y={legendY - 4} width={16} height={8}
                    fill="rgba(239,68,68,0.15)" stroke="rgba(239,68,68,0.8)" strokeWidth={0.5} />
                  <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                    LoS 차단 건물 ({blockingCount}동)
                  </text>
                </g>,
              );
              legendY += 14;
            }
            if (nonBlockingCount > 0) {
              items.push(
                <g key="leg-nb">
                  <rect x={2} y={legendY - 4} width={16} height={8}
                    fill="rgba(148,163,184,0.08)" stroke="rgba(148,163,184,0.5)" strokeWidth={0.5} />
                  <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                    비차단 건물 ({nonBlockingCount}동)
                  </text>
                </g>,
              );
              legendY += 14;
            }
            if (manualCount > 0) {
              items.push(
                <g key="leg-mn">
                  <rect x={2} y={legendY - 4} width={16} height={8}
                    fill="rgba(249,115,22,0.15)" stroke="#f97316" strokeWidth={0.5} />
                  <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                    수동 등록 건물 ({manualCount}동)
                  </text>
                </g>,
              );
              legendY += 14;
            }
            items.push(
              <g key="leg-tp">
                <circle cx={9} cy={legendY} r={1.5} fill="rgb(34,197,94)" fillOpacity={0.7} />
                <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                  항적 ({trackPoints.length.toLocaleString()}건)
                </text>
              </g>,
            );
            legendY += 14;
            items.push(
              <g key="leg-loss">
                <circle cx={9} cy={legendY} r={2.5}
                  fill={`rgb(${LOSS_COLOR[0]},${LOSS_COLOR[1]},${LOSS_COLOR[2]})`} fillOpacity={0.9} />
                <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                  소실표적 ({lossPoints.length.toLocaleString()}건)
                </text>
              </g>,
            );
            return <>{items}</>;
          })()}
        </g>
      </svg>
      {/* 항적/소실표적 포인트 canvas 오버레이 — SVG 플롯 위에 정확히 겹친다(같은 left/top/size·동일 viewBox 스케일).
          pointer-events:none 으로 SVG 의 줌/패닝 상호작용을 가리지 않는다. */}
      <canvas
        ref={pointCanvasRef}
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          width: canvasPx.w,
          height: canvasPx.h,
          pointerEvents: "none",
        }}
      />
      </div>
    </div>
  );
}

/**
 * 레이더 기준 건물 방위각 윈도우 안의 항적/소실표적 투영.
 *
 * calcBuildingAzExtent 로 건물 폴리곤(점 건물이면 ±2° 기본값)의 레이더 기준 노출면
 * 방위 구간을 구하고, 양끝에 여유마진 1° 씩 더한 윈도우 안의 포인트를 채택.
 * 거리는 레이더 기준 지상거리(haversine), X축 풀스케일(100NM)까지 — 건물 후방(음영구역)
 * 항적도 포함. (track_points_geo 는 백엔드에서 건물 중심 ±5° 로 사전 필터되어 들어오는데
 * 건물 각폭+마진은 그보다 좁으므로 이 윈도우는 그 부분집합 — 데이터 누락 없음.)
 */
export function projectPointsToLos(
  los: LoSProfileData,
  trackPoints: TrackPointGeo[],
  lossPoints: LossPointGeo[],
  building: ManualBuilding,
): { track: ChartTrackPoint[]; loss: ChartTrackPoint[] } {
  // 건물 노출면 양끝에 여유마진 1° 씩 추가 (정렬 오차/빔폭 흡수)
  const AZ_MARGIN_DEG = 1;
  const ext = calcBuildingAzExtent(los.radarLat, los.radarLon, building);
  const start = (ext.start_deg - AZ_MARGIN_DEG + 360) % 360;
  const end = (ext.end_deg + AZ_MARGIN_DEG) % 360;
  // 방위 윈도우 판정 — start > end 면 0°/360° 래핑 구간
  const inWindow = (az: number) =>
    start <= end ? az >= start && az <= end : az >= start || az <= end;

  const track: ChartTrackPoint[] = [];
  for (const tp of trackPoints) {
    const distKm = haversineKm(los.radarLat, los.radarLon, tp.lat, tp.lon);
    if (distKm <= 0.001 || distKm > FULL_X_KM) continue;
    if (!inWindow(bearingDeg(los.radarLat, los.radarLon, tp.lat, tp.lon))) continue;
    track.push({
      distKm,
      altM: tp.alt_ft / M_TO_FT,
      radarType: tp.radar_type,
      isLoss: false,
    });
  }
  const loss: ChartTrackPoint[] = [];
  for (const lp of lossPoints) {
    const distKm = haversineKm(los.radarLat, los.radarLon, lp.lat, lp.lon);
    if (distKm <= 0.001 || distKm > FULL_X_KM) continue;
    if (!inWindow(bearingDeg(los.radarLat, los.radarLon, lp.lat, lp.lon))) continue;
    loss.push({
      distKm,
      altM: lp.alt_ft / M_TO_FT,
      radarType: "",
      isLoss: true,
    });
  }
  return { track, loss };
}

