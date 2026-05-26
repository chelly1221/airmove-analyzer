import React, { useMemo } from "react";
import type { ManualBuilding, RadarSite, LoSProfileData, ElevationPoint } from "../../types";
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

// ── SVG 차트 상수 ──
const W = 900;
const H = 280;
const PAD = { top: 20, right: 30, bottom: 30, left: 65 };
const cw = W - PAD.left - PAD.right;
const ch = H - PAD.top - PAD.bottom;
const M_TO_FT = 3.28084;
const KM_TO_NM = 1 / 1.852;

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

/**
 * 직선 LoS (Running Max Angle) — 실제 지구 곡률 프레임.
 *
 * 핵심: maxAngle 의 바닥은 0(레이더 안테나의 0° 라디오 호라이즌)이다.
 *   레이더보다 낮은 지형은 가시성을 막지 않으므로 LoS 선을 끌어내리면 안 된다.
 *
 * 선택적으로 건물 장애물을 추가해 "장애물 포함" LoS 산출.
 */
function computeStraightLoS(
  profile: ElevationPoint[],
  radarHeight: number,
  buildingObstacle?: { distanceKm: number; topElevM: number },
) {
  const sampleDists = profile.map((p) => p.distance);
  if (buildingObstacle) sampleDists.push(buildingObstacle.distanceKm);
  const uniqueDists = [...new Set(sampleDists)].sort((a, b) => a - b);

  const effectiveElevAt = (d: number): number => {
    let elev = interpTerrainElev(profile, d);
    if (buildingObstacle) {
      if (Math.abs(d - buildingObstacle.distanceKm) < 0.05) {
        elev = Math.max(elev, buildingObstacle.topElevM);
      }
    }
    return elev;
  };

  let maxAngle = 0;
  const result: { distance: number; height: number }[] = [];
  for (const d of uniqueDists) {
    if (d <= 0) {
      result.push({ distance: d, height: radarHeight });
      continue;
    }
    const dM = d * 1000;
    const elev = effectiveElevAt(d);
    const adjH = elev - curvDrop(d);
    const angle = (adjH - radarHeight) / dM;
    if (angle > maxAngle) maxAngle = angle;
    const losH = radarHeight + maxAngle * dM;
    result.push({ distance: d, height: losH });
  }
  return result;
}

export interface ChartTrackPoint {
  distKm: number;
  altM: number; // 곡률 보정 전 AMSL
  radarType: string;
  isLoss: boolean;
}

