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

/** 추가 차단영역 자체가 형성되지 않은 경우(지형·기존지물 이하)의 등급 라벨 — 비율 개념이 성립하지 않음. */
export const BLOCKAGE_NONE_LABEL = "추가 차단 구간 없음";

/** 기준데이터(참조 달) 미적용 시의 등급 라벨 — 등급 판정 근거(기준월 소실율) 부재로 Δ 등급 산출 불가(회색). */
export const BLOCKAGE_NO_REF_LABEL = "기준데이터 없음";

// ─── 추가 차단영역 소실율 — 기준데이터 대비 편차(Δ%p) 등급 ───
//
// 소실율 절대값은 사이트·지형·트래픽에 좌우돼 고정 임계 보정이 어렵다. 임의 참조 달(기준데이터)
// 1달치 대비 편차(Δ%p = 분석월 소실율 − 기준월 소실율)로만 판정하면 사이트 고유 배경 소실이
// 상쇄되어 '장애물 준공 등 변화에 의한 순증분'만 남는다. (관심-주의-경계-심각 4단계 위기경보
// 색상 관례를 따르되, 스케일은 '%p 편차'라 별도 상수로 둔다. 음수 Δ(기준보다 개선)도 양호.)
//
// ※ 실측 보정 완료 (2026-07-24) — 기준월 2026-04 김포#1/#2 원시 아카이브 재집계(20.6M점)로
//    추가 차단 밴드와 같은 꼴(방위 2° 웨지 × 저양각 0.3° 밴드, 레이더당 360웨지)의 노출 조건부
//    소실율에 대해 같은 밴드의 반월 분할 |Δ| 노이즈를 측정:
//      노출≥2h/half: p90 6.3 · p95 10.1 · p99 17.9 %p
//      노출≥4h/half: p90 5.0 · p95 6.1 · p99 8.1 %p (홀짝일 분할(드리프트 제거) p95 4.9 %p)
//    → 관심 +5%p ≈ 고노출 노이즈 상단(p90), 주의 +10%p ≈ 전형 노출 p95(실변화 개연),
//      경계 +20%p > p99(명확한 변화), 심각 +30%p ≫ 노이즈. 음수 Δ(개선)는 양호.
export const BLOCKAGE_DELTA_WATCH_PP = 5.0;   // 양호/관심 경계 (Δ %p)
export const BLOCKAGE_DELTA_CAUTION_PP = 10.0; // 관심/주의 경계 (Δ %p)
export const BLOCKAGE_DELTA_ALERT_PP = 20.0;   // 주의/경계 경계 (Δ %p)
export const BLOCKAGE_DELTA_SEVERE_PP = 30.0;  // 경계/심각 경계 (Δ %p)

/**
 * 추가 차단영역 소실율 등급 (기준데이터 대비 편차 Δ%p 기준).
 *
 * 게이트(밴드 미형성 → "추가 차단 구간 없음" · 노출 0pt → "항적 없음")만 우선 판정하고, 통과 시
 * 편차 임계로 등급화한다. 표본 게이트(구 표본 부족 라벨)는 폐지 — 통과 항적 수와 무관하게 실측 Δ 를 그대로
 * 등급화한다. 반환 형태({label,color,bg,border})는 회색 게이트 라벨과 Δ 등급이 동일해 소비처
 * (요약표·소견표)가 구분 없이 렌더한다.
 *   Δ < 5 양호(음수 포함) / < 10 관심 / < 20 주의 / < 30 경계 / ≥ 30 심각.
 */
export function gradeAddedBlockageDelta(
  deltaPp: number,
  exposurePointCount: number,
  hasBlockageBand: boolean = true,
): { label: string; color: string; bg: string; border: string } {
  if (!hasBlockageBand) {
    return { label: BLOCKAGE_NONE_LABEL, color: "#6b7280", bg: "#f3f4f6", border: "border-gray-300" };
  }
  if (exposurePointCount <= 0) {
    return { label: "항적 없음", color: "#6b7280", bg: "#f3f4f6", border: "border-gray-300" };
  }
  if (deltaPp < BLOCKAGE_DELTA_WATCH_PP)   return { label: "양호", color: "#15803d", bg: "#dcfce7", border: "border-green-200" };
  if (deltaPp < BLOCKAGE_DELTA_CAUTION_PP) return { label: "관심", color: "#1d4ed8", bg: "#dbeafe", border: "border-blue-200" };
  if (deltaPp < BLOCKAGE_DELTA_ALERT_PP)   return { label: "주의", color: "#b45309", bg: "#fef3c7", border: "border-yellow-200" };
  if (deltaPp < BLOCKAGE_DELTA_SEVERE_PP)  return { label: "경계", color: "#c2410c", bg: "#ffedd5", border: "border-orange-200" };
  return { label: "심각", color: "#b91c1c", bg: "#fee2e2", border: "border-red-200" };
}
