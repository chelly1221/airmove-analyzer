import React, { useMemo } from "react";
import type { DailyStats, RadarSite, ManualBuilding, AzSector } from "../../types";

interface Props {
  sectionNum: number;
  radarSite: RadarSite;
  dailyStats: DailyStats[];
  selectedBuildings: ManualBuilding[];
  azSectors: AzSector[];
  analysisMonth?: string;
}

/** 레이더→포인트 방위(°, 0=N, CW) 및 거리(km) */
function azimuthAndDist(
  radarLat: number, radarLon: number,
  lat: number, lon: number,
): { azDeg: number; distKm: number } {
  const dLat = lat - radarLat;
  const dLon = lon - radarLon;
  const latKm = dLat * 111.32;
  const lonKm = dLon * 111.32 * Math.cos((radarLat * Math.PI) / 180);
  const distKm = Math.sqrt(latKm * latKm + lonKm * lonKm);
  let azDeg = (Math.atan2(lonKm, latKm) * 180) / Math.PI;
  if (azDeg < 0) azDeg += 360;
  return { azDeg, distKm };
}

/** 고도(ft) → 스펙트럼 HSL 색상 (빨강→파랑) */
function altToColor(altFt: number, minAlt: number, maxAlt: number): string {
  const t = maxAlt > minAlt ? Math.max(0, Math.min(1, (altFt - minAlt) / (maxAlt - minAlt))) : 0.5;
  const hue = t * 240;
  return `hsl(${hue}, 85%, 50%)`;
}

/** 방위 구간 내 포함 여부 */
function inSector(azDeg: number, sectors: AzSector[]): boolean {
  for (const s of sectors) {
    if (s.start_deg <= s.end_deg) {
      if (azDeg >= s.start_deg && azDeg <= s.end_deg) return true;
    } else {
      if (azDeg >= s.start_deg || azDeg <= s.end_deg) return true;
    }
  }
  return false;
}

const FIXED_ALTS = [1000, 2000, 3000, 5000, 10000, 15000, 20000];
const DURATION_EXAMPLES = [5, 30, 120]; // 초

/**
 * 시각화 산식 근거:
 * - 극좌표 변환: 평면 근사 azimuth/distance (latKm=dLat×111.32, lonKm=dLon×111.32×cos(lat))
 *   한국 위도(33–38°) 범위에서 200km 이내 오차 < 0.1%로 충분
 * - 점 크기: r = √(duration_s / 2), 범위 2–7px
 *   제곱근 스케일로 면적이 지속시간에 비례 (면적 ∝ πr² ∝ duration)
 * - 점 색상: HSL 스펙트럼 (hue = t×240°, t = (alt-1000)/(20000-1000))
 *   1000ft=빨강(0°) → 20000ft=파랑(240°) — 저고도(장애물 영향) 시인성 강조
 * - 차폐 영역: halfAngle = max(1°, min(5°, height/distance × 0.5))
 *   실제 전파 차폐각은 건물 폭/높이에 의존하나, 정확한 폭 데이터 없이
 *   높이/거리 비율로 시각적 근사. 정량 판정이 아닌 공간 패턴 확인 목적.
 */

