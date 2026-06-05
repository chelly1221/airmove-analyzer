/**
 * 장애물 월간 보고서 — 통계 유틸리티
 *
 * ── 가중 평균/표준편차 산식 근거 ──
 *
 * 일별 통계값(PSR율, Loss율)은 해당 일의 관측량(포인트 수, 비행시간)에 따라
 * 신뢰도가 크게 달라진다. 비행 1편(수백 포인트)만 있는 날과 수십 편이 있는 날을
 * 동일 가중치로 산술 평균하면, 소수 관측의 극단값이 전체 평균을 왜곡한다.
 *
 * 따라서 모든 평균은 **관측량 가중 평균(weighted mean)** 으로 계산한다:
 *   x̄_w = Σ(w_i · x_i) / Σ(w_i)
 *
 * 가중치 선택 근거:
 *   - Loss율 → total_track_time_secs (비행시간)
 *     Loss율 = total_loss_time / total_track_time 이므로,
 *     비행시간이 긴 날이 분모가 커서 통계적으로 더 안정적이다.
 *   - PSR율 → ssr_combined_points (SSR 포인트 수)
 *     PSR율 = psr_combined / ssr_combined 이므로,
 *     SSR 포인트가 많은 날이 더 안정적이다.
 *
 * 표준편차는 **가중 모표준편차(population weighted σ)** 를 사용한다:
 *   σ_w = √( Σ(w_i · (x_i - x̄_w)²) / Σ(w_i) )
 *   - reliability weights(빈도 가중치)이므로 Bessel 보정(N-1) 불필요
 *
 * ── 판정 보류 기준 ──
 * 관측일수 < 7일이면 "판정 보류":
 *   - 주간 주기(요일별 트래픽 패턴)를 최소 1회전 포함해야
 *     평일/주말 편향 없는 대표 통계가 산출된다.
 *   - 표본 크기가 충분해야 σ가 의미 있는 산포를 반영한다.
 */
import type { DailyStats } from "../types";

/**
 * 가중 평균
 * x̄_w = Σ(w_i · x_i) / Σ(w_i)
 * weight 합이 0이면 0 반환
 */
export function weightedAvg(
  stats: DailyStats[],
  getValue: (d: DailyStats) => number,
  getWeight: (d: DailyStats) => number,
): number {
  let sumWV = 0, sumW = 0;
  for (const d of stats) {
    const w = getWeight(d);
    if (w <= 0) continue;
    sumWV += getValue(d) * w;
    sumW += w;
  }
  return sumW > 0 ? sumWV / sumW : 0;
}

/**
 * 가중 모표준편차 (reliability weights)
 * σ_w = √( Σ(w_i · (x_i - x̄_w)²) / Σ(w_i) )
 */
export function weightedStdDev(
  stats: DailyStats[],
  getValue: (d: DailyStats) => number,
  getWeight: (d: DailyStats) => number,
): number {
  const mean = weightedAvg(stats, getValue, getWeight);
  let sumW = 0, sumWD2 = 0;
  for (const d of stats) {
    const w = getWeight(d);
    if (w <= 0) continue;
    const diff = getValue(d) - mean;
    sumWD2 += w * diff * diff;
    sumW += w;
  }
  return sumW > 0 ? Math.sqrt(sumWD2 / sumW) : 0;
}

/** Loss율 가중 평균 — 가중치: total_track_time_secs (비행시간) */
export function weightedLossAvg(stats: DailyStats[]): number {
  return weightedAvg(stats, (d) => d.loss_rate, (d) => d.total_track_time_secs);
}

/** Loss율 가중 표준편차 — 가중치: total_track_time_secs */
export function weightedLossStdDev(stats: DailyStats[]): number {
  return weightedStdDev(stats, (d) => d.loss_rate, (d) => d.total_track_time_secs);
}

/** PSR율 가중 평균 — 가중치: ssr_combined_points (SSR 포인트 수), 결과 0–1 */
export function weightedPsrAvg(stats: DailyStats[]): number {
  return weightedAvg(stats, (d) => d.psr_rate, (d) => d.ssr_combined_points);
}

/** PSR율 가중 표준편차 — 가중치: ssr_combined_points, 결과 0–1 */
export function weightedPsrStdDev(stats: DailyStats[]): number {
  return weightedStdDev(stats, (d) => d.psr_rate, (d) => d.ssr_combined_points);
}

/** 기준선 Loss율 가중 평균 — 가중치: total_track_time_secs */
export function weightedBaselineLossAvg(stats: DailyStats[]): number {
  return weightedAvg(stats, (d) => d.baseline_loss_rate, (d) => d.total_track_time_secs);
}

/** 기준선 Loss율 가중 표준편차 — 가중치: total_track_time_secs */
export function weightedBaselineLossStdDev(stats: DailyStats[]): number {
  return weightedStdDev(stats, (d) => d.baseline_loss_rate, (d) => d.total_track_time_secs);
}

