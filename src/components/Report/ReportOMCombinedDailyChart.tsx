import React from "react";
import type { DailyStats } from "../../types";
import { weightedAvg, weightedTrendSlope } from "../../utils/omStats";
import ReportPage from "./ReportPage";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import OMEditable from "./OMEditable";

interface Props {
  sectionNum: number;
  radarName: string;
  dailyStats: DailyStats[];
  /** 분석 대상 월 (YYYY-MM) */
  analysisMonth?: string;
  /** SVG 상단 회색 조건 박스에 표시할 텍스트 라인 (• 포함) */
  conditions?: string[];
}

/* ──────────────────────────────────────────────────────────────────────────
 *  결합 일별 라인 차트 (페이지 2) — 전 방위(분석 구간 포함 전체 방위) 기준.
 *
 *  PSR 탐지율(상) / 표적소실율(하) 를 한 페이지에 위·아래 라인 패널 두 개로
 *  결합 표시. 시안 락-인 옵션:
 *    combine="stacked"  curve="linear"  markers="dots"
 *
 *  ※ 본선은 전 방위(baseline_*) 시계열. 대상 방위 vs 전방위 '비교기준선'은 제거
 *    (방위 비교는 교란요인이 많아 보조 지표로 강등됨 — 이 차트는 전방위 절대값만).
 *
 *  X 축은 1~maxDay 일자, Y 축은 0~max% 자동 스케일.
 *  스타일은 reportOmStyles.css 의 `.om-table.weekly-table` (요약표 전용)만
 *  사용; SVG 내부 색상은 인라인. PSR=#3b82f6, Loss=#ef4444.
 * ──────────────────────────────────────────────────────────────────────── */

const PSR_COLOR = "#3b82f6";
const LOSS_COLOR = "#ef4444";
const TREND_UP_COLOR = "#dc2626";   // 추세 부호 강조용 (적색)
const TREND_DOWN_COLOR = "#16a34a"; // (녹색)
/** 트렌드 색 중립대 (%p) — 이 미만 변화량은 회색 */
const TREND_NEUTRAL = 0.05;

interface Pt { x: number; y: number }

