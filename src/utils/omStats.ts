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
 *   - 관측량 기반 빈도성(frequency) 가중치 + 대표본(관측일수)이라 Bessel 보정(N-1) 영향이
 *     무시 가능 → 기술통계용 모표준편차(분모 Σw) 채택. (reliability weight 의 불편분산 보정과는 구분)
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

/** 기준선 Loss율 가중 평균 — 가중치: baseline_track_time_secs (전방위 표본량, 모집단 일치) */
export function weightedBaselineLossAvg(stats: DailyStats[]): number {
  return weightedAvg(stats, (d) => d.baseline_loss_rate, (d) => d.baseline_track_time_secs);
}

/** 기준선 Loss율 가중 표준편차 — 가중치: baseline_track_time_secs (전방위 표본량) */
export function weightedBaselineLossStdDev(stats: DailyStats[]): number {
  return weightedStdDev(stats, (d) => d.baseline_loss_rate, (d) => d.baseline_track_time_secs);
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
 * 가중 최소자승 회귀 기울기 (일별 추세 등).
 * x̄_w·ȳ_w 가중평균 후 slope = Σw(x−x̄)(y−ȳ) / Σw(x−x̄)².
 * omFindingsGenerator(레이더 일별 추세)·omAddedBlockage(추가 차단영역 시계열)이 공유.
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

// ─── 추가 차단영역 소실율 등급 ───
//
// 헤드라인 심각도 = 분석 대상 건물의 추가 차단영역 내 노출 조건부 소실율.
// gradeWithConfidence(전구간 소실율)와 달리, 얇은 추가 차단영역 내부의 조건부 비율이라
// 스케일이 다르다(전구간 0.5/2.0 재사용 금지).
//
// ⚠️ 임계값은 PLACEHOLDER — 실제 추가 차단영역 소실율 분포를 관측한 뒤 반드시 보정할 것.
export const BLOCKAGE_MIN_DAYS = 7;          // 관측일수 < 7 → 판정 보류 (주간 1주기, gradeWithConfidence 와 동일 규율)
export const BLOCKAGE_MIN_EXPOSURE_DAYS = 3; // 노출>0 인 날이 3일 미만이면 소수 일자 편중 → 대표성 부족 보류
export const BLOCKAGE_CAUTION_PCT = 2.0;     // 양호/주의 경계 (%)
export const BLOCKAGE_ALERT_PCT = 10.0;      // 주의/경고 경계 (%)

/** 추가 차단영역 자체가 형성되지 않은 경우(지형·기존지물 이하)의 등급 라벨 — 비율 개념이 성립하지 않음. */
export const BLOCKAGE_NONE_LABEL = "추가 차단 구간 없음";

/**
 * 추가 차단영역 소실율 등급 — 밴드 존재 게이트 + 삼중 게이트(관측일수·통과항적유무·노출일수) 후 임계 판정.
 *
 * 판정 순서:
 *   0) 추가 차단 밴드 미형성(분석 대상이 지형·기존지물 위로 올라오지 않음) → "추가 차단 구간 없음"
 *      — 밴드 기하는 관측일수와 무관하므로 다른 게이트보다 먼저 판정한다(panoWith 없어 판정 불가면 hasBlockageBand=true 로 폴백).
 *   1) 관측일수 < 7 → "판정 보류"
 *   2) 통과 항적 전무(노출 0) → "항적 없음"
 *   3) 노출 발생일 < 3 → "판정 보류"
 * 통과 항적이 전무(노출 0)하거나 소수 일자에 편중되면 노이즈% 대신 "항적 없음/판정 보류"를 정직하게 표기.
 */
export function gradeAddedBlockage(
  lossRatePct: number,
  dayCount: number,
  exposureTrackTimeS: number,
  daysWithExposure: number,
  hasBlockageBand: boolean = true,
): { label: string; color: string; bg: string; border: string } {
  if (!hasBlockageBand) {
    // 분석 대상 장애물이 지형·기존지물 차단각 위로 추가 차단영역을 형성하지 않음 → 소실율(노출 조건부 비율) 정의 불가.
    return { label: BLOCKAGE_NONE_LABEL, color: "#6b7280", bg: "#f3f4f6", border: "border-gray-300" };
  }
  if (dayCount < BLOCKAGE_MIN_DAYS) {
    return { label: "판정 보류", color: "#6b7280", bg: "#f3f4f6", border: "border-gray-300" };
  }
  if (exposureTrackTimeS <= 0) {
    // 차단영역을 통과한 항적이 전무 → 비율 산출 불가(정직 표기). 600초 누적-노출 게이트는 폐지.
    return { label: "항적 없음", color: "#6b7280", bg: "#f3f4f6", border: "border-gray-300" };
  }
  if (daysWithExposure < BLOCKAGE_MIN_EXPOSURE_DAYS) {
    // 노출 총량은 충분하나 소수 일자에 편중 → 추세·대표성 부족으로 보류
    return { label: "판정 보류", color: "#6b7280", bg: "#f3f4f6", border: "border-gray-300" };
  }
  if (lossRatePct < BLOCKAGE_CAUTION_PCT) return { label: "양호", color: "#15803d", bg: "#dcfce7", border: "border-green-200" };
  if (lossRatePct < BLOCKAGE_ALERT_PCT) return { label: "주의", color: "#b45309", bg: "#fef3c7", border: "border-yellow-200" };
  return { label: "경고", color: "#b91c1c", bg: "#fee2e2", border: "border-red-200" };
}
