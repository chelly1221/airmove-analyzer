import { format } from "date-fns";
import type { Flight, RadarSite } from "../../types";
import { flightLabel } from "../../utils/flightConsolidation";
import { useAppStore } from "../../store";

interface Props {
  sectionNum: number;
  flights: Flight[];
  radarSite: RadarSite;
}

function getGrade(lossPercent: number): { label: string; color: string; bg: string } {
  if (lossPercent < 1) return { label: "양호", color: "text-green-700", bg: "bg-green-100 border-green-300" };
  if (lossPercent < 5) return { label: "주의", color: "text-yellow-700", bg: "bg-yellow-100 border-yellow-300" };
  return { label: "경고", color: "text-red-700", bg: "bg-red-100 border-red-300" };
}

/** 비행 건별 보고서: 선택 비행 비교 테이블 + 차트 */
export default function ReportFlightComparisonSection({ sectionNum, flights, radarSite }: Props) {
  const aircraft = useAppStore((s) => s.aircraft);

  if (flights.length === 0) return null;

  const totalLoss = flights.reduce((s, f) => s + f.loss_points.length, 0);
  const avgLossPercent = flights.reduce((s, f) => s + f.loss_percentage, 0) / flights.length;
  const totalTrackMin = flights.reduce((s, f) => s + f.total_track_time, 0) / 60;
  const totalLossTime = flights.reduce((s, f) => s + f.total_loss_time, 0);
  const grade = getGrade(avgLossPercent);
  const maxLossPercent = Math.max(...flights.map((f) => f.loss_percentage), 1);

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[15px] font-bold text-gray-900">
        {sectionNum}. 비행 비교 분석
      </h2>

      {/* 종합 요약 */}
      <div className="mb-4 flex items-center gap-3">
        <span className="text-[12px] text-gray-600">종합 판정:</span>
        <span className={`rounded-md border px-3 py-1 text-[13px] font-bold ${grade.bg} ${grade.color}`}>
          {grade.label}
        </span>
        <span className="text-[11px] text-gray-400">
          선택 {flights.length}건 · 평균 소실율 {avgLossPercent.toFixed(1)}%
        </span>
      </div>

      {/* KPI 요약 */}
      <div className="mb-5 grid grid-cols-5 gap-2">
        {[
          { label: "선택 비행", value: `${flights.length}건` },
          { label: "총 소실 건수", value: `${totalLoss}건`, accent: true },
          { label: "평균 소실율", value: `${avgLossPercent.toFixed(1)}%`, accent: true },
          { label: "총 추적시간", value: `${totalTrackMin.toFixed(1)}분` },
          { label: "총 소실시간", value: `${totalLossTime.toFixed(1)}초` },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded border border-gray-200 bg-gray-50 px-2 py-1.5 text-center">
            <div className="text-[9px] text-gray-400">{kpi.label}</div>
            <div className={`text-[14px] font-bold ${kpi.accent ? "text-[#a60739]" : "text-gray-800"}`}>
              {kpi.value}
            </div>
          </div>
        ))}
      </div>

      {/* 비행 비교 테이블 */}
      <h3 className="mb-2 text-[12px] font-semibold text-gray-700">비행별 상세</h3>
      <table className="mb-4 w-full border-collapse text-[10px]">
        <thead>
          <tr className="bg-[#28283c] text-white">
            <th className="border border-gray-300 px-1.5 py-1.5 text-center font-medium w-6">#</th>
            <th className="border border-gray-300 px-1.5 py-1.5 text-left font-medium">비행</th>
            <th className="border border-gray-300 px-1.5 py-1.5 text-center font-medium">시간범위</th>
            <th className="border border-gray-300 px-1.5 py-1.5 text-right font-medium">포인트</th>
            <th className="border border-gray-300 px-1.5 py-1.5 text-right font-medium">추적(분)</th>
            <th className="border border-gray-300 px-1.5 py-1.5 text-right font-medium">소실 건수</th>
            <th className="border border-gray-300 px-1.5 py-1.5 text-right font-medium">소실(초)</th>
            <th className="border border-gray-300 px-1.5 py-1.5 text-right font-medium">소실율(%)</th>
            <th className="border border-gray-300 px-1.5 py-1.5 text-center font-medium">판정</th>
          </tr>
        </thead>
        <tbody>
          {flights.map((f, idx) => {
            const label = flightLabel(f, aircraft);
            const g = getGrade(f.loss_percentage);
            return (
              <tr key={f.id} className={idx % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                <td className="border border-gray-200 px-1.5 py-1 text-center">{idx + 1}</td>
                <td className="border border-gray-200 px-1.5 py-1">{label}</td>
                <td className="border border-gray-200 px-1.5 py-1 text-center text-[9px]">
                  {format(new Date(f.start_time * 1000), "MM-dd HH:mm")}~{format(new Date(f.end_time * 1000), "HH:mm")}
                </td>
                <td className="border border-gray-200 px-1.5 py-1 text-right">{f.track_points.length.toLocaleString()}</td>
                <td className="border border-gray-200 px-1.5 py-1 text-right">{(f.total_track_time / 60).toFixed(1)}</td>
                <td className="border border-gray-200 px-1.5 py-1 text-right">{f.loss_points.length}</td>
                <td className="border border-gray-200 px-1.5 py-1 text-right">{f.total_loss_time.toFixed(1)}</td>
                <td className="border border-gray-200 px-1.5 py-1 text-right font-medium">{f.loss_percentage.toFixed(1)}</td>
                <td className="border border-gray-200 px-1.5 py-1 text-center">
                  <span className={`rounded px-1.5 py-0.5 text-[9px] font-medium border ${g.bg} ${g.color}`}>
                    {g.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {/* 소실율 비교 막대 차트 */}
      {flights.length > 1 && (
        <div>
          <h3 className="mb-2 text-[12px] font-semibold text-gray-700">소실율 비교</h3>
          <svg width="100%" viewBox={`0 0 600 ${flights.length * 28 + 10}`} className="overflow-visible">
            {flights.map((f, i) => {
              const barW = (f.loss_percentage / maxLossPercent) * 380;
              const y = i * 28 + 5;
              const label = flightLabel(f, aircraft);
              const name = label.length > 25 ? label.slice(0, 23) + "…" : label;
              return (
                <g key={f.id}>
                  <text x={165} y={y + 14} textAnchor="end" fontSize={10} fill="#666">
                    {name}
                  </text>
                  <rect x={175} y={y + 2} width={Math.max(barW, 2)} height={16} rx={2} fill="#a60739" opacity={0.8} />
                  <text x={180 + barW} y={y + 14} fontSize={10} fill="#333" fontWeight="600">
                    {f.loss_percentage.toFixed(1)}%
                  </text>
                </g>
              );
            })}
          </svg>
        </div>
      )}

      {/* 레이더 정보 */}
      <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-2.5 text-[10px] text-gray-500">
        레이더: {radarSite.name} ({radarSite.latitude.toFixed(4)}°N, {radarSite.longitude.toFixed(4)}°E) · 지원범위 {radarSite.range_nm}NM
      </div>
    </div>
  );
}