/** linear 모드 — pts 순서대로 M→L path */
function buildLinearPath(pts: Pt[]): string {
  if (pts.length === 0) return "";
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

interface LinePanelProps {
  x: number; y: number; w: number; h: number;
  days: number[];                 // 1..maxDay
  values: number[];               // days.length 와 동일 길이; 0 = 데이터 없음
  color: string;
  label: string;
  unit: string;
  /** 데이터가 있는 일자만 집합 (dot 마커/path 점 결정) */
  hasDataSet: Set<number>;
  /** Y축 최대 고정값 (예: PSR 탐지율 100). 없으면 데이터 기반 자동 스케일 */
  fixedMax?: number;
  /** Y축 눈금(격자) 값 직접 지정. 없으면 max 의 0/25/50/75/100% */
  tickValues?: number[];
  /** Y축 눈금 라벨 소수 자릿수 */
  tickDecimals?: number;
  /** 패널 오른쪽에도 Y축 라벨 표시 */
  rightLabels?: boolean;
}

/** 한 라인 차트 패널 (PSR 또는 Loss 1개) — 전 방위 단일 라인 */
function LinePanel({ x, y, w, h, days, values, color, label, unit, hasDataSet, fixedMax, tickValues, tickDecimals, rightLabels }: LinePanelProps) {
  const maxV = fixedMax ?? Math.max(0.001, ...values) * 1.18;
  const xs = (day: number) => x + ((day - 1) / Math.max(1, days.length - 1)) * w;
  const ys = (v: number) => y + h - (v / maxV) * h;
  const fmtTick = (v: number) =>
    tickDecimals != null ? v.toFixed(tickDecimals) : (v < 1 ? v.toFixed(2) : v.toFixed(1));

  const valPts: Pt[] = [];
  for (let i = 0; i < days.length; i++) {
    if (hasDataSet.has(days[i])) valPts.push({ x: xs(days[i]), y: ys(values[i]) });
  }
  const valPath = buildLinearPath(valPts);

  const yTicks = tickValues ?? [0, 0.25, 0.5, 0.75, 1.0].map((t) => maxV * t);

  return (
    <g>
      {/* 패널 배경 */}
      <rect x={x} y={y} width={w} height={h} fill="#fafafa" stroke="#e5e7eb" strokeWidth={0.5} rx={3} />

      {/* Y 그리드 + 라벨 (축 값별 격자) */}
      {yTicks.map((v, i) => (
        <g key={`yt-${i}`}>
          <line
            x1={x} y1={ys(v)} x2={x + w} y2={ys(v)}
            stroke="#e5e7eb" strokeWidth={0.5}
            strokeDasharray={v === 0 ? undefined : "2,3"}
          />
          <text x={x - 5} y={ys(v) + 3} textAnchor="end" fill="#9ca3af" fontSize={9}>
            {fmtTick(v)}
          </text>
          {rightLabels && (
            <text x={x + w + 5} y={ys(v) + 3} textAnchor="start" fill="#9ca3af" fontSize={9}>
              {fmtTick(v)}
            </text>
          )}
        </g>
      ))}

      {/* X 그리드 (5일 간격 + 1일) */}
      {days.filter((d) => d % 5 === 0 || d === 1).map((d) => (
        <g key={`xt-${d}`}>
          <line x1={xs(d)} y1={y} x2={xs(d)} y2={y + h} stroke="#f3f4f6" strokeWidth={0.5} />
          <text x={xs(d)} y={y + h + 12} textAnchor="middle" fill="#9ca3af" fontSize={8.5}>
            {d}
          </text>
        </g>
      ))}

      {/* 분석 라인 (전 방위) */}
      <path d={valPath} fill="none" stroke={color} strokeWidth={1.8} />

      {/* 마커 (dots) */}
      {valPts.map((p, i) => (
        <circle key={`m-${i}`} cx={p.x} cy={p.y} r={2.2} fill="#fff" stroke={color} strokeWidth={1.3} />
      ))}

      {/* 좌상단 라벨 박스 */}
      <g>
        <rect x={x + 6} y={y + 4} width={140} height={18} fill="#fff" fillOpacity={0.9} rx={3} />
        <circle cx={x + 14} cy={y + 13} r={3.5} fill={color} />
        <text x={x + 22} y={y + 16} fill="#1f2937" fontSize={10.5} fontWeight={700}>{label}</text>
        <text x={x + 22 + label.length * 7 + 6} y={y + 16} fill="#9ca3af" fontSize={9}>{unit}</text>
      </g>
    </g>
  );
}

interface SummaryTableProps {
  psrAvg: number;
  lossAvg: number;
  /** 트렌드 상승률 = 기간 전체 변화량 (%p) — 전방위 일별 시계열 가중 회귀 기울기 × 관측기간 */
  psrTrend: number;
  lossTrend: number;
  monthLabel: string;
  dayCount: number;
}

/** 결합 차트 하단 요약 표 (지표 / 분석 기간 / 분석 평균 / 트렌드 상승률) */
function CombinedSummaryTable({ psrAvg, lossAvg, psrTrend, lossTrend, monthLabel, dayCount, radarName }: SummaryTableProps & { radarName: string }) {
  // PSR: 상승=개선(녹색) / Loss: 상승=악화(적색)
  const psrTrendColor =
    psrTrend > TREND_NEUTRAL ? TREND_DOWN_COLOR : psrTrend < -TREND_NEUTRAL ? TREND_UP_COLOR : "#6b7280";
  const lossTrendColor =
    lossTrend > TREND_NEUTRAL ? TREND_UP_COLOR : lossTrend < -TREND_NEUTRAL ? TREND_DOWN_COLOR : "#6b7280";
  const dotStyle = (color: string): React.CSSProperties => ({
    display: "inline-block", width: 8, height: 8, background: color, borderRadius: 2, marginRight: 6,
  });

  return (
    <>
      <table className="om-table weekly-table">
        <thead>
          <tr>
            <th><OMEditable id={`daily.${radarName}.col.metric`} value="지표" tag="span" /></th>
            <th className="ta-r"><OMEditable id={`daily.${radarName}.col.period`} value="분석 기간" tag="span" /></th>
            <th className="ta-r"><OMEditable id={`daily.${radarName}.col.avg`} value="분석 평균(전방위)" tag="span" /></th>
            <th className="ta-r"><OMEditable id={`daily.${radarName}.col.trend`} value="트렌드 상승률(기간 %p)" tag="span" /></th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="strong"><span style={dotStyle(PSR_COLOR)} /><OMEditable id={`daily.${radarName}.row.psr`} value="PSR 탐지율" tag="span" /></td>
            <td className="ta-r">{monthLabel} · {dayCount}일</td>
            <td className="ta-r mono strong" style={{ color: PSR_COLOR }}>{psrAvg.toFixed(2)}%</td>
            <td className="ta-r mono strong" style={{ color: psrTrendColor }}>{psrTrend > 0 ? "+" : ""}{psrTrend.toFixed(2)}%p</td>
          </tr>
          <tr className="alt">
            <td className="strong"><span style={dotStyle(LOSS_COLOR)} /><OMEditable id={`daily.${radarName}.row.loss`} value="표적소실율" tag="span" /></td>
            <td className="ta-r">{monthLabel} · {dayCount}일</td>
            <td className="ta-r mono strong" style={{ color: LOSS_COLOR }}>{lossAvg.toFixed(3)}%</td>
            <td className="ta-r mono strong" style={{ color: lossTrendColor }}>{lossTrend > 0 ? "+" : ""}{lossTrend.toFixed(3)}%p</td>
          </tr>
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: "9px", marginTop: 4 }}>
        <OMEditable
          id={`daily.${radarName}.trendNote`}
          value="트렌드 상승률 = 전 방위 일별값의 관측량 가중 최소자승 회귀 기울기 × 관측기간(시작→끝 추정 변화량, %p). 양수=상승, 음수=하락."
          tag="span"
        />
      </p>
    </>
  );
}

