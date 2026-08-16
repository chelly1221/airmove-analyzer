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
import { AZ_GRID_SECTORS, RANGE_GRID_BINS } from "../../../types/asterixDetail";
import type { AsterixDetailStats, TzMode } from "../../../types/asterixDetail";

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

// ─── 거리 정밀 분포 (1NM 스텝 실루엣) ──────────────────────────────

function RangeFineChart({ bins }: { bins: number[] }) {
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null);

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

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || n === 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
    setHover({ idx, x: clampTipX(((idx + 0.5) / n) * rect.width, rect.width) });
  };

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
        className="block w-full"
        style={{ height: RANGE_CHART_H }}
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
    </div>
  );
}

// ─── 방위 정밀 로즈 (1° 360빈) ─────────────────────────────────────

/**
 * 1° 섹터 360개 PPI 로즈 (0°=북, 시계방향).
 * 반경은 카운트에 선형 비례(풍배도 관례). 웨지 인셋 없이 붙여 그려 1° 해상도를 유지하고,
 * 카운트 0 섹터는 웨지를 생략해 블랭킹·차폐 방향이 빈 쐐기로 드러난다.
 */
function AzimuthRoseFine({ bins }: { bins: number[] }) {
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

  return (
    // 폭이 좁아지면 정사각을 유지한 채 축소 — 히트 판정이 viewBox 스케일 환산에만 의존하게
    <div ref={wrapRef} className="relative mx-auto" style={{ width: "100%", maxWidth: S }}>
      {hover && <ChartTip x={hover.x} text={tipText} />}
      <svg
        viewBox={`0 0 ${S} ${S}`}
        className="block aspect-square w-full"
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <g stroke="#e5e7eb" strokeWidth={1} fill="none">
          {[0.25, 0.5, 0.75, 1].map((fr) => (
            <circle key={fr} cx={c0} cy={c0} r={R * fr} />
          ))}
          <line x1={c0} y1={c0 - R} x2={c0} y2={c0 + R} />
          <line x1={c0 - R} y1={c0} x2={c0 + R} y2={c0} />
        </g>

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
    </div>
  );
}

// ─── PPI 히트맵 (방위 5° × 거리 5NM) ───────────────────────────────

/**
 * az_range_grid(72×52)를 극좌표 도넛 섹터로 렌더.
 * 셀 색은 단색(CHART_INK) 고정, 진하기(오파시티)만 log(1+c)/log(1+max) 로 변조해
 * 몇 자릿수 차이 나는 셀 밀도를 한 화면에서 읽게 한다. 0건 셀은 아예 그리지 않는다.
 */
function PpiHeatmap({ grid }: { grid: number[] }) {
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
    ? `az ${hover.az * 5}°–${hover.az * 5 + 5}° · ${hover.r * 5}–${hover.r * 5 + 5}NM · ${hoverCount.toLocaleString()}건`
    : "";

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
          className="block aspect-square w-full"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
        >
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
    </div>
  );
}

// ─── 본문 ──────────────────────────────────────────────────────────

export default function TrafficDetail({ detail }: { detail: AsterixDetailStats; tz: TzMode }) {
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

  return (
    <div className="space-y-3">
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
        <RangeFineChart bins={range_fine} />
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
          <AzimuthRoseFine bins={azimuth_fine} />
        )}
      </Section>

      {/* PPI 히트맵 (5° × 5NM) */}
      <Section
        title="PPI 히트맵 (방위 5° × 거리 5NM)"
        right={<span className="text-[10px] text-gray-400">0–260NM · 극좌표 원본 격자</span>}
      >
        <PpiHeatmap grid={az_range_grid} />
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
