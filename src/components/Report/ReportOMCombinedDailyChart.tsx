import React from "react";
import type { DailyStats } from "../../types";
import { weightedAvg, weightedTrendSlope } from "../../utils/omStats";
import ReportPage from "./ReportPage";
import ReportOMSectionHeader from "./ReportOMSectionHeader";
import OMEditable from "./OMEditable";

export interface RadarDailySeries {
  radarName: string;
  dailyStats: DailyStats[];
}

interface Props {
  sectionNum: number;
  /** 분석 대상 레이더들 — 2개 이상이면 한 차트에 색상별로 겹쳐 표시 */
  radars: RadarDailySeries[];
  /** 분석 대상 월 (YYYY-MM) */
  analysisMonth?: string;
  /** SVG 상단 회색 조건 박스에 표시할 텍스트 라인 (• 포함) */
  conditions?: string[];
}

/* ──────────────────────────────────────────────────────────────────────────
 *  결합 일별 라인 차트 (페이지 2) — 전 방위(분석 구간 포함 전체 방위) 기준.
 *
 *  PSR 탐지율(상) / 표적소실율(하) 를 한 페이지에 위·아래 라인 패널 두 개로 결합 표시.
 *
 *  ※ 레이더가 여러 개면 각 패널에 레이더별 색상 라인을 한 차트에 겹쳐 그리고,
 *    하단에 레이더 범례를 둔다. 단일 레이더면 PSR=청색 / Loss=적색(메트릭 색).
 *  ※ 메트릭 라벨(PSR 탐지율 / 표적소실율) 박스는 각 패널 좌하단에 배치.
 *  ※ 본선은 전 방위(baseline_*) 시계열. 대상 방위 vs 전방위 비교기준선은 제거됨.
 *
 *  X 축은 1~maxDay 일자, Y 축은 PSR 0~100% 고정 / Loss 데이터 기반 자동 스케일.
 *  스타일은 reportOmStyles.css 의 `.om-table.weekly-table` 만 사용; SVG 색상은 인라인.
 * ──────────────────────────────────────────────────────────────────────── */

const PSR_COLOR = "#3b82f6";
const LOSS_COLOR = "#ef4444";
const TREND_UP_COLOR = "#dc2626";   // 추세 부호 강조용 (적색)
const TREND_DOWN_COLOR = "#16a34a"; // (녹색)
/** 트렌드 색 중립대 (%p) — 이 미만 변화량은 회색 */
const TREND_NEUTRAL = 0.05;

/** 레이더별 라인 색상 팔레트 (2개 이상 겹쳐 표시 시) */
const RADAR_PALETTE = ["#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6", "#0ea5e9", "#ec4899", "#84cc16"];

interface Pt { x: number; y: number }

/** linear 모드 — pts 순서대로 M→L path */
function buildLinearPath(pts: Pt[]): string {
  if (pts.length === 0) return "";
  return pts.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");
}

interface SeriesData {
  /** days.length 와 동일 길이; 0 = 데이터 없음 */
  values: number[];
  color: string;
  /** 데이터가 있는 일자만 집합 (dot 마커/path 점 결정) */
  hasDataSet: Set<number>;
}

interface LinePanelProps {
  x: number; y: number; w: number; h: number;
  days: number[];                 // 1..maxDay
  series: SeriesData[];           // 레이더별 시계열 (색상별로 겹쳐 그림)
  label: string;
  unit: string;
  /** Y축 최대 고정값 (예: PSR 탐지율 100). 없으면 전 series 기반 자동 스케일 */
  fixedMax?: number;
  /** Y축 눈금(격자) 값 직접 지정. 없으면 max 의 0/25/50/75/100% */
  tickValues?: number[];
  /** Y축 눈금 라벨 소수 자릿수 */
  tickDecimals?: number;
  /** 패널 오른쪽에도 Y축 라벨 표시 */
  rightLabels?: boolean;
}

