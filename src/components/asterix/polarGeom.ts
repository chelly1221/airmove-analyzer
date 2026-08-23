/**
 * 극좌표(PPI) 차트 기하 — ASTERIX 통계 상세 토픽 공용.
 *
 * 거리·방위 토픽의 1° 로즈와 PSR 채널 토픽의 PPI 히트맵이 같은 좌표 규약(0°=북, 시계방향)을
 * 써야 두 그림의 방위가 어긋나지 않으므로 여기서 단일 정의한다.
 * (컴포넌트가 없는 순수 모듈 — .tsx 에 두면 fast-refresh 경고가 난다)
 */

import { SECTION_BODY_PX } from "./shared";

/** PPI 히트맵 정사각 변 — 5°×5NM 셀이 뭉개지지 않는 크기 (lg 티어 이상) */
export const PPI_S = Math.max(SECTION_BODY_PX.lg, 420);
/** 축 라벨용 바깥 여백 */
export const POLAR_PAD = 18;

/** 나침반 좌표(0°=북, 시계방향) → 화면 좌표 */
export function polar(c: number, deg: number, r: number): readonly [number, number] {
  const a = (deg * Math.PI) / 180;
  return [c + r * Math.sin(a), c - r * Math.cos(a)] as const;
}

export const f2 = (v: number) => v.toFixed(2);

/** 중심에서 뻗는 부채꼴 (각 증가 = 화면상 시계방향이라 sweep=1) */
export function wedgePath(c: number, deg0: number, deg1: number, r: number): string {
  const [x0, y0] = polar(c, deg0, r);
  const [x1, y1] = polar(c, deg1, r);
  return `M${c} ${c} L${f2(x0)} ${f2(y0)} A${f2(r)} ${f2(r)} 0 0 1 ${f2(x1)} ${f2(y1)} Z`;
}

/** 부채꼴 고리 조각 (r0=내반경, r1=외반경) — 바깥호는 시계방향, 안쪽호는 되돌아오므로 sweep=0 */
export function ringSectorPath(c: number, deg0: number, deg1: number, r0: number, r1: number): string {
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
export function pointerAzimuth(dx: number, dy: number): number {
  return ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
}

/** 방위각 [0,360) 정규화 */
export const norm360 = (d: number) => ((d % 360) + 360) % 360;

/**
 * 적용된 방위 필터 → 실제로 그릴 각도 구간들.
 * azMin > azMax 는 0° 통과(랩어라운드)라 두 조각으로 쪼갠다 (Rust 시맨틱과 동일).
 */
export function azWindowSegments(min?: number, max?: number): { a: number; b: number }[] {
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
export function splitArcs(segs: { a: number; b: number }[], max = 90): { a: number; b: number }[] {
  const out: { a: number; b: number }[] = [];
  for (const s of segs) {
    for (let a = s.a; a < s.b - 1e-6; a += max) out.push({ a, b: Math.min(a + max, s.b) });
  }
  return out;
}
