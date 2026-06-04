import React from "react";
import type { DailyStats } from "../../types";
import { weightedAvg, PSR_DEV_THRESHOLD, LOSS_DEV_THRESHOLD } from "../../utils/omStats";
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
 *  결합 일별 라인 차트 (페이지 2)
 *
 *  PSR 탐지율(상) / 표적소실율(하) 를 한 페이지에 위·아래 라인 패널 두 개로
 *  결합 표시. 시안 락-인 옵션:
 *    combine="stacked"  curve="linear"  markers="dots"  baseband="area"
 *
 *  X 축은 1~maxDay 일자, Y 축은 0~max% 자동 스케일. baseline(전체 방위
 *  평균)이 있으면 옅은 영역(area) + 선으로 함께 표시.
 *
 *  스타일은 reportOmStyles.css 의 `.om-table.weekly-table` (요약표 전용)만
 *  사용; SVG 내부 색상은 인라인. PSR=#3b82f6, Loss=#ef4444, baseline=#9ca3af.
 * ──────────────────────────────────────────────────────────────────────── */

const PSR_COLOR = "#3b82f6";
const LOSS_COLOR = "#ef4444";
const BASELINE_COLOR = "#9ca3af";
const DEV_POS_COLOR = "#dc2626";
const DEV_NEG_COLOR = "#16a34a";

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
  baselineValues: number[];       // 동일 길이; 0 = 베이스라인 없음
  color: string;
  label: string;
  unit: string;
  hasBaseline: boolean;
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

/** 한 라인 차트 패널 (PSR 또는 Loss 1개) */
function LinePanel({ x, y, w, h, days, values, baselineValues, color, label, unit, hasBaseline, hasDataSet, fixedMax, tickValues, tickDecimals, rightLabels }: LinePanelProps) {
  const maxV = fixedMax ?? Math.max(0.001, ...values, ...baselineValues) * 1.18;
  const xs = (day: number) => x + ((day - 1) / Math.max(1, days.length - 1)) * w;
  const ys = (v: number) => y + h - (v / maxV) * h;
  const fmtTick = (v: number) =>
    tickDecimals != null ? v.toFixed(tickDecimals) : (v < 1 ? v.toFixed(2) : v.toFixed(1));

  const valPts: Pt[] = [];
  for (let i = 0; i < days.length; i++) {
    if (hasDataSet.has(days[i])) valPts.push({ x: xs(days[i]), y: ys(values[i]) });
  }
  const basePts: Pt[] = [];
  for (let i = 0; i < days.length; i++) {
    if (hasBaseline && baselineValues[i] > 0) basePts.push({ x: xs(days[i]), y: ys(baselineValues[i]) });
  }
  const valPath = buildLinearPath(valPts);
  const basePath = buildLinearPath(basePts);
  const baseArea = basePts.length > 1
    ? `${basePath} L${basePts[basePts.length - 1].x},${y + h} L${basePts[0].x},${y + h} Z`
    : "";

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

      {/* 기준선 영역(baseband="area") + 윗선 */}
      {hasBaseline && basePts.length > 1 && (
        <>
          <path d={baseArea} fill={color} fillOpacity={0.08} stroke="none" />
          <path d={basePath} fill="none" stroke={BASELINE_COLOR} strokeWidth={1.2} opacity={0.75} />
        </>
      )}

      {/* 분석 라인 */}
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
  hasBaseline: boolean;
  psrAvg: number;
  psrBaseAvg: number;
  lossAvg: number;
  lossBaseAvg: number;
  monthLabel: string;
  dayCount: number;
}

/** 결합 차트 하단 요약 표 (지표 / 분석 기간 / 분석 평균 / 기준 평균 / 편차) */
function CombinedSummaryTable({ hasBaseline, psrAvg, psrBaseAvg, lossAvg, lossBaseAvg, monthLabel, dayCount, radarName }: SummaryTableProps & { radarName: string }) {
  const psrDev = psrAvg - psrBaseAvg;
  const lossDev = lossAvg - lossBaseAvg;
  const psrDevColor =
    psrDev < -PSR_DEV_THRESHOLD ? DEV_POS_COLOR : psrDev > PSR_DEV_THRESHOLD ? DEV_NEG_COLOR : "#6b7280";
  const lossDevColor =
    lossDev > LOSS_DEV_THRESHOLD ? DEV_POS_COLOR : lossDev < -LOSS_DEV_THRESHOLD ? DEV_NEG_COLOR : "#6b7280";
  const dotStyle = (color: string): React.CSSProperties => ({
    display: "inline-block", width: 8, height: 8, background: color, borderRadius: 2, marginRight: 6,
  });

  return (
    <table className="om-table weekly-table">
      <thead>
        <tr>
          <th><OMEditable id={`daily.${radarName}.col.metric`} value="지표" tag="span" /></th>
          <th className="ta-r"><OMEditable id={`daily.${radarName}.col.period`} value="분석 기간" tag="span" /></th>
          <th className="ta-r"><OMEditable id={`daily.${radarName}.col.avg`} value="분석 평균" tag="span" /></th>
          {hasBaseline && <th className="ta-r"><OMEditable id={`daily.${radarName}.col.base`} value="기준 평균" tag="span" /></th>}
          {hasBaseline && <th className="ta-r"><OMEditable id={`daily.${radarName}.col.dev`} value="편차(%p)" tag="span" /></th>}
        </tr>
      </thead>
      <tbody>
        <tr>
          <td className="strong"><span style={dotStyle(PSR_COLOR)} /><OMEditable id={`daily.${radarName}.row.psr`} value="PSR 탐지율" tag="span" /></td>
          <td className="ta-r">{monthLabel} · {dayCount}일</td>
          <td className="ta-r mono strong" style={{ color: PSR_COLOR }}>{psrAvg.toFixed(2)}%</td>
          {hasBaseline && <td className="ta-r mono muted">{psrBaseAvg.toFixed(2)}%</td>}
          {hasBaseline && <td className="ta-r mono strong" style={{ color: psrDevColor }}>{psrDev > 0 ? "+" : ""}{psrDev.toFixed(2)}</td>}
        </tr>
        <tr className="alt">
          <td className="strong"><span style={dotStyle(LOSS_COLOR)} /><OMEditable id={`daily.${radarName}.row.loss`} value="표적소실율" tag="span" /></td>
          <td className="ta-r">{monthLabel} · {dayCount}일</td>
          <td className="ta-r mono strong" style={{ color: LOSS_COLOR }}>{lossAvg.toFixed(3)}%</td>
          {hasBaseline && <td className="ta-r mono muted">{lossBaseAvg.toFixed(3)}%</td>}
          {hasBaseline && <td className="ta-r mono strong" style={{ color: lossDevColor }}>{lossDev > 0 ? "+" : ""}{lossDev.toFixed(3)}</td>}
        </tr>
      </tbody>
    </table>
  );
}

