/**
 * 토픽: 고도·속도 분포 상세.
 *
 * 대시보드의 1,000ft/50kt 요약을 500ft·10kt 정밀 격자로 확대한다.
 * 고도는 레이더 도메인 관례대로 세로 프로파일(y=고도, 위가 높음), 속도는 가로 스텝 실루엣.
 * 차트는 전부 이 파일 로컬 순수 SVG (공유 모듈 동결) — 전 구간 전수 렌더.
 *
 * fl_fine/speed_fine 은 "관측된 빈"만 오므로 사이의 무관측 구간은 0으로 채워
 * 연속 축을 만든다 (빈 구간이 실루엣에서 그대로 골짜기로 보이게).
 */

import { useMemo, useRef, useState } from "react";
import { CHART_INK, ChartTip, clampTipX, LabeledBars, Section, StatCard } from "../shared";
import type { LabeledCount } from "../../../types/asterix";
import type { AsterixDetailStats, TzMode } from "../../../types/asterixDetail";

// ─── 로컬 상수·유틸 ────────────────────────────────────────────────

/** 고도 프로파일 본체 높이 (px) */
const ALT_CHART_H = 380;
/** 속도 스텝 차트 본체 높이 (viewBox 단위 = px) */
const SPD_CHART_H = 132;
/** 고도 500ft 빈 폭 */
const FL_BIN_FT = 500;
/** 속도 10kt 빈 폭 */
const SPD_BIN_KT = 10;
/** 고도 축 눈금 후보 (ft) — 눈금 8개 이하가 되는 첫 값 채택 */
const ALT_TICK_STEPS = [1000, 2000, 5000, 10000, 20000];
/** 속도 축 눈금 후보 (kt) */
const SPD_TICK_STEPS = [50, 100, 200, 500];

/** Rust fmt_ft_thousands 와 같은 표기 (천 단위 구분 + 음수는 U+2212) */
function fmtFt(ft: number): string {
  const v = Math.round(ft);
  return `${v < 0 ? "−" : ""}${Math.abs(v).toLocaleString()}`;
}

/** 눈금 간격 선택 — 스팬을 8칸 이하로 나누는 첫 후보 */
function pickStep(span: number, candidates: number[]): number {
  for (const s of candidates) if (span / s <= 8) return s;
  return candidates[candidates.length - 1];
}

/** LabeledCount.key(구간 하단값 문자열) → 빈 인덱스 배열로 채워 연속 축 생성 */
function densify(items: LabeledCount[], binWidth: number, forceLo?: number) {
  if (items.length === 0) return { lo: 0, counts: [] as number[] };
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  const map = new Map<number, number>();
  for (const it of items) {
    const b = Math.round(Number(it.key) / binWidth);
    if (!Number.isFinite(b)) continue;
    map.set(b, (map.get(b) ?? 0) + it.count);
    if (b < lo) lo = b;
    if (b > hi) hi = b;
  }
  if (!Number.isFinite(lo)) return { lo: 0, counts: [] as number[] };
  if (forceLo != null && forceLo < lo) lo = forceLo;
  const counts = new Array<number>(hi - lo + 1).fill(0);
  for (const [b, c] of map) counts[b - lo] = c;
  return { lo, counts };
}

/** 빈 중앙값 가중 근사 통계 (중앙값·평균) */
function binApproxStats(lo: number, counts: number[], binWidth: number) {
  let total = 0;
  let sum = 0;
  for (let i = 0; i < counts.length; i++) {
    const c = counts[i];
    if (c <= 0) continue;
    total += c;
    sum += c * (lo + i + 0.5) * binWidth;
  }
  if (total === 0) return null;
  const half = total / 2;
  let cum = 0;
  let medIdx = 0;
  for (let i = 0; i < counts.length; i++) {
    cum += counts[i];
    if (cum >= half) {
      medIdx = i;
      break;
    }
  }
  return { total, mean: sum / total, median: (lo + medIdx + 0.5) * binWidth };
}

// ─── 고도 정밀 프로파일 (500ft · y=고도) ───────────────────────────

/**
 * 세로 프로파일 — y축이 고도(위가 높음), x축이 건수인 가로 막대 실루엣.
 * 레이더/항공 도메인에서 고도 분포는 세로축으로 읽는 것이 자연스럽다.
 */
