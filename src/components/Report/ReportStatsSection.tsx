import { format, startOfWeek, subWeeks, isWithinInterval } from "date-fns";
import { ko } from "date-fns/locale";
import type { Flight } from "../../types";
import { flightLabel } from "../../utils/flightConsolidation";
import { useAppStore } from "../../store";

interface StatsSectionProps {
  sectionNum: number;
  flights: Flight[];
  template?: "weekly" | "monthly" | "flights" | "single";
}

interface WeekStats {
  label: string;
  start: Date;
  end: Date;
  flights: Flight[];
  totalLoss: number;
  avgLossPercent: number;
  totalLossTime: number;
  totalTrackTime: number;
}

function getWeekStats(flights: Flight[], weeksAgo: number): WeekStats {
  const now = new Date();
  const weekStart = startOfWeek(subWeeks(now, weeksAgo), { locale: ko, weekStartsOn: 1 });
  const weekEnd = startOfWeek(subWeeks(now, weeksAgo - 1), { locale: ko, weekStartsOn: 1 });

  const weekFlights = flights.filter((f) => {
    const d = new Date(f.start_time * 1000);
    return isWithinInterval(d, { start: weekStart, end: weekEnd });
  });

  const totalLoss = weekFlights.reduce((s, f) => s + f.loss_points.length, 0);
  const avgLossPercent = weekFlights.length > 0
    ? weekFlights.reduce((s, f) => s + f.loss_percentage, 0) / weekFlights.length
    : 0;
  const totalLossTime = weekFlights.reduce((s, f) => s + f.total_loss_time, 0);
  const totalTrackTime = weekFlights.reduce((s, f) => s + f.total_track_time, 0);

  const label = `${format(weekStart, "MM/dd")}~${format(weekEnd, "MM/dd")}`;

  return { label, start: weekStart, end: weekEnd, flights: weekFlights, totalLoss, avgLossPercent, totalLossTime, totalTrackTime };
}

