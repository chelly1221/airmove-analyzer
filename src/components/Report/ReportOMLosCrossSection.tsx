import React, { useMemo } from "react";
import type { ManualBuilding, RadarSite, LoSProfileData, BuildingOnPath, ElevationPoint } from "../../types";
import type { ObstacleMonthlyResult, LossPointGeo, TrackPointGeo } from "../../types/obstacle";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import ReportPage from "./ReportPage";
import { detectionTypeColor, PSR_TYPES } from "../../utils/radarConstants";
import { bearingDeg, haversineKm } from "../../utils/geo";
import { calcBuildingAzExtent } from "../../utils/obstacleAnalysisHelpers";

interface Props {
  sectionNum: number;
  selectedBuildings: ManualBuilding[];
  radarSites: RadarSite[];
  losMap: Map<string, LoSProfileData>;
  omResult: ObstacleMonthlyResult | null;
  hideHeader?: boolean;
}

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

    // 2b) 분석 대상 건물 제외 선 (순수지형 base + 대상 외 건물).
    //     대상 식별: 수동건물 + 치수 일치 + far_dist 가 타겟 거리(D)까지 도달 (코리도 끝 = 대상).
    //     point 형 대상은 Rust 가 pathBuildings 에서 제외 → 매칭 0 건이면 미표시(두 선 동일).
    //     terrainProfile(raw) 은 DB 복원 los 엔 없음 → 그 경우도 미표시 (graceful).
    const isTargetBuilding = (b: BuildingOnPath) =>
      b.is_manual &&
      Math.abs(b.ground_elev_m - building.ground_elev) < 1 &&
      Math.abs(b.height_m - building.height) < 1 &&
      (b.far_dist_km ?? b.distance_km) >= D - 0.5;
    const buildingsWithoutTarget = buildings.filter((b) => !isTargetBuilding(b));
    const rawTerrain = los.terrainProfile;
    const minDetWithout =
      rawTerrain && rawTerrain.length > 0 && buildingsWithoutTarget.length < buildings.length
        ? computeMinDet(rawTerrain, buildingsWithoutTarget)
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

    // 5) 차폐 기여 빌딩 — 지형만 shadow 보다 빌딩 꼭대기가 높으면 실질 차폐 기여
    const significantBuildings: (BuildingOnPath & { isBlocking: boolean })[] = [];
    for (const b of buildings) {
      const bDist = b.distance_km;
      if (bDist <= 0 || bDist >= D) continue;
      const bTop = b.ground_elev_m + b.height_m;
      const bAdj = bTop - curvDrop(bDist);
      let terrainShadow = radarHeight;
      for (const p of profile) {
        if (p.distance <= 0 || p.distance >= bDist) continue;
        const adjH = p.elevation - curvDrop(p.distance);
        const shadow = radarHeight + (adjH - radarHeight) * (bDist / p.distance);
        if (shadow > terrainShadow) terrainShadow = shadow;
      }
      if (bAdj > terrainShadow) {
        const isBlk = !!(maxBlockPoint &&
          Math.abs(bDist - maxBlockPoint.distance) < 0.1 &&
          bAdj > maxBlockPoint.adjHeight - 5);
        significantBuildings.push({ ...b, isBlocking: isBlk });
      }
    }

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

  if (!chartData) return null;

  const {
    adjTerrain, minDetStraight, minDetWithout,
    blocked, significantBuildings, minY, maxY, maxDistance, radarHeight,
  } = chartData;

  const xScale = (d: number) => PAD.left + (d / maxDistance) * cw;
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

  // X축 눈금 (NM)
  const maxDistNm = maxDistance * KM_TO_NM;
  const xStepNm = maxDistNm > 80 ? 20 : maxDistNm > 40 ? 10 : maxDistNm > 15 ? 5 : maxDistNm > 5 ? 2 : 1;
  const xTicks: number[] = [];
  for (let xn = xStepNm; xn <= maxDistNm; xn += xStepNm) xTicks.push(xn / KM_TO_NM);

  // 제목용 빌딩 메타
  const D = los.totalDistance;
  const targetElev = building.ground_elev + building.height;
  const buildingName = building.name || `건물 ${building.id}`;
  const bDistNm = D * KM_TO_NM;

  // 빌딩 카운트
  const blockingCount = significantBuildings.filter((b) => b.isBlocking).length;
  const manualCount = significantBuildings.filter((b) => b.is_manual).length;
  const nonBlockingCount = significantBuildings.length - blockingCount;

  // 범례 박스 높이 — LoS + 지형 (2줄, 28px) [+ 대상제외선] + 차폐/비차폐/수동 + 항적/소실표적
  let legendH = 24;
  if (minDetWithout) legendH += 14;
  if (blockingCount > 0) legendH += 14;
  if (nonBlockingCount > 0) legendH += 14;
  if (manualCount > 0) legendH += 14;
  legendH += 14 + 14; // 항적 + 소실표적

  const idSuffix = `${los.id}-${building.id}`;

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

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 230 }}>
        <defs>
          <clipPath id={`cc-${idSuffix}`}>
            <rect x={PAD.left} y={PAD.top} width={cw} height={ch} />
          </clipPath>
        </defs>

        {/* Y축 라벨 (클립 밖) */}
        {yTicks.map((y) => {
          const labelY = yScale(y - curvDrop(0));
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
              const dist = (s / 50) * maxDistance;
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
            if (bHeight < 1) return null;

            const baseColor = b.is_manual
              ? "#f97316"
              : b.isBlocking
                ? "rgba(239, 68, 68, 0.8)"
                : "rgba(148, 163, 184, 0.5)";
            const fillColor = b.is_manual
              ? "rgba(249,115,22,0.15)"
              : b.isBlocking
                ? "rgba(239,68,68,0.15)"
                : "rgba(148,163,184,0.08)";

            if (hasExtent) {
              const pathD = `M ${bxNear} ${byBottomNear} L ${bxNear} ${byTopNear} L ${bxFar} ${byTopFar} L ${bxFar} ${byBottomFar} Z`;
              return (
                <path key={`bld-${bi}`} d={pathD} fill={fillColor} stroke={baseColor} strokeWidth={1} />
              );
            }
            return (
              <line key={`bld-${bi}`}
                x1={bxNear} y1={byBottomNear}
                x2={bxNear} y2={byTopNear}
                stroke={baseColor} strokeWidth={1} />
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

          {/* 항적 포인트 */}
          {trackPoints.map((tp, i) => {
            const adjAlt = tp.altM - curvDrop(tp.distKm);
            const px = xScale(tp.distKm);
            const py = yScale(adjAlt);
            const col = detectionTypeColor(tp.radarType);
            const hasPsr = PSR_TYPES.has(tp.radarType);
            return (
              <circle key={`tp-${i}`} cx={px} cy={py} r={1.5}
                fill={`rgb(${col[0]},${col[1]},${col[2]})`} fillOpacity={0.7}
                stroke={hasPsr ? "rgba(255,255,255,0.6)" : "none"}
                strokeWidth={hasPsr ? 1 : 0} />
            );
          })}
          {/* 소실표적 포인트 */}
          {lossPoints.map((lp, i) => {
            const adjAlt = lp.altM - curvDrop(lp.distKm);
            const px = xScale(lp.distKm);
            const py = yScale(adjAlt);
            return (
              <circle key={`lp-${i}`} cx={px} cy={py} r={2.5}
                fill={`rgb(${LOSS_COLOR[0]},${LOSS_COLOR[1]},${LOSS_COLOR[2]})`} fillOpacity={0.9}
                stroke={`rgba(${LOSS_COLOR[0]},${LOSS_COLOR[1]},${LOSS_COLOR[2]},0.5)`}
                strokeWidth={0.5} />
            );
          })}
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

/** 페이지당 차트 수 */
const CHARTS_PER_PAGE = 2;

function ReportOMLosCrossSection({ sectionNum, selectedBuildings, radarSites, losMap, omResult, hideHeader }: Props) {
  const entries = useMemo(() => {
    const result: { building: ManualBuilding; radar: RadarSite; los: LoSProfileData; trackPoints: ChartTrackPoint[]; lossPoints: ChartTrackPoint[] }[] = [];

    const lossPointsByRadar = new Map<string, LossPointGeo[]>();
    const trackPointsByRadar = new Map<string, TrackPointGeo[]>();
    if (omResult) {
      for (const rr of omResult.radar_results) {
        const allLoss: LossPointGeo[] = [];
        const allTrack: TrackPointGeo[] = [];
        for (const ds of rr.daily_stats) {
          for (const lp of ds.loss_points_summary) allLoss.push(lp);
          if (ds.track_points_geo) {
            for (const tp of ds.track_points_geo) allTrack.push(tp);
          }
        }
        lossPointsByRadar.set(rr.radar_name, allLoss);
        trackPointsByRadar.set(rr.radar_name, allTrack);
      }
    }

    for (const b of selectedBuildings) {
      for (const r of radarSites) {
        const los = losMap.get(`${r.name}_${b.id}`);
        if (!los || los.elevationProfile.length === 0) continue;

        const allTrack = trackPointsByRadar.get(r.name) ?? [];
        const allLoss = lossPointsByRadar.get(r.name) ?? [];
        const projected = projectPointsToLos(los, allTrack, allLoss, b);

        result.push({
          building: b, radar: r, los,
          trackPoints: projected.track,
          lossPoints: projected.loss,
        });
      }
    }
    return result;
  }, [selectedBuildings, radarSites, losMap, omResult]);

  if (entries.length === 0) return null;

  const pages: React.ReactNode[] = [];
  for (let offset = 0; offset < entries.length; offset += CHARTS_PER_PAGE) {
    const chunk = entries.slice(offset, offset + CHARTS_PER_PAGE);
    const isFirst = offset === 0;
    pages.push(
      <ReportPage key={`loscs-${offset}`}>
        <div className="mb-4">
          {isFirst && !hideHeader && (
            <ReportOMSectionHeader sectionNum={sectionNum} title="건물별 LoS 단면도" editId="losCross.title" />
          )}
          {!isFirst && (
            <div className="mb-2 text-[10px] text-gray-400">
              건물별 LoS 단면도 (계속 — {offset + 1}~{Math.min(offset + CHARTS_PER_PAGE, entries.length)}/{entries.length})
            </div>
          )}
          {chunk.map((e) => (
            <LosCrossSection
              key={`${e.radar.name}_${e.building.id}`}
              los={e.los}
              radarName={e.radar.name}
              building={e.building}
              trackPoints={e.trackPoints}
              lossPoints={e.lossPoints}
            />
          ))}
        </div>
      </ReportPage>
    );
  }

  return <>{pages}</>;
}

export default React.memo(ReportOMLosCrossSection);
