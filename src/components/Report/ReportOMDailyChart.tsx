import React from "react";
import { Calendar } from "lucide-react";
import type { DailyStats } from "../../types";
import { weightedAvg, weightedStdDev, LOSS_DEV_THRESHOLD, PSR_DEV_THRESHOLD } from "../../utils/omStats";
import ReportOMSectionHeader from "./ReportOMSectionHeader";

interface Props {
  sectionNum: number;
  mode: "psr" | "loss";
  radarName: string;
  dailyStats: DailyStats[];
  /** 차트 상단 조건 설명 */
  conditions?: string[];
  /** 분석 대상 월 (YYYY-MM) */
  analysisMonth?: string;
  /** true면 헤더 생략 (OMSectionImage 래핑 시 외부에서 헤더 렌더) */
  hideHeader?: boolean;
}

const BAR_COLOR = { psr: "#3b82f6", loss: "#ef4444" } as const;
const BASELINE_COLOR = "#9ca3af";
const DEV_POS_COLOR = "#dc2626"; // 편차 양(+) = 분석구간이 더 높음 → 장애물 영향 의심
const DEV_NEG_COLOR = "#22c55e"; // 편차 음(-) = 분석구간이 더 낮음

function ReportOMDailyChart({ sectionNum, mode, radarName, dailyStats, conditions, analysisMonth, hideHeader }: Props) {
  if (dailyStats.length === 0) return (
    <div className="mb-8">
      {!hideHeader && (
        <ReportOMSectionHeader
          sectionNum={sectionNum}
          title={`일별 ${mode === "psr" ? "PSR 탐지율" : "표적소실율"}`}
          radarName={radarName}
        />
      )}
      <div className="flex flex-col items-center py-12 text-gray-400">
        <Calendar size={28} strokeWidth={1.2} className="mb-2" />
        <p className="text-sm">해당 기간 분석 데이터 없음</p>
        <p className="mt-1 text-xs">방위 섹터/거리 필터 조건 또는 분석월을 확인하세요</p>
      </div>
    </div>
  );

  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";
  const title = mode === "psr"
    ? `${monthLabel ? monthLabel + " " : ""}일별 PSR 탐지율`
    : `${monthLabel ? monthLabel + " " : ""}일별 표적소실율`;
  const xLabel = mode === "psr" ? "PSR율 (%)" : "표적소실율 (%)";
  const color = BAR_COLOR[mode];

  // 베이스라인 데이터 존재 여부
  // 양쪽 모두 확인 — baseline_loss_rate가 정확히 0인 정상 데이터 누락 방지
  const hasBaseline = dailyStats.some((d) => d.baseline_loss_rate > 0 || d.baseline_psr_rate > 0);

  // 데이터 준비
  const maxDay = Math.max(...dailyStats.map((d) => d.day_of_month), 28);
  const dayDataMap = new Map(dailyStats.map((d) => [d.day_of_month, d]));
  const allDays = Array.from({ length: maxDay }, (_, i) => i + 1);
  const values = allDays.map((day) => {
    const d = dayDataMap.get(day);
    if (!d) return 0;
    return mode === "psr" ? d.psr_rate * 100 : d.loss_rate;
  });
  const baselineValues = allDays.map((day) => {
    const d = dayDataMap.get(day);
    if (!d) return 0;
    return mode === "psr" ? d.baseline_psr_rate * 100 : d.baseline_loss_rate;
  });
  const deviations = allDays.map((_, i) => {
    if (values[i] === 0 && baselineValues[i] === 0) return 0;
    return values[i] - baselineValues[i];
  });
  const maxVal = Math.max(...values, ...baselineValues, mode === "psr" ? 100 : 0.1) * 1.1;
  // 가중 평균 x̄_w = Σ(w·x) / Σ(w)
  // PSR: 가중치 = SSR포인트수 (분모가 클수록 안정적), Loss: 가중치 = 비행시간(초)
  const getVal = (d: DailyStats) => mode === "psr" ? d.psr_rate * 100 : d.loss_rate;
  const getWeight = (d: DailyStats) => mode === "psr" ? d.ssr_combined_points : d.total_track_time_secs;
  // 가중치 > 0인 일자만 평균 계산 (데이터 없는 일자 제외 — 0값 편향 방지)
  const activeDays = dailyStats.filter((d) => getWeight(d) > 0);
  const avg = activeDays.length > 0 ? weightedAvg(activeDays, getVal, getWeight) : 0;
  // σ_w = √( Σ(w·(x - x̄)²) / Σ(w) ) — 일별 산포 (관측량 가중)
  const sigma = activeDays.length > 0 ? weightedStdDev(activeDays, getVal, getWeight) : 0;
  const getBaseVal = (d: DailyStats) => mode === "psr" ? d.baseline_psr_rate * 100 : d.baseline_loss_rate;
  const baselineDays = dailyStats.filter((d) => getBaseVal(d) > 0);
  const avgBaseline = baselineDays.length > 0 ? weightedAvg(baselineDays, getBaseVal, getWeight) : 0;

  // SVG 레이아웃 (한 페이지 채움, 섹션 제목은 SVG 외부 h2)
  const condLineCount = conditions?.length ?? 0;
  const condH = condLineCount > 0 ? 14 + condLineCount * 15 : 0;
  // 범례+평균 라벨 공간: 조건 박스 아래 32px 여백
  const legendH = hasBaseline ? 32 : 20;
  const svgW = 720;
  const svgH = 920;
  const margin = { top: 10 + condH + legendH, right: 70, bottom: hasBaseline ? 50 : 36, left: 42 };
  const plotW = svgW - margin.left - margin.right;
  const plotH = svgH - margin.top - margin.bottom;

  const rowH = plotH / maxDay;
  const barH = Math.min(rowH * (hasBaseline ? 0.35 : 0.7), hasBaseline ? 12 : 22);
  const yCenter = (day: number) => margin.top + (day - 0.5) * rowH;
  const xScale = (v: number) => margin.left + (v / maxVal) * plotW;

  // X축 눈금
  const xTicks: number[] = [];
  const xStep = maxVal > 50 ? 10 : maxVal > 10 ? 5 : maxVal > 2 ? 1 : maxVal > 0.5 ? 0.2 : 0.1;
  for (let v = 0; v <= maxVal + xStep * 0.01; v += xStep) {
    xTicks.push(Math.round(v * 1000) / 1000);
  }

  // 편차 통계 (가중 평균 간 차이 — 일별 단순 평균 대신 가중 평균 사용)
  const avgDev = avg - avgBaseline;
  const devThreshold = mode === "psr" ? PSR_DEV_THRESHOLD : LOSS_DEV_THRESHOLD;
  // Loss: 양(+)이면 나쁨, PSR: 음(-)이면 나쁨
  const avgDevBad = mode === "loss" ? avgDev > devThreshold : avgDev < -devThreshold;
  const avgDevSimilar = Math.abs(avgDev) <= devThreshold;
  const avgDevLabel = avgDevBad ? "(장애물 영향 의심)" : avgDevSimilar ? "(유사 수준)" : "(분석구간 양호)";
  const avgDevColor = avgDevBad ? DEV_POS_COLOR : avgDevSimilar ? "#9ca3af" : DEV_NEG_COLOR;

  return (
    <div className="mb-8">
      {!hideHeader && <ReportOMSectionHeader sectionNum={sectionNum} title={title} radarName={radarName} />}

      <svg viewBox={`0 0 ${svgW} ${svgH}`} className="w-full" style={{ aspectRatio: `${svgW}/${svgH}` }}>
        <rect x={0} y={0} width={svgW} height={svgH} fill="#fafafa" rx={3} />

        {/* 분석 조건 박스 */}
        {condLineCount > 0 && (
          <g>
            <rect
              x={margin.left}
              y={4}
              width={plotW + margin.right}
              height={condH - 4}
              fill="#f3f4f6"
              rx={3}
              stroke="#e5e7eb"
              strokeWidth={0.5}
            />
            {conditions!.map((c, i) => (
              <text key={i} x={margin.left + 10} y={19 + i * 15} fill="#6b7280" fontSize={10}>
                {c}
              </text>
            ))}
          </g>
        )}

        {/* X축 그리드 + 라벨 */}
        {xTicks.map((v) => (
          <g key={`x-${v}`}>
            <line
              x1={xScale(v)}
              y1={margin.top}
              x2={xScale(v)}
              y2={svgH - margin.bottom}
              stroke="#e5e7eb"
              strokeWidth={0.5}
              strokeDasharray={v === 0 ? undefined : "3,3"}
            />
            <text x={xScale(v)} y={svgH - margin.bottom + 16} textAnchor="middle" fill="#9ca3af" fontSize={9}>
              {v < 1 ? v.toFixed(1) : v.toFixed(0)}
            </text>
          </g>
        ))}

        {/* 평균 수직선 (분석 구간) */}
        {avg > 0 && (
          <>
            <line
              x1={xScale(avg)}
              y1={margin.top}
              x2={xScale(avg)}
              y2={svgH - margin.bottom}
              stroke={color}
              strokeWidth={1}
              strokeDasharray="5,3"
              opacity={0.6}
            />
            <text x={xScale(avg)} y={margin.top - 6} textAnchor="middle" fill={color} fontSize={9.5} fontWeight={600}>
              평균 {avg.toFixed(2)}%{sigma > 0 ? ` ±${sigma.toFixed(2)}` : ""}
            </text>
          </>
        )}

        {/* 평균 수직선 (베이스라인) */}
        {hasBaseline && avgBaseline > 0 && (
          <>
            <line
              x1={xScale(avgBaseline)}
              y1={margin.top}
              x2={xScale(avgBaseline)}
              y2={svgH - margin.bottom}
              stroke={BASELINE_COLOR}
              strokeWidth={1}
              strokeDasharray="2,4"
              opacity={0.5}
            />
            <text x={xScale(avgBaseline)} y={margin.top - 18} textAnchor="middle" fill={BASELINE_COLOR} fontSize={9} fontWeight={500}>
              기준 {avgBaseline.toFixed(2)}%
            </text>
          </>
        )}

        {/* 가로 막대 */}
        {allDays.map((day) => {
          const val = values[day - 1];
          const blVal = baselineValues[day - 1];
          const dev = deviations[day - 1];
          const cy = yCenter(day);
          const hasData = dayDataMap.has(day);
          const barWidth = xScale(val) - margin.left;
          const blBarWidth = xScale(blVal) - margin.left;

          return (
            <g key={`bar-${day}`}>
              {/* 일자 라벨 */}
              <text
                x={margin.left - 6}
                y={cy + (hasBaseline ? 0 : 3.5)}
                textAnchor="end"
                fill={hasData ? "#374151" : "#d1d5db"}
                fontSize={10}
                fontWeight={hasData ? 600 : 400}
              >
                {day}
              </text>

              {/* 행 배경 (짝수) */}
              {day % 2 === 0 && (
                <rect
                  x={margin.left}
                  y={cy - rowH / 2}
                  width={plotW}
                  height={rowH}
                  fill="#f9fafb"
                />
              )}

              {hasBaseline ? (
                /* ── 2행 레이아웃: 분석구간 (위) + 베이스라인 (아래) ── */
                <>
                  {/* 분석 구간 막대 (위) */}
                  {val > 0 && (
                    <>
                      <rect
                        x={margin.left}
                        y={cy - barH - 1}
                        width={Math.max(1, barWidth)}
                        height={barH}
                        fill={color}
                        fillOpacity={0.7}
                        rx={2}
                      />
                      <text
                        x={margin.left + Math.max(1, barWidth) + 4}
                        y={cy - barH / 2 + 2}
                        fill={color}
                        fontSize={8.5}
                        fontWeight={500}
                      >
                        {val.toFixed(val < 1 ? 2 : 1)}%
                      </text>
                    </>
                  )}

                  {/* 베이스라인 막대 (아래) */}
                  {blVal > 0 && (
                    <>
                      <rect
                        x={margin.left}
                        y={cy + 1}
                        width={Math.max(1, blBarWidth)}
                        height={barH}
                        fill={BASELINE_COLOR}
                        fillOpacity={0.4}
                        rx={2}
                      />
                      <text
                        x={margin.left + Math.max(1, blBarWidth) + 4}
                        y={cy + barH / 2 + 4}
                        fill={BASELINE_COLOR}
                        fontSize={8.5}
                        fontWeight={500}
                      >
                        {blVal.toFixed(blVal < 1 ? 2 : 1)}%
                      </text>
                    </>
                  )}

                  {/* 편차 뱃지 (우측) */}
                  {hasData && (val > 0 || blVal > 0) && (
                    <text
                      x={svgW - margin.right + 6}
                      y={cy - 2}
                      fill={(mode === "loss" ? dev > 0 : dev < 0) ? DEV_POS_COLOR : (mode === "loss" ? dev < 0 : dev > 0) ? DEV_NEG_COLOR : "#9ca3af"}
                      fontSize={9}
                      fontWeight={600}
                    >
                      {dev > 0 ? "+" : ""}{dev.toFixed(dev < 1 && dev > -1 ? 2 : 1)}
                    </text>
                  )}
                  {/* N 뱃지 (우측 편차 아래) */}
                  {hasData && (
                    <text x={svgW - margin.right + 6} y={cy + 9} fill="#b0b0b0" fontSize={7}>
                      N={dayDataMap.get(day)!.total_points.toLocaleString()}
                    </text>
                  )}

                  {/* 데이터 없는 날 */}
                  {!hasData && (
                    <text x={margin.left + 6} y={cy + 3} fill="#d1d5db" fontSize={8.5}>
                      —
                    </text>
                  )}
                </>
              ) : (
                /* ── 기존 단일 행 레이아웃 ── */
                <>
                  {val > 0 && (
                    <>
                      <rect
                        x={margin.left}
                        y={cy - barH / 2}
                        width={Math.max(1, barWidth)}
                        height={barH}
                        fill={color}
                        fillOpacity={0.7}
                        rx={2}
                      />
                      <text
                        x={margin.left + Math.max(1, barWidth) + 4}
                        y={cy + 3}
                        fill={color}
                        fontSize={9}
                        fontWeight={500}
                      >
                        {val.toFixed(val < 1 ? 2 : 1)}%
                      </text>
                    </>
                  )}
                  {hasData && (
                    <text x={svgW - margin.right + 6} y={cy + 3} fill="#b0b0b0" fontSize={7}>
                      N={dayDataMap.get(day)!.total_points.toLocaleString()}
                    </text>
                  )}
                  {!hasData && (
                    <text x={margin.left + 6} y={cy + 3} fill="#d1d5db" fontSize={8.5}>
                      —
                    </text>
                  )}
                </>
              )}
            </g>
          );
        })}

        {/* X축 라벨 */}
        <text x={margin.left + plotW / 2} y={svgH - 8} textAnchor="middle" fill="#6b7280" fontSize={10}>
          {xLabel}
        </text>

        {/* Y축 라벨 */}
        <text x={margin.left - 8} y={margin.top - 8} fill="#6b7280" fontSize={9.5} textAnchor="end">
          일
        </text>

        {/* 범례 (조건 박스 아래, 플롯 영역 위) */}
        <g transform={`translate(${svgW - margin.right - (hasBaseline ? 280 : 130)}, ${10 + condH + 2})`}>
          <rect x={0} y={0} width={10} height={10} fill={color} rx={1} opacity={0.7} />
          <text x={13} y={8} fill="#6b7280" fontSize={9}>
            {mode === "psr" ? "PSR 탐지율" : "표적소실율"} (분석 구간)
          </text>
          <line x1={110} y1={5} x2={132} y2={5} stroke={color} strokeWidth={1} strokeDasharray="5,3" opacity={0.6} />
          <text x={135} y={8} fill="#6b7280" fontSize={9}>
            평균
          </text>
          {hasBaseline && (
            <>
              <rect x={160} y={0} width={10} height={10} fill={BASELINE_COLOR} rx={1} opacity={0.4} />
              <text x={173} y={8} fill="#6b7280" fontSize={9}>
                나머지 방위 (기준)
              </text>
            </>
          )}
        </g>

        {/* 편차 요약 (하단, X축 눈금 아래) */}
        {hasBaseline && (
          <g transform={`translate(${svgW - margin.right - 150}, ${svgH - margin.bottom + 28})`}>
            <text x={0} y={0} fill="#6b7280" fontSize={9}>
              평균 편차:
            </text>
            <text
              x={52}
              y={0}
              fill={avgDevColor}
              fontSize={10}
              fontWeight={700}
            >
              {avgDev > 0 ? "+" : ""}{avgDev.toFixed(2)}%p
            </text>
            <text x={110} y={0} fill="#6b7280" fontSize={8.5}>
              {avgDevLabel}
            </text>
          </g>
        )}
      </svg>
    </div>
  );
}

export default React.memo(ReportOMDailyChart);
