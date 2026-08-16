/**
 * 토픽: 거리·방위 분포 상세.
 *
 * 대시보드의 10NM/10° 요약을 1NM·1° 정밀 격자와 PPI(방위×거리) 히트맵으로 확대한다.
 * 차트는 전부 이 파일 로컬 순수 SVG — 공유 모듈(shared.tsx)은 동결이라 36빈 전용
 * AzimuthRose 를 고치지 않고 360빈 로즈·극좌표 히트맵을 여기서 따로 구현한다.
 * 전 구간 전수 렌더(다운샘플링 없음).
 */

import { useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import {
  AzimuthRose,
  CHART_INK,
  ChartTip,
  clampTipX,
  LabeledBars,
  Section,
  SECTION_BODY_PX,
  StatCard,
} from "../shared";
import { ChartHint, TopicExcelExport, useBrush, type ExportSheet } from "../detailUi";
import { exportStrings, type ExportLang } from "../../../utils/exportI18n";
import type { Cell } from "../../../utils/xlsxExport";
import { AZ_GRID_SECTORS, RANGE_GRID_BINS } from "../../../types/asterixDetail";
import type { AsterixDetailFilter, AsterixDetailStats } from "../../../types/asterixDetail";

// ─── 로컬 차트 상수 ────────────────────────────────────────────────

/** 거리 정밀 분포 본체 높이 (viewBox 단위 = px) */
const RANGE_CHART_H = 132;
/** 거리 축 눈금 (NM) — 축 잘림 범위 안에 드는 것만 표시 */
const RANGE_TICKS_NM = [0, 50, 100, 150, 200, 250];
/** 마지막 관측 구간 뒤로 남길 여백 비율 — 뒤쪽 연속 0 구간은 잘라낸다 */
const RANGE_AXIS_MARGIN = 1.1;
/** 축을 너무 짧게 잘라 눈금이 사라지는 것을 막는 최소 폭 (NM) */
const RANGE_AXIS_MIN = 20;

/** 1° 로즈 정사각 변 */
const ROSE_FINE_S = Math.max(SECTION_BODY_PX.lg, 340);
/** PPI 히트맵 정사각 변 — 5°×5NM 셀이 뭉개지지 않는 크기 (lg 티어 이상) */
const PPI_S = Math.max(SECTION_BODY_PX.lg, 420);
/** 축 라벨용 바깥 여백 */
const POLAR_PAD = 18;

/** 나침반 좌표(0°=북, 시계방향) → 화면 좌표 */
function polar(c: number, deg: number, r: number): readonly [number, number] {
  const a = (deg * Math.PI) / 180;
  return [c + r * Math.sin(a), c - r * Math.cos(a)] as const;
}

const f2 = (v: number) => v.toFixed(2);

/** 중심에서 뻗는 부채꼴 (각 증가 = 화면상 시계방향이라 sweep=1) */
function wedgePath(c: number, deg0: number, deg1: number, r: number): string {
  const [x0, y0] = polar(c, deg0, r);
  const [x1, y1] = polar(c, deg1, r);
  return `M${c} ${c} L${f2(x0)} ${f2(y0)} A${f2(r)} ${f2(r)} 0 0 1 ${f2(x1)} ${f2(y1)} Z`;
}

/** 부채꼴 고리 조각 (r0=내반경, r1=외반경) — 바깥호는 시계방향, 안쪽호는 되돌아오므로 sweep=0 */
function ringSectorPath(c: number, deg0: number, deg1: number, r0: number, r1: number): string {
  const [ax, ay] = polar(c, deg0, r1);
  const [bx, by] = polar(c, deg1, r1);
  if (r0 <= 0.01) {
    return `M${c} ${c} L${f2(ax)} ${f2(ay)} A${f2(r1)} ${f2(r1)} 0 0 1 ${f2(bx)} ${f2(by)} Z`;
  }
  const [cx, cy] = polar(c, deg1, r0);
  const [dx, dy] = polar(c, deg0, r0);
  return (
    `M${f2(ax)} ${f2(ay)} A${f2(r1)} ${f2(r1)} 0 0 1 ${f2(bx)} ${f2(by)}` +
    ` L${f2(cx)} ${f2(cy)} A${f2(r0)} ${f2(r0)} 0 0 0 ${f2(dx)} ${f2(dy)} Z`
  );
}

/** 포인터 위치 → 나침반 방위각(0–360) */
function pointerAzimuth(dx: number, dy: number): number {
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

/** 방위각 [0,360) 정규화 */
const norm360 = (d: number) => ((d % 360) + 360) % 360;

/**
 * 적용된 방위 필터 → 실제로 그릴 각도 구간들.
 * azMin > azMax 는 0° 통과(랩어라운드)라 두 조각으로 쪼갠다 (Rust 시맨틱과 동일).
 */
function azWindowSegments(min?: number, max?: number): { a: number; b: number }[] {
  if (min == null && max == null) return [];
  if (min == null) return [{ a: 0, b: norm360(max as number) }];
  if (max == null) return [{ a: norm360(min), b: 360 }];
  const lo = norm360(min);
  const hi = norm360(max);
  if (lo === hi) return [];
  return lo < hi ? [{ a: lo, b: hi }] : [{ a: lo, b: 360 }, { a: 0, b: hi }];
}

/**
 * 넓은 각 구간을 90° 이하 조각으로 쪼갠다.
 * wedgePath/ringSectorPath 는 large-arc 플래그를 0 으로 고정하므로 180° 를 넘는 호를 그리지 못한다.
 * 조각들은 같은 색·불투명도로 맞붙여 채우므로 이음매가 보이지 않는다.
 */
function splitArcs(segs: { a: number; b: number }[], max = 90): { a: number; b: number }[] {
  const out: { a: number; b: number }[] = [];
  for (const s of segs) {
    for (let a = s.a; a < s.b - 1e-6; a += max) out.push({ a, b: Math.min(a + max, s.b) });
  }
  return out;
}

/**
 * 연속 0 구간(무탐지 섹터) 스캔 — 359°→0° 경계를 넘는 구간은 하나로 병합한다.
 * 반환 start 는 [0,360), width 는 병합 결과라 360 까지 가능(전 방위 무탐지).
 */
interface BlindSector {
  start: number;
  width: number;
}
function scanBlindSectors(bins: number[]): BlindSector[] {
  const n = bins.length;
  if (n === 0) return [];
  let nz = 0;
  for (let i = 0; i < n; i++) if (bins[i] > 0) nz++;
  if (nz === 0) return [{ start: 0, width: n }]; // 전 방위 무탐지
  const runs: { s: number; e: number }[] = [];
  let i = 0;
  while (i < n) {
    if (bins[i] === 0) {
      let j = i;
      while (j < n && bins[j] === 0) j++;
      runs.push({ s: i, e: j });
      i = j;
    } else i++;
  }
  // 첫 구간이 0° 에서 시작하고 마지막 구간이 끝(360°)까지면 같은 구간 — 랩어라운드로 병합
  if (runs.length > 1) {
    const first = runs[0];
    const last = runs[runs.length - 1];
    if (first.s === 0 && last.e === n) {
      runs.pop();
      runs.shift();
      runs.unshift({ s: last.s, e: first.e + n });
    }
  }
  return runs.map((r) => ({ start: r.s, width: r.e - r.s }));
}

// ─── 거리 정밀 분포 (1NM 스텝 실루엣) ──────────────────────────────

function RangeFineChart({
  bins,
  filterMin,
  filterMax,
  onQuickFilter,
}: {
  bins: number[];
  /** 현재 적용된 거리 필터 — 차트 위 구간 하이라이트 */
  filterMin?: number;
  filterMax?: number;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null);
  // 빈 인덱스 = NM 이라 확정값이 곧 1NM 스냅된 경계
  const brush = useBrush((lo, hi) => onQuickFilter({ rangeMinNm: lo, rangeMaxNm: hi }));

  /** 마지막 비영 빈 — 뒤쪽 연속 0 구간 잘라내기 기준 */
  const lastNz = useMemo(() => {
    for (let i = bins.length - 1; i >= 0; i--) if (bins[i] > 0) return i;
    return -1;
  }, [bins]);

  const n =
    lastNz < 0 ? 0 : Math.min(bins.length, Math.max(RANGE_AXIS_MIN, Math.ceil((lastNz + 1) * RANGE_AXIS_MARGIN)));
  const view = useMemo(() => bins.slice(0, n), [bins, n]);
  const maxCount = useMemo(() => view.reduce((a, b) => (b > a ? b : a), 0), [view]);

  // 스텝 상단선 + 기준선까지 닫은 면적
  const { line, area } = useMemo(() => {
    const H = RANGE_CHART_H;
    const scale = maxCount > 0 ? (H - 2) / maxCount : 0;
    let d = "";
    for (let i = 0; i < n; i++) {
      const y = (H - view[i] * scale).toFixed(2);
      d += `${i === 0 ? "M" : " L"}${i} ${y} L${i + 1} ${y}`;
    }
    return { line: d, area: n > 0 ? `${d} L${n} ${H} L0 ${H} Z` : "" };
  }, [view, n, maxCount]);

  /** 포인터 x → 1NM 빈 인덱스 */
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

  /** 적용된 거리 필터 → 차트 좌표 (축이 잘려 있어도 겹치는 부분만) */
  const activeSpan = (() => {
    if (n === 0 || (filterMin == null && filterMax == null)) return null;
    const lo = Math.max(0, Math.min(n, filterMin ?? 0));
    const hi = Math.max(0, Math.min(n, filterMax ?? n));
    return hi - lo > 0 ? { lo, hi } : null;
  })();

  if (lastNz < 0) return <div className="text-[11px] text-gray-400">I048/040 ρ 관측 없음</div>;

  const ticks = RANGE_TICKS_NM.filter((t) => t <= n);

  return (
    <div className="relative">
      {hover && (
        <ChartTip x={hover.x} text={`${hover.idx}–${hover.idx + 1}NM · ${(view[hover.idx] ?? 0).toLocaleString()}건`} />
      )}
      <svg
        viewBox={`0 0 ${n} ${RANGE_CHART_H}`}
        preserveAspectRatio="none"
        className="block w-full cursor-ew-resize touch-none select-none"
        style={{ height: RANGE_CHART_H }}
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
        {activeSpan && (
          <rect
            x={activeSpan.lo}
            width={activeSpan.hi - activeSpan.lo}
            y={0}
            height={RANGE_CHART_H}
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
        {brush.span && (
          <rect
            x={brush.span.lo}
            width={brush.span.hi - brush.span.lo}
            y={0}
            height={RANGE_CHART_H}
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
            y2={RANGE_CHART_H}
            stroke={CHART_INK}
            strokeWidth={1}
            opacity={0.45}
            vectorEffect="non-scaling-stroke"
          />
        )}
      </svg>
      <div className="h-px w-full bg-gray-200" />
      <div className="relative mt-0.5 h-3">
        {ticks.map((t) => {
          const frac = t / n;
          return (
            <span
              key={t}
              className="absolute top-0 whitespace-nowrap text-[9px] tabular-nums text-gray-400"
              style={{
                left: `${frac * 100}%`,
                transform: t === 0 ? "none" : frac > 0.97 ? "translateX(-100%)" : "translateX(-50%)",
              }}
            >
              {t}NM
            </span>
          );
        })}
      </div>
      <ChartHint
        text={`가로로 드래그하면 그 거리 구간(1NM 스냅)으로 전수 재집계합니다 · Esc 또는 1NM 미만 드래그는 취소${
          activeSpan ? " — 음영 = 현재 적용된 거리 필터" : ""
        }`}
      />
    </div>
  );
}

// ─── 방위 정밀 로즈 (1° 360빈) ─────────────────────────────────────

/**
 * 1° 섹터 360개 PPI 로즈 (0°=북, 시계방향).
 * 반경은 카운트에 선형 비례(풍배도 관례). 웨지 인셋 없이 붙여 그려 1° 해상도를 유지하고,
 * 카운트 0 섹터는 웨지를 생략해 블랭킹·차폐 방향이 빈 쐐기로 드러난다.
 */
function AzimuthRoseFine({
  bins,
  filterMin,
  filterMax,
  onQuickFilter,
}: {
  bins: number[];
  /** 현재 적용된 방위 필터 — 로즈 위에 구간 하이라이트 */
  filterMin?: number;
  filterMax?: number;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null);

  const total = useMemo(() => bins.reduce((a, b) => a + b, 0), [bins]);
  const maxV = useMemo(() => bins.reduce((a, b) => (b > a ? b : a), 0), [bins]);

  const S = ROSE_FINE_S;
  const c0 = S / 2;
  const R = c0 - POLAR_PAD;

  // 호버 때마다 360개 웨지를 재조정하지 않도록 엘리먼트 배열을 메모 (호버 강조는 별도 오버레이)
  const wedges = useMemo(() => {
    if (maxV <= 0) return [] as ReactElement[];
    const out: ReactElement[] = [];
    for (let i = 0; i < bins.length; i++) {
      const c = bins[i];
      if (c <= 0) continue;
      out.push(<path key={i} d={wedgePath(c0, i, i + 1, (c / maxV) * R)} fill={CHART_INK} opacity={0.85} />);
    }
    return out;
  }, [bins, maxV, c0, R]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    // 거리는 보지 않는다 — 짧은/빈 섹터도 집을 수 있게 히트 타깃은 사각형 전체 (각도로만 판정)
    const angle = pointerAzimuth(e.clientX - rect.left - rect.width / 2, e.clientY - rect.top - rect.height / 2);
    const idx = Math.min(bins.length - 1, Math.floor(angle));
    const wr = wrap.getBoundingClientRect();
    setHover({ idx, x: clampTipX(e.clientX - wr.left, wr.width) });
  };

  const tipText = (() => {
    if (!hover) return "";
    const c = bins[hover.idx] ?? 0;
    const pct = total > 0 ? (c / total) * 100 : 0;
    return `${hover.idx}°–${hover.idx + 1}° · ${c.toLocaleString()}건 (${pct.toFixed(2)}%)`;
  })();

  /**
   * 클릭 = 그 도수를 중심으로 한 10° 윈도우로 재집계.
   * 0° 를 통과하면 min > max 로 넘긴다 — Rust 가 랩어라운드 구간으로 해석한다.
   */
  const applyWindow = (deg: number) => {
    onQuickFilter({ azMinDeg: norm360(deg - 5), azMaxDeg: norm360(deg + 5) });
  };

  /** 적용된 방위 필터 → 그릴 구간(랩어라운드는 두 조각, 넓은 각은 90° 단위로 분할) */
  const activeSegs = splitArcs(azWindowSegments(filterMin, filterMax));

  return (
    // 폭이 좁아지면 정사각을 유지한 채 축소 — 히트 판정이 viewBox 스케일 환산에만 의존하게
    <div ref={wrapRef} className="relative mx-auto" style={{ width: "100%", maxWidth: S }}>
      {hover && <ChartTip x={hover.x} text={tipText} />}
      <svg
        viewBox={`0 0 ${S} ${S}`}
        className="block aspect-square w-full cursor-pointer"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onClick={() => {
          if (hover) applyWindow(hover.idx);
        }}
      >
        <g stroke="#e5e7eb" strokeWidth={1} fill="none">
          {[0.25, 0.5, 0.75, 1].map((fr) => (
            <circle key={fr} cx={c0} cy={c0} r={R * fr} />
          ))}
          <line x1={c0} y1={c0 - R} x2={c0} y2={c0 + R} />
          <line x1={c0 - R} y1={c0} x2={c0 + R} y2={c0} />
        </g>

        {/* 적용된 방위 필터 구간 — 데이터 웨지 아래에 옅게 */}
        {activeSegs.map((s) => (
          <path key={`${s.a}:${s.b}`} d={wedgePath(c0, s.a, s.b, R)} fill={CHART_INK} opacity={0.07} />
        ))}

        {hover && <path d={wedgePath(c0, hover.idx, hover.idx + 1, R)} fill={CHART_INK} opacity={0.1} />}
        {wedges}
        {hover && (bins[hover.idx] ?? 0) > 0 && maxV > 0 && (
          <path d={wedgePath(c0, hover.idx, hover.idx + 1, (bins[hover.idx] / maxV) * R)} fill={CHART_INK} />
        )}

        <g fontSize={9} fill="#9ca3af">
          <text x={c0} y={c0 - R - 5} textAnchor="middle">
            0°
          </text>
          <text x={S - 1} y={c0} textAnchor="end" dominantBaseline="central">
            90°
          </text>
          <text x={c0} y={c0 + R + 12} textAnchor="middle">
            180°
          </text>
          <text x={1} y={c0} textAnchor="start" dominantBaseline="central">
            270°
          </text>
        </g>
      </svg>
      <ChartHint
        text={`섹터를 클릭하면 그 도수를 중심으로 한 10° 방위 윈도우로 전수 재집계합니다 (0° 통과 구간도 그대로 지원)${
          activeSegs.length > 0 ? " — 음영 = 현재 적용된 방위 필터" : ""
        }`}
      />
    </div>
  );
}

// ─── PPI 히트맵 (방위 5° × 거리 5NM) ───────────────────────────────

/**
 * az_range_grid(72×52)를 극좌표 도넛 섹터로 렌더.
 * 셀 색은 단색(CHART_INK) 고정, 진하기(오파시티)만 log(1+c)/log(1+max) 로 변조해
 * 몇 자릿수 차이 나는 셀 밀도를 한 화면에서 읽게 한다. 0건 셀은 아예 그리지 않는다.
 */
function PpiHeatmap({
  grid,
  filter,
  onQuickFilter,
}: {
  grid: number[];
  /** 현재 적용된 방위·거리 필터 — 격자 위 창(window) 하이라이트 */
  filter: AsterixDetailFilter;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ az: number; r: number; x: number } | null>(null);

  const S = PPI_S;
  const c0 = S / 2;
  const R = c0 - POLAR_PAD;
  const ringW = R / RANGE_GRID_BINS;

  const { maxV, minNz, cellsWithData } = useMemo(() => {
    let mx = 0;
    let mn = Number.POSITIVE_INFINITY;
    let k = 0;
    for (let i = 0; i < grid.length; i++) {
      const c = grid[i];
      if (c <= 0) continue;
      k++;
      if (c > mx) mx = c;
      if (c < mn) mn = c;
    }
    return { maxV: mx, minNz: Number.isFinite(mn) ? mn : 0, cellsWithData: k };
  }, [grid]);

  // 셀 엘리먼트는 메모 — 호버 상태 변경 때 3,744개 경로를 재조정하지 않게 한다
  const cells = useMemo(() => {
    if (maxV <= 0) return [] as ReactElement[];
    const denom = Math.log(1 + maxV);
    const out: ReactElement[] = [];
    for (let az = 0; az < AZ_GRID_SECTORS; az++) {
      for (let r = 0; r < RANGE_GRID_BINS; r++) {
        const c = grid[az * RANGE_GRID_BINS + r] ?? 0;
        if (c <= 0) continue;
        out.push(
          <path
            key={`${az}:${r}`}
            d={ringSectorPath(c0, az * 5, az * 5 + 5, r * ringW, (r + 1) * ringW)}
            fill={CHART_INK}
            opacity={Math.log(1 + c) / denom}
          />,
        );
      }
    }
    return out;
  }, [grid, maxV, c0, ringW]);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    // 화면 좌표 → viewBox 좌표(정사각 스케일)로 환산해 반경 판정
    const scale = S / rect.width;
    const dx = (e.clientX - rect.left - rect.width / 2) * scale;
    const dy = (e.clientY - rect.top - rect.height / 2) * scale;
    const dist = Math.hypot(dx, dy);
    if (dist > R) {
      // 원 밖 — 해제
      setHover(null);
      return;
    }
    const az = Math.min(AZ_GRID_SECTORS - 1, Math.floor(pointerAzimuth(dx, dy) / 5));
    const r = Math.min(RANGE_GRID_BINS - 1, Math.floor(dist / ringW));
    const wr = wrap.getBoundingClientRect();
    setHover({ az, r, x: clampTipX(e.clientX - wr.left, wr.width) });
  };

  const hoverCount = hover ? (grid[hover.az * RANGE_GRID_BINS + hover.r] ?? 0) : 0;
  const tipText = hover
    ? `az ${hover.az * 5}°–${hover.az * 5 + 5}° · ${hover.r * 5}–${hover.r * 5 + 5}NM · ${hoverCount.toLocaleString()}건${
        hoverCount > 0 ? " · 클릭 = 이 셀로 재집계" : ""
      }`
    : "";

  /** 셀 클릭 = 그 5°×5NM 셀 범위로 재집계 (0건 셀은 결과가 비므로 막는다) */
  const onCellClick = () => {
    if (!hover || hoverCount <= 0) return;
    onQuickFilter({
      azMinDeg: hover.az * 5,
      azMaxDeg: hover.az * 5 + 5,
      rangeMinNm: hover.r * 5,
      rangeMaxNm: hover.r * 5 + 5,
    });
  };

  /** 적용된 방위×거리 필터 → 그릴 고리 조각들 (랩어라운드·넓은 각 분할) */
  const activeCells = (() => {
    const segs = splitArcs(azWindowSegments(filter.azMinDeg, filter.azMaxDeg));
    const hasRange = filter.rangeMinNm != null || filter.rangeMaxNm != null;
    if (segs.length === 0 && !hasRange) return [];
    const maxNm = RANGE_GRID_BINS * 5;
    const r0 = (Math.max(0, Math.min(maxNm, filter.rangeMinNm ?? 0)) / maxNm) * R;
    const r1 = (Math.max(0, Math.min(maxNm, filter.rangeMaxNm ?? maxNm)) / maxNm) * R;
    if (r1 - r0 <= 0) return [];
    const use = segs.length > 0 ? segs : splitArcs([{ a: 0, b: 360 }]);
    return use.map((s) => ringSectorPath(c0, s.a, s.b, r0, r1));
  })();

  // 범례 그라데이션 — 오파시티가 log 스케일이라 stop 도 같은 곡선으로 찍는다
  const legendStops = useMemo(() => {
    const denom = Math.log(1 + maxV);
    const lo = minNz;
    return Array.from({ length: 9 }, (_, i) => {
      const t = i / 8;
      const c = lo + t * (maxV - lo);
      return { t, op: denom > 0 ? Math.log(1 + c) / denom : 0 };
    });
  }, [maxV, minNz]);

  if (maxV <= 0) return <div className="text-[11px] text-gray-400">I048/040 ρ·θ 동시 관측 없음</div>;

  return (
    <div className="flex flex-col items-center">
      <div ref={wrapRef} className="relative w-full" style={{ maxWidth: S }}>
        {hover && <ChartTip x={hover.x} text={tipText} />}
        <svg
          viewBox={`0 0 ${S} ${S}`}
          className={`block aspect-square w-full ${hoverCount > 0 ? "cursor-pointer" : ""}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          onClick={onCellClick}
        >
          {/* 적용된 방위×거리 필터 창 — 셀 아래에 옅게 */}
          {activeCells.map((d, i) => (
            <path key={i} d={d} fill={CHART_INK} opacity={0.08} />
          ))}
          {cells}

          {/* 거리 링(50NM 간격) · 방위 스포크(30° 간격) — 데이터 위에 옅게 */}
          <g stroke="#9ca3af" strokeWidth={0.5} fill="none" opacity={0.5}>
            {[10, 20, 30, 40, 50].map((rb) => (
              <circle key={rb} cx={c0} cy={c0} r={rb * ringW} />
            ))}
            {Array.from({ length: 12 }, (_, i) => {
              const [x, y] = polar(c0, i * 30, R);
              return <line key={i} x1={c0} y1={c0} x2={f2(x)} y2={f2(y)} />;
            })}
          </g>

          {hover && (
            <path
              d={ringSectorPath(c0, hover.az * 5, hover.az * 5 + 5, hover.r * ringW, (hover.r + 1) * ringW)}
              fill="none"
              stroke={CHART_INK}
              strokeWidth={1.5}
              vectorEffect="non-scaling-stroke"
            />
          )}

          {/* 거리 링 라벨은 180° 방향(아래쪽) 축을 따라 — 흰 테두리로 데이터 위에서도 읽히게 */}
          <g fontSize={8} fill="#6b7280" style={{ paintOrder: "stroke" }} stroke="#ffffff" strokeWidth={2.5}>
            {[10, 20, 30, 40, 50].map((rb) => (
              <text key={rb} x={c0} y={c0 + rb * ringW - 2} textAnchor="middle">
                {rb * 5}NM
              </text>
            ))}
          </g>

          <g fontSize={9} fill="#9ca3af">
            <text x={c0} y={c0 - R - 5} textAnchor="middle">
              0°
            </text>
            <text x={S - 1} y={c0} textAnchor="end" dominantBaseline="central">
              90°
            </text>
            <text x={c0} y={c0 + R + 13} textAnchor="middle">
              180°
            </text>
            <text x={1} y={c0} textAnchor="start" dominantBaseline="central">
              270°
            </text>
          </g>
        </svg>
      </div>

      {/* 범례 — 오파시티 그라데이션 바 + 최소/최대 건수 */}
      <div className="mt-2 flex items-center gap-2" style={{ width: Math.min(S, 320), maxWidth: "100%" }}>
        <span className="shrink-0 text-[9px] tabular-nums text-gray-400">{minNz.toLocaleString()}건</span>
        <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="h-2 flex-1">
          <defs>
            <linearGradient id="asterix-ppi-legend" x1="0" y1="0" x2="1" y2="0">
              {legendStops.map((s) => (
                <stop key={s.t} offset={s.t} stopColor={CHART_INK} stopOpacity={s.op} />
              ))}
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="100" height="8" fill="url(#asterix-ppi-legend)" />
        </svg>
        <span className="shrink-0 text-[9px] tabular-nums text-gray-400">{maxV.toLocaleString()}건</span>
      </div>
      <div className="mt-0.5 text-[10px] text-gray-400">
        셀 진하기 = 건수(log 스케일) · 관측 셀 {cellsWithData.toLocaleString()} /{" "}
        {(AZ_GRID_SECTORS * RANGE_GRID_BINS).toLocaleString()}
      </div>
      <ChartHint
        text={`관측이 있는 셀을 클릭하면 그 방위 5° × 거리 5NM 범위로 전수 재집계합니다${
          activeCells.length > 0 ? " — 음영 = 현재 적용된 방위·거리 필터" : ""
        }`}
      />
    </div>
  );
}

// ─── 본문 ──────────────────────────────────────────────────────────

export default function TrafficDetail({
  detail,
  appliedFilter,
  onQuickFilter,
}: {
  detail: AsterixDetailStats;
  /** 적용된 필터 — 차트에 현재 창(window)을 그리는 데만 쓴다 (시각 표기 없음 → tz 미사용) */
  appliedFilter: AsterixDetailFilter;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
}) {
  const { stats, range_fine, azimuth_fine, az_range_grid } = detail;

  const rangeTotal = useMemo(() => range_fine.reduce((a, b) => a + b, 0), [range_fine]);
  const azTotal = useMemo(() => azimuth_fine.reduce((a, b) => a + b, 0), [azimuth_fine]);

  /** 마지막 비영 1NM 빈 = 최대 관측거리 구간 */
  const lastRangeBin = useMemo(() => {
    for (let i = range_fine.length - 1; i >= 0; i--) if (range_fine[i] > 0) return i;
    return -1;
  }, [range_fine]);

  /** 누적합 95% 도달 1NM 빈 */
  const p95Bin = useMemo(() => {
    if (rangeTotal <= 0) return -1;
    const target = rangeTotal * 0.95;
    let cum = 0;
    for (let i = 0; i < range_fine.length; i++) {
      cum += range_fine[i];
      if (cum >= target) return i;
    }
    return range_fine.length - 1;
  }, [range_fine, rangeTotal]);

  /** 최빈 1° 방위 섹터 */
  const peakAz = useMemo(() => {
    let idx = -1;
    let mx = 0;
    for (let i = 0; i < azimuth_fine.length; i++) {
      if (azimuth_fine[i] > mx) {
        mx = azimuth_fine[i];
        idx = i;
      }
    }
    return { idx, count: mx };
  }, [azimuth_fine]);

  /** 무관측 1° 섹터 수 — 블랭킹·차폐 시사 */
  const emptyAzSectors = useMemo(() => azimuth_fine.reduce((a, b) => a + (b === 0 ? 1 : 0), 0), [azimuth_fine]);

  const rangeHistTotal = useMemo(() => stats.range_hist.reduce((a, b) => a + b.count, 0), [stats.range_hist]);
  const coverPct = stats.record_count > 0 ? (rangeTotal / stats.record_count) * 100 : 0;

  /** 무탐지(연속 0) 방위 섹터 — 랩어라운드 병합, 폭 내림차순 */
  const blindSectors = useMemo(() => {
    if (azTotal === 0) return [] as BlindSector[];
    const s = scanBlindSectors(azimuth_fine);
    s.sort((a, b) => b.width - a.width || a.start - b.start);
    return s;
  }, [azimuth_fine, azTotal]);
  const blindTotalDeg = useMemo(() => blindSectors.reduce((a, s) => a + s.width, 0), [blindSectors]);

  /** Excel — 거리 1NM · 방위 1° · PPI 격자(az×range 행렬) · 무탐지 섹터 */
  const buildSheets = (lang: ExportLang): ExportSheet[] => {
    const L = exportStrings(lang);
    const sheets: ExportSheet[] = [];

    if (rangeTotal > 0) {
      const rows: Cell[][] = [L.detail.rangeFineHeader];
      for (let i = 0; i < range_fine.length; i++) rows.push([i, i + 1, range_fine[i]]);
      sheets.push({ name: L.detail.sheet.rangeFine, rows });
    }
    if (azTotal > 0) {
      const rows: Cell[][] = [L.detail.azFineHeader];
      for (let i = 0; i < azimuth_fine.length; i++) rows.push([i, i + 1, azimuth_fine[i]]);
      sheets.push({ name: L.detail.sheet.azimuthFine, rows });
    }
    if (az_range_grid.length > 0) {
      // 행 = 방위 5° 섹터, 열 = 거리 5NM 구간 (원본 격자 그대로, 다운샘플링 없음)
      const head: Cell[] = [L.detail.ppiCorner];
      for (let r = 0; r < RANGE_GRID_BINS; r++) head.push(`${r * 5}–${r * 5 + 5}`);
      const rows: Cell[][] = [head];
      for (let az = 0; az < AZ_GRID_SECTORS; az++) {
        const row: Cell[] = [`${az * 5}–${az * 5 + 5}`];
        for (let r = 0; r < RANGE_GRID_BINS; r++) row.push(az_range_grid[az * RANGE_GRID_BINS + r] ?? 0);
        rows.push(row);
      }
      sheets.push({ name: L.detail.sheet.ppiGrid, rows });
    }
    if (blindSectors.length > 0) {
      const rows: Cell[][] = [L.detail.blindSectorHeader];
      for (const s of blindSectors) rows.push([s.start, (s.start + s.width) % 360, s.width]);
      sheets.push({ name: L.detail.sheet.blindSectors, rows });
    }
    return sheets;
  };

  return (
    <div className="space-y-3">
      <TopicExcelExport
        topic="traffic"
        build={buildSheets}
        title="거리 1NM·방위 1°·PPI 격자·무탐지 섹터를 Excel(.xlsx)로 내보냅니다 — 언어 선택"
      />

      {/* 요약 카드 */}
      <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
        <StatCard
          label="I040 보유 레코드"
          value={rangeTotal.toLocaleString()}
          sub={`필터 레코드의 ${coverPct.toFixed(1)}%`}
          title="I048/040(극좌표 ρ/θ)을 담은 CAT048 레코드 수"
        />
        <StatCard
          label="최대 관측거리"
          value={lastRangeBin < 0 ? "—" : `${lastRangeBin + 1} NM`}
          sub={lastRangeBin < 0 ? undefined : `마지막 비영 빈 ${lastRangeBin}–${lastRangeBin + 1}NM`}
          title={
            lastRangeBin === range_fine.length - 1
              ? "최종 빈은 255NM 이상 클램프 구간"
              : "관측이 존재하는 가장 먼 1NM 구간"
          }
        />
        <StatCard
          label="95백분위 거리"
          value={p95Bin < 0 ? "—" : `${p95Bin + 1} NM`}
          sub="거리 누적 95% 도달"
          title="1NM 히스토그램 누적합이 전체의 95%에 도달하는 구간"
        />
        <StatCard
          label="최빈 방위"
          value={peakAz.idx < 0 ? "—" : `${peakAz.idx}°–${peakAz.idx + 1}°`}
          sub={peakAz.idx < 0 ? undefined : `${peakAz.count.toLocaleString()}건`}
          title="1° 섹터 중 레코드가 가장 많은 방위"
        />
        <StatCard
          label="빈 방위 섹터"
          value={azTotal > 0 ? `${emptyAzSectors} / 360` : "—"}
          sub="블랭킹·차폐 시사"
          title="관측이 전혀 없는 1° 섹터 수 — 섹터 블랭킹이나 지형/지물 차폐를 시사"
        />
      </div>

      {/* 거리 정밀 분포 (1NM) */}
      <Section
        title="거리 정밀 분포 (I048/040 ρ · 1NM)"
        right={
          <span className="text-[10px] text-gray-400">
            {rangeTotal.toLocaleString()}건 · 뒤쪽 무관측 구간 축 잘라냄
          </span>
        }
      >
        <RangeFineChart
          bins={range_fine}
          filterMin={appliedFilter.rangeMinNm}
          filterMax={appliedFilter.rangeMaxNm}
          onQuickFilter={onQuickFilter}
        />
      </Section>

      {/* 방위 정밀 로즈 (1°) */}
      <Section
        title="방위 정밀 분포 (I048/040 θ · 1°)"
        right={
          <span className="text-[10px] text-gray-400">
            {azTotal.toLocaleString()}건 · 반경 = 건수 비례 (0°=북, 시계방향)
          </span>
        }
      >
        {azTotal === 0 ? (
          <div className="text-[11px] text-gray-400">I048/040 θ 관측 없음</div>
        ) : (
          <AzimuthRoseFine
            bins={azimuth_fine}
            filterMin={appliedFilter.azMinDeg}
            filterMax={appliedFilter.azMaxDeg}
            onQuickFilter={onQuickFilter}
          />
        )}
      </Section>

      {/* 방위 무탐지 섹터 — 연속 0 구간 (블랭킹·차폐 후보). 관측이 전무하면 표시하지 않는다 */}
      {azTotal > 0 && (
        <Section
          title={`방위 무탐지 섹터 (${blindSectors.length.toLocaleString()}구간)`}
          right={
            <span className="text-[10px] text-gray-400">azimuth_fine 연속 0 구간 · 359°→0° 경계 병합</span>
          }
        >
          {blindSectors.length === 0 ? (
            <div className="text-[11px] text-gray-400">360개 1° 섹터 전부에 관측이 있습니다 — 무탐지 섹터 없음</div>
          ) : (
            <>
              <div className="mb-2 grid grid-cols-2 gap-2 md:grid-cols-3">
                <StatCard
                  label="무탐지 구간"
                  value={`${blindSectors.length.toLocaleString()}구간`}
                  sub="연속 0 섹터 묶음"
                  title="관측이 하나도 없는 1° 섹터가 연이어 붙은 구간의 개수 (0° 경계는 병합)"
                />
                <StatCard
                  label="최장 구간"
                  value={`${blindSectors[0].width}°`}
                  sub={`${blindSectors[0].start}° 부터`}
                  title="가장 넓은 연속 무탐지 방위 구간 — 섹터 블랭킹이나 큰 차폐물을 시사"
                />
                <StatCard
                  label="무탐지 합계"
                  value={`${blindTotalDeg}°`}
                  sub={`전 방위의 ${((blindTotalDeg / 360) * 100).toFixed(1)}%`}
                  title="무탐지 1° 섹터의 총 폭"
                />
              </div>
              <div className="max-h-72 overflow-auto rounded border border-gray-100">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="sticky top-0 bg-gray-50 text-gray-500">
                      <th className="w-10 px-2 py-1 text-right font-medium">#</th>
                      <th className="px-2 py-1 text-left font-medium">구간</th>
                      <th className="px-2 py-1 text-right font-medium">폭</th>
                    </tr>
                  </thead>
                  <tbody>
                    {blindSectors.map((s, i) => (
                      <tr key={`${s.start}:${s.width}`} className="border-t border-gray-100">
                        <td className="px-2 py-1 text-right tabular-nums text-gray-400">{i + 1}</td>
                        <td
                          className="px-2 py-1 tabular-nums text-gray-700"
                          title={
                            s.start + s.width > 360 ? "0°(북) 을 통과하는 구간 — 359°→0° 경계에서 병합됨" : undefined
                          }
                        >
                          {s.start}° – {(s.start + s.width) % 360}°
                          {s.start + s.width > 360 && <span className="ml-1 text-[10px] text-gray-400">0° 통과</span>}
                        </td>
                        <td className="px-2 py-1 text-right tabular-nums text-gray-600">{s.width}°</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </Section>
      )}

      {/* PPI 히트맵 (5° × 5NM) */}
      <Section
        title="PPI 히트맵 (방위 5° × 거리 5NM)"
        right={<span className="text-[10px] text-gray-400">0–260NM · 극좌표 원본 격자</span>}
      >
        <PpiHeatmap grid={az_range_grid} filter={appliedFilter} onQuickFilter={onQuickFilter} />
      </Section>

      {/* 대시보드 연속성 — 기존 10NM / 10° 요약 */}
      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Section
          title="거리 분포 요약 (10NM)"
          size="lg"
          right={<span className="text-[10px] text-gray-400">대시보드와 동일</span>}
        >
          <LabeledBars items={stats.range_hist} total={rangeHistTotal} labelWidth="w-28" />
        </Section>

        <Section
          title="방위 분포 요약 (10°)"
          size="lg"
          scroll={false}
          right={<span className="text-[10px] text-gray-400">대시보드와 동일</span>}
        >
          {stats.azimuth_hist.length === 0 ? (
            <div className="text-[11px] text-gray-400">없음</div>
          ) : (
            <AzimuthRose bins={stats.azimuth_hist} />
          )}
        </Section>
      </div>
    </div>
  );
}
