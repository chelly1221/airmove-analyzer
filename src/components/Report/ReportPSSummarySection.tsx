import type { PreScreeningResult, ManualBuilding, RadarSite } from "../../types";

interface Props {
  sectionNum: number;
  result: PreScreeningResult;
  buildings: ManualBuilding[];
  radars: RadarSite[];
  analysisMonth?: string;
}

export default function ReportPSSummarySection({
  sectionNum,
  result,
  buildings,
  radars,
  analysisMonth,
}: Props) {
  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";

  // 전체 추가 Loss 집계
  const totalAdditionalLoss = result.radar_results.reduce(
    (sum, rr) => sum + rr.building_results.reduce((s, br) => s + br.additional_loss_events.length, 0),
    0,
  );
  const totalAdditionalTimeSecs = result.radar_results.reduce(
    (sum, rr) => sum + rr.building_results.reduce((s, br) => s + br.additional_loss_time_secs, 0),
    0,
  );
  const totalAffectedAircraft = new Set(
    result.radar_results.flatMap((rr) =>
      rr.building_results.flatMap((br) => br.additional_loss_events.map((e) => e.mode_s)),
    ),
  ).size;

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[19px] font-bold text-gray-900">
        {sectionNum}. 사전검토 요약{monthLabel && ` (${monthLabel})`}
      </h2>

      {/* KPI 그리드 */}
      <div className="mb-5 grid grid-cols-4 gap-3">
        {[
          { label: "분석 레이더", value: radars.length, unit: "개" },
          { label: "검토 건물", value: buildings.length, unit: "개" },
          { label: "추가 Loss 이벤트", value: totalAdditionalLoss, unit: "건" },
          { label: "영향 항공기", value: totalAffectedAircraft, unit: "대" },
        ].map(({ label, value, unit }) => (
          <div key={label} className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-center">
            <div className="text-[10px] text-gray-400">{label}</div>
            <div className="text-[22px] font-bold text-gray-800">{value}<span className="text-[12px] font-normal text-gray-400 ml-0.5">{unit}</span></div>
          </div>
        ))}
      </div>

      {/* 총 추가 Loss 시간 */}
      {totalAdditionalTimeSecs > 0 && (
        <div className="mb-5 rounded-lg border border-red-200 bg-red-50 p-3">
          <span className="text-[12px] font-semibold text-red-700">
            총 추가 표적소실 시간: {formatDuration(totalAdditionalTimeSecs)}
          </span>
        </div>
      )}

      {/* 대상 레이더 */}
      <h3 className="mb-2 text-[14px] font-semibold text-gray-700">분석 레이더</h3>
      <table className="mb-4 w-full text-[11px]">
        <thead>
          <tr className="border-b border-gray-300 bg-gray-100 text-gray-500">
            <th className="px-2 py-1 text-left">레이더</th>
            <th className="px-2 py-1 text-right">파일 수</th>
            <th className="px-2 py-1 text-right">분석 포인트</th>
            <th className="px-2 py-1 text-left">분석 기간</th>
          </tr>
        </thead>
        <tbody>
          {result.radar_results.map((rr) => (
            <tr key={rr.radar_name} className="border-b border-gray-100">
              <td className="px-2 py-1 font-medium text-gray-700">{rr.radar_name}</td>
              <td className="px-2 py-1 text-right text-gray-600">{rr.total_files_parsed}</td>
              <td className="px-2 py-1 text-right text-gray-600">{rr.total_points_in_sectors.toLocaleString()}</td>
              <td className="px-2 py-1 text-gray-500">{rr.analysis_period}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* 대상 건물 */}
      <h3 className="mb-2 text-[14px] font-semibold text-gray-700">검토 대상 건물</h3>
      <table className="w-full text-[11px]">
        <thead>
          <tr className="border-b border-gray-300 bg-gray-100 text-gray-500">
            <th className="px-2 py-1 text-left">건물명</th>
            <th className="px-2 py-1 text-right">높이 (m)</th>
            <th className="px-2 py-1 text-right">지면고 (m)</th>
            <th className="px-2 py-1 text-right">좌표</th>
          </tr>
        </thead>
        <tbody>
          {buildings.map((b) => (
            <tr key={b.id} className="border-b border-gray-100">
              <td className="px-2 py-1 font-medium text-gray-700">{b.name || `건물 ${b.id}`}</td>
              <td className="px-2 py-1 text-right text-gray-600">{b.height.toFixed(1)}</td>
              <td className="px-2 py-1 text-right text-gray-600">{b.ground_elev.toFixed(1)}</td>
              <td className="px-2 py-1 text-right text-gray-500 font-mono text-[10px]">
                {b.latitude.toFixed(5)}°N {b.longitude.toFixed(5)}°E
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function formatDuration(secs: number): string {
  if (secs < 60) return `${secs.toFixed(0)}초`;
  if (secs < 3600) return `${Math.floor(secs / 60)}분 ${Math.floor(secs % 60)}초`;
  return `${Math.floor(secs / 3600)}시간 ${Math.floor((secs % 3600) / 60)}분`;
}