function ReportOMCombinedDailyChart({ sectionNum, radarName, dailyStats, analysisMonth, conditions }: Props) {
  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";
  const title = `일별 PSR 탐지율 · 표적소실율`;

  if (dailyStats.length === 0) {
    return (
      <ReportPage>
        <ReportOMSectionHeader sectionNum={sectionNum} title={title} radarName={radarName} editId={`daily.${radarName}.title`} />
        <div className="empty"><p className="sm">해당 기간 분석 데이터 없음</p></div>
      </ReportPage>
    );
  }

  const hasBaseline = dailyStats.some((d) => d.baseline_loss_rate > 0 || d.baseline_psr_rate > 0);
  const maxDay = Math.max(...dailyStats.map((d) => d.day_of_month), 28);
  const dayDataMap = new Map<number, DailyStats>(dailyStats.map((d) => [d.day_of_month, d]));
  const hasDataSet = new Set<number>(dayDataMap.keys());
  const days = Array.from({ length: maxDay }, (_, i) => i + 1);
  const psrVals = days.map((d) => {
    const r = dayDataMap.get(d);
    return r ? r.psr_rate * 100 : 0;
  });
  const psrBase = days.map((d) => {
    const r = dayDataMap.get(d);
    return r ? r.baseline_psr_rate * 100 : 0;
  });
  const lossVals = days.map((d) => {
    const r = dayDataMap.get(d);
    return r ? r.loss_rate : 0;
  });
  const lossBase = days.map((d) => {
    const r = dayDataMap.get(d);
    return r ? r.baseline_loss_rate : 0;
  });

  // 가중 평균 — 시안과 동일 가중치(PSR: SSR 포인트, Loss: 비행시간)
  const psrAvg = weightedAvg(
    dailyStats.filter((d) => d.ssr_combined_points > 0),
    (d) => d.psr_rate * 100,
    (d) => d.ssr_combined_points,
  );
  const psrBaseAvg = weightedAvg(
    dailyStats.filter((d) => d.ssr_combined_points > 0),
    (d) => d.baseline_psr_rate * 100,
    (d) => d.ssr_combined_points,
  );
  const lossAvg = weightedAvg(
    dailyStats.filter((d) => d.total_track_time_secs > 0),
    (d) => d.loss_rate,
    (d) => d.total_track_time_secs,
  );
  const lossBaseAvg = weightedAvg(
    dailyStats.filter((d) => d.total_track_time_secs > 0),
    (d) => d.baseline_loss_rate,
    (d) => d.total_track_time_secs,
  );

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
          days={days} values={psrVals} baselineValues={psrBase}
          color={PSR_COLOR} label="PSR 탐지율" unit="(%)"
          hasBaseline={hasBaseline} hasDataSet={hasDataSet}
          fixedMax={100} tickValues={[0, 20, 40, 60, 80, 100]} tickDecimals={0} rightLabels
        />
        {/* 하단 패널: 표적소실율 */}
        <LinePanel
          x={panelX} y={top1} w={panelW} h={panelH}
          days={days} values={lossVals} baselineValues={lossBase}
          color={LOSS_COLOR} label="표적소실율" unit="(%)"
          hasBaseline={hasBaseline} hasDataSet={hasDataSet}
        />

        {/* X 축 라벨 */}
        <text x={panelX + panelW / 2} y={svgH - 6} textAnchor="middle" fill="#6b7280" fontSize={10}>
          일자 (1~{maxDay}일)
        </text>
      </svg>

      <CombinedSummaryTable
        hasBaseline={hasBaseline}
        psrAvg={psrAvg} psrBaseAvg={psrBaseAvg}
        lossAvg={lossAvg} lossBaseAvg={lossBaseAvg}
        monthLabel={monthLabel} dayCount={dailyStats.length}
        radarName={radarName}
      />
    </ReportPage>
  );
}

export default React.memo(ReportOMCombinedDailyChart);