/**
 * 판정 등급 (관측일수 < 7이면 판정 보류)
 *
 * 임계값 근거:
 *   - 양호 (< 0.5%): 자연 환경(기상, 지형)에 의한 배경 소실율 수준
 *   - 주의 (0.5–2.0%): 장애물 영향 가능성, 모니터링 필요
 *   - 경고 (≥ 2.0%): 운용 영향 우려, 대책 검토 필요
 */
export function gradeWithConfidence(
  avgLoss: number,
  dayCount: number,
): { label: string; color: string; bg: string; border: string } {
  if (dayCount < 7) {
    return { label: "판정 보류", color: "#6b7280", bg: "#f3f4f6", border: "border-gray-300" };
  }
  if (avgLoss < 0.5) return { label: "양호", color: "#15803d", bg: "#dcfce7", border: "border-green-200" };
  if (avgLoss < 2.0) return { label: "주의", color: "#b45309", bg: "#fef3c7", border: "border-yellow-200" };
  return { label: "경고", color: "#b91c1c", bg: "#fee2e2", border: "border-red-200" };
}

/**
 * 편차 해석 임계값 — 이 범위 내이면 "유사 수준" 판정
 *
 * Loss율 (%p): 0.1%p — 통상적 배경 소실율 변동 폭 이내
 * PSR율 (%p): 0.5%p — PSR율은 80–100% 범위로, Loss 대비 변동 스케일이 큼
 */
export const LOSS_DEV_THRESHOLD = 0.1;
export const PSR_DEV_THRESHOLD = 0.5;

/**
 * 가중 최소자승 회귀 기울기 (일별 추세 등).
 * x̄_w·ȳ_w 가중평균 후 slope = Σw(x−x̄)(y−ȳ) / Σw(x−x̄)².
 * omFindingsGenerator(레이더 일별 추세)·omWedgeMetric(쐐기 시계열)이 공유.
 */
export function weightedTrendSlope(
  points: { x: number; y: number; w: number }[],
): number {
  let sumW = 0;
  for (const p of points) sumW += p.w;
  if (sumW <= 0) return 0;
  let xMean = 0, yMean = 0;
  for (const p of points) { xMean += p.x * p.w; yMean += p.y * p.w; }
  xMean /= sumW; yMean /= sumW;
  let num = 0, den = 0;
  for (const p of points) {
    num += p.w * (p.x - xMean) * (p.y - yMean);
    den += p.w * (p.x - xMean) ** 2;
  }
  return den > 0 ? num / den : 0;
}

// ─── 추가 차단영역(쐐기) 소실율 등급 ───
//
// 헤드라인 심각도 = 분석 대상 건물의 추가 차단영역(쐐기) 내 노출 조건부 소실율.
// gradeWithConfidence(전구간 소실율)와 달리, 얇은 쐐기 내부의 조건부 비율이라
// 스케일이 다르다(전구간 0.5/2.0 재사용 금지).
//
// ⚠️ 임계값은 PLACEHOLDER — 실제 쐐기 소실율 분포를 관측한 뒤 반드시 보정할 것.
export const WEDGE_MIN_DAYS = 7;          // 관측일수 < 7 → 판정 보류 (주간 1주기, gradeWithConfidence 와 동일 규율)
export const WEDGE_MIN_EXPOSURE_S = 600;  // 누적 노출 < 10분 → "노출 없음"(영향 없음). 쐐기 희소 고분산 1차 방어.
export const WEDGE_CAUTION_PCT = 2.0;     // 양호/주의 경계 (%)
export const WEDGE_ALERT_PCT = 10.0;      // 주의/경고 경계 (%)

/**
 * 쐐기 소실율 등급 — 이중 게이트(관측일수, 노출량) 후 임계 판정.
 * 노출이 거의 없으면 노이즈% 대신 "노출 없음 → 영향 없음"을 정직하게 표기.
 */
export function gradeWedge(
  wedgeLossRatePct: number,
  dayCount: number,
  exposureTrackTimeS: number,
): { label: string; color: string; bg: string; border: string } {
  if (dayCount < WEDGE_MIN_DAYS) {
    return { label: "판정 보류", color: "#6b7280", bg: "#f3f4f6", border: "border-gray-300" };
  }
  if (exposureTrackTimeS < WEDGE_MIN_EXPOSURE_S) {
    return { label: "노출 없음", color: "#6b7280", bg: "#f3f4f6", border: "border-gray-300" };
  }
  if (wedgeLossRatePct < WEDGE_CAUTION_PCT) return { label: "양호", color: "#15803d", bg: "#dcfce7", border: "border-green-200" };
  if (wedgeLossRatePct < WEDGE_ALERT_PCT) return { label: "주의", color: "#b45309", bg: "#fef3c7", border: "border-yellow-200" };
  return { label: "경고", color: "#b91c1c", bg: "#fee2e2", border: "border-red-200" };
}
