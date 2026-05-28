import React, { useMemo } from "react";
import type { ManualBuilding, RadarSite, LoSProfileData, ElevationPoint, BuildingOnPath } from "../../types";
import type { ObstacleMonthlyResult, LossPointGeo, TrackPointGeo } from "../../types/obstacle";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import ReportPage from "./ReportPage";
import { detectionTypeColor, PSR_TYPES } from "../../utils/radarConstants";

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

/** 디스플레이 프레임 곡률 보정량 (m): 실제 지구반경 기준
 *  → 직선 LoS 가 직선으로, 지형이 거리에 따라 아래로 처져 보임 */
function curvDrop(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EARTH_M);
}

// ── SVG 차트 상수 (TrackMap LoSProfilePanel 과 일치) ──
const W = 900;
const H = 280;
const PAD = { top: 20, right: 30, bottom: 30, left: 65 };
const cw = W - PAD.left - PAD.right;
const ch = H - PAD.top - PAD.bottom;
const M_TO_FT = 3.28084;
const KM_TO_NM = 1 / 1.852;

/** X축 최소 범위 (NM) — 빌딩이 가까워도 차트는 최소 이 거리까지 그린다.
 *  보고서 내 차트들의 X축 스케일을 통일해서 시각 비교를 쉽게 하기 위함. */
const MIN_X_NM = 100;

const LOSS_COLOR: [number, number, number] = [255, 23, 69]; // #ff1745

/** 프로파일 보간 */
function interpTerrainElev(profile: ElevationPoint[], d: number): number {
  if (profile.length === 0) return 0;
  if (d <= profile[0].distance) return profile[0].elevation;
  if (d >= profile[profile.length - 1].distance) return profile[profile.length - 1].elevation;
  for (let i = 1; i < profile.length; i++) {
    if (profile[i].distance >= d) {
      const denom = profile[i].distance - profile[i - 1].distance;
      const t = denom > 1e-9 ? (d - profile[i - 1].distance) / denom : 0;
      return profile[i - 1].elevation + t * (profile[i].elevation - profile[i - 1].elevation);
    }
  }
  return 0;
}

export interface ChartTrackPoint {
  distKm: number;
  altM: number; // 곡률 보정 전 AMSL
  radarType: string;
  isLoss: boolean;
}

/** 단일 LoS 단면도 SVG — TrackMap LoSProfilePanel 디자인을 보고서용으로 정적 변환.
 *
 *  TrackMap 과 동일한 시각 요소:
 *   - 단일 LoS 선 (running max angle, 통합 obstacle 배열)
 *   - 경로상 모든 빌딩: 도형은 사다리꼴(곡률 보정으로 양 끝 높이 다름), 점은 세로선
 *   - 빌딩 색상: 차폐 기여(빨강) / 비차단(회색) / 수동(주황)
 *   - 범례 좌상단 + 빌딩 카운트
 *   - 항적/소실표적은 SVG circles (PDF 캡처 호환)
 *
 *  보고서 한정 추가:
 *   - 타겟 빌딩(분석 대상)은 별도 마커 + ft 라벨로 명시
 */