function ReportOMAzDistScatter({
  sectionNum, radarSite, dailyStats, selectedBuildings, azSectors, analysisMonth,
}: Props) {
  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";

  // Loss 포인트 추출 + 극좌표 변환
  const lossData = useMemo(() => {
    const points: { azDeg: number; distKm: number; altFt: number; durationS: number; inSec: boolean }[] = [];
    for (const d of dailyStats) {
      for (const lp of d.loss_points_summary) {
        if (lp.lat === 0 && lp.lon === 0) continue;
        const { azDeg, distKm } = azimuthAndDist(radarSite.latitude, radarSite.longitude, lp.lat, lp.lon);
        points.push({
          azDeg, distKm,
          altFt: lp.alt_ft,
          durationS: lp.duration_s,
          inSec: inSector(azDeg, azSectors),
        });
      }
    }
    return points;
  }, [dailyStats, radarSite, azSectors]);

  // 건물 극좌표
  const buildingPolar = useMemo(() =>
    selectedBuildings.map((b) => ({
      ...azimuthAndDist(radarSite.latitude, radarSite.longitude, b.latitude, b.longitude),
      name: b.name || `B${b.id}`,
      height: b.height,
    })),
  [selectedBuildings, radarSite]);

  if (lossData.length === 0) return null;

  // SVG 레이아웃
  const svgSize = 700;
  const cx = svgSize / 2;
  const cy = svgSize / 2;
  const maxR = svgSize / 2 - 50;

  // 최대 거리 결정
  const maxDistKm = useMemo(() => {
    let maxD = radarSite.range_nm * 1.852;
    for (const lp of lossData) { if (lp.distKm > maxD) maxD = lp.distKm; }
    for (const bp of buildingPolar) { if (bp.distKm > maxD) maxD = bp.distKm; }
    return maxD * 1.1;
  }, [lossData, buildingPolar, radarSite.range_nm]);

  const scale = maxR / maxDistKm;

  // 고도 범위
  const minAlt = 1000;
  const maxAlt = 20000;

  // 거리 링 (20NM 간격)
  const ringIntervalKm = 20 * 1.852;
  const rings: { km: number; nm: number }[] = [];
  for (let km = ringIntervalKm; km <= maxDistKm; km += ringIntervalKm) {
    rings.push({ km, nm: km / 1.852 });
  }

  // 방위 라벨
  const compassPoints = [
    { deg: 0, label: "N" }, { deg: 45, label: "NE" }, { deg: 90, label: "E" },
    { deg: 135, label: "SE" }, { deg: 180, label: "S" }, { deg: 225, label: "SW" },
    { deg: 270, label: "W" }, { deg: 315, label: "NW" },
  ];

  // 점 크기: 지속시간 기반 (2~7px)
  const dotR = (durationS: number) => Math.max(2, Math.min(7, Math.sqrt(durationS / 2)));

  // 섹터 내/외 통계
  const inSectorCount = lossData.filter((p) => p.inSec).length;
  const outSectorCount = lossData.length - inSectorCount;

  // 극좌표 → SVG 좌표
  const polar2xy = (azDeg: number, distKm: number) => {
    const rad = (azDeg * Math.PI) / 180;
    const r = distKm * scale;
    return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
  };

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[17px] font-bold text-gray-900">
        {sectionNum}. 방위-거리 소실표적 산점도{monthLabel && ` (${monthLabel})`}
      </h2>
      <h3 className="mb-2 text-[15px] font-semibold text-gray-700">{radarSite.name}</h3>

      {/* 정보 요약 */}
      <div className="mb-2 flex items-center justify-between rounded-md border border-gray-200 bg-gray-50 px-3 py-1.5 text-[10px] text-gray-500">
        <span>소실 이벤트 총 {lossData.length}건 (섹터 내 {inSectorCount}건 / 섹터 외 {outSectorCount}건)</span>
        <span>
          방위 구간: {azSectors.map((s) => `${s.start_deg.toFixed(1)}°~${s.end_deg.toFixed(1)}°`).join(", ") || "—"}
        </span>
      </div>

      <div className="rounded-md border border-gray-200 p-2">
        <svg viewBox={`0 0 ${svgSize} ${svgSize}`} className="w-full" style={{ aspectRatio: "1/1" }}>
          <rect x={0} y={0} width={svgSize} height={svgSize} fill="#fafafa" rx={4} />

          {/* 거리 링 */}
          {rings.map((ring, i) => {
            const r = ring.km * scale;
            return (
              <g key={`ring-${i}`}>
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="#d1d5db" strokeWidth={0.4} strokeDasharray="3,3" />
                <text x={cx + r + 3} y={cy - 3} fill="#9ca3af" fontSize={7} textAnchor="start">
                  {ring.nm.toFixed(0)}NM
                </text>
              </g>
            );
          })}

          {/* 방위선 + 라벨 */}
          {compassPoints.map(({ deg, label }) => {
            const rad = (deg * Math.PI) / 180;
            return (
              <g key={deg}>
                <line x1={cx} y1={cy}
                  x2={cx + (maxR + 10) * Math.sin(rad)}
                  y2={cy - (maxR + 10) * Math.cos(rad)}
                  stroke="#c0c0c8" strokeWidth={0.4} />
                <text
                  x={cx + (maxR + 22) * Math.sin(rad)}
                  y={cy - (maxR + 22) * Math.cos(rad) + 3}
                  textAnchor="middle" fill="#6b7280" fontSize={9} fontWeight={600}>{label}</text>
              </g>
            );
          })}

          {/* 방위 섹터 경계선 */}
          {azSectors.flatMap((s) => [s.start_deg, s.end_deg]).map((deg, i) => {
            const rad = (deg * Math.PI) / 180;
            return (
              <line key={`sec-${i}`} x1={cx} y1={cy}
                x2={cx + (maxR + 15) * Math.sin(rad)}
                y2={cy - (maxR + 15) * Math.cos(rad)}
                stroke="#ef4444" strokeWidth={0.8} strokeDasharray="6,3" opacity={0.7} />
            );
          })}

          {/* 섹터 영역 반투명 표시 */}
          {azSectors.map((s, si) => {
            const step = 1;
            const pts: string[] = [`${cx},${cy}`];
            let deg = s.start_deg;
            const end = s.start_deg <= s.end_deg ? s.end_deg : s.end_deg + 360;
            while (deg <= end) {
              const d = deg % 360;
              const rad = (d * Math.PI) / 180;
              const r = maxR + 5;
              pts.push(`${(cx + r * Math.sin(rad)).toFixed(1)},${(cy - r * Math.cos(rad)).toFixed(1)}`);
              deg += step;
            }
            return (
              <polygon key={`sector-fill-${si}`} points={pts.join(" ")}
                fill="#ef4444" fillOpacity={0.04} stroke="none" />
            );
          })}

          {/* 건물 그림자 영역 (이론적 차폐 삼각형) */}
          {buildingPolar.map((bp, i) => {
            // 건물 높이에 비례한 각도 폭 (최소 ±1°, 최대 ±5°)
            const halfAngle = Math.max(1, Math.min(5, (bp.height / bp.distKm) * 0.5));
            const startDeg = bp.azDeg - halfAngle;
            const endDeg = bp.azDeg + halfAngle;
            const pts: string[] = [];
            // 건물 위치부터 최대 거리까지
            const rStart = bp.distKm * scale;
            const rEnd = maxR + 5;
            for (let d = startDeg; d <= endDeg; d += 0.5) {
              const rad = (d * Math.PI) / 180;
              pts.push(`${(cx + rEnd * Math.sin(rad)).toFixed(1)},${(cy - rEnd * Math.cos(rad)).toFixed(1)}`);
            }
            for (let d = endDeg; d >= startDeg; d -= 0.5) {
              const rad = (d * Math.PI) / 180;
              pts.push(`${(cx + rStart * Math.sin(rad)).toFixed(1)},${(cy - rStart * Math.cos(rad)).toFixed(1)}`);
            }
            return (
              <polygon key={`shadow-${i}`} points={pts.join(" ")}
                fill="#f59e0b" fillOpacity={0.08} stroke="#f59e0b" strokeWidth={0.3}
                strokeDasharray="3,3" strokeOpacity={0.3} />
            );
          })}

          {/* 소실표적 산점 — 섹터 외 (먼저 그려서 뒤로) */}
          {lossData.filter((p) => !p.inSec).map((pt, i) => {
            const { x, y } = polar2xy(pt.azDeg, pt.distKm);
            if (pt.distKm > maxDistKm) return null;
            const r = dotR(pt.durationS);
            const color = altToColor(pt.altFt, minAlt, maxAlt);
            return (
              <circle key={`out-${i}`} cx={x} cy={y} r={r}
                fill={color} fillOpacity={0.3}
                stroke={color} strokeWidth={0.3} strokeOpacity={0.4} />
            );
          })}

          {/* 소실표적 산점 — 섹터 내 (위에 그려서 강조) */}
          {lossData.filter((p) => p.inSec).map((pt, i) => {
            const { x, y } = polar2xy(pt.azDeg, pt.distKm);
            if (pt.distKm > maxDistKm) return null;
            const r = dotR(pt.durationS);
            const color = altToColor(pt.altFt, minAlt, maxAlt);
            return (
              <g key={`in-${i}`}>
                <circle cx={x} cy={y} r={r + 1} fill="none" stroke="#ffffff" strokeWidth={0.8} />
                <circle cx={x} cy={y} r={r}
                  fill={color} fillOpacity={0.85}
                  stroke={color} strokeWidth={0.5} />
              </g>
            );
          })}

          {/* 건물 위치 */}
          {buildingPolar.map((bp, i) => {
            const { x, y } = polar2xy(bp.azDeg, bp.distKm);
            return (
              <g key={`bld-${i}`}>
                <rect x={x - 5} y={y - 5} width={10} height={10}
                  fill="#f59e0b" stroke="#ffffff" strokeWidth={1} rx={2} />
                <text x={x + 8} y={y + 3} fill="#92400e" fontSize={8} fontWeight={600}
                  stroke="#ffffff" strokeWidth={2.5} paintOrder="stroke">
                  {bp.name}
                </text>
              </g>
            );
          })}

          {/* 레이더 중심 */}
          <circle cx={cx} cy={cy} r={4} fill="#a60739" stroke="white" strokeWidth={1.2} />
          <text x={cx} y={cy + 14} textAnchor="middle" fill="#a60739" fontSize={8} fontWeight={600}
            stroke="#ffffff" strokeWidth={2} paintOrder="stroke">{radarSite.name}</text>

          {/* 고도 스펙트럼 범례 */}
          {(() => {
            const legendW = FIXED_ALTS.length * 36;
            const lx = svgSize / 2 - legendW / 2;
            const ly = svgSize - 46;
            return (
              <g>
                {FIXED_ALTS.map((alt, i) => {
                  const x = lx + i * 36;
                  const color = altToColor(alt, minAlt, maxAlt);
                  return (
                    <g key={alt}>
                      <rect x={x} y={ly} width={12} height={8} fill={color} rx={1.5} />
                      <text x={x + 6} y={ly + 17} textAnchor="middle" fill="#6b7280" fontSize={7}>
                        {alt >= 1000 ? `${(alt / 1000).toFixed(0)}k` : alt}
                      </text>
                    </g>
                  );
                })}
                <text x={lx + legendW / 2} y={ly - 4} textAnchor="middle" fill="#6b7280" fontSize={7}>
                  고도 (ft)
                </text>
              </g>
            );
          })()}

          {/* 크기 범례 (지속시간) */}
          {(() => {
            const baseX = svgSize - 100;
            const baseY = svgSize - 46;
            return (
              <g>
                <text x={baseX} y={baseY - 4} fill="#6b7280" fontSize={7}>지속시간(초)</text>
                {DURATION_EXAMPLES.map((dur, i) => {
                  const r = dotR(dur);
                  const x = baseX + i * 28;
                  return (
                    <g key={dur}>
                      <circle cx={x + 5} cy={baseY + 4} r={r} fill="#9ca3af" fillOpacity={0.5} stroke="#6b7280" strokeWidth={0.5} />
                      <text x={x + 5} y={baseY + 18} textAnchor="middle" fill="#6b7280" fontSize={6.5}>{dur}s</text>
                    </g>
                  );
                })}
              </g>
            );
          })()}
        </svg>
      </div>

      {/* 산식 근거 주석 */}
      <div className="mt-1 rounded border border-gray-200 bg-gray-50/70 px-3 py-1.5 text-[9px] leading-relaxed text-gray-500">
        점 크기: √(지속시간/2) — 면적이 소실 지속시간에 비례
        {" · "}색상: 고도별 HSL 스펙트럼 (1kft 빨강 → 20kft 파랑)
        {" · "}차폐 영역: 건물 높이/거리 비율 기반 시각적 근사 (정량 판정 아님)
      </div>

      {/* 하단 범례 */}
      <div className="mt-2 flex flex-wrap justify-center gap-4 text-[10px] text-gray-600">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full" style={{
            background: "linear-gradient(135deg, hsl(0,85%,50%), hsl(120,85%,50%), hsl(240,85%,50%))",
          }} />
          섹터 내 소실 ({inSectorCount}건, 불투명)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded-full bg-gray-300 opacity-50" />
          섹터 외 소실 ({outSectorCount}건, 반투명)
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-2.5 rounded bg-amber-400 border border-white" />
          분석 대상 장애물
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2.5 w-4 bg-amber-400/10 border border-amber-400/30 border-dashed" />
          이론적 차폐 영역
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-0 w-4 border-t border-dashed border-red-500" />
          방위 구간 경계
        </span>
      </div>
    </div>
  );
}

export default React.memo(ReportOMAzDistScatter);