/** 한 라인 차트 패널 — series 를 색상별로 겹쳐 그리고, 메트릭 라벨은 좌하단에 배치 */
function LinePanel({ x, y, w, h, days, series, label, unit, fixedMax, tickValues, tickDecimals, rightLabels }: LinePanelProps) {
  let dataMax = 0.001;
  for (const s of series) for (const v of s.values) if (v > dataMax) dataMax = v;
  const maxV = fixedMax ?? dataMax * 1.18;
  const xs = (day: number) => x + ((day - 1) / Math.max(1, days.length - 1)) * w;
  const ys = (v: number) => y + h - (v / maxV) * h;
  const fmtTick = (v: number) =>
    tickDecimals != null ? v.toFixed(tickDecimals) : (v < 1 ? v.toFixed(2) : v.toFixed(1));

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

      {/* 레이더별 분석 라인 + 마커 (색상별로 겹쳐 그림) */}
      {series.map((s, si) => {
        const pts: Pt[] = [];
        for (let i = 0; i < days.length; i++) {
          if (s.hasDataSet.has(days[i])) pts.push({ x: xs(days[i]), y: ys(s.values[i]) });
        }
        return (
          <g key={`series-${si}`}>
            <path d={buildLinearPath(pts)} fill="none" stroke={s.color} strokeWidth={1.8} />
            {pts.map((p, i) => (
              <circle key={`m-${i}`} cx={p.x} cy={p.y} r={2.2} fill="#fff" stroke={s.color} strokeWidth={1.3} />
            ))}
          </g>
        );
      })}

      {/* 좌하단 메트릭 라벨 박스 (그래프 아래쪽) */}
      <g>
        <rect x={x + 6} y={y + h - 22} width={120} height={18} fill="#fff" fillOpacity={0.9} rx={3} />
        <text x={x + 12} y={y + h - 9} fill="#1f2937" fontSize={10.5} fontWeight={700}>
          {label} <tspan fill="#9ca3af" fontWeight={400} fontSize={9}>{unit}</tspan>
        </text>
      </g>
    </g>
  );
}

interface RadarStat {
  radarName: string;
  /** 겹쳐 표시 시 레이더 색상. 단일 레이더면 null (메트릭 색 사용) */
  color: string | null;
  hasDataSet: Set<number>;
  psrVals: number[];
  lossVals: number[];
  psrAvg: number;
  lossAvg: number;
  /** 트렌드 = 기간 전체 변화량 (%p) — 일별 시계열 가중 회귀 기울기 × 관측기간 */
  psrTrend: number;
  lossTrend: number;
}

/** 결합 차트 하단 요약 표 — 레이더 1줄씩 (분석 기간은 년·월만 표기) */
function CombinedSummaryTable({ rows, monthLabel, multi }: { rows: RadarStat[]; monthLabel: string; multi: boolean }) {
  // PSR: 상승=개선(녹색) / Loss: 상승=악화(적색)
  const trendCell = (val: number, kind: "psr" | "loss") => {
    const color = kind === "psr"
      ? (val > TREND_NEUTRAL ? TREND_DOWN_COLOR : val < -TREND_NEUTRAL ? TREND_UP_COLOR : "#6b7280")
      : (val > TREND_NEUTRAL ? TREND_UP_COLOR : val < -TREND_NEUTRAL ? TREND_DOWN_COLOR : "#6b7280");
    const dec = kind === "psr" ? 2 : 3;
    return (
      <td className="ta-r mono strong" style={{ color }}>
        {val > 0 ? "+" : ""}{val.toFixed(dec)}%p
      </td>
    );
  };
  const swatch = (color: string | null): React.CSSProperties => ({
    display: "inline-block", width: 8, height: 8, background: color ?? "#9ca3af", borderRadius: 2, marginRight: 6,
  });

  return (
    <>
      <table className="om-table weekly-table">
        <thead>
          <tr>
            <th><OMEditable id="daily.col.radar" value="레이더" tag="span" /></th>
            <th className="ta-r"><OMEditable id="daily.col.period" value="분석 기간" tag="span" /></th>
            <th className="ta-r"><OMEditable id="daily.col.psrAvg" value="PSR 탐지율 평균(%)" tag="span" /></th>
            <th className="ta-r"><OMEditable id="daily.col.psrTrend" value="PSR 트렌드(기간 %p)" tag="span" /></th>
            <th className="ta-r"><OMEditable id="daily.col.lossAvg" value="표적소실율 평균(%)" tag="span" /></th>
            <th className="ta-r"><OMEditable id="daily.col.lossTrend" value="표적소실율 트렌드(기간 %p)" tag="span" /></th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.radarName} className={i % 2 === 0 ? "" : "alt"}>
              <td className="strong">
                {multi && <span style={swatch(r.color)} />}
                {r.radarName}
              </td>
              <td className="ta-r">{monthLabel}</td>
              <td className="ta-r mono strong" style={{ color: PSR_COLOR }}>{r.psrAvg.toFixed(2)}%</td>
              {trendCell(r.psrTrend, "psr")}
              <td className="ta-r mono strong" style={{ color: LOSS_COLOR }}>{r.lossAvg.toFixed(3)}%</td>
              {trendCell(r.lossTrend, "loss")}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="muted" style={{ fontSize: "9px", marginTop: 4 }}>
        <OMEditable
          id="daily.trendNote"
          value="트렌드 = 전 방위 일별값의 관측량 가중 최소자승 회귀 기울기 × 관측기간(시작→끝 추정 변화량, %p). PSR 양수=개선, 표적소실율 양수=악화."
          tag="span"
        />
      </p>
    </>
  );
}