export function LosCrossSection({
  los, radarName, building, trackPoints, lossPoints,
}: {
  los: LoSProfileData;
  radarName: string;
  building: ManualBuilding;
  trackPoints: ChartTrackPoint[];
  lossPoints: ChartTrackPoint[];
}) {
  const chartData = useMemo(() => {
    const profile = los.elevationProfile;
    if (profile.length === 0) return null;

    const radarHeight = los.radarHeight;
    const profileEnd = profile[profile.length - 1].distance;

    // 빌딩 좌표 — los.totalDistance/bearing 이 이미 빌딩 좌표 기준
    const bDistKm = los.totalDistance;
    const bTopElev = building.ground_elev + building.height;

    // X축은 최소 MIN_X_NM 보장 — 빌딩이 가까워도 차트 비교가 가능하도록.
    const maxDistance = Math.max(profileEnd, MIN_X_NM / KM_TO_NM);

    // 1) 조정 지형 (실제지구 곡률 보정)
    const adjTerrain = profile.map((p) => ({
      distance: p.distance,
      height: p.elevation - curvDrop(p.distance),
    }));

    // 1.5) 통합 장애물 배열: 지형 + 경로상 빌딩 + 타겟 빌딩
    //   TrackMap 방식 — building 을 정확한 위치의 독립 장애물로 처리.
    //   bDistKm 너머의 지형은 LoS 누적에서 제외 (빌딩 가시성은 빌딩까지의 지형에만 좌우).
    const pathBuildings = los.pathBuildings ?? [];
    interface Obstacle { distance: number; elevation: number; }
    const obstacles: Obstacle[] = [];
    for (const p of profile) {
      if (p.distance <= bDistKm + 1e-9) {
        obstacles.push({ distance: p.distance, elevation: p.elevation });
      }
    }
    for (const b of pathBuildings) {
      const nearD = b.near_dist_km ?? b.distance_km;
      const farD = b.far_dist_km ?? b.distance_km;
      const bTop = b.ground_elev_m + b.height_m;
      if (nearD <= bDistKm + 1e-9) {
        obstacles.push({ distance: nearD, elevation: bTop });
      }
      if (farD - nearD > 0.001 && farD <= bDistKm + 1e-9) {
        obstacles.push({ distance: farD, elevation: bTop });
      }
    }
    // 타겟 빌딩 — pathBuildings 에 동일 좌표 빌딩이 이미 있을 수도 있지만,
    //   사용자가 입력한 ManualBuilding 의 정확한 높이/위치를 보장하기 위해 항상 추가.
    obstacles.push({ distance: bDistKm, elevation: bTopElev });
    obstacles.sort((a, b) => a.distance - b.distance);

    // 건물 경계 — 쉐도잉 라인의 수직 전환 보장용
    interface BuildingEdge { nearD: number; farD: number; topElev: number; groundElev: number; }
    const buildingEdges: BuildingEdge[] = pathBuildings.map((b) => ({
      nearD: b.near_dist_km ?? b.distance_km,
      farD: b.far_dist_km ?? b.distance_km,
      topElev: b.ground_elev_m + b.height_m,
      groundElev: b.ground_elev_m,
    }));

    // 통합 샘플 거리 — 프로파일 포인트 + 건물 경계 (LoS 라인이 건물에서 수직으로 오르도록)
    const sampleDists: number[] = [];
    for (const p of profile) sampleDists.push(p.distance);
    const eps = 0.0005; // ~0.5m
    for (const be of buildingEdges) {
      if (be.nearD > eps) sampleDists.push(be.nearD - eps);
      sampleDists.push(be.nearD);
      if (be.farD - be.nearD > 0.001) {
        sampleDists.push(be.farD);
        sampleDists.push(be.farD + eps);
      } else {
        sampleDists.push(be.nearD + eps);
      }
    }
    // 타겟 빌딩 경계도 동일하게 추가
    if (bDistKm > eps) sampleDists.push(bDistKm - eps);
    sampleDists.push(bDistKm);
    sampleDists.push(bDistKm + eps);
    const uniqueDists = [...new Set(sampleDists)].sort((a, b) => a - b);

    // 유효 고도 — 지형 + 건물 포함 (특정 거리에서 가장 높은 장애물)
    const effectiveElevAt = (d: number): number => {
      let elev = interpTerrainElev(profile, d);
      for (const be of buildingEdges) {
        if (d >= be.nearD && d <= be.farD + 0.0001) {
          if (be.topElev > elev) elev = be.topElev;
        }
      }
      if (Math.abs(d - bDistKm) < 0.001 && bTopElev > elev) elev = bTopElev;
      return elev;
    };

    // 2) 직선 LoS (running max angle) — TrackMap minDetStraight 와 동일한 로직.
    //   bDistKm 까지만 maxAngle 누적; 그 너머는 마지막 각도로 외삽.
    let maxAngle = 0;
    let obIdx = 0;
    const losPath: { distance: number; height: number }[] = [];
    for (const d of uniqueDists) {
      if (d <= 0) {
        losPath.push({ distance: d, height: radarHeight });
        continue;
      }
      const dM = d * 1000;
      while (obIdx < obstacles.length && obstacles[obIdx].distance <= d + 1e-9) {
        const ob = obstacles[obIdx];
        if (ob.distance > 0 && ob.distance <= bDistKm + 1e-9) {
          const adjH = ob.elevation - curvDrop(ob.distance);
          const angle = (adjH - radarHeight) / (ob.distance * 1000);
          if (angle > maxAngle) maxAngle = angle;
        }
        obIdx++;
      }
      // 현재 지점의 유효 고도(건물 포함)도 앙각에 반영 (analysisEnd 이내)
      if (d <= bDistKm + 1e-9) {
        const elev = effectiveElevAt(d);
        const adjH = elev - curvDrop(d);
        const terrAngle = (adjH - radarHeight) / dM;
        if (terrAngle > maxAngle) maxAngle = terrAngle;
      }
      const losH = radarHeight + maxAngle * dM;
      losPath.push({ distance: d, height: losH });
    }

    // 3) 차폐 기여 빌딩 — TrackMap 방식: 지형만 shadow 보다 빌딩 꼭대기가 높으면 차폐 기여.
    //   타겟 빌딩은 별도 처리 (항상 마커로 표시되므로 significantBuildings 에서는 분리).
    type SigBuilding = BuildingOnPath & { isBlocking: boolean; isTarget: boolean };
    const significantBuildings: SigBuilding[] = [];
    const targetEpsDeg = 1e-4;
    let targetInPath = false;
    for (const b of pathBuildings) {
      const bDist = b.distance_km;
      if (bDist <= 0 || bDist > bDistKm + 0.01) continue;
      const bTop = b.ground_elev_m + b.height_m;
      const bAdj = bTop - curvDrop(bDist);

      // 지형만으로 생성된 shadow
      let terrainShadow = radarHeight;
      for (const p of profile) {
        if (p.distance <= 0 || p.distance >= bDist) continue;
        const adjH = p.elevation - curvDrop(p.distance);
        const shadow = radarHeight + (adjH - radarHeight) * (bDist / p.distance);
        if (shadow > terrainShadow) terrainShadow = shadow;
      }
      const isTarget =
        Math.abs(b.lat - building.latitude) < targetEpsDeg &&
        Math.abs(b.lon - building.longitude) < targetEpsDeg;
      if (isTarget) targetInPath = true;
      const isBlocking = bAdj > terrainShadow;
      if (isBlocking || isTarget) {
        significantBuildings.push({ ...b, isBlocking, isTarget });
      }
    }
    // 타겟 빌딩이 pathBuildings 에 없으면 사용자 입력 좌표/높이로 별도 추가.
    if (!targetInPath) {
      const bTop = bTopElev;
      const bAdj = bTop - curvDrop(bDistKm);
      let terrainShadow = radarHeight;
      for (const p of profile) {
        if (p.distance <= 0 || p.distance >= bDistKm) continue;
        const adjH = p.elevation - curvDrop(p.distance);
        const shadow = radarHeight + (adjH - radarHeight) * (bDistKm / p.distance);
        if (shadow > terrainShadow) terrainShadow = shadow;
      }
      significantBuildings.push({
        distance_km: bDistKm,
        near_dist_km: bDistKm,
        far_dist_km: bDistKm,
        height_m: building.height,
        ground_elev_m: building.ground_elev,
        total_height_m: bTopElev,
        name: building.name,
        address: null,
        usage: null,
        lat: building.latitude,
        lon: building.longitude,
        is_manual: true,
        isBlocking: bAdj > terrainShadow,
        isTarget: true,
      });
    }

    // 타겟 빌딩 차단 여부 (제목 chip 용)
    const blocked = significantBuildings.find((b) => b.isTarget)?.isBlocking ?? false;

    // 4) Y축 범위 — 빌딩 거리 + 20% 버퍼 안의 데이터만 사용 (TrackMap 와 동일한 의도).
    //   100NM 까지 확장된 profile 의 먼 지점은 curvDrop 이 수천 m 로 커서
    //   Y 범위를 잡으면 정작 빌딩 부근의 디테일이 압축돼 보이지 않게 됨.
    const yWindowEndKm = bDistKm * 1.2;
    const inYWindow = (d: number) => d <= yWindowEndKm;
    const allHeights: number[] = [radarHeight];
    for (const p of adjTerrain) if (inYWindow(p.distance)) allHeights.push(p.height);
    for (const p of losPath) if (inYWindow(p.distance)) allHeights.push(p.height);
    for (const b of significantBuildings) {
      allHeights.push((b.ground_elev_m + b.height_m) - curvDrop(b.distance_km));
    }
    let maxY = -Infinity;
    for (const h of allHeights) if (h > maxY) maxY = h;
    maxY += 100;
    let minY = 0;
    for (const p of adjTerrain) if (inYWindow(p.distance) && p.height < minY) minY = p.height;
    minY -= 50;
    if (minY < 0) {
      const minMaxYFor40Pct = -minY * 1.5;
      if (maxY < minMaxYFor40Pct) maxY = minMaxYFor40Pct;
    }

    return {
      adjTerrain, losPath, significantBuildings, blocked,
      bDistKm, bTopElev, minY, maxY, maxDistance, radarHeight,
    };
  }, [los, building]);

  if (!chartData) return null;

  const {
    adjTerrain, losPath, significantBuildings, blocked,
    bDistKm, bTopElev, minY, maxY, maxDistance, radarHeight,
  } = chartData;

  const xScale = (d: number) => PAD.left + (d / maxDistance) * cw;
  const yScale = (h: number) => PAD.top + ch - ((h - minY) / (maxY - minY)) * ch;

  // 지형 채우기
  const lastTerrainD = adjTerrain[adjTerrain.length - 1]?.distance ?? maxDistance;
  const terrainFill =
    `M ${xScale(0)} ${yScale(minY)} ` +
    adjTerrain.map((p) => `L ${xScale(p.distance)} ${yScale(p.height)}`).join(" ") +
    ` L ${xScale(lastTerrainD)} ${yScale(minY)} Z`;
  const terrainLine = adjTerrain
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
    .join(" ");

  // 직선 LoS (장애물 포함, 메인 — 주황 실선)
  const losPathD = losPath
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
    .join(" ");

  // Y축 눈금 (ft)
  const yRangeFt = (maxY - minY) * M_TO_FT;
  const yStepFt = yRangeFt > 30000 ? 5000 : yRangeFt > 15000 ? 2000 : yRangeFt > 5000 ? 1000 : yRangeFt > 2000 ? 500 : 200;
  const yTicks: number[] = [];
  const minYft = minY * M_TO_FT;
  const maxYft = maxY * M_TO_FT;
  for (let yf = Math.ceil(minYft / yStepFt) * yStepFt; yf <= maxYft; yf += yStepFt) yTicks.push(yf / M_TO_FT);

  // X축 눈금 (NM)
  const maxDistNm = maxDistance * KM_TO_NM;
  const xStepNm = maxDistNm > 80 ? 20 : maxDistNm > 40 ? 10 : maxDistNm > 15 ? 5 : maxDistNm > 5 ? 2 : maxDistNm > 2 ? 1 : 0.5;
  const xTicks: number[] = [];
  for (let xn = xStepNm; xn <= maxDistNm; xn += xStepNm) xTicks.push(xn / KM_TO_NM);
  const xTickDecimals = xStepNm < 1 ? 1 : 0;

  // 타겟 빌딩 마커 정보 (꼭대기 동그라미만 사용 — 본체는 significantBuildings 에서 그려짐)
  const bTopAdj = bTopElev - curvDrop(bDistKm);
  const buildingName = building.name || `건물 ${building.id}`;
  const bDistNm = bDistKm * KM_TO_NM;

  // 빌딩 카운트 (범례용)
  const blockingCount = significantBuildings.filter((b) => b.isBlocking && !b.isTarget).length;
  const nonBlockingCount = significantBuildings.filter((b) => !b.isBlocking && !b.isTarget).length;
  const manualCount = significantBuildings.filter((b) => b.is_manual && !b.isTarget).length;
  const legendH = 66 + 14 // 타겟 빌딩 항목 (항상 표시)
    + (blockingCount > 0 ? 14 : 0)
    + (nonBlockingCount > 0 ? 14 : 0)
    + (manualCount > 0 ? 14 : 0)
    + 14 // 항적
    + 14; // 소실표적

  return (
    <div className="mb-3">
      {/* 제목 */}
      <div className="mb-1 flex items-center gap-2">
        <span className="text-[13px] font-bold text-gray-800">{buildingName}</span>
        <span className="text-[11px] text-gray-500">
          {radarName} → 방위 {los.bearing.toFixed(1)}° / 거리 {bDistNm.toFixed(1)}NM ({bDistKm.toFixed(1)}km)
          / 높이 {Math.round(bTopElev * M_TO_FT).toLocaleString()}ft ({bTopElev.toFixed(0)}m)
        </span>
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium ${
          blocked ? "bg-red-50 text-red-600" : "bg-green-50 text-green-600"
        }`}>
          {blocked ? "차단" : "양호"}
        </span>
      </div>

      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 230 }}>
        <defs>
          <linearGradient id={`tg-${los.id}-${building.id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#22c55e" stopOpacity="0.5" />
            <stop offset="100%" stopColor="#22c55e" stopOpacity="0.05" />
          </linearGradient>
          <clipPath id={`cc-${los.id}-${building.id}`}>
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
        {/* X축 라벨 (클립 밖) */}
        {xTicks.map((x) => (
          <text key={`xl-${x.toFixed(3)}`} x={xScale(x)} y={H - PAD.bottom + 14} textAnchor="middle"
            fill="#6b7280" fontSize={9}>
            {(x * KM_TO_NM).toFixed(xTickDecimals)}NM
          </text>
        ))}

        <g clipPath={`url(#cc-${los.id}-${building.id})`}>
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

          {/* 지형 */}
          <path d={terrainFill} fill={`url(#tg-${los.id}-${building.id})`} />
          <path d={terrainLine} fill="none" stroke="#22c55e" strokeWidth={1.5} />

          {/* 건물 실루엣 — TrackMap 방식: 도형 빌딩은 사다리꼴, 점 빌딩은 세로선.
              isTarget: 분석 대상 (밝은 주황 + 굵은 윤곽)
              isBlocking: 차폐 기여 (빨강)
              is_manual: 수동 등록 (주황)
              그 외: 비차단 (회색) */}
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

            // 색상 결정 — TrackMap 과 동일한 우선순위
            let baseColor: string;
            let fillColor: string;
            let strokeW: number;
            if (b.isTarget) {
              baseColor = "#f97316"; // 분석 대상 — 주황 (밝은)
              fillColor = "rgba(249,115,22,0.25)";
              strokeW = 2;
            } else if (b.isBlocking) {
              baseColor = "rgba(239, 68, 68, 0.8)"; // 빨강
              fillColor = "rgba(239,68,68,0.15)";
              strokeW = 1;
            } else if (b.is_manual) {
              baseColor = "#f97316"; // 수동 — 주황
              fillColor = "rgba(249,115,22,0.15)";
              strokeW = 1;
            } else {
              baseColor = "rgba(148, 163, 184, 0.5)"; // 비차단 — 회색
              fillColor = "rgba(148,163,184,0.08)";
              strokeW = 1;
            }

            if (hasExtent) {
              // 도형 건물: 채워진 사다리꼴 (곡률 보정으로 양쪽 높이 다름)
              const pathD = `M ${bxNear} ${byBottomNear} L ${bxNear} ${byTopNear} L ${bxFar} ${byTopFar} L ${bxFar} ${byBottomFar} Z`;
              return (
                <path key={`bld-${bi}`} d={pathD} fill={fillColor} stroke={baseColor}
                  strokeWidth={strokeW} />
              );
            }
            // 점 건물: 세로선
            return (
              <line key={`bld-${bi}`}
                x1={bxNear} y1={byBottomNear}
                x2={bxNear} y2={byTopNear}
                stroke={baseColor} strokeWidth={b.isTarget ? 2.5 : 1.5} />
            );
          })}

          {/* 직선 LoS (장애물 포함, 메인 주황 실선) */}
          <path d={losPathD} fill="none"
            stroke="#f59e0b" strokeWidth={1.8} />

          {/* 타겟 빌딩 마커 — 분석 대상임을 명시 (꼭대기 동그라미 + ft 라벨) */}
          <circle
            cx={xScale(bDistKm)}
            cy={yScale(bTopAdj)}
            r={4}
            fill="#f97316" stroke="white" strokeWidth={1} />
          <text
            x={xScale(bDistKm)}
            y={yScale(bTopAdj) - 8}
            textAnchor="middle" fill="#374151" fontSize={8} fontWeight="bold">
            {Math.round(bTopElev * M_TO_FT).toLocaleString()}ft
          </text>

          {/* 항적 포인트 (일반) */}
          {trackPoints.map((tp, i) => {
            const adjAlt = tp.altM - curvDrop(tp.distKm);
            const px = xScale(tp.distKm);
            const py = yScale(adjAlt);
            const col = detectionTypeColor(tp.radarType);
            const hasPsr = PSR_TYPES.has(tp.radarType);
            return (
              <circle
                key={`tp-${i}`}
                cx={px}
                cy={py}
                r={1.2}
                fill={`rgb(${col[0]},${col[1]},${col[2]})`}
                fillOpacity={0.6}
                stroke={hasPsr ? "rgba(255,255,255,0.5)" : "none"}
                strokeWidth={hasPsr ? 0.5 : 0}
              />
            );
          })}
          {/* 소실표적 포인트 (Loss — 일반 항적 위에 표시) */}
          {lossPoints.map((lp, i) => {
            const adjAlt = lp.altM - curvDrop(lp.distKm);
            const px = xScale(lp.distKm);
            const py = yScale(adjAlt);
            return (
              <circle
                key={`lp-${i}`}
                cx={px}
                cy={py}
                r={2}
                fill={`rgb(${LOSS_COLOR[0]},${LOSS_COLOR[1]},${LOSS_COLOR[2]})`}
                fillOpacity={0.85}
                stroke={`rgba(${LOSS_COLOR[0]},${LOSS_COLOR[1]},${LOSS_COLOR[2]},0.4)`}
                strokeWidth={0.5}
              />
            );
          })}

          {/* 레이더 위치 라벨 */}
          <text x={xScale(0) + 4} y={PAD.top + 12}
            fill="#6b7280" fontSize={8}>
            {radarName} ({Math.round(radarHeight * M_TO_FT).toLocaleString()}ft)
          </text>
        </g>

        {/* 범례 (좌상단 — TrackMap 방식) */}
        <g transform={`translate(${PAD.left + 8}, ${PAD.top + 5})`}>
          <rect x={-4} y={-6} width={270} height={legendH} rx={4}
            fill="rgba(255,255,255,0.9)" stroke="rgba(0,0,0,0.1)" strokeWidth={0.5} />
          {/* LoS 선 */}
          <line x1={0} y1={0} x2={20} y2={0}
            stroke="#f59e0b" strokeWidth={1.8} />
          <text x={24} y={3} fill="#374151" fontSize={8}>
            직선 LoS (장애물 포함)
          </text>
          {/* 지형 */}
          <line x1={0} y1={14} x2={20} y2={14} stroke="#22c55e" strokeWidth={1.5} />
          <text x={24} y={17} fill="#374151" fontSize={8}>
            지형 (지구곡률 보정)
          </text>
          {/* 타겟 빌딩 */}
          <rect x={2} y={28 - 4} width={16} height={8} fill="rgba(249,115,22,0.25)" stroke="#f97316" strokeWidth={2} />
          <text x={24} y={31} fill="#374151" fontSize={8}>
            분석 대상 ({buildingName})
          </text>
          {/* 빌딩 카운트 (조건부) */}
          {(() => {
            let legendY = 42;
            const items: React.ReactNode[] = [];
            if (blockingCount > 0) {
              items.push(
                <g key="leg-blk">
                  <rect x={2} y={legendY - 4} width={16} height={8} fill="rgba(239,68,68,0.15)" stroke="rgba(239,68,68,0.8)" strokeWidth={0.5} />
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
                  <rect x={2} y={legendY - 4} width={16} height={8} fill="rgba(148,163,184,0.08)" stroke="rgba(148,163,184,0.5)" strokeWidth={0.5} />
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
                  <rect x={2} y={legendY - 4} width={16} height={8} fill="rgba(249,115,22,0.15)" stroke="#f97316" strokeWidth={0.5} />
                  <text x={24} y={legendY + 3} fill="#374151" fontSize={8}>
                    수동 등록 건물 ({manualCount}동)
                  </text>
                </g>,
              );
              legendY += 14;
            }
            // 항적/소실표적
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
                  fill={`rgb(${LOSS_COLOR[0]},${LOSS_COLOR[1]},${LOSS_COLOR[2]})`} fillOpacity={0.85} />
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
 * 레이더→빌딩 직선상 항적/소실표적 투영 — TrackMap LoSProfilePanel 의 `losTrackPoints` 와 동일.
 *
 * 절대 수직거리 1km 이내 + along ∈ (0, 빌딩거리] 만 채택.
 * (이전엔 ±5° 베어링 필터를 썼는데, 빌딩이 1.4NM 처럼 가까우면 ±5° 가 거의 전방향이라
 *  0NM 근처에 점이 검은 막대처럼 뭉치는 문제가 있었다 — TrackMap 방식으로 통일.)
 */
export function projectPointsToLos(
  los: LoSProfileData,
  trackPoints: TrackPointGeo[],
  lossPoints: LossPointGeo[],
): { track: ChartTrackPoint[]; loss: ChartTrackPoint[] } {
  const DEG2RAD = Math.PI / 180;
  const cosLat = Math.cos(los.radarLat * DEG2RAD);
  const mPerDegLat = DEG2RAD * R_EARTH_M;
  const mPerDegLon = DEG2RAD * R_EARTH_M * cosLat;
  const lineDxM = (los.targetLat - los.radarLat) * mPerDegLat;
  const lineDyM = (los.targetLon - los.radarLon) * mPerDegLon;
  const lineLen = Math.sqrt(lineDxM * lineDxM + lineDyM * lineDyM);
  if (lineLen < 1e-6) return { track: [], loss: [] };
  const cosB = lineDxM / lineLen;
  const sinB = lineDyM / lineLen;
  const TOLERANCE_M = 1000;

  const track: ChartTrackPoint[] = [];
  for (const tp of trackPoints) {
    const dx = (tp.lat - los.radarLat) * mPerDegLat;
    const dy = (tp.lon - los.radarLon) * mPerDegLon;
    const along = dx * cosB + dy * sinB;
    const across = Math.abs(-dx * sinB + dy * cosB);
    if (across >= TOLERANCE_M) continue;
    if (along <= 0 || along > lineLen) continue;
    track.push({
      distKm: along / 1000,
      altM: tp.alt_ft / M_TO_FT,
      radarType: tp.radar_type,
      isLoss: false,
    });
  }
  const loss: ChartTrackPoint[] = [];
  for (const lp of lossPoints) {
    const dx = (lp.lat - los.radarLat) * mPerDegLat;
    const dy = (lp.lon - los.radarLon) * mPerDegLon;
    const along = dx * cosB + dy * sinB;
    const across = Math.abs(-dx * sinB + dy * cosB);
    if (across >= TOLERANCE_M) continue;
    if (along <= 0 || along > lineLen) continue;
    loss.push({
      distKm: along / 1000,
      altM: lp.alt_ft / M_TO_FT,
      radarType: "",
      isLoss: true,
    });
  }
  return { track, loss };
}

/** 페이지당 차트 수 (각 차트 ≈ 80mm) */
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
        const projected = projectPointsToLos(los, allTrack, allLoss);

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

  // 페이지 분할
  const pages: React.ReactNode[] = [];
  for (let offset = 0; offset < entries.length; offset += CHARTS_PER_PAGE) {
    const chunk = entries.slice(offset, offset + CHARTS_PER_PAGE);
    const isFirst = offset === 0;
    pages.push(
      <ReportPage key={`loscs-${offset}`}>
        <div className="mb-4">
          {isFirst && !hideHeader && (
            <ReportOMSectionHeader sectionNum={sectionNum} title="건물별 LoS 단면도" />
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
