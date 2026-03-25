import React, { useMemo } from "react";
import type { RadarMonthlyResult, ManualBuilding, RadarSite, LoSProfileData, PanoramaPoint } from "../../types";

interface Props {
  sectionNum: number;
  radarResults: RadarMonthlyResult[];
  selectedBuildings: ManualBuilding[];
  radarSites: RadarSite[];
  losMap: Map<string, LoSProfileData>;
  panoWithTargets?: Map<string, PanoramaPoint[]>;
  panoWithoutTargets?: Map<string, PanoramaPoint[]>;
}

const R_EARTH = 6_371_000; // 실제 지구반경 (m)
const FT_PER_M = 3.28084;
const KM_PER_NM = 1.852;
const AZ_TOLERANCE = 10; // 방위 허용 오차 (°)

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const y = Math.sin((lon2 - lon1) * toRad) * Math.cos(lat2 * toRad);
  const x = Math.cos(lat1 * toRad) * Math.sin(lat2 * toRad) -
    Math.sin(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.cos((lon2 - lon1) * toRad);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

/** elevationProfile에서 running max angle 추출 (지형+건물 통합)
 *  cutoffDistKm 이전까지만 계산 (건물 전/후 분리 가능) */
function runningMaxAngle(
  profile: { distance: number; elevation: number }[],
  radarHeight: number,
  cutoffDistKm?: number,
): number {
  let maxAngle = -Infinity;
  for (const pt of profile) {
    if (pt.distance <= 0) continue;
    if (cutoffDistKm !== undefined && pt.distance > cutoffDistKm) break;
    const dM = pt.distance * 1000;
    const curvDrop = (dM * dM) / (2 * R_EARTH);
    const adjH = pt.elevation - curvDrop;
    const angle = (adjH - radarHeight) / dM;
    if (angle > maxAngle) maxAngle = angle;
  }
  return maxAngle === -Infinity ? 0 : maxAngle;
}

/** 실제 지구 구면 양각 (°) — 레이더에서 목표점까지의 기하학적 양각 */
function calcElevAngleDeg(radarH: number, targetAltM: number, distM: number): number {
  if (distM <= 0) return 0;
  const curvDrop = (distM * distM) / (2 * R_EARTH);
  return Math.atan((targetAltM - curvDrop - radarH) / distM) * 180 / Math.PI;
}

/** running max angle (tan값) → 도 변환 */
function angleToDeg(tanAngle: number): number {
  return Math.atan(tanAngle) * 180 / Math.PI;
}

interface ClassifiedLoss {
  azDeg: number;
  elevAngleDeg: number;
  distKm: number;
  altFt: number;
  durationS: number;
  inShadow: boolean;
  buildingCaused: boolean;
  buildingName: string;
}

interface BuildingInfo {
  id: number;
  name: string;
  distKm: number;
  azDeg: number;
  topM: number;
  angleTotalDeg: number;
  angleTerrainDeg: number;
  angleTotal: number;
  angleTerrain: number;
}

const CHART_W = 720;
const CHART_H = 340;
const MARGIN = { top: 24, right: 20, bottom: 48, left: 50 };
const INNER_W = CHART_W - MARGIN.left - MARGIN.right;
const INNER_H = CHART_H - MARGIN.top - MARGIN.bottom;

const COMPASS_DIRS: Record<number, string> = {
  0: "N", 45: "NE", 90: "E", 135: "SE",
  180: "S", 225: "SW", 270: "W", 315: "NW",
};

function ReportOMAltitudeDistribution({
  sectionNum,
  radarResults,
  selectedBuildings,
  radarSites,
  losMap,
  panoWithTargets,
  panoWithoutTargets,
}: Props) {
  const radarAnalysis = useMemo(() => {
    return radarResults.map((rr) => {
      const rs = radarSites.find((r) => r.name === rr.radar_name);
      if (!rs) return { radarName: rr.radar_name, losses: [] as ClassifiedLoss[], buildings: [] as BuildingInfo[], radarSite: null as RadarSite | null };

      const radarH = rs.altitude + rs.antenna_height;

      // 건물별 정보 + losMap 프로파일에서 angle 추출
      const bldgInfo: BuildingInfo[] = selectedBuildings.map((b) => {
        const topM = (b.ground_elev || 0) + b.height;
        const distKm = haversineKm(rs.latitude, rs.longitude, b.latitude, b.longitude);
        const key = `${rs.name}_${b.id}`;
        const los = losMap.get(key);

        let angleTotal = 0;
        let angleTerrain = 0;
        if (los && los.elevationProfile.length > 0) {
          angleTotal = runningMaxAngle(los.elevationProfile, radarH);
          angleTerrain = runningMaxAngle(los.elevationProfile, radarH, distKm);
        } else {
          const dM = distKm * 1000;
          const curvDrop = (dM * dM) / (2 * R_EARTH);
          angleTotal = (topM - curvDrop - radarH) / dM;
          angleTerrain = 0;
        }

        return {
          id: b.id,
          name: b.name || `건물${b.id}`,
          distKm,
          azDeg: bearingDeg(rs.latitude, rs.longitude, b.latitude, b.longitude),
          topM,
          angleTotalDeg: angleToDeg(angleTotal),
          angleTerrainDeg: angleToDeg(angleTerrain),
          angleTotal,
          angleTerrain,
        };
      });

      // 소실표적 분류 — 양각 기반 (altitude 비교와 수학적 등가)
      const allLoss = rr.daily_stats.flatMap((d) => d.loss_points_summary);
      const classified: ClassifiedLoss[] = [];

      for (const lp of allLoss) {
        const lpDistKm = haversineKm(rs.latitude, rs.longitude, lp.lat, lp.lon);
        const lpAz = bearingDeg(rs.latitude, rs.longitude, lp.lat, lp.lon);
        const lpAltM = lp.alt_ft / FT_PER_M;
        const lpDistM = lpDistKm * 1000;
        const lpElevDeg = calcElevAngleDeg(radarH, lpAltM, lpDistM);

        // 가장 가까운 방위의 건물
        let bestBldg: BuildingInfo | undefined = bldgInfo[0];
        let bestAzDiff = 360;
        for (const b of bldgInfo) {
          let azDiff = Math.abs(lpAz - b.azDeg);
          if (azDiff > 180) azDiff = 360 - azDiff;
          if (azDiff < bestAzDiff) { bestAzDiff = azDiff; bestBldg = b; }
        }

        let inShadow = false;
        let buildingCaused = false;

        if (bestBldg && bestAzDiff <= AZ_TOLERANCE && lpDistKm > bestBldg.distKm && bestBldg.distKm > 0.01) {
          // 양각이 차단각보다 낮으면 shadow 내
          inShadow = lpElevDeg < bestBldg.angleTotalDeg;
          if (inShadow) {
            // 지형 차단각 이상이면 건물 추가 기인
            buildingCaused = lpElevDeg >= bestBldg.angleTerrainDeg;
          }
        }

        classified.push({
          azDeg: lpAz,
          elevAngleDeg: lpElevDeg,
          distKm: lpDistKm,
          altFt: lp.alt_ft,
          durationS: lp.duration_s,
          inShadow,
          buildingCaused,
          buildingName: bestBldg?.name || "",
        });
      }

      return { radarName: rr.radar_name, losses: classified, buildings: bldgInfo, radarSite: rs };
    });
  }, [radarResults, radarSites, selectedBuildings, losMap]);

  if (radarAnalysis.every((r) => r.losses.length === 0)) return null;

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. LoS 차단 양각 대비 표적소실 분포
      </h2>

      {radarAnalysis.map(({ radarName, losses, buildings, radarSite: _rs }, rIdx) => {
        if (losses.length === 0) {
          return (
            <div key={radarName} className="mb-5">
              <h3 className="mb-2 text-[15px] font-semibold text-gray-700">{radarName}</h3>
              <p className="text-[12px] text-gray-400">표적소실 데이터 없음</p>
            </div>
          );
        }

        const inShadowCount = losses.filter((l) => l.inShadow).length;
        const bldgCausedCount = losses.filter((l) => l.buildingCaused).length;
        const totalCount = losses.length;
        const shadowRatio = totalCount > 0 ? (inShadowCount / totalCount) * 100 : 0;
        const bldgCausedRatio = totalCount > 0 ? (bldgCausedCount / totalCount) * 100 : 0;
        const bldgCausedDuration = losses.filter((l) => l.buildingCaused).reduce((s, l) => s + l.durationS, 0);

        // 파노라마 데이터 (분석 대상 포함/미포함)
        const panoWith = panoWithTargets?.get(radarName) ?? [];
        const panoWithout = panoWithoutTargets?.get(radarName) ?? [];

        // Y축 범위: 파노라마 최대 양각 1° 올림 (상한), 차단 내 소실표적 최소 양각 1° 내림 (하한)
        let panoMax = 0;
        for (const p of panoWith) { if (p.elevation_angle_deg > panoMax) panoMax = p.elevation_angle_deg; }
        const inShadowLosses = losses.filter((l) => l.inShadow);
        let minElevDeg = 0;
        for (const l of inShadowLosses) { if (l.elevAngleDeg < minElevDeg) minElevDeg = l.elevAngleDeg; }
        const yTop = Math.max(1, Math.ceil(panoMax));
        const yBottom = Math.min(0, Math.floor(minElevDeg));
        const maxAngle = yTop;
        const minAngle = yBottom;

        // X축: 건물 또는 소실표적 방위 중심으로 포커싱
        const AZ_PAD = 20;
        let azCenter = 180, azHalfSpan = 180;
        // 포커싱 대상: 건물 우선, 없으면 소실표적 방위 사용
        const focusAzimuths: number[] = buildings.length > 0
          ? buildings.map((b) => b.azDeg)
          : losses.map((l) => l.azDeg);
        if (focusAzimuths.length > 0) {
          const toRad = Math.PI / 180;
          const sumS = focusAzimuths.reduce((s, az) => s + Math.sin(az * toRad), 0);
          const sumC = focusAzimuths.reduce((s, az) => s + Math.cos(az * toRad), 0);
          azCenter = (Math.atan2(sumS, sumC) / toRad + 360) % 360;
          let maxDist = 0;
          for (const az of focusAzimuths) {
            let d = az - azCenter;
            if (d > 180) d -= 360;
            if (d < -180) d += 360;
            const ext = Math.abs(d) + (buildings.length > 0 ? AZ_TOLERANCE : 0);
            if (ext > maxDist) maxDist = ext;
          }
          azHalfSpan = Math.min(maxDist + AZ_PAD, 180);
        }
        const azSpan = azHalfSpan * 2;

        const xScale = (az: number) => {
          let rel = az - azCenter;
          if (rel > 180) rel -= 360;
          if (rel < -180) rel += 360;
          return MARGIN.left + ((rel + azHalfSpan) / azSpan) * INNER_W;
        };
        const yRange = maxAngle - minAngle;
        const yScale = (a: number) => MARGIN.top + INNER_H - ((a - minAngle) / yRange) * INNER_H;

        // X축 눈금
        const azTickStep = azSpan > 120 ? 30 : azSpan > 60 ? 15 : azSpan > 30 ? 10 : 5;
        const azRawStart = azCenter - azHalfSpan;
        const azRawEnd = azCenter + azHalfSpan;
        const firstAzTick = Math.ceil(azRawStart / azTickStep) * azTickStep;
        const xTicks: number[] = [];
        for (let v = firstAzTick; v <= azRawEnd + 0.001; v += azTickStep) xTicks.push(v);

        // Y축 눈금
        const yStep = yRange > 5 ? 1 : yRange > 2 ? 0.5 : yRange > 1 ? 0.2 : 0.1;
        const yTicks: number[] = [];
        const firstYTick = Math.ceil(minAngle / yStep) * yStep;
        for (let v = firstYTick; v <= maxAngle + 0.001; v += yStep) yTicks.push(Math.round(v * 100) / 100);

        return (
          <div key={radarName} className="mb-6">
            <h3 className="mb-2 text-[15px] font-semibold text-gray-700">{radarName}</h3>

            <svg viewBox={`0 0 ${CHART_W} ${CHART_H}`} className="w-full block">
              <defs>
                <clipPath id={`az-elev-clip-${rIdx}`}>
                  <rect x={MARGIN.left} y={MARGIN.top} width={INNER_W} height={INNER_H} />
                </clipPath>
              </defs>
              <rect x={MARGIN.left} y={MARGIN.top} width={INNER_W} height={INNER_H}
                fill="#fafafa" stroke="#e5e7eb" strokeWidth={0.5} />

              {/* 그리드 — 방위 (분석 범위) */}
              {xTicks.map((rawDeg) => {
                const dispDeg = ((rawDeg % 360) + 360) % 360;
                const compass = COMPASS_DIRS[Math.round(dispDeg)];
                return (
                  <g key={`x-${rawDeg}`}>
                    <line x1={xScale(dispDeg)} y1={MARGIN.top} x2={xScale(dispDeg)} y2={MARGIN.top + INNER_H}
                      stroke="#e5e7eb" strokeWidth={compass ? 0.8 : 0.4} strokeDasharray="2,2" />
                    <text x={xScale(dispDeg)} y={CHART_H - MARGIN.bottom + 13} textAnchor="middle"
                      fontSize={9} fill="#374151">
                      {dispDeg.toFixed(0)}°
                    </text>
                    {compass && (
                      <text x={xScale(dispDeg)} y={CHART_H - MARGIN.bottom + 24} textAnchor="middle"
                        fontSize={8} fill="#6b7280" fontWeight={600}>
                        {compass}
                      </text>
                    )}
                  </g>
                );
              })}
              {/* 양각 눈금 */}
              {yTicks.map((v) => (
                <g key={`y-${v}`}>
                  <line x1={MARGIN.left} y1={yScale(v)} x2={MARGIN.left + INNER_W} y2={yScale(v)}
                    stroke="#e5e7eb" strokeWidth={0.5} strokeDasharray={v > 0 ? "2,2" : undefined} />
                  <text x={MARGIN.left - 4} y={yScale(v) + 3} textAnchor="end" fontSize={9} fill="#6b7280">
                    {v.toFixed(yStep < 1 ? 1 : 0)}°
                  </text>
                </g>
              ))}

              {/* 파노라마 차단 프로파일 (미포함=베이스라인 점선, 포함=실선) */}
              {(() => {
                const filterSort = (pts: PanoramaPoint[]) =>
                  pts
                    .filter((p) => {
                      let rel = p.azimuth_deg - azCenter;
                      if (rel > 180) rel -= 360;
                      if (rel < -180) rel += 360;
                      return Math.abs(rel) <= azHalfSpan;
                    })
                    .sort((a, b) => {
                      let ra = a.azimuth_deg - azCenter;
                      if (ra > 180) ra -= 360; if (ra < -180) ra += 360;
                      let rb = b.azimuth_deg - azCenter;
                      if (rb > 180) rb -= 360; if (rb < -180) rb += 360;
                      return ra - rb;
                    });
                const toPath = (pts: PanoramaPoint[]) =>
                  pts.map((p, i) =>
                    `${i === 0 ? "M" : "L"}${xScale(p.azimuth_deg).toFixed(1)},${yScale(p.elevation_angle_deg).toFixed(1)}`
                  ).join(" ");
                const withVis = filterSort(panoWith);
                const withoutVis = filterSort(panoWithout);
                return (
                  <g clipPath={`url(#az-elev-clip-${rIdx})`}>
                    {withoutVis.length > 1 && (
                      <path d={toPath(withoutVis)} fill="none"
                        stroke="#84cc16" strokeWidth={1} />
                    )}
                    {withVis.length > 1 && (
                      <path d={toPath(withVis)} fill="none"
                        stroke="#ef4444" strokeWidth={1} />
                    )}
                  </g>
                );
              })()}

              {/* 소실표적 (지형 차단 + 장애물 추가 기인만 표시) */}
              <g clipPath={`url(#az-elev-clip-${rIdx})`}>
                {losses.filter((l) => l.inShadow && !l.buildingCaused).map((l, i) => (
                  <circle key={`terr-${i}`} cx={xScale(l.azDeg)} cy={yScale(l.elevAngleDeg)} r={2.5}
                    fill="#9ca3af" opacity={0.6} />
                ))}
                {losses.filter((l) => l.buildingCaused).map((l, i) => (
                  <circle key={`bldg-${i}`} cx={xScale(l.azDeg)} cy={yScale(l.elevAngleDeg)} r={3}
                    fill="#ef4444" opacity={0.8} stroke="#b91c1c" strokeWidth={0.3} />
                ))}
              </g>

              {/* 축 라벨 */}
              <text x={MARGIN.left + INNER_W / 2} y={CHART_H - 2} textAnchor="middle" fontSize={10} fill="#6b7280">
                방위
              </text>
              <text x={14} y={MARGIN.top + INNER_H / 2} textAnchor="middle" fontSize={10} fill="#6b7280"
                transform={`rotate(-90, 14, ${MARGIN.top + INNER_H / 2})`}>
                양각 (°)
              </text>
            </svg>

            {/* 범례 */}
            <div className="flex flex-wrap items-center gap-3 justify-center mt-1.5 text-[11px] text-gray-500">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "#ef4444", opacity: 0.8 }} />
                장애물 추가 기인
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-2.5 rounded-full" style={{ backgroundColor: "#9ca3af", opacity: 0.6 }} />
                지형 차단 (장애물 무관)
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-4 border-t" style={{ borderColor: "#ef4444" }} />
                차단 프로파일 (대상 포함)
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-4 border-t" style={{ borderColor: "#84cc16" }} />
                차단 프로파일 (대상 미포함)
              </span>
            </div>

            {/* 요약 테이블 */}
            <table className="mt-3 w-full border-collapse text-[12px]">
              <thead>
                <tr className="bg-[#28283c] text-white">
                  <th className="border border-gray-300 px-2 py-1 font-medium">항목</th>
                  <th className="border border-gray-300 px-2 py-1 font-medium">값</th>
                  <th className="border border-gray-300 px-2 py-1 font-medium">비고</th>
                </tr>
              </thead>
              <tbody>
                <tr className="bg-white">
                  <td className="border border-gray-200 px-2 py-1">전체 소실표적</td>
                  <td className="border border-gray-200 px-2 py-1 text-right font-mono">{totalCount}건</td>
                  <td className="border border-gray-200 px-2 py-1 text-gray-500">분석 구간 내 누적</td>
                </tr>
                <tr className="bg-gray-50">
                  <td className="border border-gray-200 px-2 py-1">LoS 차단 영역 내 (전체)</td>
                  <td className="border border-gray-200 px-2 py-1 text-right font-mono">
                    {inShadowCount}건 ({shadowRatio.toFixed(1)}%)
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-gray-500">지형+건물 통합 차단</td>
                </tr>
                <tr className="bg-white">
                  <td className="border border-gray-200 px-2 py-1 font-semibold text-[#a60739]">장애물 추가 기인</td>
                  <td className="border border-gray-200 px-2 py-1 text-right font-mono font-bold" style={{ color: bldgCausedRatio > 10 ? "#dc2626" : "#374151" }}>
                    {bldgCausedCount}건 ({bldgCausedRatio.toFixed(1)}%) / {bldgCausedDuration.toFixed(1)}초
                  </td>
                  <td className="border border-gray-200 px-2 py-1 text-gray-500">
                    분석 대상 장애물로 인한 추가 차단
                  </td>
                </tr>
                {buildings.map((b) => {
                  const bCaused = losses.filter((l) => l.buildingName === b.name && l.buildingCaused);
                  const bDur = bCaused.reduce((s, l) => s + l.durationS, 0);
                  const hasBldgEffect = b.angleTotalDeg > b.angleTerrainDeg + 0.005;
                  return (
                    <tr key={b.name} className="bg-gray-50">
                      <td className="border border-gray-200 px-2 py-1 pl-4">↳ {b.name}</td>
                      <td className="border border-gray-200 px-2 py-1 text-right font-mono">
                        {bCaused.length}건 / {bDur.toFixed(1)}초
                      </td>
                      <td className="border border-gray-200 px-2 py-1 text-gray-500">
                        방위 {b.azDeg.toFixed(0)}° · {(b.distKm / KM_PER_NM).toFixed(1)}NM · 차단각 {b.angleTotalDeg.toFixed(2)}°
                        {hasBldgEffect ? ` (지형 ${b.angleTerrainDeg.toFixed(2)}°)` : " (지형 이하)"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>

            {/* 판정 뱃지 */}
            <div className="mt-2 flex items-center gap-2">
              <span className="text-[12px] text-gray-500">장애물 추가 기인 판정:</span>
              {bldgCausedRatio > 20 ? (
                <span className="px-2 py-0.5 rounded text-[12px] font-bold bg-red-100 text-red-700">
                  유의미 — 소실표적의 {bldgCausedRatio.toFixed(0)}%가 장애물 추가 차단 영역 내
                </span>
              ) : bldgCausedRatio > 5 ? (
                <span className="px-2 py-0.5 rounded text-[12px] font-bold bg-amber-100 text-amber-700">
                  부분 영향 — 소실표적의 {bldgCausedRatio.toFixed(0)}%가 장애물 추가 차단 영역 내
                </span>
              ) : (
                <span className="px-2 py-0.5 rounded text-[12px] font-bold bg-green-100 text-green-700">
                  영향 미미 — 장애물 추가 기인 {bldgCausedRatio.toFixed(0)}% (지형 또는 기타 원인 우세)
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default React.memo(ReportOMAltitudeDistribution);
