/**
 * 토픽: 수집 시간·공백 상세.
 *
 * 구성: 요약 카드 → 수집 범위 + 시간대별 레코드 밀도(공용 차트) → 시간대(0–23시) 패턴(로컬 차트)
 *       → 수집 공백 전체 표 → 파일별 요약 표.
 *
 * 구조/필터 구분: 파일 용량·프레임·시각 범위·NEC 날짜는 구조 지표(필터 무관),
 * 레코드 수·밀도·공백·시간대 패턴은 전부 필터 적용분이다.
 */

import { useMemo, useState } from "react";
import { CHART_INK, ChartTip, Section, StatCard, clampTipX } from "../shared";
import { ChartHint, FilterChipButton, TopicExcelExport, useBrush, type ExportSheet } from "../detailUi";
import { fmtBytes, fmtGapDur, fmtShiftH, formatTime, fmtTod, pad } from "../format";
import { exportStrings, type ExportLang } from "../../../utils/exportI18n";
import type { Cell } from "../../../utils/xlsxExport";
import type { TimeDensity } from "../../../types/asterix";
import type { AsterixDetailFilter, AsterixDetailStats, TzMode } from "../../../types/asterixDetail";

// ─── 로컬 유틸 ───────────────────────────────────────

/** 초 → "3일 4시간" / "5시간 12분" / "42분" / "38초" (요약 카드용 사람이 읽는 표기) */
function fmtDurLong(secs: number): string {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}초`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}분`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 ${m % 60}분`;
  return `${Math.floor(h / 24)}일 ${h % 24}시간`;
}

/** 비율 표기 — 분모 0이면 "—" */
function pctOf(n: number, d: number): string {
  if (d <= 0) return "—";
  const p = (n / d) * 100;
  return `${p >= 10 ? p.toFixed(0) : p.toFixed(1)}%`;
}

// ─── 시간대(hour-of-day) 패턴 차트 (로컬, 순수 SVG 단색) ──────

/** 막대 차트 본체 높이 (viewBox 단위 = px) */
const HOUR_CHART_H = 96;

/**
 * hourly_utc(UTC 기준 24칸)를 표시 tz 의 로컬 시각으로 재배열해 그리는 막대 차트.
 * KST 로컬 h시 = UTC (h−9)시 → bars[h] = hourly_utc[(h−9+24)%24].
 */
function HourOfDayChart({ hourly, tz }: { hourly: number[]; tz: TzMode }) {
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null);

  const shift = tz === "KST" ? 9 : 0;
  const bars = useMemo(
    () => Array.from({ length: 24 }, (_, h) => hourly[(((h - shift) % 24) + 24) % 24] ?? 0),
    [hourly, shift],
  );
  const maxV = useMemo(() => bars.reduce((a, b) => (b > a ? b : a), 0), [bars]);
  const total = useMemo(() => bars.reduce((a, b) => a + b, 0), [bars]);
  const peak = maxV > 0 ? bars.indexOf(maxV) : -1;

  if (hourly.length === 0 || total === 0) {
    return <div className="text-[11px] text-gray-400">시각(abs_time) 보유 레코드 없음</div>;
  }

  const H = HOUR_CHART_H;
  const scale = maxV > 0 ? (H - 2) / maxV : 0;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(23, Math.max(0, Math.floor(frac * 24)));
    setHover({ idx, x: clampTipX(((idx + 0.5) / 24) * rect.width, rect.width) });
  };

  return (
    <div className="mt-1">
      <div className="mb-0.5 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-gray-400">시간대별 레코드 수 · {tz} 기준</span>
        <span className="text-[10px] text-gray-400">
          최대 {maxV.toLocaleString()}건/시{peak >= 0 ? ` (${pad(peak)}시)` : ""} · 합계 {total.toLocaleString()}건
        </span>
      </div>
      <div className="relative">
        {hover && <ChartTip x={hover.x} text={`${pad(hover.idx)}시 · ${bars[hover.idx].toLocaleString()}건`} />}
        <svg
          viewBox={`0 0 24 ${H}`}
          preserveAspectRatio="none"
          className="block w-full"
          style={{ height: H }}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
          {bars.map((c, i) => (
            <rect
              key={i}
              x={i + 0.12}
              width={0.76}
              y={H - c * scale}
              height={Math.max(0, c * scale)}
              fill={CHART_INK}
              opacity={hover?.idx === i ? 1 : 0.85}
            />
          ))}
        </svg>
        <div className="h-px w-full bg-gray-200" />
        <div className="relative mt-0.5 h-3">
          {[0, 3, 6, 9, 12, 15, 18, 21].map((h) => (
            <span
              key={h}
              className="absolute top-0 text-[9px] tabular-nums text-gray-400"
              style={{ left: `${((h + 0.5) / 24) * 100}%`, transform: "translateX(-50%)" }}
            >
              {pad(h)}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── 시간 밀도 차트 (브러시 가능 로컬판) ────────────────────

/** 그래프 본체 높이 (viewBox 단위 = px) — shared.TimeDensityChart 와 동일 */
const DENSITY_H = 56;

/**
 * 시간대별 레코드 밀도 — 버킷 스텝 실루엣 + 드래그 브러시.
 *
 * shared.TimeDensityChart(동결 모듈) 를 복제해 상호작용만 얹은 로컬판이다.
 * 드래그 확정 시 버킷 경계로 스냅한 [timeMin, timeMax) 로 전수 재집계한다.
 * 0 카운트 구간은 기준선까지 떨어져 수집 공백이 그대로 보인다.
 */
function TimeDensityBrushChart({
  density,
  tz,
  filterMin,
  filterMax,
  onQuickFilter,
}: {
  density: TimeDensity;
  tz: TzMode;
  /** 현재 적용된 기간 필터 — 차트 위에 구간 하이라이트로 표시 */
  filterMin?: number;
  filterMax?: number;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  const { start_ts, bucket_secs, counts } = density;
  const n = counts.length;
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null);

  // 확정 = 버킷 경계 스냅 (반열린 [lo, hi) 구간을 그대로 절대시각으로 환산)
  const brush = useBrush((lo, hi) =>
    onQuickFilter({ timeMin: start_ts + lo * bucket_secs, timeMax: start_ts + hi * bucket_secs }),
  );

  const H = DENSITY_H;
  const maxCount = useMemo(() => counts.reduce((a, b) => (b > a ? b : a), 0), [counts]);

  // 스텝 경로 (상단선) + 기준선까지 닫은 면적 경로
  const { line, area } = useMemo(() => {
    const scale = maxCount > 0 ? (H - 2) / maxCount : 0;
    let d = "";
    for (let i = 0; i < n; i++) {
      const y = (H - counts[i] * scale).toFixed(2);
      d += `${i === 0 ? "M" : " L"}${i} ${y} L${i + 1} ${y}`;
    }
    return { line: d, area: n > 0 ? `${d} L${n} ${H} L0 ${H} Z` : "" };
  }, [counts, n, maxCount, H]);

  // x축 눈금 3~5개 (스팬 하루 미만이면 HH:MM, 이상이면 MM-DD HH:MM)
  const spanSecs = n * bucket_secs;
  const withDate = spanSecs >= 86400;
  const ticks = useMemo(() => {
    const k = Math.min(5, Math.max(2, n));
    return Array.from({ length: k }, (_, i) => {
      const frac = k === 1 ? 0 : i / (k - 1);
      const ts = start_ts + frac * spanSecs;
      const full = formatTime(ts, tz);
      return { frac, label: withDate ? full.slice(3, 14) : full.slice(9, 14) };
    });
  }, [n, start_ts, spanSecs, withDate, tz]);

  /** 포인터 x → 버킷 인덱스 */
  const idxAt = (e: React.PointerEvent<SVGSVGElement>): number | null => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || n === 0) return null;
    const frac = (e.clientX - rect.left) / rect.width;
    return Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const idx = idxAt(e);
    if (idx == null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    brush.move(idx);
    setHover({ idx, x: clampTipX(((idx + 0.5) / n) * rect.width, rect.width) });
  };

  const tipText = (() => {
    if (!hover) return "";
    const s = start_ts + hover.idx * bucket_secs;
    const e = s + bucket_secs;
    const head = withDate ? formatTime(s, tz).slice(3, 14) : formatTime(s, tz).slice(9, 14);
    const tail = formatTime(e, tz).slice(9, 14);
    return `${head}~${tail} · ${counts[hover.idx].toLocaleString()}건`;
  })();

  /** 현재 적용된 기간 필터 → 버킷 좌표 구간 (차트 범위와 겹칠 때만) */
  const activeSpan = useMemo(() => {
    if (n === 0 || (filterMin == null && filterMax == null)) return null;
    const lo = filterMin != null ? (filterMin - start_ts) / bucket_secs : 0;
    const hi = filterMax != null ? (filterMax - start_ts) / bucket_secs : n;
    const cl = Math.max(0, Math.min(n, lo));
    const ch = Math.max(0, Math.min(n, hi));
    return ch - cl > 0 ? { lo: cl, hi: ch } : null;
  }, [filterMin, filterMax, start_ts, bucket_secs, n]);

  if (n === 0) return null;

  return (
    <div className="mt-2">
      <div className="mb-0.5 flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-gray-400">시간대별 레코드 밀도</span>
        <span className="text-[10px] text-gray-400">
          분해능 {(bucket_secs / 60).toLocaleString()}분 · 최대 {maxCount.toLocaleString()}건/버킷
        </span>
      </div>
      <div className="relative">
        {hover && <ChartTip x={hover.x} text={tipText} />}
        <svg
          viewBox={`0 0 ${n} ${H}`}
          preserveAspectRatio="none"
          className="block w-full cursor-ew-resize touch-none select-none"
          style={{ height: H }}
          onPointerDown={(e) => {
            const idx = idxAt(e);
            if (idx != null) brush.begin(idx, e);
          }}
          onPointerMove={onMove}
          onPointerUp={brush.end}
          onPointerCancel={brush.cancel}
          onPointerLeave={() => {
            if (!brush.dragging) setHover(null);
          }}
        >
          {/* 적용된 기간 필터 구간 — 데이터 아래에 옅게 깔아 실루엣을 가리지 않는다 */}
          {activeSpan && (
            <rect
              x={activeSpan.lo}
              width={activeSpan.hi - activeSpan.lo}
              y={0}
              height={H}
              fill={CHART_INK}
              opacity={0.07}
            />
          )}
          <path d={area} fill={CHART_INK} opacity={0.15} />
          <path
            d={line}
            fill="none"
            stroke={CHART_INK}
            strokeWidth={1.5}
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          {/* 드래그 중 라이브 하이라이트 */}
          {brush.span && (
            <rect
              x={brush.span.lo}
              width={brush.span.hi - brush.span.lo}
              y={0}
              height={H}
              fill={CHART_INK}
              opacity={0.18}
              stroke={CHART_INK}
              strokeWidth={1}
              vectorEffect="non-scaling-stroke"
            />
          )}
          {hover && !brush.dragging && (
            <line
              x1={hover.idx + 0.5}
              x2={hover.idx + 0.5}
              y1={0}
              y2={H}
              stroke={CHART_INK}
              strokeWidth={1}
              opacity={0.45}
              vectorEffect="non-scaling-stroke"
            />
          )}
        </svg>
        <div className="h-px w-full bg-gray-200" />
        <div className="relative mt-0.5 h-3">
          {ticks.map((t, i) => (
            <span
              key={i}
              className="absolute top-0 whitespace-nowrap text-[9px] tabular-nums text-gray-400"
              style={{
                left: `${t.frac * 100}%`,
                transform: i === 0 ? "none" : i === ticks.length - 1 ? "translateX(-100%)" : "translateX(-50%)",
              }}
            >
              {t.label}
            </span>
          ))}
        </div>
      </div>
      <ChartHint
        text={
          activeSpan
            ? `드래그하면 그 구간(버킷 경계 스냅)으로 전수 재집계합니다 · Esc 취소 — 음영 = 현재 적용된 기간 필터`
            : "드래그하면 그 구간(버킷 경계 스냅)으로 전수 재집계합니다 · Esc 또는 1버킷 미만 드래그는 취소"
        }
      />
    </div>
  );
}

// ─── 본문 ────────────────────────────────────────────

export default function TimeDetail({
  detail,
  tz,
  appliedFilter,
  onQuickFilter,
}: {
  detail: AsterixDetailStats;
  tz: TzMode;
  appliedFilter: AsterixDetailFilter;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  const { stats, gaps_all, gaps_all_truncated, hourly_utc, unfiltered_records } = detail;
  const [gapSort, setGapSort] = useState<"dur" | "time">("dur");

  // 수집 스팬 — abs_time 이 없으면 TOD 범위로 대체 표기 (대시보드 관례)
  const spanSecs = stats.time_min != null && stats.time_max != null ? stats.time_max - stats.time_min : null;
  const timeRange =
    stats.time_min != null && stats.time_max != null
      ? `${formatTime(stats.time_min, tz)} ~ ${formatTime(stats.time_max, tz)} (${tz})`
      : stats.tod_min != null && stats.tod_max != null
        ? `${fmtTod(stats.tod_min)} ~ ${fmtTod(stats.tod_max)} UTC`
        : "—";

  // 유효 수집 시간 — 레코드가 존재하는 밀도 버킷 수 × 버킷 폭 (버킷 분해능 근사)
  const activeSecs = useMemo(() => {
    const d = stats.time_density;
    if (!d) return null;
    let n = 0;
    for (const c of d.counts) if (c > 0) n++;
    return n * d.bucket_secs;
  }, [stats.time_density]);

  // 표시된 공백의 총 시간 (truncated 이면 표시분 합계임을 카드 sub 에 명시)
  const gapTotalSecs = useMemo(() => gaps_all.reduce((a, g) => a + g.duration_secs, 0), [gaps_all]);
  /** 최장 공백 — 카드 sub 에 합계와 나란히 표기 (한 건이 스팬을 지배하는지 바로 보이게) */
  const gapMaxSecs = useMemo(
    () => gaps_all.reduce((a, g) => (g.duration_secs > a ? g.duration_secs : a), 0),
    [gaps_all],
  );

  // I140 TOD→UTC 자동보정이 적용된 파일 (보정량별 묶음 — 대시보드와 동일 표기)
  const todShiftGroups = useMemo(() => {
    const g = new Map<number, string[]>();
    for (const f of stats.files) {
      if (f.tod_shift_hours !== 0) {
        const list = g.get(f.tod_shift_hours);
        if (list) list.push(f.filename);
        else g.set(f.tod_shift_hours, [f.filename]);
      }
    }
    return [...g.entries()].sort((a, b) => a[0] - b[0]);
  }, [stats.files]);
  const todShiftFileCount = useMemo(
    () => todShiftGroups.reduce((a, [, files]) => a + files.length, 0),
    [todShiftGroups],
  );

  // 공백 정렬 — 원본(길이 내림차순) 훼손 금지라 항상 복사본을 정렬
  const gapsSorted = useMemo(() => {
    const a = gaps_all.slice();
    a.sort(
      gapSort === "dur"
        ? (x, y) => y.duration_secs - x.duration_secs || x.start_ts - y.start_ts
        : (x, y) => x.start_ts - y.start_ts,
    );
    return a;
  }, [gaps_all, gapSort]);

  /** Excel — 수집 공백 전체 · 시간대(표시 tz 반영) · 파일별 요약 */
  const buildSheets = (lang: ExportLang): ExportSheet[] => {
    const L = exportStrings(lang);
    const sheets: ExportSheet[] = [];

    if (gapsSorted.length > 0) {
      const rows: Cell[][] = [L.gapsHeader(tz)];
      for (const g of gapsSorted) {
        rows.push([formatTime(g.start_ts, tz), formatTime(g.end_ts, tz), Math.round(g.duration_secs)]);
      }
      sheets.push({ name: L.sheet.gaps, rows });
    }

    // 시간대는 UTC 24칸 원본을 표시 tz 로 재배열해 내보낸다(화면 차트와 동일 규칙)
    if (hourly_utc.length > 0) {
      const shift = tz === "KST" ? 9 : 0;
      const rows: Cell[][] = [L.detail.hourlyHeader(tz)];
      for (let h = 0; h < 24; h++) rows.push([h, hourly_utc[(((h - shift) % 24) + 24) % 24] ?? 0]);
      sheets.push({ name: L.detail.sheet.hourly, rows });
    }

    if (stats.files.length > 0) {
      const rows: Cell[][] = [L.filesHeader(tz)];
      for (const f of stats.files) {
        rows.push([
          f.filename,
          f.bytes,
          f.frames,
          f.records,
          f.time_min != null ? formatTime(f.time_min, tz) : "",
          f.time_max != null ? formatTime(f.time_max, tz) : "",
          f.tod_shift_hours || 0,
        ]);
      }
      sheets.push({ name: L.sheet.files, rows });
    }
    return sheets;
  };

  return (
    <div className="space-y-3">
      <TopicExcelExport
        topic="time"
        build={buildSheets}
        title="수집 공백 전체·시간대·파일별 요약을 Excel(.xlsx)로 내보냅니다 — 언어 선택"
      />

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label="수집 스팬"
          value={spanSecs != null ? fmtDurLong(spanSecs) : "—"}
          sub={
            stats.time_min != null && stats.time_max != null
              ? `${formatTime(stats.time_min, tz).slice(0, 8)} ~ ${formatTime(stats.time_max, tz).slice(0, 8)}`
              : undefined
          }
          title={`시각 범위 ${timeRange}`}
        />
        <StatCard
          label="유효 수집 시간"
          value={activeSecs != null ? fmtDurLong(activeSecs) : "—"}
          sub={activeSecs != null && spanSecs != null ? `스팬의 ${pctOf(activeSecs, spanSecs)}` : undefined}
          title={
            stats.time_density
              ? `레코드가 존재하는 밀도 버킷 수 × 버킷 폭 (분해능 ${(stats.time_density.bucket_secs / 60).toLocaleString()}분 근사)`
              : "밀도 버킷 없음"
          }
        />
        <StatCard
          label="수집 공백"
          value={`${stats.gap_count.toLocaleString()}곳`}
          sub={
            gaps_all.length > 0
              ? `최장 ${fmtGapDur(gapMaxSecs)} · ${gaps_all_truncated ? "표시분 합 " : "총 "}${fmtGapDur(gapTotalSecs)}`
              : "없음"
          }
          title={
            gaps_all_truncated
              ? `전체 ${stats.gap_count.toLocaleString()}곳 중 길이 상위 ${gaps_all.length.toLocaleString()}곳의 합계`
              : "분 해상도 수집 공백의 총 길이"
          }
        />
        <StatCard
          label="NEC 프레임 날짜"
          value={`${stats.nec_dates.length.toLocaleString()}일`}
          sub={
            stats.nec_dates.length > 0
              ? `${stats.nec_dates.slice(0, 3).join(", ")}${stats.nec_dates.length > 3 ? " …" : ""}`
              : undefined
          }
          title={stats.nec_dates.length > 0 ? stats.nec_dates.join(", ") : "NEC 프레임 헤더 [월][일] 관측 없음"}
        />
        <StatCard
          label="I140 TOD 보정 파일"
          value={todShiftFileCount.toLocaleString()}
          sub={
            todShiftGroups.length > 0
              ? `전체 ${stats.file_count.toLocaleString()}개 중 · ${todShiftGroups.map(([h]) => fmtShiftH(h)).join(" · ")}`
              : `전체 ${stats.file_count.toLocaleString()}개 중`
          }
          title="I140 TOD 가 UTC 가 아닌 것으로 판정되어 자동보정(시프트)된 파일 수"
        />
        <StatCard
          label="레코드(필터)"
          value={stats.record_count.toLocaleString()}
          sub={`전체 ${unfiltered_records.toLocaleString()} 중 ${pctOf(stats.record_count, unfiltered_records)}`}
          title="현재 필터를 통과한 레코드 수 / 필터 전 전체 레코드 수"
        />
      </div>

      {/* 수집 범위 + 밀도 (차트 툴팁이 잘리지 않도록 고정 높이·스크롤 없이 전폭) */}
      <Section title="수집 범위">
        <div className="grid grid-cols-1 gap-1 text-[11px] text-gray-700 md:grid-cols-2">
          <div>
            <span className="text-gray-400">시각 범위 </span>
            <span className="font-mono">{timeRange}</span>
          </div>
          <div>
            <span className="text-gray-400">NEC 프레임 날짜 </span>
            <span className="font-mono">{stats.nec_dates.length ? stats.nec_dates.join(", ") : "—"}</span>
          </div>
        </div>
        {todShiftGroups.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-1">
            {todShiftGroups.map(([h, files]) => (
              <span
                key={h}
                title={`${files.slice(0, 10).join(", ")}${files.length > 10 ? ` 외 ${files.length - 10}개` : ""}`}
                className="rounded border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] text-amber-700"
              >
                I140 TOD {fmtShiftH(h)} → UTC 보정 · {files.length}개 파일
              </span>
            ))}
          </div>
        )}
        {stats.time_density ? (
          <TimeDensityBrushChart
            density={stats.time_density}
            tz={tz}
            filterMin={appliedFilter.timeMin}
            filterMax={appliedFilter.timeMax}
            onQuickFilter={onQuickFilter}
          />
        ) : (
          <div className="mt-2 text-[11px] text-gray-400">시각(abs_time) 보유 레코드 없음</div>
        )}
      </Section>

      {/* 시간대(hour-of-day) 패턴 */}
      <Section
        title="시간대(0–23시) 패턴"
        right={<span className="text-[10px] text-gray-400">I048/140 절대시각 보유 레코드 기준</span>}
      >
        <HourOfDayChart hourly={hourly_utc} tz={tz} />
      </Section>

      {/* 수집 공백 전체 */}
      <Section
        title={`수집 공백 전체 (${stats.gap_count.toLocaleString()}곳)`}
        right={
          <div className="inline-flex overflow-hidden rounded border border-gray-200">
            {(
              [
                ["dur", "길이순"],
                ["time", "시각순"],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setGapSort(k)}
                className={`px-2 py-0.5 text-[10px] font-medium transition-colors ${
                  gapSort === k ? "bg-[#a60739] text-white" : "bg-white text-gray-500 hover:text-gray-700"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        {gaps_all_truncated && (
          <div className="mb-1 rounded border border-amber-200 bg-amber-50 px-2 py-1 text-[10px] text-amber-700">
            전체 {stats.gap_count.toLocaleString()}곳 중 길이 상위 {gaps_all.length.toLocaleString()}곳만 전달되었습니다
            — 짧은 공백 일부는 표에 없습니다.
          </div>
        )}
        {gapsSorted.length === 0 ? (
          <div className="text-[11px] text-gray-400">공백 없음</div>
        ) : (
          <div className="max-h-[28rem] overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="sticky top-0 bg-gray-50 text-gray-500">
                  <th className="w-10 px-2 py-1 text-right font-medium">#</th>
                  <th
                    className="w-8 px-2 py-1 text-left font-medium"
                    title="공백 전후 ±10분 구간으로 재집계 — 공백 자체엔 레코드가 없으므로 경계를 관찰한다"
                  >
                    보기
                  </th>
                  <th className="px-2 py-1 text-left font-medium">시작 ({tz})</th>
                  <th className="px-2 py-1 text-left font-medium">끝 ({tz})</th>
                  <th className="px-2 py-1 text-right font-medium">길이</th>
                </tr>
              </thead>
              <tbody>
                {gapsSorted.map((g, i) => (
                  <tr key={`${g.start_ts}:${g.end_ts}:${i}`} className="border-t border-gray-100">
                    <td className="px-2 py-1 text-right tabular-nums text-gray-400">{i + 1}</td>
                    <td className="px-2 py-1">
                      {/* 공백 구간 자체는 레코드가 0건이라 그대로 재집계하면 빈 결과가 된다.
                          앞뒤 ±10분 여유를 붙여 공백 직전/직후의 마지막·첫 레코드를 함께 본다. */}
                      <FilterChipButton
                        title={`이 공백 전후 ±10분(${formatTime(g.start_ts - 600, tz)} ~ ${formatTime(
                          g.end_ts + 600,
                          tz,
                        )}) 구간으로 재집계`}
                        onClick={() => onQuickFilter({ timeMin: g.start_ts - 600, timeMax: g.end_ts + 600 })}
                      />
                    </td>
                    <td className="px-2 py-1 font-mono text-gray-600">{formatTime(g.start_ts, tz)}</td>
                    <td className="px-2 py-1 font-mono text-gray-600">{formatTime(g.end_ts, tz)}</td>
                    <td
                      className="px-2 py-1 text-right tabular-nums text-gray-700"
                      title={`${Math.round(g.duration_secs).toLocaleString()}초`}
                    >
                      {fmtGapDur(g.duration_secs)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>

      {/* 파일별 요약 */}
      <Section
        title={`파일별 요약 (${stats.files.length.toLocaleString()}개)`}
        right={<span className="text-[10px] text-gray-400">용량·프레임·시각 범위는 필터 무관(구조 지표)</span>}
      >
        {stats.files.length === 0 ? (
          <div className="text-[11px] text-gray-400">파일 없음</div>
        ) : (
          <div className="max-h-[24rem] overflow-auto rounded border border-gray-100">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="sticky top-0 bg-gray-50 text-gray-500">
                  <th className="px-2 py-1 text-left font-medium">파일</th>
                  <th className="px-2 py-1 text-left font-medium">시각 범위 ({tz})</th>
                  <th className="px-2 py-1 text-right font-medium">용량</th>
                  <th className="px-2 py-1 text-right font-medium">프레임</th>
                  <th className="px-2 py-1 text-right font-medium">레코드(필터)</th>
                </tr>
              </thead>
              <tbody>
                {stats.files.map((f, i) => (
                  <tr key={`${f.filename}:${i}`} className="border-t border-gray-100">
                    <td className="px-2 py-1 text-gray-700">
                      {f.filename}
                      {f.tod_shift_hours !== 0 && (
                        <span
                          title="I140 TOD→UTC 보정 적용"
                          className="ml-1 rounded border border-amber-200 bg-amber-50 px-1 text-[9px] tabular-nums text-amber-700"
                        >
                          {fmtShiftH(f.tod_shift_hours)}
                        </span>
                      )}
                    </td>
                    <td className="px-2 py-1 text-left font-mono text-gray-600">
                      {f.time_min != null && f.time_max != null
                        ? `${formatTime(f.time_min, tz)} ~ ${formatTime(f.time_max, tz)}`
                        : "—"}
                    </td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{fmtBytes(f.bytes)}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{f.frames.toLocaleString()}</td>
                    <td className="px-2 py-1 text-right tabular-nums text-gray-600">{f.records.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}