function AltProfileChart({ lo, counts }: { lo: number; counts: number[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null);

  const n = counts.length;
  const maxCount = useMemo(() => counts.reduce((a, b) => (b > a ? b : a), 0), [counts]);
  const loFt = lo * FL_BIN_FT;
  const hiFt = (lo + n) * FL_BIN_FT;

  // 스텝 실루엣 — viewBox x=0..100(건수 %), y=0..n(빈, 아래가 낮은 고도)
  const { line, area } = useMemo(() => {
    if (n === 0) return { line: "", area: "" };
    const scale = maxCount > 0 ? 100 / maxCount : 0;
    let d = "";
    for (let k = 0; k < n; k++) {
      const x = (counts[k] * scale).toFixed(3);
      d += k === 0 ? `M${x} ${n} L${x} ${n - 1}` : ` L${x} ${n - k} L${x} ${n - k - 1}`;
    }
    return { line: d, area: `${d} L0 0 L0 ${n} Z` };
  }, [counts, n, maxCount]);

  // 고도 눈금 (ft)
  const altTicks = useMemo(() => {
    const span = hiFt - loFt;
    if (span <= 0) return [] as { ft: number; frac: number }[];
    const step = pickStep(span, ALT_TICK_STEPS);
    const first = Math.ceil(loFt / step) * step;
    const out: { ft: number; frac: number }[] = [];
    for (let ft = first; ft <= hiFt; ft += step) out.push({ ft, frac: 1 - (ft - loFt) / span });
    return out;
  }, [loFt, hiFt]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.height <= 0 || n === 0) return;
    const fromTop = (e.clientY - rect.top) / rect.height;
    const idx = Math.min(n - 1, Math.max(0, n - 1 - Math.floor(fromTop * n)));
    const wr = wrap.getBoundingClientRect();
    setHover({ idx, x: clampTipX(e.clientX - wr.left, wr.width) });
  };

  const tipText = (() => {
    if (!hover) return "";
    const b = lo + hover.idx;
    return `${fmtFt(b * FL_BIN_FT)}–${fmtFt((b + 1) * FL_BIN_FT)} ft · ${counts[hover.idx].toLocaleString()}건`;
  })();

  if (n === 0) return <div className="text-[11px] text-gray-400">I048/090 관측 없음</div>;

  return (
    <div ref={wrapRef} className="relative flex gap-2">
      {hover && <ChartTip x={hover.x} text={tipText} />}

      {/* 좌측 고도 눈금 */}
      <div className="relative w-14 shrink-0" style={{ height: ALT_CHART_H }}>
        {altTicks.map((t) => (
          <span
            key={t.ft}
            className="absolute right-0 -translate-y-1/2 whitespace-nowrap text-[9px] tabular-nums text-gray-400"
            style={{ top: `${t.frac * 100}%` }}
          >
            {fmtFt(t.ft)}
          </span>
        ))}
      </div>

      <div className="min-w-0 flex-1">
        <div className="flex">
          {/* 건수 0 기준축 */}
          <div className="w-px shrink-0 bg-gray-200" style={{ height: ALT_CHART_H }} />
          <svg
            viewBox={`0 0 100 ${n}`}
            preserveAspectRatio="none"
            className="block min-w-0 flex-1"
            style={{ height: ALT_CHART_H }}
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
          >
            <g stroke="#e5e7eb" strokeWidth={1} vectorEffect="non-scaling-stroke">
              {altTicks.map((t) => (
                <line key={t.ft} x1={0} x2={100} y1={t.frac * n} y2={t.frac * n} />
              ))}
            </g>
            <path d={area} fill={CHART_INK} opacity={0.15} />
            <path
              d={line}
              fill="none"
              stroke={CHART_INK}
              strokeWidth={1.5}
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
            {hover && (
              <line
                x1={0}
                x2={100}
                y1={n - hover.idx - 0.5}
                y2={n - hover.idx - 0.5}
                stroke={CHART_INK}
                strokeWidth={1}
                opacity={0.45}
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
        </div>
        <div className="h-px w-full bg-gray-200" />
        <div className="relative mt-0.5 h-3">
          {[0, 0.5, 1].map((fr) => (
            <span
              key={fr}
              className="absolute top-0 whitespace-nowrap text-[9px] tabular-nums text-gray-400"
              style={{
                left: `${fr * 100}%`,
                transform: fr === 0 ? "none" : fr === 1 ? "translateX(-100%)" : "translateX(-50%)",
              }}
            >
              {Math.round(maxCount * fr).toLocaleString()}건
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 속도 정밀 분포 (10kt · 스텝 실루엣) ───────────────────────────

function SpeedFineChart({ lo, counts }: { lo: number; counts: number[] }) {
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null);

  const n = counts.length;
  const maxCount = useMemo(() => counts.reduce((a, b) => (b > a ? b : a), 0), [counts]);

  const { line, area } = useMemo(() => {
    if (n === 0) return { line: "", area: "" };
    const scale = maxCount > 0 ? (SPD_CHART_H - 2) / maxCount : 0;
    let d = "";
    for (let i = 0; i < n; i++) {
      const y = (SPD_CHART_H - counts[i] * scale).toFixed(2);
      d += `${i === 0 ? "M" : " L"}${i} ${y} L${i + 1} ${y}`;
    }
    return { line: d, area: `${d} L${n} ${SPD_CHART_H} L0 ${SPD_CHART_H} Z` };
  }, [counts, n, maxCount]);

  const loKt = lo * SPD_BIN_KT;
  const hiKt = (lo + n) * SPD_BIN_KT;
  const ticks = useMemo(() => {
    const span = hiKt - loKt;
    if (span <= 0) return [] as { kt: number; frac: number }[];
    const step = pickStep(span, SPD_TICK_STEPS);
    const first = Math.ceil(loKt / step) * step;
    const out: { kt: number; frac: number }[] = [];
    for (let kt = first; kt <= hiKt; kt += step) out.push({ kt, frac: (kt - loKt) / span });
    return out;
  }, [loKt, hiKt]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || n === 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
    setHover({ idx, x: clampTipX(((idx + 0.5) / n) * rect.width, rect.width) });
  };

  const tipText = (() => {
    if (!hover) return "";
    const b = lo + hover.idx;
    return `${b * SPD_BIN_KT}–${(b + 1) * SPD_BIN_KT}kt · ${counts[hover.idx].toLocaleString()}건`;
  })();

  if (n === 0) return <div className="text-[11px] text-gray-400">I048/200 관측 없음</div>;

  return (
    <div className="relative">
      {hover && <ChartTip x={hover.x} text={tipText} />}
      <svg
        viewBox={`0 0 ${n} ${SPD_CHART_H}`}
        preserveAspectRatio="none"
        className="block w-full"
        style={{ height: SPD_CHART_H }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <path d={area} fill={CHART_INK} opacity={0.15} />
        <path
          d={line}
          fill="none"
          stroke={CHART_INK}
          strokeWidth={1.5}
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
        {hover && (
          <line
            x1={hover.idx + 0.5}
            x2={hover.idx + 0.5}
            y1={0}
            y2={SPD_CHART_H}
            stroke={CHART_INK}
            strokeWidth={1}
            opacity={0.45}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="h-px w-full bg-gray-200" />
      <div className="relative mt-0.5 h-3">
        {ticks.map((t) => (
          <span
            key={t.kt}
            className="absolute top-0 whitespace-nowrap text-[9px] tabular-nums text-gray-400"
            style={{
              left: `${t.frac * 100}%`,
              transform: t.frac <= 0 ? "none" : t.frac > 0.97 ? "translateX(-100%)" : "translateX(-50%)",
            }}
          >
            {t.kt}kt
          </span>
        ))}
      </div>
    </div>
  );
}

// ─── 본문 ──────────────────────────────────────────────────────────

export default function AltSpeedDetail({ detail }: { detail: AsterixDetailStats; tz: TzMode }) {
  const { stats, fl_fine, speed_fine } = detail;

  // 관측 빈 → 연속 축 (속도는 0kt 부터 그려 정지/저속 구간의 부재가 보이게)
  const alt = useMemo(() => densify(fl_fine, FL_BIN_FT), [fl_fine]);
  const spd = useMemo(() => densify(speed_fine, SPD_BIN_KT, 0), [speed_fine]);

  const flTotal = useMemo(() => fl_fine.reduce((a, b) => a + b.count, 0), [fl_fine]);
  const spTotal = useMemo(() => speed_fine.reduce((a, b) => a + b.count, 0), [speed_fine]);

  const altStats = useMemo(() => binApproxStats(alt.lo, alt.counts, FL_BIN_FT), [alt]);
  const spdStats = useMemo(() => binApproxStats(spd.lo, spd.counts, SPD_BIN_KT), [spd]);

  const flHistTotal = useMemo(() => stats.fl_hist.reduce((a, b) => a + b.count, 0), [stats.fl_hist]);
  const spHistTotal = useMemo(() => stats.speed_hist.reduce((a, b) => a + b.count, 0), [stats.speed_hist]);

  const flFirst = fl_fine.length > 0 ? fl_fine[0] : null;
  const flLast = fl_fine.length > 0 ? fl_fine[fl_fine.length - 1] : null;
  const spLast = speed_fine.length > 0 ? speed_fine[speed_fine.length - 1] : null;

  const flPct = stats.record_count > 0 ? (flTotal / stats.record_count) * 100 : 0;
  const spPct = stats.record_count > 0 ? (spTotal / stats.record_count) * 100 : 0;

  return (
    <div className="space-y-3">
      {/* 요약 카드 */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <StatCard
          label="I090 보유 레코드"
          value={flTotal.toLocaleString()}
          sub={`필터 레코드의 ${flPct.toFixed(1)}%`}
          title="I048/090(비행고도)을 담은 CAT048 레코드 수"
        />
        <StatCard
          label="최고 관측 고도"
          value={flLast ? `${fmtFt(Number(flLast.key) + FL_BIN_FT)} ft` : "—"}
          sub={flLast?.label}
          title="관측이 존재하는 가장 높은 500ft 구간의 상단"
        />
        <StatCard
          label="최저 관측 고도"
          value={flFirst ? `${fmtFt(Number(flFirst.key))} ft` : "—"}
          sub={flFirst?.label}
          title="관측이 존재하는 가장 낮은 500ft 구간의 하단 (음수 = 해면 아래 기압고도)"
        />
        <StatCard
          label="고도 V/G 플래그"
          value={`${stats.fl_v_invalid.toLocaleString()} / ${stats.fl_g_garbled.toLocaleString()}`}
          sub="미검증(V) · Garbled(G)"
          title="I048/090 V=1(미검증)·G=1(garbled) 레코드 수 — 고도값 자체는 그대로 집계에 포함"
        />
        <StatCard
          label="I200 보유 레코드"
          value={spTotal.toLocaleString()}
          sub={`필터 레코드의 ${spPct.toFixed(1)}%`}
          title="I048/200(대지속도·방위)을 담은 CAT048 레코드 수"
        />
        <StatCard
          label="최고 속도"
          value={spLast ? `${Number(spLast.key) + SPD_BIN_KT} kt` : "—"}
          sub={spLast?.label}
          title="관측이 존재하는 가장 빠른 10kt 구간의 상단"
        />
        <StatCard
          label="정지 미만 (<10kt)"
          value={stats.speed_low_records.toLocaleString()}
          sub="지상 이동·정지 표적"
          title="I048/200 대지속도 10kt 미만 레코드 수"
        />
        <StatCard
          label="600kt 초과"
          value={stats.speed_high_records.toLocaleString()}
          sub="이상치 후보"
          title="I048/200 대지속도 600kt 초과 레코드 수"
        />
      </div>

      {/* 고도 정밀 분포 (500ft) */}
      <Section
        title="고도 정밀 분포 (I048/090 · 500ft)"
        right={
          <span className="text-[10px] text-gray-400">
            {flTotal.toLocaleString()}건 · 세로축 고도(ft) / 가로축 건수
          </span>
        }
      >
        <AltProfileChart lo={alt.lo} counts={alt.counts} />
        {altStats && (
          <div className="mt-1 text-[10px] text-gray-400">
            중앙값 {fmtFt(altStats.median)} ft · 평균 {fmtFt(altStats.mean)} ft{" "}
            <span className="text-gray-300">— 빈 근사(500ft 구간 중앙값 가중)</span>
          </div>
        )}
      </Section>

      {/* 속도 정밀 분포 (10kt) */}
      <Section
        title="속도 정밀 분포 (I048/200 · 10kt)"
        right={<span className="text-[10px] text-gray-400">{spTotal.toLocaleString()}건</span>}
      >
        <SpeedFineChart lo={spd.lo} counts={spd.counts} />
        <div className="mt-1 flex flex-wrap items-baseline justify-between gap-x-3 text-[10px] text-gray-400">
          <span>
            정지 미만(&lt;10kt) {stats.speed_low_records.toLocaleString()}건 · 600kt 초과{" "}
            {stats.speed_high_records.toLocaleString()}건
          </span>
          {spdStats && (
            <span>
              중앙값 {Math.round(spdStats.median).toLocaleString()} kt · 평균{" "}
              {Math.round(spdStats.mean).toLocaleString()} kt{" "}
              <span className="text-gray-300">— 빈 근사(10kt 구간 중앙값 가중)</span>
            </span>
          )}
        </div>
      </Section>

      {/* 대시보드 연속성 — 기존 1,000ft / 50kt 요약 */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section
          title="고도 분포 요약 (1,000ft)"
          size="lg"
          right={<span className="text-[10px] text-gray-400">대시보드와 동일</span>}
        >
          <LabeledBars items={stats.fl_hist} total={flHistTotal} labelWidth="w-28" />
        </Section>

        <Section
          title="속도 분포 요약 (50kt)"
          size="lg"
          right={<span className="text-[10px] text-gray-400">대시보드와 동일</span>}
        >
          <LabeledBars items={stats.speed_hist} total={spHistTotal} color="#0f766e" labelWidth="w-28" />
        </Section>
      </div>
    </div>
  );
}
