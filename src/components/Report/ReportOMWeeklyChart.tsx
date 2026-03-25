import React from "react";
import { Calendar } from "lucide-react";
import type { DailyStats } from "../../types";
import { weightedAvg } from "../../utils/omStats";
import ReportOMSectionHeader from "./ReportOMSectionHeader";

interface Props {
  sectionNum: number;
  radarName: string;
  dailyStats: DailyStats[];
  /** 분석 대상 월 (YYYY-MM) */
  analysisMonth?: string;
  /** true면 헤더 생략 (OMSectionImage 래핑 시 외부에서 헤더 렌더) */
  hideHeader?: boolean;
}

const WEEK_COLOR = "#6b7280"; // 주차 라벨 통일 색상

interface WeekSummary {
  week: number;
  label: string;
  avgPsr: number;
  avgLoss: number;
  days: number;
  baselinePsr: number;
  baselineLoss: number;
}

function ReportOMWeeklyChart({ sectionNum, radarName, dailyStats, analysisMonth, hideHeader }: Props) {
  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";

  if (dailyStats.length === 0) return (
    <div className="mb-8">
      {!hideHeader && (
        <ReportOMSectionHeader
          sectionNum={sectionNum}
          title={`${monthLabel ? `${monthLabel} ` : ""}주차별 비교`}
          radarName={radarName}
        />
      )}
      <div className="flex flex-col items-center py-12 text-gray-400">
        <Calendar size={28} strokeWidth={1.2} className="mb-2" />
        <p className="text-sm">해당 기간 분석 데이터 없음</p>
      </div>
    </div>
  );

  const hasBaseline = dailyStats.some((d) => d.baseline_loss_rate > 0 || d.baseline_psr_rate > 0);

  // 주차별 집계
  const weekMap = new Map<number, DailyStats[]>();
  for (const d of dailyStats) {
    const list = weekMap.get(d.week_num) ?? [];
    list.push(d);
    weekMap.set(d.week_num, list);
  }

  const weeks: WeekSummary[] = [];
  for (const [wk, stats] of weekMap) {
    const avgPsr = weightedAvg(stats, (d) => d.psr_rate * 100, (d) => d.ssr_combined_points);
    const avgLoss = weightedAvg(stats, (d) => d.loss_rate, (d) => d.total_track_time_secs);
    const baselinePsr = weightedAvg(stats, (d) => d.baseline_psr_rate * 100, (d) => d.ssr_combined_points);
    const baselineLoss = weightedAvg(stats, (d) => d.baseline_loss_rate, (d) => d.total_track_time_secs);
    weeks.push({ week: wk, label: `${wk}주차`, avgPsr, avgLoss, days: stats.length, baselinePsr, baselineLoss });
  }
  weeks.sort((a, b) => a.week - b.week);

  // SVG 레이아웃
  const svgW = 720;
  const svgH = hasBaseline ? 290 : 230;
  const margin = { top: 34, right: 80, bottom: hasBaseline ? 68 : 44, left: 50 };
  const plotW = svgW - margin.left - margin.right;
  const plotH = svgH - margin.top - margin.bottom;

  const maxPsr = Math.max(...weeks.map((w) => w.avgPsr), 1) * 1.15;
  const maxLoss = Math.max(...weeks.map((w) => w.avgLoss), ...weeks.map((w) => w.baselineLoss), 0.1) * 1.15;

  const groupW = plotW / (weeks.length + 1);
  const barW = Math.min(groupW * 0.35, 30);

  const xCenter = (i: number) => margin.left + (i + 1) * groupW;
  const yPsr = (v: number) => margin.top + plotH - (v / maxPsr) * plotH;
  const yLoss = (v: number) => margin.top + plotH - (v / maxLoss) * plotH;

  return (
    <div className="mb-8">
      {!hideHeader && (
        <ReportOMSectionHeader
          sectionNum={sectionNum}
          title={`${monthLabel ? `${monthLabel} ` : ""}주차별 비교`}
          radarName={radarName}
        />
      )}

      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full">
        <rect x={0} y={0} width={svgW} height={svgH} fill="#fafafa" rx={3} />

        {/* 그리드 */}
        {[0, 0.25, 0.5, 0.75, 1.0].map((t) => {
          const y = margin.top + plotH * (1 - t);
          return (
            <line
              key={`grid-${t}`}
              x1={margin.left}
              y1={y}
              x2={svgW - margin.right}
              y2={y}
              stroke="#e5e7eb"
              strokeWidth={0.5}
              strokeDasharray="3,3"
            />
          );
        })}

        {/* 주차별 그룹 */}
        {weeks.map((w, i) => {
          const cx = xCenter(i);
          const psrH = Math.max(0, yPsr(0) - yPsr(w.avgPsr));
          const lossH = Math.max(0, yLoss(0) - yLoss(w.avgLoss));
          const lossDev = w.avgLoss - w.baselineLoss;

          return (
            <g key={`wk-${w.week}`}>
              {/* PSR 막대 (좌) */}
              <rect
                x={cx - barW - 1}
                y={yPsr(w.avgPsr)}
                width={barW}
                height={psrH}
                fill="#3b82f6"
                fillOpacity={0.7}
                rx={2}
              />
              <text
                x={cx - barW / 2 - 1}
                y={yPsr(w.avgPsr) - 3}
                textAnchor="middle"
                fill="#3b82f6"
                fontSize={9}
                fontWeight={600}
              >
                {w.avgPsr.toFixed(1)}%
              </text>

              {/* Loss 막대 (우) */}
              <rect
                x={cx + 1}
                y={yLoss(w.avgLoss)}
                width={barW}
                height={lossH}
                fill="#ef4444"
                fillOpacity={0.7}
                rx={2}
              />
              <text
                x={cx + barW / 2 + 1}
                y={yLoss(w.avgLoss) - 3}
                textAnchor="middle"
                fill="#ef4444"
                fontSize={9}
                fontWeight={600}
              >
                {w.avgLoss.toFixed(2)}%
              </text>

              {/* 베이스라인 Loss 표시 (삼각 마커) */}
              {hasBaseline && w.baselineLoss > 0 && (
                <>
                  <line
                    x1={cx + 1}
                    y1={yLoss(w.baselineLoss)}
                    x2={cx + barW + 1}
                    y2={yLoss(w.baselineLoss)}
                    stroke="#9ca3af"
                    strokeWidth={1.2}
                    strokeDasharray="3,2"
                  />
                  <text
                    x={cx + barW + 4}
                    y={yLoss(w.baselineLoss) + 3}
                    fill="#9ca3af"
                    fontSize={8}
                  >
                    기준 {w.baselineLoss.toFixed(2)}%
                  </text>
                </>
              )}

              {/* 주차 라벨 */}
              <text x={cx} y={svgH - margin.bottom + 16} textAnchor="middle" fill={WEEK_COLOR} fontSize={10} fontWeight={600}>
                {w.label}
              </text>
              <text x={cx} y={svgH - margin.bottom + 30} textAnchor="middle" fill="#9ca3af" fontSize={8.5}>
                ({w.days}일)
              </text>
              {/* 편차 텍스트 */}
              {hasBaseline && (
                <text
                  x={cx}
                  y={svgH - margin.bottom + 44}
                  textAnchor="middle"
                  fill={lossDev > 0.05 ? "#dc2626" : lossDev < -0.05 ? "#22c55e" : "#9ca3af"}
                  fontSize={8.5}
                  fontWeight={600}
                >
                  {lossDev > 0 ? "+" : ""}{lossDev.toFixed(2)}%p
                </text>
              )}
            </g>
          );
        })}

        {/* Y축 라벨 */}
        <text x={margin.left - 5} y={margin.top - 8} textAnchor="end" fill="#3b82f6" fontSize={9}>
          PSR율(%)
        </text>
        <text x={svgW - margin.right + 5} y={margin.top - 8} textAnchor="start" fill="#ef4444" fontSize={9}>
          표적소실율(%)
        </text>

        {/* 범례 */}
        <g transform={`translate(${margin.left + plotW / 2 - (hasBaseline ? 130 : 70)}, ${margin.top - 22})`}>
          <rect x={0} y={0} width={10} height={10} fill="#3b82f6" opacity={0.7} rx={1} />
          <text x={13} y={8} fill="#6b7280" fontSize={9}>PSR 탐지율</text>
          <rect x={80} y={0} width={10} height={10} fill="#ef4444" opacity={0.7} rx={1} />
          <text x={93} y={8} fill="#6b7280" fontSize={9}>표적소실율</text>
          {hasBaseline && (
            <>
              <line x1={140} y1={5} x2={162} y2={5} stroke="#9ca3af" strokeWidth={1.2} strokeDasharray="3,2" />
              <text x={165} y={8} fill="#6b7280" fontSize={9}>기준(나머지 방위)</text>
            </>
          )}
        </g>
      </svg>

      {/* 주차별 요약 테이블 */}
      <table className="mt-2 w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-[#28283c] text-white">
            <th className="border border-gray-300 px-2 py-1 font-medium">주차</th>
            <th className="border border-gray-300 px-2 py-1 text-right font-medium">분석일수</th>
            <th className="border border-gray-300 px-2 py-1 text-right font-medium">평균 PSR율(%)</th>
            <th className="border border-gray-300 px-2 py-1 text-right font-medium">평균 표적소실율(%)</th>
            {hasBaseline && (
              <>
                <th className="border border-gray-300 px-2 py-1 text-right font-medium">기준 표적소실율(%)</th>
                <th className="border border-gray-300 px-2 py-1 text-right font-medium">편차(%p)</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {weeks.map((w, i) => {
            const dev = w.avgLoss - w.baselineLoss;
            return (
              <tr key={w.week} className={i % 2 === 0 ? "bg-white" : "bg-gray-50"}>
                <td className="border border-gray-200 px-2 py-1 text-center font-semibold text-gray-700">
                  {w.label}
                </td>
                <td className="border border-gray-200 px-2 py-1 text-right">{w.days}일</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-mono text-blue-600">{w.avgPsr.toFixed(2)}</td>
                <td className="border border-gray-200 px-2 py-1 text-right font-mono text-red-600">{w.avgLoss.toFixed(3)}</td>
                {hasBaseline && (
                  <>
                    <td className="border border-gray-200 px-2 py-1 text-right font-mono text-gray-500">{w.baselineLoss.toFixed(3)}</td>
                    <td className={`border border-gray-200 px-2 py-1 text-right font-mono font-semibold ${
                      dev > 0.05 ? "text-red-600" : dev < -0.05 ? "text-green-600" : "text-gray-500"
                    }`}>
                      {dev > 0 ? "+" : ""}{dev.toFixed(3)}
                    </td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default React.memo(ReportOMWeeklyChart);
