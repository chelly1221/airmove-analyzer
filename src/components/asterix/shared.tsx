/**
 * ASTERIX 화면 공용 표시 컴포넌트 — 대시보드(AsterixAnalysis)와 통계 상세 페이지가 공유한다.
 * (AsterixAnalysis.tsx 파일 로컬 컴포넌트를 동작 불변으로 이전 — Section.onOpen 만 신규)
 */

import { useMemo, useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import type { LabeledCount, TimeDensity } from "../../types/asterix";
import type { TzMode } from "../../types/asterixDetail";
import { formatTime } from "./format";

export function StatCard({
  label,
  value,
  sub,
  onClick,
  title,
}: {
  label: string;
  value: string;
  sub?: string;
  onClick?: () => void;
  title?: string;
}) {
  const body = (
    <>
      <div className="text-[10px] uppercase tracking-wider text-gray-400">{label}</div>
      <div className="mt-0.5 text-lg font-semibold tabular-nums text-gray-800">{value}</div>
      {/* sub 줄은 값이 없어도 빈 줄로 항상 렌더 — 요약 카드 8장 높이 통일 */}
      <div className="text-[10px] text-gray-400">{sub ?? " "}</div>
    </>
  );
  const base = "rounded-lg border border-gray-200 bg-[#f8f9fa] px-3 py-2";
  // onClick 있으면 버튼화 (외형은 동일, 호버 강조만 추가)
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        title={title}
        className={`${base} w-full cursor-pointer text-left transition-colors hover:border-[#a60739]/40`}
      >
        {body}
      </button>
    );
  }
  return (
    <div className={base} title={title}>
      {body}
    </div>
  );
}

/** Section 본문 고정 높이 티어 — 같은 그리드 행의 카드는 동일 티어를 써서 높이를 맞춘다 */
export type SectionSize = "sm" | "md" | "lg";
export const SECTION_BODY_H: Record<SectionSize, string> = { sm: "h-28", md: "h-48", lg: "h-72" };
/** 위 Tailwind 클래스의 픽셀값 (차트 높이 계산용 — 클래스와 반드시 동기 유지) */
export const SECTION_BODY_PX: Record<SectionSize, number> = { sm: 112, md: 192, lg: 288 };

export function Section({
  title,
  children,
  right,
  size,
  scroll = true,
  onOpen,
}: {
  title: string;
  children: React.ReactNode;
  right?: React.ReactNode;
  /** 지정 시 본문을 고정 높이 박스로 감싼다 (미지정=자연 높이, 전폭 카드용) */
  size?: SectionSize;
  /** 본문 세로 스크롤. 차트 카드는 ChartTip(카드 밖 절대배치)이 잘리므로 false */
  scroll?: boolean;
  /** 지정 시 헤더 우측에 "상세" 버튼 — 통계 상세 페이지로 드릴다운 (미지정 시 외형 불변) */
  onOpen?: () => void;
}) {
  return (
    <div
      className={`rounded-lg border border-gray-200 bg-white p-3${onOpen ? " transition-colors hover:border-[#a60739]/40" : ""}`}
    >
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-[12px] font-semibold text-gray-700">{title}</h3>
        {onOpen ? (
          <div className="flex items-center gap-2">
            {right}
            <button
              type="button"
              onClick={onOpen}
              title="이 항목의 상세 분석 페이지 열기"
              className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] font-medium text-gray-400 transition-colors hover:bg-[#a60739]/5 hover:text-[#a60739]"
            >
              상세
              <ChevronRight size={11} />
            </button>
          </div>
        ) : (
          right
        )}
      </div>
      {size ? (
        <div className={`${SECTION_BODY_H[size]} ${scroll ? "overflow-y-auto pr-1" : ""}`}>{children}</div>
      ) : (
        children
      )}
    </div>
  );
}

export function BarRow({
  label,
  sub,
  count,
  total,
  color = "#a60739",
  labelWidth = "w-44",
}: {
  label: string;
  sub?: string;
  count: number;
  total: number;
  color?: string;
  /** 라벨 컬럼 폭 클래스 — 수치 구간 라벨은 좁게(w-28) 잡아 막대를 길게 */
  labelWidth?: string;
}) {
  const pct = total > 0 ? (count / total) * 100 : 0;
  return (
    <div className="flex items-center gap-2 py-0.5 text-[11px]">
      <div className={`${labelWidth} shrink-0 truncate text-gray-700`} title={label}>
        {label}
        {sub && <span className="ml-1 text-gray-400">{sub}</span>}
      </div>
      <div className="relative h-3.5 flex-1 overflow-hidden rounded bg-gray-100">
        <div className="absolute inset-y-0 left-0 rounded" style={{ width: `${pct}%`, background: color, opacity: 0.85 }} />
      </div>
      <div className="w-28 shrink-0 text-right tabular-nums text-gray-600">
        {count.toLocaleString()} <span className="text-gray-400">{pct >= 0.1 ? `${pct.toFixed(1)}%` : ""}</span>
      </div>
    </div>
  );
}

export function LabeledBars({
  items,
  total,
  color,
  labelWidth,
}: {
  items: LabeledCount[];
  total: number;
  color?: string;
  labelWidth?: string;
}) {
  if (items.length === 0) return <div className="text-[11px] text-gray-400">없음</div>;
  return (
    <div>
      {items.map((it) => (
        <BarRow key={it.key} label={it.label} count={it.count} total={total} color={color} labelWidth={labelWidth} />
      ))}
    </div>
  );
}

// ─── 차트 (순수 SVG, 단일 시리즈 · 단일 색상) ────────

export const CHART_INK = "#a60739";

