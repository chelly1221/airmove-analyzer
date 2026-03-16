import type { TrackPoint } from "../types";

/**
 * 이상고도 보정 유틸리티
 *
 * 연속된 항적 포인트 간 물리적으로 불가능한 고도 변화를 감지하고,
 * 앞뒤 정상 포인트를 기준으로 선형 보간하여 보정.
 */

/** 최대 허용 수직속도 (m/s) — 약 40,000 ft/min, 명백한 이상값만 걸러냄 */
const MAX_VERTICAL_RATE_MS = 200;

/** 최소 고도 (m) — 이보다 낮으면 이상값 (지상인데 비행 중일 때) */
const MIN_VALID_ALTITUDE_M = -100;

/** 최대 고도 (m) — FL600 ≈ 18,288m, 이보다 높으면 이상값 */
const MAX_VALID_ALTITUDE_M = 20000;

/** 이상고도 보정 결과 */
export interface AltitudeCorrectionResult {
  /** 보정된 포인트 배열 (원본과 같은 길이) */
  points: TrackPoint[];
  /** 보정된 포인트 수 */
  correctedCount: number;
}

/**
 * 시간순 정렬된 동일 mode_s 포인트 배열에서 이상고도를 감지하고 보정.
 *
 * 알고리즘:
 * 1. 절대 범위 벗어난 고도 → 이상값
 * 2. 앞뒤 포인트 대비 수직속도가 임계값 초과 → 이상값 후보
 *    - 단, 앞뒤 모두와 비교하여 양쪽 다 이상이면 이상값 확정
 * 3. 이상값은 가장 가까운 양쪽 정상 포인트로 선형 보간
 */
export function correctAnomalousAltitudes(
  points: TrackPoint[],
): AltitudeCorrectionResult {
  if (points.length < 3) return { points, correctedCount: 0 };

  const n = points.length;
  const isAnomalous = new Array<boolean>(n).fill(false);

  // 1단계: 절대 범위 검사
  for (let i = 0; i < n; i++) {
    const alt = points[i].altitude;
    if (alt < MIN_VALID_ALTITUDE_M || alt > MAX_VALID_ALTITUDE_M) {
      isAnomalous[i] = true;
    }
  }

  // 2단계: 수직속도 기반 이상값 감지
  // 앞뒤 포인트와의 수직속도를 비교하여 양쪽 다 비정상이면 이상값
  for (let i = 1; i < n - 1; i++) {
    if (isAnomalous[i]) continue;

    const prev = points[i - 1];
    const curr = points[i];
    const next = points[i + 1];

    const dtPrev = curr.timestamp - prev.timestamp;
    const dtNext = next.timestamp - curr.timestamp;

    // 시간 간격이 0이면 스킵
    if (dtPrev <= 0 || dtNext <= 0) continue;

    // 이전 포인트가 이상값이면 비교 불가 → 스킵
    if (isAnomalous[i - 1]) continue;

    const vrPrev = Math.abs(curr.altitude - prev.altitude) / dtPrev;
    const vrNext = Math.abs(next.altitude - curr.altitude) / dtNext;

    // 앞뒤 모두 수직속도 초과 → 이 포인트가 이상값
    if (vrPrev > MAX_VERTICAL_RATE_MS && vrNext > MAX_VERTICAL_RATE_MS) {
      isAnomalous[i] = true;
    }
  }

  // 첫/끝 포인트 검사: 다음/이전 정상 포인트와의 수직속도만 확인
  if (!isAnomalous[0] && n >= 2) {
    const dt = points[1].timestamp - points[0].timestamp;
    if (dt > 0 && !isAnomalous[1]) {
      const vr = Math.abs(points[1].altitude - points[0].altitude) / dt;
      // 첫 포인트가 이상하고, 두 번째~세 번째는 유사하면 첫 포인트가 이상
      if (vr > MAX_VERTICAL_RATE_MS && n >= 3 && !isAnomalous[2]) {
        const dt23 = points[2].timestamp - points[1].timestamp;
        if (dt23 > 0) {
          const vr23 = Math.abs(points[2].altitude - points[1].altitude) / dt23;
          if (vr23 <= MAX_VERTICAL_RATE_MS) {
            // 1→2는 정상인데 0→1이 비정상 → 0이 이상값
            isAnomalous[0] = true;
          }
        }
      }
    }
  }

  if (!isAnomalous[n - 1] && n >= 2) {
    const dt = points[n - 1].timestamp - points[n - 2].timestamp;
    if (dt > 0 && !isAnomalous[n - 2]) {
      const vr = Math.abs(points[n - 1].altitude - points[n - 2].altitude) / dt;
      if (vr > MAX_VERTICAL_RATE_MS && n >= 3 && !isAnomalous[n - 3]) {
        const dt_prev = points[n - 2].timestamp - points[n - 3].timestamp;
        if (dt_prev > 0) {
          const vr_prev = Math.abs(points[n - 2].altitude - points[n - 3].altitude) / dt_prev;
          if (vr_prev <= MAX_VERTICAL_RATE_MS) {
            isAnomalous[n - 1] = true;
          }
        }
      }
    }
  }

  // 3단계: 이상값 보정 — 가장 가까운 양쪽 정상 포인트로 선형 보간
  let correctedCount = 0;
  const corrected = points.map((p, i) => {
    if (!isAnomalous[i]) return p;

    // 왼쪽 정상 포인트 찾기
    let leftIdx = -1;
    for (let j = i - 1; j >= 0; j--) {
      if (!isAnomalous[j]) { leftIdx = j; break; }
    }

    // 오른쪽 정상 포인트 찾기
    let rightIdx = -1;
    for (let j = i + 1; j < n; j++) {
      if (!isAnomalous[j]) { rightIdx = j; break; }
    }

    let newAlt: number;
    if (leftIdx >= 0 && rightIdx >= 0) {
      // 양쪽 정상 포인트로 선형 보간
      const left = points[leftIdx];
      const right = points[rightIdx];
      const totalDt = right.timestamp - left.timestamp;
      if (totalDt > 0) {
        const t = (p.timestamp - left.timestamp) / totalDt;
        newAlt = left.altitude + (right.altitude - left.altitude) * t;
      } else {
        newAlt = left.altitude;
      }
    } else if (leftIdx >= 0) {
      // 왼쪽만 있으면 왼쪽 값 사용
      newAlt = points[leftIdx].altitude;
    } else if (rightIdx >= 0) {
      // 오른쪽만 있으면 오른쪽 값 사용
      newAlt = points[rightIdx].altitude;
    } else {
      // 정상 포인트가 없으면 원본 유지
      return p;
    }

    correctedCount++;
    return { ...p, altitude: Math.round(newAlt) };
  });

  return { points: corrected, correctedCount };
}
