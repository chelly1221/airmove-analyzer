import { format } from "date-fns";
import type { Flight } from "../../types";

interface Props {
  sectionNum: number;
  flight: Flight;
}

/** 단일비행 상세 보고서: 소실 구간별 심층 분석 */
export default function ReportFlightLossAnalysisSection({ sectionNum, flight }: Props) {
  const segments = flight.loss_segments;
  const lossPoints = flight.loss_points;

  // 시간대별 소실 분포 (1시간 bin)
  const hourBins = new Map<number, number>();
  for (const lp of lossPoints) {
    const hour = new Date(lp.timestamp * 1000).getHours();
    hourBins.set(hour, (hourBins.get(hour) ?? 0) + 1);
  }
  const hourEntries = Array.from(hourBins.entries()).sort((a, b) => a[0] - b[0]);
  let maxHourCount = 1;
  for (const [, c] of hourEntries) if (c > maxHourCount) maxHourCount = c;

  // 거리대별 소실 분포 (20km bin)
  const distBins = new Map<string, number>();
  for (const lp of lossPoints) {
    const binStart = Math.floor(lp.radar_distance_km / 20) * 20;
    const binLabel = `${binStart}~${binStart + 20}km`;
    distBins.set(binLabel, (distBins.get(binLabel) ?? 0) + 1);
  }
  const distEntries = Array.from(distBins.entries()).sort((a, b) => {
    const na = parseInt(a[0]);
    const nb = parseInt(b[0]);
    return na - nb;
  });
  let maxDistCount = 1;
  for (const [, c] of distEntries) if (c > maxDistCount) maxDistCount = c;

  return (
    <div className="space-y-6">
      <h2 className="border-b-2 border-[#a60739] pb-1 text-[15px] font-bold text-gray-900">
        {sectionNum}. 소실 구간 분석
      </h2>

      {/* Loss Segments 테이블 */}
      {segments.length > 0 && (
        <div>
          <h3 className="mb-2 text-[12px] font-semibold text-gray-700">
            소실 구간 ({segments.length}건)
          </h3>
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr className="bg-[#28283c] text-white">
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium w-6">#</th>
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">시작 시각</th>
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">종료 시각</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">지속(초)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">거리(km)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">시작고도(m)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">끝고도(m)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">레이더거리(km)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">유형</th>
              </tr>
            </thead>
            <tbody>
              {segments.map((seg, idx) => (
                <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">{idx + 1}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">
                    {format(new Date(seg.start_time * 1000), "HH:mm:ss")}
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">
                    {format(new Date(seg.end_time * 1000), "HH:mm:ss")}
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right">{seg.duration_secs.toFixed(1)}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right">{seg.distance_km.toFixed(1)}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right">{seg.start_altitude.toFixed(0)}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right">{seg.end_altitude.toFixed(0)}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right">
                    {seg.start_radar_dist_km.toFixed(1)}~{seg.end_radar_dist_km.toFixed(1)}
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">
                    <span className={`rounded px-1 py-0.5 text-[9px] font-medium ${
                      seg.loss_type === "signal_loss"
                        ? "bg-red-100 text-red-700"
                        : "bg-orange-100 text-orange-700"
                    }`}>
                      {seg.loss_type === "signal_loss" ? "소실" : "범위이탈"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Loss Points 테이블 */}
      {lossPoints.length > 0 && (
        <div>
          <h3 className="mb-2 text-[12px] font-semibold text-gray-700">
            미탐지 포인트 ({lossPoints.length}건)
          </h3>
          <table className="w-full border-collapse text-[10px]">
            <thead>
              <tr className="bg-[#28283c] text-white">
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium w-6">#</th>
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">예상시각</th>
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">스캔</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">gap(초)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">레이더(km)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-right font-medium">고도(m)</th>
                <th className="border border-gray-300 px-1.5 py-1 text-center font-medium">유형</th>
              </tr>
            </thead>
            <tbody>
              {lossPoints.slice(0, 100).map((pt, idx) => (
                <tr key={idx} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">{idx + 1}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">
                    {format(new Date(pt.timestamp * 1000), "HH:mm:ss")}
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">
                    {pt.scan_index}/{pt.total_missed_scans}
                  </td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right">{pt.gap_duration_secs.toFixed(1)}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right">{pt.radar_distance_km.toFixed(1)}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-right">{pt.altitude.toFixed(0)}</td>
                  <td className="border border-gray-200 px-1.5 py-1 text-center">
                    <span className={`rounded px-1 py-0.5 text-[9px] font-medium ${
                      pt.loss_type === "signal_loss"
                        ? "bg-red-100 text-red-700"
                        : "bg-orange-100 text-orange-700"
                    }`}>
                      {pt.loss_type === "signal_loss" ? "소실" : "범위이탈"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {lossPoints.length > 100 && (
            <p className="mt-1 text-[9px] text-gray-400">
              ... 외 {lossPoints.length - 100}건 (총 {lossPoints.length}건)
            </p>
          )}
        </div>
      )}

      {/* 분포 분석 차트 */}
      {lossPoints.length > 0 && (
        <div className="grid grid-cols-2 gap-6">
          {/* 시간대별 분포 */}
          {hourEntries.length > 0 && (
            <div>
              <h3 className="mb-2 text-[11px] font-semibold text-gray-700">시간대별 소실 분포</h3>
              <svg width="100%" viewBox={`0 0 280 ${hourEntries.length * 20 + 10}`} className="overflow-visible">
                {hourEntries.map(([hour, count], i) => {
                  const barW = (count / maxHourCount) * 160;
                  const y = i * 20 + 5;
                  return (
                    <g key={hour}>
                      <text x={48} y={y + 13} textAnchor="end" fontSize={9} fill="#666">
                        {String(hour).padStart(2, "0")}시
                      </text>
                      <rect x={55} y={y + 2} width={Math.max(barW, 2)} height={14} rx={2} fill="#ef4444" opacity={0.7} />
                      <text x={60 + barW} y={y + 13} fontSize={9} fill="#333" fontWeight="600">
                        {count}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          )}

          {/* 거리대별 분포 */}
          {distEntries.length > 0 && (
            <div>
              <h3 className="mb-2 text-[11px] font-semibold text-gray-700">레이더 거리별 소실 분포</h3>
              <svg width="100%" viewBox={`0 0 280 ${distEntries.length * 20 + 10}`} className="overflow-visible">
                {distEntries.map(([label, count], i) => {
                  const barW = (count / maxDistCount) * 130;
                  const y = i * 20 + 5;
                  return (
                    <g key={label}>
                      <text x={78} y={y + 13} textAnchor="end" fontSize={9} fill="#666">
                        {label}
                      </text>
                      <rect x={85} y={y + 2} width={Math.max(barW, 2)} height={14} rx={2} fill="#f97316" opacity={0.7} />
                      <text x={90 + barW} y={y + 13} fontSize={9} fill="#333" fontWeight="600">
                        {count}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
        </div>
      )}

      {/* 소실 없음 */}
      {lossPoints.length === 0 && segments.length === 0 && (
        <div className="rounded border border-green-200 bg-green-50 p-4 text-center text-[12px] text-green-700">
          해당 비행에서 표적소실이 발생하지 않았습니다.
        </div>
      )}
    </div>
  );
}
