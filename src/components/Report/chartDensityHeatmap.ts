/**
 * OM 보고서 차트(LoS 단면도·Az×Elev) 공용 밀도 히트맵 렌더 헬퍼.
 *
 * 두 차트 모두 항적/소실표적을 개별 점(circle)으로 그리는데, 점이 수천~수만 개라 밀집 구간의
 * 분포가 보이지 않는다. 이미 차트 좌표로 투영된 점들을 정방형 셀로 비닝해 단일 색상 알파 램프로
 * 그려, 점 표시 ↔ 밀도 히트맵을 토글로 전환할 수 있게 한다. (비닝은 전 점을 카운트하는 집계라
 *  표본화가 아님 — 다운샘플링 금지 규칙 위반 아님.)
 */

/** 히트맵 단일 색상 램프 — 소실표적(빨강 #ff1745, 기존 LOSS_COLOR 와 동일) */
export const HEATMAP_LOSS_RGB: [number, number, number] = [255, 23, 69];
/** 히트맵 단일 색상 램프 — 항적(파랑 #2563eb blue-600. 지형 녹색·추가차단 핑크·소실 빨강과
 *  겹치지 않는 hue. 점 모드의 detection type 색과 달리 히트맵 모드에선 밀도 단일 색). */
export const HEATMAP_TRACK_RGB: [number, number, number] = [37, 99, 235];

/** 이미 차트 좌표(viewBox px)로 투영된 점들을 정방형 셀로 비닝해 단일 색상 알파 램프 히트맵으로 그린다. */
export function drawDensityHeatmap(
  ctx: CanvasRenderingContext2D,
  points: { x: number; y: number }[],   // viewBox 좌표(투영 완료)
  plot: { x: number; y: number; w: number; h: number }, // 플롯 내부 rect (viewBox)
  cellPx: number,                        // 셀 한 변 (viewBox px)
  rgb: [number, number, number],         // 단일 색상 (순차 램프 hue)
  opts?: { alphaMin?: number; alphaMax?: number },
): void {
  const alphaMin = opts?.alphaMin ?? 0.18;
  const alphaMax = opts?.alphaMax ?? 0.92;
  const cols = Math.ceil(plot.w / cellPx);
  const rows = Math.ceil(plot.h / cellPx);
  if (cols <= 0 || rows <= 0) return;

  // 셀 카운트 — 대량 점(수천~수만)에서 GC 압박 없게 typed array 로 누산.
  const counts = new Uint32Array(cols * rows);
  let maxCount = 0;
  for (const p of points) {
    // plot rect 밖 점은 제외 (인덱스 클램프 아님 — 줌 윈도우 밖 점이 가장자리 셀에 뭉치면 안 됨).
    if (p.x < plot.x || p.x >= plot.x + plot.w || p.y < plot.y || p.y >= plot.y + plot.h) continue;
    const cx = Math.floor((p.x - plot.x) / cellPx);
    const cy = Math.floor((p.y - plot.y) / cellPx);
    const idx = cy * cols + cx;
    const c = counts[idx] + 1;
    counts[idx] = c;
    if (c > maxCount) maxCount = c;
  }
  if (maxCount === 0) return; // 그릴 점 없음

  const [r, g, b] = rgb;
  const span = alphaMax - alphaMin;
  // 셀마다 fillRect — sqrt 스케일이라 단발 셀도 보인다. 셀 수는 수천 개 수준이라 단순 루프로 충분.
  for (let cy = 0; cy < rows; cy++) {
    for (let cx = 0; cx < cols; cx++) {
      const c = counts[cy * cols + cx];
      if (c === 0) continue;
      const a = alphaMin + span * Math.sqrt(c / maxCount);
      ctx.fillStyle = `rgba(${r},${g},${b},${a})`;
      ctx.fillRect(plot.x + cx * cellPx, plot.y + cy * cellPx, cellPx, cellPx);
    }
  }
}