/** 단일 LoS 단면도 SVG — 결합 페이지(빌딩별)에서도 import 하여 재사용 */
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
    // X축은 프로파일 끝(= 레이더↔빌딩 거리)까지. TrackMap 과 동일하게 외삽 없음.
    const maxDistance = profileEnd;

    // 조정 지형 (실제지구 곡률 보정)
    const adjTerrain = profile.map((p) => ({
      distance: p.distance,
      height: p.elevation - curvDrop(p.distance),
    }));

    // 빌딩 좌표 — los.totalDistance/bearing 이 이미 빌딩 좌표 기준
    const bDistKm = los.totalDistance;
    const bTopElev = building.ground_elev + building.height;

    // 직선 LoS — 장애물 미포함 (지형만, 회색 점선 참고용)
    const losWithout = computeStraightLoS(profile, radarHeight, undefined);

    // 직선 LoS — 장애물 포함 (메인, 주황 실선)
    const losWith = computeStraightLoS(profile, radarHeight, {
      distanceKm: bDistKm,
      topElevM: bTopElev,
    });

    // 차단 판정 — 빌딩 위치에서 "장애물 미포함 LoS" 보다 빌딩 꼭대기가 높으면 차단.
    //   (장애물 포함 LoS 는 정의상 빌딩을 항상 통과하므로 비교 대상이 아님)
    const bAdj = bTopElev - curvDrop(bDistKm);
    let blocked = false;
    for (const pt of losWithout) {
      if (Math.abs(pt.distance - bDistKm) < 0.1 || pt.distance >= bDistKm) {
        if (bAdj > pt.height + 1) blocked = true;
        break;
      }
    }

    // Y축 범위
    const allHeights = [
      radarHeight,
      ...adjTerrain.map((p) => p.height),
      ...losWithout.map((p) => p.height),
      ...losWith.map((p) => p.height),
    ];
    let maxY = -Infinity;
    for (const h of allHeights) if (h > maxY) maxY = h;
    maxY += 100;
    let minY = 0;
    for (const p of adjTerrain) if (p.height < minY) minY = p.height;
    minY -= 50;
    // 0ft 가 차트 40% 이상으로 오지 않도록 maxY 보장
    if (minY < 0) {
      const minMaxYFor40Pct = -minY * 1.5;
      if (maxY < minMaxYFor40Pct) maxY = minMaxYFor40Pct;
    }

    return { adjTerrain, losWithout, losWith, blocked, bDistKm, bTopElev, minY, maxY, maxDistance, radarHeight };
  }, [los, building]);

  if (!chartData) return null;

  const { adjTerrain, losWithout, losWith, blocked, bDistKm, bTopElev,
          minY, maxY, maxDistance, radarHeight } = chartData;

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

  // 직선 LoS (장애물 미포함, 회색 점선)
  const losWithoutPath = losWithout
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
    .join(" ");

  // 직선 LoS (장애물 포함, 주황 실선)
  const losWithPath = losWith
    .map((p, i) => `${i === 0 ? "M" : "L"} ${xScale(p.distance)} ${yScale(p.height)}`)
    .join(" ");

  // Y축 눈금
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

  // 건물 표시 데이터
  const bGroundAdj = building.ground_elev - curvDrop(bDistKm);
  const bTopAdj = bTopElev - curvDrop(bDistKm);

  const buildingName = building.name || `건물 ${building.id}`;
  const bDistNm = bDistKm * KM_TO_NM;

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

        {/* Y축 라벨 */}
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

          {/* 건물 실루엣 (세로선) */}
          {bTopAdj > bGroundAdj && (
            <line
              x1={xScale(bDistKm)} y1={yScale(bGroundAdj)}
              x2={xScale(bDistKm)} y2={yScale(bTopAdj)}
              stroke="#f97316" strokeWidth={2.5}
            />
          )}

          {/* 직선 LoS — 장애물 미포함 (회색 점선, 참고) */}
          <path d={losWithoutPath} fill="none"
            stroke="rgba(107,114,128,0.6)" strokeWidth={1.4} strokeDasharray="5 3" />

          {/* 직선 LoS — 장애물 포함 (주황 실선, 메인) */}
          <path d={losWithPath} fill="none"
            stroke="#f59e0b" strokeWidth={1.8} />

          {/* 건물 위치 마커 */}
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

        {/* 범례 (우측 상단) */}
        <g transform={`translate(${W - PAD.right - 230}, ${PAD.top + 5})`}>
          <rect x={-4} y={-6} width={228} height={86} rx={4} fill="rgba(255,255,255,0.9)" stroke="rgba(0,0,0,0.1)" strokeWidth={0.5} />
          <line x1={0} y1={0} x2={20} y2={0}
            stroke="#f59e0b" strokeWidth={1.8} />
          <text x={24} y={3} fill="#374151" fontSize={8}>
            직선 LoS (장애물 포함)
          </text>
          <line x1={0} y1={14} x2={20} y2={14}
            stroke="rgba(107,114,128,0.6)" strokeWidth={1.4} strokeDasharray="5 3" />
          <text x={24} y={17} fill="#374151" fontSize={8}>
            직선 LoS (장애물 미포함)
          </text>
          <line x1={0} y1={28} x2={20} y2={28} stroke="#22c55e" strokeWidth={1.5} />
          <text x={24} y={31} fill="#374151" fontSize={8}>
            지형 (지구곡률 보정)
          </text>
          <line x1={0} y1={42} x2={20} y2={42} stroke="#f97316" strokeWidth={2.5} />
          <text x={24} y={45} fill="#374151" fontSize={8}>
            건물 ({buildingName})
          </text>
          <circle cx={7} cy={56} r={1.5} fill="rgb(34,197,94)" fillOpacity={0.7} />
          <text x={24} y={59} fill="#374151" fontSize={8}>
            항적 ({trackPoints.length.toLocaleString()}건)
          </text>
          <circle cx={7} cy={70} r={2.5} fill={`rgb(${LOSS_COLOR[0]},${LOSS_COLOR[1]},${LOSS_COLOR[2]})`} fillOpacity={0.85} />
          <text x={24} y={73} fill="#374151" fontSize={8}>
            소실표적 ({lossPoints.length.toLocaleString()}건)
          </text>
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
