import type { PanoramaPoint, RadarSite } from "../../types";

interface PanoramaSectionProps {
  sectionNum: number;
  panoramaData: PanoramaPoint[];
  radarSite: RadarSite;
  peakNames?: Map<number, string>;
}

/** 방위 라벨 */
function azLabel(deg: number): string {
  const dirs: [number, string][] = [
    [0, "N"], [45, "NE"], [90, "E"], [135, "SE"],
    [180, "S"], [225, "SW"], [270, "W"], [315, "NW"], [360, "N"],
  ];
  for (const [d, l] of dirs) {
    if (Math.abs(deg - d) < 5) return l;
  }
  return `${deg.toFixed(0)}°`;
}

/** 장애물 유형 한글 */
function obstacleLabel(type: string): string {
  if (type === "terrain") return "지형";
  if (type === "gis_building") return "건물통합정보";
  if (type === "manual_building") return "수동 건물";
  return type;
}

export default function ReportPanoramaSection({ sectionNum, panoramaData, radarSite, peakNames }: PanoramaSectionProps) {
  if (panoramaData.length === 0) return null;

  // 통계 계산
  const buildings = panoramaData.filter((p) => p.obstacle_type !== "terrain");
  const gisBuildings = buildings.filter((p) => p.obstacle_type === "gis_building");
  const manualBuildings = buildings.filter((p) => p.obstacle_type === "manual_building");
  const maxAnglePt = panoramaData.reduce((a, b) => a.elevation_angle_deg > b.elevation_angle_deg ? a : b, panoramaData[0]);
  const avgAngle = panoramaData.reduce((s, p) => s + p.elevation_angle_deg, 0) / panoramaData.length;

  // 주요 장애물 (앙각 상위 건물)
  const topBuildings = [...buildings]
    .sort((a, b) => b.elevation_angle_deg - a.elevation_angle_deg)
    .slice(0, 15);

  // 방위별 분석 (8방위)
  const sectorSize = 45;
  const sectorLabels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const sectorStats = sectorLabels.map((label, i) => {
    const start = i * sectorSize;
    const end = start + sectorSize;
    const ptsWithIdx = panoramaData.map((p, idx) => ({ ...p, _idx: idx })).filter((p) => p.azimuth_deg >= start && p.azimuth_deg < end);
    const bldgs = ptsWithIdx.filter((p) => p.obstacle_type !== "terrain");
    const maxPtWithIdx = ptsWithIdx.length > 0 ? ptsWithIdx.reduce((a, b) => a.elevation_angle_deg > b.elevation_angle_deg ? a : b) : null;
    const maxPt = maxPtWithIdx as (PanoramaPoint & { _idx: number }) | null;
    return { label, start, end, count: ptsWithIdx.length, buildings: bldgs.length, maxAngle: maxPt?.elevation_angle_deg ?? 0, maxPt };
  });

  // SVG 파노라마 차트 (보고서용 간소화)
  const svgW = 720;
  const svgH = 200;
  const margin = { top: 20, right: 20, bottom: 28, left: 45 };
  const chartW = svgW - margin.left - margin.right;
  const chartH = svgH - margin.top - margin.bottom;

  const angles = panoramaData.map((p) => p.elevation_angle_deg);
  const minAngle = Math.min(0, Math.min(...angles) - 0.05);
  const maxAngle = Math.max(...angles) + 0.1;
  const range = maxAngle - minAngle;

  const toY = (a: number) => margin.top + chartH * (1 - (a - minAngle) / range);

  // 지형 영역 path
  const terrainPath = (() => {
    const yBase = margin.top + chartH;
    let d = `M ${margin.left} ${yBase}`;
    for (let i = 0; i < panoramaData.length; i++) {
      const x = margin.left + (i / (panoramaData.length - 1)) * chartW;
      const pt = panoramaData[i];
      const terrainAngle = pt.obstacle_type === "terrain"
        ? pt.elevation_angle_deg
        : Math.max(0, pt.elevation_angle_deg - (pt.obstacle_height_m / (pt.distance_km * 1000)) * (180 / Math.PI));
      d += ` L ${x} ${toY(Math.max(terrainAngle, minAngle))}`;
    }
    d += ` L ${margin.left + chartW} ${yBase} Z`;
    return d;
  })();

  // 실루엣 path
  const silhouettePath = (() => {
    let d = "";
    for (let i = 0; i < panoramaData.length; i++) {
      const x = margin.left + (i / (panoramaData.length - 1)) * chartW;
      const y = toY(panoramaData[i].elevation_angle_deg);
      d += i === 0 ? `M ${x} ${y}` : ` L ${x} ${y}`;
    }
    return d;
  })();

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. 전파 장애물 분석
      </h2>

      {/* 레이더 정보 + 요약 KPI */}
      <div className="mb-4 grid grid-cols-5 gap-2">
        <div className="rounded-md bg-gray-50 px-2 py-1.5 text-center">
          <p className="text-[11px] text-gray-400">레이더</p>
          <p className="text-[13px] font-bold text-gray-800">{radarSite.name}</p>
        </div>
        <div className="rounded-md bg-gray-50 px-2 py-1.5 text-center">
          <p className="text-[11px] text-gray-400">안테나 높이</p>
          <p className="text-[13px] font-bold text-gray-800">{(radarSite.altitude + radarSite.antenna_height).toFixed(0)}m ASL</p>
        </div>
        <div className="rounded-md bg-gray-50 px-2 py-1.5 text-center">
          <p className="text-[11px] text-gray-400">최대 앙각</p>
          <p className="text-[13px] font-bold text-[#a60739]">{maxAnglePt.elevation_angle_deg.toFixed(3)}°</p>
        </div>
        <div className="rounded-md bg-gray-50 px-2 py-1.5 text-center">
          <p className="text-[11px] text-gray-400">평균 앙각</p>
          <p className="text-[13px] font-bold text-gray-800">{avgAngle.toFixed(3)}°</p>
        </div>
        <div className="rounded-md bg-gray-50 px-2 py-1.5 text-center">
          <p className="text-[11px] text-gray-400">건물 장애물</p>
          <p className="text-[13px] font-bold text-gray-800">{buildings.length}건</p>
        </div>
      </div>

      {/* 파노라마 차트 (SVG) */}
      <div className="mb-4 rounded-md border border-gray-200 p-2">
        <p className="mb-1 text-[12px] font-semibold text-gray-600">360° LoS 파노라마</p>
        <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full">
          <rect x={0} y={0} width={svgW} height={svgH} fill="#fafafa" rx={3} />

          <defs>
            <clipPath id="report-panorama-clip">
              <rect x={margin.left} y={margin.top} width={chartW} height={chartH} />
            </clipPath>
          </defs>

          {/* Y축 그리드 */}
          {(() => {
            const step = range > 2 ? 0.5 : range > 1 ? 0.2 : 0.1;
            const lines: React.JSX.Element[] = [];
            for (let v = Math.ceil(minAngle / step) * step; v <= maxAngle; v += step) {
              const y = toY(v);
              lines.push(
                <g key={`yg-${v.toFixed(2)}`}>
                  <line x1={margin.left} y1={y} x2={margin.left + chartW} y2={y}
                    stroke={Math.abs(v) < 0.001 ? "#9ca3af" : "#e5e7eb"} strokeWidth={Math.abs(v) < 0.001 ? 0.8 : 0.4}
                    strokeDasharray={Math.abs(v) < 0.001 ? undefined : "2,2"} />
                  <text x={margin.left - 4} y={y + 3} textAnchor="end" fill="#6b7280" fontSize={7}>{v.toFixed(1)}°</text>
                </g>
              );
            }
            return lines;
          })()}

          {/* X축 방위 */}
          {[0, 45, 90, 135, 180, 225, 270, 315, 360].map((az) => {
            const x = margin.left + (az / 360) * chartW;
            const labels: Record<number, string> = { 0: "N", 90: "E", 180: "S", 270: "W", 360: "N" };
            return (
              <g key={`xg-${az}`}>
                <line x1={x} y1={margin.top} x2={x} y2={margin.top + chartH}
                  stroke={az % 90 === 0 ? "#d1d5db" : "#e5e7eb"} strokeWidth={az % 90 === 0 ? 0.6 : 0.3}
                  strokeDasharray={az % 90 === 0 ? undefined : "2,3"} />
                <text x={x} y={margin.top + chartH + 12} textAnchor="middle"
                  fill={az % 90 === 0 ? "#374151" : "#9ca3af"} fontSize={az % 90 === 0 ? 8 : 7} fontWeight={az % 90 === 0 ? 600 : 400}>
                  {labels[az] ?? `${az}°`}
                </text>
              </g>
            );
          })}

          {/* BRA 0.25° 기준선 */}
          {0.25 >= minAngle && 0.25 <= maxAngle && (
            <line
              x1={margin.left} y1={toY(0.25)} x2={margin.left + chartW} y2={toY(0.25)}
              stroke="#06b6d4" strokeWidth={0.7} strokeDasharray="4,3" opacity={0.7}
            />
          )}
          {0.25 >= minAngle && 0.25 <= maxAngle && (
            <text x={margin.left + chartW - 2} y={toY(0.25) - 3}
              textAnchor="end" fill="#06b6d4" fontSize={6.5} fontWeight={500}>BRA 0.25°</text>
          )}

          {/* 지형 + 실루엣 */}
          <g clipPath="url(#report-panorama-clip)">
            <path d={terrainPath} fill="#22c55e" fillOpacity={0.2} />
            <path d={silhouettePath} fill="none" stroke="#16a34a" strokeWidth={0.8} />

            {/* 건물 세로선 */}
            {panoramaData.map((pt, i) => {
              if (pt.obstacle_type === "terrain") return null;
              const x = margin.left + (i / (panoramaData.length - 1)) * chartW;
              const yTop = toY(pt.elevation_angle_deg);
              const terrainAngle = Math.max(0, pt.elevation_angle_deg - (pt.obstacle_height_m / (pt.distance_km * 1000)) * (180 / Math.PI));
              const yBottom = toY(Math.max(terrainAngle, minAngle));
              const color = pt.obstacle_type === "manual_building" ? "#ef4444" : "#f97316";
              return <line key={`b-${i}`} x1={x} y1={yTop} x2={x} y2={yBottom} stroke={color} strokeWidth={1.2} strokeOpacity={0.7} />;
            })}
          </g>

          {/* 범례 */}
          <g transform={`translate(${margin.left + 6}, ${margin.top + 5})`}>
            <rect x={0} y={0} width={6} height={6} fill="#22c55e" fillOpacity={0.5} rx={1} />
            <text x={8} y={6} fill="#374151" fontSize={7}>지형</text>
            <rect x={35} y={0} width={6} height={6} fill="#f97316" fillOpacity={0.7} rx={1} />
            <text x={43} y={6} fill="#374151" fontSize={7}>건물통합정보</text>
            <rect x={80} y={0} width={6} height={6} fill="#ef4444" fillOpacity={0.7} rx={1} />
            <text x={88} y={6} fill="#374151" fontSize={7}>수동 건물</text>
            <line x1={120} y1={3} x2={135} y2={3} stroke="#06b6d4" strokeWidth={0.7} strokeDasharray="3,2" />
            <text x={138} y={6} fill="#06b6d4" fontSize={7}>BRA 0.25°</text>
          </g>

          {/* 축 라벨 */}
          <text x={svgW / 2} y={svgH - 2} textAnchor="middle" fill="#6b7280" fontSize={7}>방위 (°)</text>
          <text x={10} y={margin.top + chartH / 2} textAnchor="middle" fill="#6b7280" fontSize={7}
            transform={`rotate(-90, 10, ${margin.top + chartH / 2})`}>앙각 (°)</text>
        </svg>
      </div>

      {/* 방위별 요약 테이블 */}
      <div className="mb-4 overflow-hidden">
        <p className="mb-1.5 text-[13px] font-semibold text-gray-600">방위별 장애물 요약 (8방위)</p>
        <table className="w-full table-fixed border-collapse text-[12px]">
          <colgroup>
            <col style={{ width: "10%" }} />
            <col style={{ width: "13%" }} />
            <col style={{ width: "15%" }} />
            <col style={{ width: "12%" }} />
            <col style={{ width: "50%" }} />
          </colgroup>
          <thead>
            <tr className="bg-[#28283c] text-white">
              <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">방위</th>
              <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">범위</th>
              <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">최대 앙각(°)</th>
              <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">건물 수</th>
              <th className="border border-gray-300 px-1.5 py-1 text-left font-medium">최대 장애물</th>
            </tr>
          </thead>
          <tbody>
            {sectorStats.map((s, i) => (
              <tr key={s.label} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                <td className="border border-gray-200 px-1.5 py-1 text-center font-semibold">{s.label}</td>
                <td className="border border-gray-200 px-1.5 py-1 text-center font-mono text-[11px] text-gray-500">
                  {s.start}°–{s.end}°
                </td>
                <td className="border border-gray-200 px-1.5 py-1 text-right font-mono">
                  {s.maxAngle.toFixed(3)}
                </td>
                <td className="border border-gray-200 px-1.5 py-1 text-right">
                  {s.buildings > 0 ? (
                    <span className="text-orange-600 font-medium">{s.buildings}</span>
                  ) : (
                    <span className="text-gray-400">0</span>
                  )}
                </td>
                <td className="border border-gray-200 px-1.5 py-1 truncate">
                  {s.maxPt ? (
                    <span className="flex items-center gap-1">
                      <span className={`inline-block shrink-0 rounded px-1 py-0.5 text-[11px] font-medium ${
                        s.maxPt.obstacle_type === "terrain"
                          ? "bg-green-50 text-green-600"
                          : s.maxPt.obstacle_type === "gis_building"
                          ? "bg-orange-50 text-orange-600"
                          : "bg-red-50 text-red-600"
                      }`}>
                        {obstacleLabel(s.maxPt.obstacle_type)}
                      </span>
                      <span className="truncate text-gray-600">
                        {s.maxPt.distance_km.toFixed(1)}km
                        {(s.maxPt.name || peakNames?.get(s.maxPt._idx)) ? ` · ${s.maxPt.name || peakNames?.get(s.maxPt._idx)}` : ""}
                      </span>
                    </span>
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 주요 건물 장애물 목록 */}
      {topBuildings.length > 0 && (
        <div>
          <p className="mb-1.5 text-[13px] font-semibold text-gray-600">
            주요 건물 장애물 (앙각 상위 {topBuildings.length}건)
            {gisBuildings.length > 0 && <span className="ml-2 font-normal text-gray-400">GIS {gisBuildings.length}건</span>}
            {manualBuildings.length > 0 && <span className="ml-1 font-normal text-gray-400">수동 {manualBuildings.length}건</span>}
          </p>
          <table className="w-full border-collapse text-[12px]">
            <thead>
              <tr className="bg-[#28283c] text-white">
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium w-5">#</th>
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">유형</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">방위(°)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">앙각(°)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">거리(km)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">건물높이(m)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">총높이(m)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-left font-medium">주소/이름</th>
                <th className="border border-gray-300 px-1.5 py-1 text-left font-medium">용도</th>
              </tr>
            </thead>
            <tbody>
              {topBuildings.map((pt, idx) => (
                <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">{idx + 1}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">
                    <span className={`rounded px-1 py-0.5 text-[11px] font-medium ${
                      pt.obstacle_type === "gis_building"
                        ? "bg-orange-50 text-orange-600"
                        : "bg-red-50 text-red-600"
                    }`}>
                      {pt.obstacle_type === "gis_building" ? "GIS" : "수동"}
                    </span>
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right font-mono">
                    {pt.azimuth_deg.toFixed(1)} <span className="text-[10px] text-gray-400">{azLabel(pt.azimuth_deg)}</span>
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right font-mono font-medium text-[#a60739]">
                    {pt.elevation_angle_deg.toFixed(3)}
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right font-mono">{pt.distance_km.toFixed(2)}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right font-mono">{pt.obstacle_height_m.toFixed(1)}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right font-mono">
                    {(pt.ground_elev_m + pt.obstacle_height_m).toFixed(0)}
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 truncate max-w-[120px]" title={pt.address ?? pt.name ?? ""}>
                    {pt.address || pt.name || "—"}
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 truncate max-w-[80px]" title={pt.usage ?? ""}>
                    {pt.usage || "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