function ReportOMCombinedDailyChart({ sectionNum, radars, analysisMonth, conditions }: Props) {
  const monthLabel = analysisMonth
    ? `${analysisMonth.slice(0, 4)}년 ${parseInt(analysisMonth.slice(5, 7))}월`
    : "";
  const title = `일별 PSR 탐지율 · 표적소실율 (전 방위)`;
  const single = radars.length === 1;

  // 데이터가 있는 레이더만 차트에 표시
  const activeRadars = radars.filter((r) => r.dailyStats.length > 0);

  if (activeRadars.length === 0) {
    return (
      <ReportPage>
        <ReportOMSectionHeader sectionNum={sectionNum} title={title} radarName={single ? radars[0]?.radarName : undefined} editId="daily.title" />
        <div className="empty"><p className="sm">해당 기간 분석 데이터 없음</p></div>
      </ReportPage>
    );
  }

  const multi = activeRadars.length > 1;

  // 전 레이더 공통 X축 (1..maxDay)
  let maxDay = 28;
  for (const r of activeRadars) for (const d of r.dailyStats) if (d.day_of_month > maxDay) maxDay = d.day_of_month;
  const days = Array.from({ length: maxDay }, (_, i) => i + 1);

  // 레이더별 전 방위(baseline_*) 시계열 + 가중 평균 + 트렌드
  const radarStats: RadarStat[] = activeRadars.map((r, idx) => {
    const color = multi ? RADAR_PALETTE[idx % RADAR_PALETTE.length] : null;
    const dayMap = new Map<number, DailyStats>(r.dailyStats.map((d) => [d.day_of_month, d]));
    const hasDataSet = new Set<number>(dayMap.keys());
    const psrVals = days.map((d) => { const x = dayMap.get(d); return x ? x.baseline_psr_rate * 100 : 0; });
    const lossVals = days.map((d) => { const x = dayMap.get(d); return x ? x.baseline_loss_rate : 0; });

    // 가중 평균 — 전방위 기준선이므로 전방위 표본량으로 가중 (PSR: baseline_ssr_points, Loss: baseline_track_time_secs)
    const psrAvg = weightedAvg(
      r.dailyStats.filter((d) => d.baseline_ssr_points > 0),
      (d) => d.baseline_psr_rate * 100,
      (d) => d.baseline_ssr_points,
    );
    const lossAvg = weightedAvg(
      r.dailyStats.filter((d) => d.baseline_track_time_secs > 0),
      (d) => d.baseline_loss_rate,
      (d) => d.baseline_track_time_secs,
    );

    // 트렌드 = 가중 회귀 기울기(%p/일) × 관측기간(일)
    const obsDays = r.dailyStats.map((d) => d.day_of_month);
    const daySpan = obsDays.length > 1 ? Math.max(...obsDays) - Math.min(...obsDays) : 0;
    const psrSlope = weightedTrendSlope(
      r.dailyStats.filter((d) => d.baseline_ssr_points > 0).map((d) => ({ x: d.day_of_month, y: d.baseline_psr_rate * 100, w: d.baseline_ssr_points })),
    );
    const lossSlope = weightedTrendSlope(
      r.dailyStats.filter((d) => d.baseline_track_time_secs > 0).map((d) => ({ x: d.day_of_month, y: d.baseline_loss_rate, w: d.baseline_track_time_secs })),
    );

    return {
      radarName: r.radarName, color, hasDataSet, psrVals, lossVals,
      psrAvg, lossAvg, psrTrend: psrSlope * daySpan, lossTrend: lossSlope * daySpan,
    };
  });

  const psrSeries: SeriesData[] = radarStats.map((s) => ({ values: s.psrVals, color: s.color ?? PSR_COLOR, hasDataSet: s.hasDataSet }));
  const lossSeries: SeriesData[] = radarStats.map((s) => ({ values: s.lossVals, color: s.color ?? LOSS_COLOR, hasDataSet: s.hasDataSet }));

  // SVG 레이아웃 — stacked 모드 (조건 문구는 SVG 밖 HTML 로 분리해 편집 가능)
  const svgW = 720;
  const panelH = 220;
  const panelGap = 20;
  const panelX = 50;
  const panelW = svgW - 80; // 좌측 50, 우측 30 (우측 Y 라벨 여백)
  const top0 = 22;
  const top1 = top0 + panelH + panelGap;
  const bottomPanelEnd = top1 + panelH;
  const legendRowH = multi ? 26 : 0; // 다중 레이더 범례 영역
  const svgH = bottomPanelEnd + 36 + legendRowH;

  return (
    <ReportPage>
      <ReportOMSectionHeader sectionNum={sectionNum} title={title} radarName={single ? activeRadars[0].radarName : undefined} editId="daily.title" />

      {/* 조건 박스 (상단 회색) — 편집 가능 HTML */}
      {conditions && conditions.length > 0 && (
        <div className="om-daily-conditions">
          {conditions.map((c, i) => (
            <OMEditable key={i} id={`daily.cond.${i}`} value={c} tag="div" />
          ))}
        </div>
      )}

      <svg viewBox={`0 0 ${svgW} ${svgH}`} style={{ width: "100%" }}>
        {/* 상단 패널: PSR 탐지율 — Y축 0~100% 고정, 우측 라벨 */}
        <LinePanel
          x={panelX} y={top0} w={panelW} h={panelH}
          days={days} series={psrSeries}
          label="PSR 탐지율" unit="(%)"
          fixedMax={100} tickValues={[0, 20, 40, 60, 80, 100]} tickDecimals={0} rightLabels
        />
        {/* 하단 패널: 표적소실율 — 자동 스케일 */}
        <LinePanel
          x={panelX} y={top1} w={panelW} h={panelH}
          days={days} series={lossSeries}
          label="표적소실율" unit="(%)"
        />

        {/* X 축 라벨 */}
        <text x={panelX + panelW / 2} y={bottomPanelEnd + 28} textAnchor="middle" fill="#6b7280" fontSize={10}>
          일자 (1~{maxDay}일)
        </text>

        {/* 레이더 범례 (2개 이상 겹쳐 표시 시) */}
        {multi && radarStats.map((s, i) => {
          const cellW = panelW / radarStats.length;
          const cx = panelX + i * cellW + 8;
          const ly = bottomPanelEnd + 44;
          return (
            <g key={`lg-${i}`}>
              <line x1={cx} y1={ly} x2={cx + 16} y2={ly} stroke={s.color ?? "#000"} strokeWidth={2} />
              <circle cx={cx + 8} cy={ly} r={2.2} fill="#fff" stroke={s.color ?? "#000"} strokeWidth={1.3} />
              <text x={cx + 21} y={ly + 3.5} textAnchor="start" fill="#374151" fontSize={9.5} fontWeight={600}>{s.radarName}</text>
            </g>
          );
        })}
      </svg>

      <CombinedSummaryTable rows={radarStats} monthLabel={monthLabel} multi={multi} />
    </ReportPage>
  );
}

export default React.memo(ReportOMCombinedDailyChart);