function ReportOMCombinedDailyChart({ sectionNum, radarName, dailyStats, analysisMonth, conditions }: Props) {
  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";
  const title = `일별 PSR 탐지율 · 표적소실율 (전 방위)`;

  if (dailyStats.length === 0) {
    return (
      <ReportPage>
        <ReportOMSectionHeader sectionNum={sectionNum} title={title} radarName={radarName} editId={`daily.${radarName}.title`} />
        <div className="empty"><p className="sm">해당 기간 분석 데이터 없음</p></div>
      </ReportPage>
    );
  }

  const maxDay = Math.max(...dailyStats.map((d) => d.day_of_month), 28);
  const dayDataMap = new Map<number, DailyStats>(dailyStats.map((d) => [d.day_of_month, d]));
  const hasDataSet = new Set<number>(dayDataMap.keys());
  const days = Array.from({ length: maxDay }, (_, i) => i + 1);
  // 본선 = 전 방위(baseline_*) 시계열
  const psrVals = days.map((d) => {
    const r = dayDataMap.get(d);
    return r ? r.baseline_psr_rate * 100 : 0;
  });
  const lossVals = days.map((d) => {
    const r = dayDataMap.get(d);
    return r ? r.baseline_loss_rate : 0;
  });

  // 가중 평균 (전 방위) — 시안과 동일 가중치(PSR: SSR 포인트, Loss: 비행시간)
  const psrAvg = weightedAvg(
    dailyStats.filter((d) => d.ssr_combined_points > 0),
    (d) => d.baseline_psr_rate * 100,
    (d) => d.ssr_combined_points,
  );
  const lossAvg = weightedAvg(
    dailyStats.filter((d) => d.total_track_time_secs > 0),
    (d) => d.baseline_loss_rate,
    (d) => d.total_track_time_secs,
  );

  // 트렌드 상승률 = 기간 전체 변화량(%p) = 가중 회귀 기울기(%p/일) × 관측기간(일)
  const obsDays = dailyStats.map((d) => d.day_of_month);
  const daySpan = obsDays.length > 1 ? Math.max(...obsDays) - Math.min(...obsDays) : 0;
  const psrSlope = weightedTrendSlope(
    dailyStats
      .filter((d) => d.ssr_combined_points > 0)
      .map((d) => ({ x: d.day_of_month, y: d.baseline_psr_rate * 100, w: d.ssr_combined_points })),
  );
  const lossSlope = weightedTrendSlope(
    dailyStats
      .filter((d) => d.total_track_time_secs > 0)
      .map((d) => ({ x: d.day_of_month, y: d.baseline_loss_rate, w: d.total_track_time_secs })),
  );
  const psrTrend = psrSlope * daySpan;
  const lossTrend = lossSlope * daySpan;

  // SVG 레이아웃 — stacked 모드 락-인 (조건 문구는 SVG 밖 HTML 로 분리해 편집 가능)
  const svgW = 720;
  const panelH = 220;
  const panelGap = 20;
  const panelX = 50;
  const panelW = svgW - 80; // 좌측 50, 우측 30 (우측 Y 라벨 여백)
  const top0 = 22;
  const top1 = top0 + panelH + panelGap;
  const svgH = top0 + panelH + panelGap + panelH + 40;

  return (
    <ReportPage>
      <ReportOMSectionHeader sectionNum={sectionNum} title={title} radarName={radarName} editId={`daily.${radarName}.title`} />

      {/* 조건 박스 (상단 회색) — 편집 가능 HTML */}
      {conditions && conditions.length > 0 && (
        <div className="om-daily-conditions">
          {conditions.map((c, i) => (
            <OMEditable key={i} id={`daily.${radarName}.cond.${i}`} value={c} tag="div" />
          ))}
        </div>
      )}

      <svg viewBox={`0 0 ${svgW} ${svgH}`} style={{ width: "100%" }}>
        {/* 상단 패널: PSR 탐지율 — Y축 0~100% 고정, 축 값별 격자 + 우측 라벨 */}
        <LinePanel
          x={panelX} y={top0} w={panelW} h={panelH}
          days={days} values={psrVals}
          color={PSR_COLOR} label="PSR 탐지율" unit="(%)"
          hasDataSet={hasDataSet}
          fixedMax={100} tickValues={[0, 20, 40, 60, 80, 100]} tickDecimals={0} rightLabels
        />
        {/* 하단 패널: 표적소실율 */}
        <LinePanel
          x={panelX} y={top1} w={panelW} h={panelH}
          days={days} values={lossVals}
          color={LOSS_COLOR} label="표적소실율" unit="(%)"
          hasDataSet={hasDataSet}
        />

        {/* X 축 라벨 */}
        <text x={panelX + panelW / 2} y={svgH - 6} textAnchor="middle" fill="#6b7280" fontSize={10}>
          일자 (1~{maxDay}일)
        </text>
      </svg>

      <CombinedSummaryTable
        psrAvg={psrAvg} lossAvg={lossAvg}
        psrTrend={psrTrend} lossTrend={lossTrend}
        monthLabel={monthLabel} dayCount={dailyStats.length}
        radarName={radarName}
      />
    </ReportPage>
  );
}

export default React.memo(ReportOMCombinedDailyChart);
