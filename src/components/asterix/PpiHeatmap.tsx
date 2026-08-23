/**
 * PPI(방위 5° × 거리 5NM) 극좌표 히트맵 — 통계 상세 토픽 공용.
 *
 * TrafficDetail 로컬 컴포넌트를 동작 불변으로 추출한 것(거리·방위 토픽의 건수 격자)에
 * `valueMode="ratio"` 를 더해 PSR 채널 토픽의 탐지율 격자도 같은 그림으로 그린다.
 * shared.tsx 는 대시보드와 공유하는 동결 모듈이라 상세 전용 극좌표 차트는 여기에 둔다.
 * 좌표 규약(0°=북, 시계방향)과 기하 헬퍼는 polarGeom.ts 단일 원천.
 */

import { useId, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";
import { CHART_INK, ChartTip, clampTipX } from "./shared";
import { ChartHint } from "./detailUi";
import {
  azWindowSegments,
  f2,
  polar,
  POLAR_PAD,
  pointerAzimuth,
  PPI_S,
  ringSectorPath,
  splitArcs,
} from "./polarGeom";
import { AZ_GRID_SECTORS, RANGE_GRID_BINS } from "../../types/asterixDetail";
import type { AsterixDetailFilter } from "../../types/asterixDetail";

// ─── 히트맵 ────────────────────────────────────────────────────────

/**
 * 셀 값의 의미.
 * - count: 건수 격자. 진하기 = log(1+c)/log(1+max), 0건 셀은 그리지 않는다.
 * - ratio: 0~1 비율 격자(NaN = 표본 없음 → 미표시). 진하기는 선형이되 0% 도 옅게 보이도록
 *   바닥값(RATIO_OP_FLOOR)을 둔다 — "표본은 있는데 0%" 와 "표본 자체가 없음" 을 구분해야 한다.
 */
export type PpiValueMode = "count" | "ratio";

/** ratio 모드 진하기 바닥값 — 0% 셀도 보이게 (미표시 셀과 구분) */
const RATIO_OP_FLOOR = 0.12;

/** 셀에 표본이 있는가 — ratio 는 NaN 이 결측, count 는 0 이 결측 */
const cellHasData = (v: number, mode: PpiValueMode) => (mode === "ratio" ? Number.isFinite(v) : v > 0);

/**
 * az_range_grid(72×52)를 극좌표 도넛 섹터로 렌더.
 * 셀 색은 단색(CHART_INK) 고정, 진하기(오파시티)만 변조해 몇 자릿수 차이 나는 셀 밀도를
 * 한 화면에서 읽게 한다.
 */
export default function PpiHeatmap({
  grid,
  filter,
  onQuickFilter,
  valueMode = "count",
  formatValue,
  emptyText = "I048/040 ρ·θ 동시 관측 없음",
}: {
  /** idx = az*RANGE_GRID_BINS + r */
  grid: number[];
  /** 현재 적용된 방위·거리 필터 — 격자 위 창(window) 하이라이트 */
  filter: AsterixDetailFilter;
  onQuickFilter: (p: Partial<AsterixDetailFilter>) => void;
  valueMode?: PpiValueMode;
  /** 툴팁 값 표기 — idx = az*RANGE_GRID_BINS + r (미지정 시 count=건수, ratio=백분율) */
  formatValue?: (v: number, idx: number) => string;
  /** 표본이 전혀 없을 때의 안내 문구 */
  emptyText?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const gradId = useId();
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
      if (!cellHasData(c, valueMode)) continue;
      k++;
      if (c > mx) mx = c;
      if (c < mn) mn = c;
    }
    return { maxV: mx, minNz: Number.isFinite(mn) ? mn : 0, cellsWithData: k };
  }, [grid, valueMode]);

  /** 값 → 셀 진하기 */
  const opacityOf = useMemo(() => {
    if (valueMode === "ratio") {
      return (v: number) => RATIO_OP_FLOOR + (1 - RATIO_OP_FLOOR) * Math.max(0, Math.min(1, v));
    }
    const denom = Math.log(1 + maxV);
    return (v: number) => (denom > 0 ? Math.log(1 + v) / denom : 0);
  }, [valueMode, maxV]);

  // 셀 엘리먼트는 메모 — 호버 상태 변경 때 3,744개 경로를 재조정하지 않게 한다
  const cells = useMemo(() => {
    if (cellsWithData === 0) return [] as ReactElement[];
    const out: ReactElement[] = [];
    for (let az = 0; az < AZ_GRID_SECTORS; az++) {
      for (let r = 0; r < RANGE_GRID_BINS; r++) {
        const c = grid[az * RANGE_GRID_BINS + r] ?? NaN;
        if (!cellHasData(c, valueMode)) continue;
        out.push(
          <path
            key={`${az}:${r}`}
            d={ringSectorPath(c0, az * 5, az * 5 + 5, r * ringW, (r + 1) * ringW)}
            fill={CHART_INK}
            opacity={opacityOf(c)}
          />,
        );
      }
    }
    return out;
  }, [grid, valueMode, cellsWithData, opacityOf, c0, ringW]);

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

  const hoverIdx = hover ? hover.az * RANGE_GRID_BINS + hover.r : -1;
  const hoverValue = hover ? (grid[hoverIdx] ?? NaN) : NaN;
  const hoverHasData = hover != null && cellHasData(hoverValue, valueMode);
  const valueText = (v: number, idx: number) =>
    formatValue ? formatValue(v, idx) : valueMode === "ratio" ? `${(v * 100).toFixed(1)}%` : `${v.toLocaleString()}건`;
  const tipText = hover
    ? `az ${hover.az * 5}°–${hover.az * 5 + 5}° · ${hover.r * 5}–${hover.r * 5 + 5}NM · ${
        hoverHasData ? valueText(hoverValue, hoverIdx) : "표본 없음"
      }${hoverHasData ? " · 클릭 = 이 셀로 재집계" : ""}`
    : "";

  /** 셀 클릭 = 그 5°×5NM 셀 범위로 재집계 (표본 없는 셀은 결과가 비므로 막는다) */
  const onCellClick = () => {
    if (!hover || !hoverHasData) return;
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

  // 범례 그라데이션 — 셀 진하기와 같은 곡선으로 stop 을 찍는다
  const legendStops = useMemo(() => {
    const lo = valueMode === "ratio" ? 0 : minNz;
    const hi = valueMode === "ratio" ? 1 : maxV;
    return Array.from({ length: 9 }, (_, i) => {
      const t = i / 8;
      return { t, op: opacityOf(lo + t * (hi - lo)) };
    });
  }, [valueMode, maxV, minNz, opacityOf]);

  if (cellsWithData === 0) return <div className="text-[11px] text-gray-400">{emptyText}</div>;

  return (
    <div className="flex flex-col items-center">
      <div ref={wrapRef} className="relative w-full" style={{ maxWidth: S }}>
        {hover && <ChartTip x={hover.x} text={tipText} />}
        <svg
          viewBox={`0 0 ${S} ${S}`}
          className={`block aspect-square w-full ${hoverHasData ? "cursor-pointer" : ""}`}
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

      {/* 범례 — 오파시티 그라데이션 바 + 최소/최대 */}
      <div className="mt-2 flex items-center gap-2" style={{ width: Math.min(S, 320), maxWidth: "100%" }}>
        <span className="shrink-0 text-[9px] tabular-nums text-gray-400">
          {valueMode === "ratio" ? "0%" : `${minNz.toLocaleString()}건`}
        </span>
        <svg viewBox="0 0 100 8" preserveAspectRatio="none" className="h-2 flex-1">
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
              {legendStops.map((s) => (
                <stop key={s.t} offset={s.t} stopColor={CHART_INK} stopOpacity={s.op} />
              ))}
            </linearGradient>
          </defs>
          <rect x="0" y="0" width="100" height="8" fill={`url(#${gradId})`} />
        </svg>
        <span className="shrink-0 text-[9px] tabular-nums text-gray-400">
          {valueMode === "ratio" ? "100%" : `${maxV.toLocaleString()}건`}
        </span>
      </div>
      <div className="mt-0.5 text-[10px] text-gray-400">
        셀 진하기 = {valueMode === "ratio" ? "탐지율(선형, 0%도 옅게 표시)" : "건수(log 스케일)"} · 관측 셀{" "}
        {cellsWithData.toLocaleString()} / {(AZ_GRID_SECTORS * RANGE_GRID_BINS).toLocaleString()}
      </div>
      <ChartHint
        text={`관측이 있는 셀을 클릭하면 그 방위 5° × 거리 5NM 범위로 전수 재집계합니다${
          activeCells.length > 0 ? " — 음영 = 현재 적용된 방위·거리 필터" : ""
        }`}
      />
    </div>
  );
}