/** 툴팁이 차트 밖으로 크게 튀지 않도록 x 위치를 컨테이너 안쪽으로 당김 */
export function clampTipX(x: number, width: number): number {
  if (width <= 120) return x;
  return Math.min(Math.max(x, 55), width - 55);
}

/** 차트 공용 호버 툴팁 — 컨테이너(relative) 기준 절대 배치 */
export function ChartTip({ x, text }: { x: number; text: string }) {
  return (
    <div
      className="pointer-events-none absolute -top-1 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded bg-gray-900/90 px-1.5 py-0.5 text-[10px] text-white shadow-sm"
      style={{ left: x }}
    >
      {text}
    </div>
  );
}

/**
 * 시간대별 레코드 밀도 — 버킷 스텝 실루엣.
 * 0 카운트 구간은 기준선까지 떨어져 수집 공백이 그대로 보인다.
 */
export function TimeDensityChart({ density, tz }: { density: TimeDensity; tz: TzMode }) {
  const { start_ts, bucket_secs, counts } = density;
  const n = counts.length;
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null);

  const H = 56; // 그래프 본체 높이 (viewBox 단위 = px)
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
  }, [counts, n, maxCount]);

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

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const frac = (e.clientX - rect.left) / rect.width;
    const idx = Math.min(n - 1, Math.max(0, Math.floor(frac * n)));
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
          className="block w-full"
          style={{ height: H }}
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
    </div>
  );
}

/** 로즈 차트 정사각 변 — lg 티어 본문 높이에 맞춰 원이 카드를 꽉 채운다 */
const AZ_ROSE_S = SECTION_BODY_PX.lg;
/** 축 라벨이 들어갈 바깥 여백 */
const AZ_ROSE_PAD = 16;
/** 섹터 사이를 갈라 보이게 하는 양쪽 인셋 각 */
const AZ_WEDGE_INSET_DEG = 0.6;

/**
 * 방위 분포 — 10° 섹터 36개 PPI 로즈 (0° = 북, 시계방향).
 * 반경은 카운트에 선형 비례(풍배도 관례)라 면적이 아닌 길이로 읽는다.
 * 카운트 0인 섹터는 웨지를 생략해 블랭킹·차폐 섹터가 빈 방향으로 드러난다.
 */
export function AzimuthRose({ bins }: { bins: number[] }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ idx: number; x: number } | null>(null);
  const total = useMemo(() => bins.reduce((a, b) => a + b, 0), [bins]);
  const maxV = useMemo(() => bins.reduce((a, b) => (b > a ? b : a), 0), [bins]);

  const S = AZ_ROSE_S;
  const c0 = S / 2;
  const R = c0 - AZ_ROSE_PAD;

  /** 나침반 좌표 → 화면 좌표 (0°=위, 시계방향) */
  const pt = (deg: number, r: number) => {
    const a = (deg * Math.PI) / 180;
    return [c0 + r * Math.sin(a), c0 - r * Math.cos(a)] as const;
  };
  /** 중심에서 뻗는 부채꼴 — 각이 증가하는 방향이 화면상 시계방향이라 sweep=1 */
  const wedge = (deg0: number, deg1: number, r: number) => {
    const [x0, y0] = pt(deg0, r);
    const [x1, y1] = pt(deg1, r);
    return `M${c0} ${c0} L${x0.toFixed(2)} ${y0.toFixed(2)} A${r.toFixed(2)} ${r.toFixed(2)} 0 0 1 ${x1.toFixed(2)} ${y1.toFixed(2)} Z`;
  };

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return;
    const dx = e.clientX - rect.left - rect.width / 2;
    const dy = e.clientY - rect.top - rect.height / 2;
    // 거리는 보지 않는다 — 짧은/빈 섹터도 집을 수 있게 히트 타깃을 사각형 전체로
    const angle = ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    const idx = Math.min(35, Math.floor(angle / 10));
    const wr = wrap.getBoundingClientRect();
    setHover({ idx, x: clampTipX(e.clientX - wr.left, wr.width) });
  };

  const tipText = (() => {
    if (!hover) return "";
    const c = bins[hover.idx] ?? 0;
    const pct = total > 0 ? (c / total) * 100 : 0;
    return `${hover.idx * 10}°–${hover.idx * 10 + 10}° · ${c.toLocaleString()}건 (${pct.toFixed(1)}%)`;
  })();

  return (
    <div ref={wrapRef} className="relative flex h-full items-center justify-center">
      {hover && <ChartTip x={hover.x} text={tipText} />}
      <svg
        viewBox={`0 0 ${S} ${S}`}
        className="block"
        style={{ width: S, height: S }}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <g stroke="#e5e7eb" strokeWidth={1} fill="none">
          {[0.25, 0.5, 0.75, 1].map((f) => (
            <circle key={f} cx={c0} cy={c0} r={R * f} />
          ))}
          <line x1={c0} y1={c0 - R} x2={c0} y2={c0 + R} />
          <line x1={c0 - R} y1={c0} x2={c0 + R} y2={c0} />
        </g>

        {hover && <path d={wedge(hover.idx * 10, hover.idx * 10 + 10, R)} fill={CHART_INK} opacity={0.08} />}

        {maxV > 0 &&
          bins.map((c, i) => {
            if (c <= 0) return null;
            return (
              <path
                key={i}
                d={wedge(i * 10 + AZ_WEDGE_INSET_DEG, (i + 1) * 10 - AZ_WEDGE_INSET_DEG, (c / maxV) * R)}
                fill={CHART_INK}
                opacity={hover?.idx === i ? 1 : 0.85}
              />
            );
          })}

        {/* 동/서 라벨은 여백(16px)보다 넓어 viewBox 가장자리에 붙여 잘림을 막는다 */}
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