export default function ReportStatsSection({ sectionNum, flights, template = "weekly" }: StatsSectionProps) {
  const aircraft = useAppStore((s) => s.aircraft);

  if (flights.length === 0) return null;

  // 주간 보고서: 10주 추이
  const isWeekly = template === "weekly";
  const weeks = isWeekly
    ? Array.from({ length: 10 }, (_, i) => getWeekStats(flights, i))
    : [];

  // 비행검사기별 그룹핑 (OpenSky 매칭된 실제 비행만)
  const realFlights = flights.filter((f) => f.match_type === "opensky");
  const byAircraft = new Map<string, Flight[]>();
  for (const f of realFlights) {
    const name = f.aircraft_name ?? f.mode_s;
    let arr = byAircraft.get(name);
    if (!arr) {
      arr = [];
      byAircraft.set(name, arr);
    }
    arr.push(f);
  }

  // 막대 차트용 최대값
  const maxLossPercent = Math.max(...realFlights.map((f) => f.loss_percentage), 1);

  return (
    <div className="mb-8">
      <h2 className="mb-4 border-b-2 border-[#a60739] pb-1 text-[15px] font-bold text-gray-900">
        {sectionNum}. 분석 통계
      </h2>

      {/* 주간 보고서: 10주 추이 테이블 */}
      {isWeekly && weeks.length > 0 && (
        <div className="mb-6">
          <h3 className="mb-2 text-[12px] font-semibold text-gray-700">주간 변화 추이 (최근 10주)</h3>
          <table className="mb-4 w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-[#28283c] text-white">
                <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">기간</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">비행 수</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">소실 건수</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">평균 소실율(%)</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">소실 시간(초)</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">추적 시간(분)</th>
              </tr>
            </thead>
            <tbody>
              {weeks.map((w, i) => (
                <tr key={i} className={i === 0 ? "bg-[#a60739]/5 font-medium" : i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                  <td className="border border-gray-200 px-2 py-1.5">
                    {w.label}{i === 0 ? " (금주)" : ` (${i}주전)`}
                  </td>
                  <td className="border border-gray-200 px-2 py-1.5 text-right">{w.flights.length}</td>
                  <td className="border border-gray-200 px-2 py-1.5 text-right">{w.totalLoss}</td>
                  <td className="border border-gray-200 px-2 py-1.5 text-right font-medium">
                    {w.flights.length > 0 ? w.avgLossPercent.toFixed(1) : "-"}
                  </td>
                  <td className="border border-gray-200 px-2 py-1.5 text-right">{w.totalLossTime.toFixed(1)}</td>
                  <td className="border border-gray-200 px-2 py-1.5 text-right">{(w.totalTrackTime / 60).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* 추이 차트 (SVG) */}
          <WeeklyTrendChart weeks={weeks} />
        </div>
      )}

      {/* 비행검사기별 비행 분석 (OpenSky 매칭 비행만) */}
      {[...byAircraft.entries()].sort(([a], [b]) => a.localeCompare(b, "ko")).map(([acName, acFlights]) => (
        <div key={acName} className="mb-5">
          <h3 className="mb-2 text-[12px] font-semibold text-gray-700">
            {acName} — 비행별 분석
          </h3>
          <table className="mb-3 w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-[#28283c] text-white">
                <th className="border border-gray-300 px-2 py-1.5 text-left font-medium">비행</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">포인트</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">소실 건수</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">소실 시간(초)</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">추적 시간(분)</th>
                <th className="border border-gray-300 px-2 py-1.5 text-right font-medium">소실율(%)</th>
              </tr>
            </thead>
            <tbody>
              {acFlights.map((f, i) => {
                const label = flightLabel(f, aircraft);
                return (
                  <tr key={i} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                    <td className="border border-gray-200 px-2 py-1.5">{label}</td>
                    <td className="border border-gray-200 px-2 py-1.5 text-right">{f.track_points.length.toLocaleString()}</td>
                    <td className="border border-gray-200 px-2 py-1.5 text-right">{f.loss_points.length}</td>
                    <td className="border border-gray-200 px-2 py-1.5 text-right">{f.total_loss_time.toFixed(1)}</td>
                    <td className="border border-gray-200 px-2 py-1.5 text-right">{(f.total_track_time / 60).toFixed(1)}</td>
                    <td className="border border-gray-200 px-2 py-1.5 text-right font-medium">
                      {f.loss_percentage.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* 비행별 소실율 막대 차트 */}
          {acFlights.length > 1 && (
            <div className="mb-2">
              <svg width="100%" viewBox={`0 0 600 ${acFlights.length * 28 + 10}`} className="overflow-visible">
                {acFlights.map((f, i) => {
                  const barW = (f.loss_percentage / maxLossPercent) * 400;
                  const y = i * 28 + 5;
                  const label = flightLabel(f, aircraft);
                  const name = label.length > 20 ? label.slice(0, 18) + "…" : label;
                  return (
                    <g key={i}>
                      <text x={145} y={y + 14} textAnchor="end" fontSize={10} fill="#666">
                        {name}
                      </text>
                      <rect x={155} y={y + 2} width={Math.max(barW, 2)} height={16} rx={2} fill="#a60739" opacity={0.8} />
                      <text x={160 + barW} y={y + 14} fontSize={10} fill="#333" fontWeight="600">
                        {f.loss_percentage.toFixed(1)}%
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** 주간 추이 차트 (소실율 + 소실 건수) */
function WeeklyTrendChart({ weeks }: { weeks: WeekStats[] }) {
  // 역순 (3주전 → 금주)
  const data = [...weeks].reverse();
  const chartW = 560;
  const chartH = 120;
  const padL = 40;
  const padR = 50;
  const padT = 15;
  const padB = 30;
  const innerW = chartW - padL - padR;
  const innerH = chartH - padT - padB;

  const maxLoss = Math.max(...data.map((w) => w.avgLossPercent), 1);
  const maxCount = Math.max(...data.map((w) => w.totalLoss), 1);

  const barW = innerW / data.length * 0.35;

  return (
    <svg width="100%" viewBox={`0 0 ${chartW} ${chartH}`} className="overflow-visible">
      {/* Y축 좌: 소실율 */}
      <text x={padL - 5} y={padT - 4} textAnchor="end" fontSize={8} fill="#a60739">소실율(%)</text>
      {[0, 0.5, 1].map((r) => {
        const y = padT + innerH * (1 - r);
        return (
          <g key={r}>
            <line x1={padL} y1={y} x2={padL + innerW} y2={y} stroke="#eee" strokeWidth={0.5} />
            <text x={padL - 4} y={y + 3} textAnchor="end" fontSize={8} fill="#999">
              {(maxLoss * r).toFixed(1)}
            </text>
          </g>
        );
      })}
      {/* Y축 우: 건수 */}
      <text x={padL + innerW + 5} y={padT - 4} textAnchor="start" fontSize={8} fill="#3b82f6">건수</text>

      {data.map((w, i) => {
        const cx = padL + (i + 0.5) * (innerW / data.length);
        const lossH = w.avgLossPercent > 0 ? (w.avgLossPercent / maxLoss) * innerH : 0;
        const countH = w.totalLoss > 0 ? (w.totalLoss / maxCount) * innerH : 0;

        return (
          <g key={i}>
            {/* 소실율 막대 */}
            <rect
              x={cx - barW - 1}
              y={padT + innerH - lossH}
              width={barW}
              height={lossH}
              rx={2}
              fill="#a60739"
              opacity={0.7}
            />
            {w.avgLossPercent > 0 && (
              <text x={cx - barW / 2 - 1} y={padT + innerH - lossH - 3} textAnchor="middle" fontSize={8} fill="#a60739" fontWeight="600">
                {w.avgLossPercent.toFixed(1)}
              </text>
            )}

            {/* 소실 건수 막대 */}
            <rect
              x={cx + 1}
              y={padT + innerH - countH}
              width={barW}
              height={countH}
              rx={2}
              fill="#3b82f6"
              opacity={0.6}
            />
            {w.totalLoss > 0 && (
              <text x={cx + barW / 2 + 1} y={padT + innerH - countH - 3} textAnchor="middle" fontSize={8} fill="#3b82f6" fontWeight="600">
                {w.totalLoss}
              </text>
            )}

            {/* X축 라벨 */}
            <text x={cx} y={padT + innerH + 14} textAnchor="middle" fontSize={8} fill="#666">
              {w.label}
            </text>
            <text x={cx} y={padT + innerH + 24} textAnchor="middle" fontSize={7} fill="#999">
              {i === data.length - 1 ? "금주" : `${data.length - 1 - i}주전`}
            </text>
          </g>
        );
      })}

      {/* 범례 */}
      <rect x={padL + innerW - 90} y={padT} width={8} height={8} rx={1} fill="#a60739" opacity={0.7} />
      <text x={padL + innerW - 80} y={padT + 7} fontSize={8} fill="#666">소실율</text>
      <rect x={padL + innerW - 40} y={padT} width={8} height={8} rx={1} fill="#3b82f6" opacity={0.6} />
      <text x={padL + innerW - 30} y={padT + 7} fontSize={8} fill="#666">건수</text>
    </svg>
  );
}
