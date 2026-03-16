import type { RadarSite } from "../../types";
import type { CoverageLayer } from "../../utils/radarCoverage";

interface CoverageMapSectionProps {
  sectionNum: number;
  coverageLayers: CoverageLayer[];
  radarSite: RadarSite;
}

/** 고도(ft) → 스펙트럼 HSL 색상 (빨강→주황→노랑→초록→시안→파랑) */
function altToColor(altFt: number, minAlt: number, maxAlt: number): string {
  const t = maxAlt > minAlt ? (altFt - minAlt) / (maxAlt - minAlt) : 0.5;
  const hue = t * 240; // 0°(red) → 240°(blue)
  return `hsl(${hue}, 85%, 50%)`;
}

export default function ReportCoverageMapSection({
  sectionNum,
  coverageLayers,
  radarSite,
}: CoverageMapSectionProps) {
  if (coverageLayers.length === 0) return null;

  // 레이어 샘플링 (최대 14개, 시각적 최적)
  const sampleCount = Math.min(coverageLayers.length, 14);
  const step = Math.max(1, Math.floor(coverageLayers.length / sampleCount));
  const sampled: CoverageLayer[] = [];
  for (let i = 0; i < coverageLayers.length; i += step) {
    sampled.push(coverageLayers[i]);
  }
  if (sampled[sampled.length - 1] !== coverageLayers[coverageLayers.length - 1]) {
    sampled.push(coverageLayers[coverageLayers.length - 1]);
  }

  const minAlt = sampled[0].altitudeFt;
  const maxAlt = sampled[sampled.length - 1].altitudeFt;

  // SVG 레이아웃
  const svgW = 720;
  const svgH = 500;
  const cx = svgW / 2;
  const cy = 235;
  const maxR = 205;

  // 스케일링: 전체 레이어 중 최대 범위
  const globalMaxRange = Math.max(
    ...coverageLayers.flatMap((l) => l.bearings.map((b) => b.maxRangeKm)),
    radarSite.range_nm * 1.852
  );
  const scale = maxR / globalMaxRange;

  // 레이어 polygon path 생성 (bearings 10개 간격 샘플링)
  function layerPath(layer: CoverageLayer): string {
    const bearings = layer.bearings;
    const every = Math.max(1, Math.floor(bearings.length / 360));
    let d = "";
    for (let i = 0; i < bearings.length; i += every) {
      const b = bearings[i];
      const r = b.maxRangeKm * scale;
      const rad = (b.deg * Math.PI) / 180;
      const x = cx + r * Math.sin(rad);
      const y = cy - r * Math.cos(rad);
      d += i === 0 ? `M ${x.toFixed(1)} ${y.toFixed(1)}` : ` L ${x.toFixed(1)} ${y.toFixed(1)}`;
    }
    return d + " Z";
  }

  // 거리 링 (20NM 간격)
  const ringIntervalKm = 20 * 1.852;
  const rings: { km: number; nm: number }[] = [];
  for (let km = ringIntervalKm; km <= globalMaxRange; km += ringIntervalKm) {
    rings.push({ km, nm: km / 1.852 });
  }

  // 높은 고도 먼저 그리기 (낮은 고도가 위에)
  const drawOrder = [...sampled].sort((a, b) => b.altitudeFt - a.altitudeFt);

  // 최저 고도 레이어 기준 방위별 통계
  const lowestLayer = coverageLayers[0];
  const sectorSize = 45;
  const sectorLabels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const sectorStats = sectorLabels.map((label, i) => {
    const start = i * sectorSize;
    const end = start + sectorSize;
    const bs = lowestLayer.bearings.filter((b) => b.deg >= start && b.deg < end);
    const minRange = bs.length > 0 ? Math.min(...bs.map((b) => b.maxRangeKm)) : 0;
    const avgRange = bs.length > 0 ? bs.reduce((s, b) => s + b.maxRangeKm, 0) / bs.length : 0;
    return { label, minRange, avgRange };
  });

  // 최고 고도 레이어 방위별 평균 범위
  const highestLayer = coverageLayers[coverageLayers.length - 1];
  const sectorStatsHigh = sectorLabels.map((label, i) => {
    const start = i * sectorSize;
    const end = start + sectorSize;
    const bs = highestLayer.bearings.filter((b) => b.deg >= start && b.deg < end);
    const avgRange = bs.length > 0 ? bs.reduce((s, b) => s + b.maxRangeKm, 0) / bs.length : 0;
    return { label, avgRange };
  });

  const avgMinRange = lowestLayer.bearings.reduce((s, b) => s + b.maxRangeKm, 0) / lowestLayer.bearings.length;
  const avgMaxRange = highestLayer.bearings.reduce((s, b) => s + b.maxRangeKm, 0) / highestLayer.bearings.length;
  const worstSector = sectorStats.reduce((a, b) => (a.avgRange < b.avgRange ? a : b));

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[15px] font-bold text-gray-900">
        {sectionNum}. 레이더 커버리지 맵
      </h2>

      {/* KPI */}
      <div className="mb-3 grid grid-cols-5 gap-2">
        <div className="rounded-md bg-gray-50 px-2 py-1.5 text-center">
          <p className="text-[8px] text-gray-400">분석 고도 범위</p>
          <p className="text-[10px] font-bold text-gray-800">
            {minAlt.toLocaleString()}~{maxAlt.toLocaleString()} ft
          </p>
        </div>
        <div className="rounded-md bg-gray-50 px-2 py-1.5 text-center">
          <p className="text-[8px] text-gray-400">레이어 수</p>
          <p className="text-[10px] font-bold text-gray-800">{coverageLayers.length}개</p>
        </div>
        <div className="rounded-md bg-gray-50 px-2 py-1.5 text-center">
          <p className="text-[8px] text-gray-400">최저고도 평균범위</p>
          <p className="text-[10px] font-bold text-[#a60739]">{avgMinRange.toFixed(1)} km</p>
        </div>
        <div className="rounded-md bg-gray-50 px-2 py-1.5 text-center">
          <p className="text-[8px] text-gray-400">최고고도 평균범위</p>
          <p className="text-[10px] font-bold text-gray-800">{avgMaxRange.toFixed(1)} km</p>
        </div>
        <div className="rounded-md bg-gray-50 px-2 py-1.5 text-center">
          <p className="text-[8px] text-gray-400">최약 방위</p>
          <p className="text-[10px] font-bold text-[#a60739]">
            {worstSector.label} ({worstSector.avgRange.toFixed(0)}km)
          </p>
        </div>
      </div>

      {/* 극좌표 스펙트럼 커버리지 차트 */}
      <div className="mb-3 rounded-md border border-gray-200 p-2">
        <p className="mb-1 text-[9px] font-semibold text-gray-600">고도별 레이더 커버리지 스펙트럼</p>
        <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full">
          <rect x={0} y={0} width={svgW} height={svgH} fill="#fafafa" rx={3} />

          {/* 극좌표 영역 배경 */}
          <circle cx={cx} cy={cy} r={maxR + 8} fill="#f3f3f7" stroke="#e5e7eb" strokeWidth={0.5} />

          {/* 거리 링 */}
          {rings.map((ring, i) => {
            const r = ring.km * scale;
            return (
              <g key={`ring-${i}`}>
                <circle cx={cx} cy={cy} r={r} fill="none" stroke="#d1d5db" strokeWidth={0.4} strokeDasharray="3,3" />
                <text x={cx + r + 2} y={cy - 3} fill="#9ca3af" fontSize={6.5} textAnchor="start">
                  {ring.nm.toFixed(0)}NM
                </text>
              </g>
            );
          })}

          {/* 방위선 + 라벨 */}
          {[
            { deg: 0, label: "N" },
            { deg: 45, label: "NE" },
            { deg: 90, label: "E" },
            { deg: 135, label: "SE" },
            { deg: 180, label: "S" },
            { deg: 225, label: "SW" },
            { deg: 270, label: "W" },
            { deg: 315, label: "NW" },
          ].map(({ deg, label }) => {
            const rad = (deg * Math.PI) / 180;
            const x2 = cx + (maxR + 8) * Math.sin(rad);
            const y2 = cy - (maxR + 8) * Math.cos(rad);
            const xl = cx + (maxR + 20) * Math.sin(rad);
            const yl = cy - (maxR + 20) * Math.cos(rad);
            const isCardinal = deg % 90 === 0;
            return (
              <g key={`dir-${deg}`}>
                <line
                  x1={cx}
                  y1={cy}
                  x2={x2}
                  y2={y2}
                  stroke={isCardinal ? "#b0b0b8" : "#d5d5dd"}
                  strokeWidth={isCardinal ? 0.6 : 0.3}
                />
                <text
                  x={xl}
                  y={yl + 3}
                  textAnchor="middle"
                  fill={isCardinal ? "#374151" : "#9ca3af"}
                  fontSize={isCardinal ? 9 : 7}
                  fontWeight={isCardinal ? 600 : 400}
                >
                  {label}
                </text>
              </g>
            );
          })}

          {/* 커버리지 레이어 (높은 고도 먼저 → 낮은 고도가 위에 겹침) */}
          {drawOrder.map((layer, idx) => {
            const color = altToColor(layer.altitudeFt, minAlt, maxAlt);
            const isLowest = layer.altitudeFt === minAlt;
            const isHighest = layer.altitudeFt === maxAlt;
            return (
              <path
                key={`cov-${idx}`}
                d={layerPath(layer)}
                fill={color}
                fillOpacity={0.16}
                stroke={color}
                strokeWidth={isLowest ? 1.5 : isHighest ? 1.0 : 0.2}
                strokeOpacity={isLowest ? 0.85 : isHighest ? 0.6 : 0.15}
              />
            );
          })}

          {/* Cone of Silence (최저 레이어) */}
          {lowestLayer.coneRadiusKm > 0.5 && (
            <circle
              cx={cx}
              cy={cy}
              r={lowestLayer.coneRadiusKm * scale}
              fill="none"
              stroke="#a60739"
              strokeWidth={0.8}
              strokeDasharray="4,3"
              opacity={0.5}
            />
          )}

          {/* 레이더 중심 마커 */}
          <circle cx={cx} cy={cy} r={3.5} fill="#a60739" stroke="white" strokeWidth={1} />
          <text x={cx} y={cy + 14} textAnchor="middle" fill="#374151" fontSize={8} fontWeight={600}>
            {radarSite.name}
          </text>

          {/* 스펙트럼 범례 바 */}
          <defs>
            <linearGradient id="report-spectrum-grad" x1="0%" y1="0%" x2="100%" y2="0%">
              <stop offset="0%" stopColor="hsl(0, 85%, 50%)" />
              <stop offset="25%" stopColor="hsl(60, 85%, 50%)" />
              <stop offset="50%" stopColor="hsl(120, 85%, 50%)" />
              <stop offset="75%" stopColor="hsl(180, 85%, 50%)" />
              <stop offset="100%" stopColor="hsl(240, 85%, 50%)" />
            </linearGradient>
          </defs>
          <g transform={`translate(${cx - 130}, ${svgH - 38})`}>
            <text x={130} y={-5} textAnchor="middle" fill="#6b7280" fontSize={7}>
              고도 (ft) — 저고도(빨강) → 고고도(파랑)
            </text>
            <rect x={0} y={0} width={260} height={10} fill="url(#report-spectrum-grad)" rx={2} opacity={0.75} />
            <text x={0} y={21} textAnchor="middle" fill="#6b7280" fontSize={7}>
              {minAlt.toLocaleString()}
            </text>
            <text x={130} y={21} textAnchor="middle" fill="#6b7280" fontSize={7}>
              {Math.round((minAlt + maxAlt) / 2).toLocaleString()}
            </text>
            <text x={260} y={21} textAnchor="middle" fill="#6b7280" fontSize={7}>
              {maxAlt.toLocaleString()}
            </text>
          </g>
        </svg>
      </div>

      {/* 방위별 커버리지 테이블 */}
      <div>
        <p className="mb-1.5 text-[10px] font-semibold text-gray-600">
          방위별 커버리지 요약 (최저 {minAlt.toLocaleString()}ft / 최고 {maxAlt.toLocaleString()}ft)
        </p>
        <table className="w-full border-collapse text-[9px]">
          <thead>
            <tr className="bg-[#28283c] text-white">
              <th className="border border-gray-300 px-2 py-1 text-center font-medium">방위</th>
              <th className="border border-gray-300 px-2 py-1 text-right font-medium">최저고도 범위(km)</th>
              <th className="border border-gray-300 px-2 py-1 text-right font-medium">최고고도 범위(km)</th>
              <th className="border border-gray-300 px-2 py-1 text-right font-medium">최소(NM)</th>
              <th className="border border-gray-300 px-2 py-1 text-center font-medium">커버리지 비율</th>
            </tr>
          </thead>
          <tbody>
            {sectorStats.map((s, i) => {
              const highAvg = sectorStatsHigh[i].avgRange;
              const ratio = globalMaxRange > 0 ? (s.avgRange / globalMaxRange) * 100 : 0;
              const barColor = ratio > 80 ? "#22c55e" : ratio > 60 ? "#eab308" : "#ef4444";
              return (
                <tr key={s.label} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                  <td className="border border-gray-200 px-2 py-1 text-center font-semibold">{s.label}</td>
                  <td className="border border-gray-200 px-2 py-1 text-right font-mono">{s.avgRange.toFixed(1)}</td>
                  <td className="border border-gray-200 px-2 py-1 text-right font-mono">{highAvg.toFixed(1)}</td>
                  <td className="border border-gray-200 px-2 py-1 text-right font-mono">
                    {(s.minRange / 1.852).toFixed(1)}
                  </td>
                  <td className="border border-gray-200 px-2 py-1">
                    <div className="flex items-center gap-1">
                      <div className="h-1.5 flex-1 rounded-full bg-gray-200">
                        <div
                          className="h-full rounded-full"
                          style={{ width: `${Math.min(100, ratio)}%`, backgroundColor: barColor }}
                        />
                      </div>
                      <span className="w-8 text-right text-[8px]">{ratio.toFixed(0)}%</span>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
