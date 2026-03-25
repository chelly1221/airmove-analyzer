import type { TrackPoint } from "../types";

/**
 * 이상고도 보정 유틸리티
 *
 * 연속된 항적 포인트 간 물리적으로 불가능한 고도 변화를 감지하고,
 * 앞뒤 정상 포인트를 기준으로 선형 보간하여 보정.
 */

/** 최대 허용 수직속도 (m/s) — 약 20,000 ft/min, 전투기 급상승 수준 */
const MAX_VERTICAL_RATE_MS = 100;

/** 최소 고도 (m) — 이보다 낮으면 이상값 (지상인데 비행 중일 때) */
const MIN_VALID_ALTITUDE_M = -100;

/** 최대 고도 (m) — FL600 ≈ 18,288m, 이보다 높으면 이상값 */
const MAX_VALID_ALTITUDE_M = 20000;

function buildNextNormalIdx(isAnomalous: Uint8Array, n: number): Int32Array {
  const next = new Int32Array(n).fill(-1);
  for (let i = n - 2; i >= 0; i--) {
    next[i] = isAnomalous[i + 1] ? next[i + 1] : i + 1;
  }
  return next;
}

function buildPrevNormalIdx(isAnomalous: Uint8Array, n: number): Int32Array {
  const prev = new Int32Array(n).fill(-1);
  for (let i = 1; i < n; i++) {
    prev[i] = isAnomalous[i - 1] ? prev[i - 1] : i - 1;
  }
  return prev;
}

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
 * 2. 가장 가까운 정상 이전 포인트 대비 수직속도가 임계값 초과 → 이상값 후보
 *    - 다음 포인트와도 비교하여 양쪽 다 이상이면 이상값 확정
 * 3. 첫/끝 포인트: 인접 정상 포인트 2개의 추세와 비교하여 판정
 * 4. 이상값은 가장 가까운 양쪽 정상 포인트로 선형 보간
 */
const yieldUI = () => new Promise<void>(r => setTimeout(r, 0));

export async function correctAnomalousAltitudes(
  points: TrackPoint[],
): Promise<AltitudeCorrectionResult> {
  if (points.length < 3) return { points, correctedCount: 0 };

  const n = points.length;
  const isAnomalous = new Uint8Array(n);
  let hasAny = false;

  // 1단계: 절대 범위 검사
  for (let i = 0; i < n; i++) {
    const alt = points[i].altitude;
    if (alt < MIN_VALID_ALTITUDE_M || alt > MAX_VALID_ALTITUDE_M) {
      isAnomalous[i] = 1;
      hasAny = true;
    }
  }

  await yieldUI();

  // 2단계: 수직속도 기반 이상값 감지
  {
    let lastSeenNormal = -1;
    if (!isAnomalous[0]) lastSeenNormal = 0;
    for (let i = 1; i < n - 1; i++) {
      if (isAnomalous[i]) continue;

      const curr = points[i];
      const next = points[i + 1];
      const prevIdx = lastSeenNormal;
      if (prevIdx < 0) {
        lastSeenNormal = i;
        continue;
      }

      const prev = points[prevIdx];
      const dtPrev = curr.timestamp - prev.timestamp;
      const dtNext = next.timestamp - curr.timestamp;

      if (dtPrev <= 0 || dtNext <= 0) {
        lastSeenNormal = i;
        continue;
      }

      const vrPrev = Math.abs(curr.altitude - prev.altitude) / dtPrev;
      const vrNext = Math.abs(next.altitude - curr.altitude) / dtNext;

      if ((vrPrev > MAX_VERTICAL_RATE_MS && vrNext > MAX_VERTICAL_RATE_MS) || vrPrev > 500 || vrNext > 500) {
        isAnomalous[i] = 1;
        hasAny = true;
      }

      if (!isAnomalous[i]) {
        lastSeenNormal = i;
      }
    }
  }

  // 이상값이 전혀 없으면 나머지 단계 스킵
  if (!hasAny) return { points, correctedCount: 0 };

  await yieldUI();

  // 2.5단계: 단일 포인트 스파이크 탐지
  const SPIKE_DEVIATION_M = 300;
  {
    const nextNormal = buildNextNormalIdx(isAnomalous, n);
    let lastSeenNormal25 = -1;
    if (!isAnomalous[0]) lastSeenNormal25 = 0;
    for (let i = 1; i < n - 1; i++) {
      if (isAnomalous[i]) continue;

      const leftIdx = lastSeenNormal25;
      const rightIdx = nextNormal[i];
      if (leftIdx < 0 || rightIdx < 0) {
        lastSeenNormal25 = i;
        continue;
      }

      const left = points[leftIdx];
      const right = points[rightIdx];
      const curr = points[i];
      const totalDt = right.timestamp - left.timestamp;
      if (totalDt <= 0) {
        lastSeenNormal25 = i;
        continue;
      }

      const t = (curr.timestamp - left.timestamp) / totalDt;
      const expectedAlt = left.altitude + (right.altitude - left.altitude) * t;

      if (Math.abs(curr.altitude - expectedAlt) > SPIKE_DEVIATION_M) {
        isAnomalous[i] = 1;
      }

      if (!isAnomalous[i]) {
        lastSeenNormal25 = i;
      }
    }
  }

  await yieldUI();

  // 첫 포인트 검사
  if (!isAnomalous[0] && n >= 2) {
    let firstNormal = -1;
    let secondNormal = -1;
    for (let j = 1; j < n; j++) {
      if (!isAnomalous[j]) {
        if (firstNormal < 0) { firstNormal = j; }
        else { secondNormal = j; break; }
      }
    }

    if (firstNormal >= 0) {
      const dt01 = points[firstNormal].timestamp - points[0].timestamp;
      if (dt01 > 0) {
        const vr01 = Math.abs(points[firstNormal].altitude - points[0].altitude) / dt01;
        if (vr01 > MAX_VERTICAL_RATE_MS) {
          if (secondNormal >= 0) {
            const dt12 = points[secondNormal].timestamp - points[firstNormal].timestamp;
            const vr12 = dt12 > 0 ? Math.abs(points[secondNormal].altitude - points[firstNormal].altitude) / dt12 : 0;
            if (vr12 <= MAX_VERTICAL_RATE_MS) {
              isAnomalous[0] = 1;
            }
          } else {
            isAnomalous[0] = 1;
          }
        }
      }
    }
  }

  // 끝 포인트 검사
  if (!isAnomalous[n - 1] && n >= 2) {
    let firstNormal = -1;
    let secondNormal = -1;
    for (let j = n - 2; j >= 0; j--) {
      if (!isAnomalous[j]) {
        if (firstNormal < 0) { firstNormal = j; }
        else { secondNormal = j; break; }
      }
    }

    if (firstNormal >= 0) {
      const dtLast = points[n - 1].timestamp - points[firstNormal].timestamp;
      if (dtLast > 0) {
        const vrLast = Math.abs(points[n - 1].altitude - points[firstNormal].altitude) / dtLast;
        if (vrLast > MAX_VERTICAL_RATE_MS) {
          if (secondNormal >= 0) {
            const dtPrev = points[firstNormal].timestamp - points[secondNormal].timestamp;
            const vrPrev = dtPrev > 0 ? Math.abs(points[firstNormal].altitude - points[secondNormal].altitude) / dtPrev : 0;
            if (vrPrev <= MAX_VERTICAL_RATE_MS) {
              isAnomalous[n - 1] = 1;
            }
          } else {
            isAnomalous[n - 1] = 1;
          }
        }
      }
    }
  }

  await yieldUI();

  // lookup 재빌드 + 전파
  let nextNormalIdx = buildNextNormalIdx(isAnomalous, n);
  let prevNormalIdx = buildPrevNormalIdx(isAnomalous, n);

  if (isAnomalous[0]) {
    for (let i = 1; i < n - 1; i++) {
      if (isAnomalous[i]) continue;
      const nextIdx = nextNormalIdx[i];
      if (nextIdx < 0) continue;
      const dtNext = points[nextIdx].timestamp - points[i].timestamp;
      if (dtNext <= 0) continue;
      const vrNext = Math.abs(points[nextIdx].altitude - points[i].altitude) / dtNext;
      if (vrNext > MAX_VERTICAL_RATE_MS) {
        isAnomalous[i] = 1;
      } else {
        break;
      }
    }
  }

  if (isAnomalous[n - 1]) {
    for (let i = n - 2; i > 0; i--) {
      if (isAnomalous[i]) continue;
      const prevIdx = prevNormalIdx[i];
      if (prevIdx < 0) continue;
      const dtPrev = points[i].timestamp - points[prevIdx].timestamp;
      if (dtPrev <= 0) continue;
      const vrPrev = Math.abs(points[i].altitude - points[prevIdx].altitude) / dtPrev;
      if (vrPrev > MAX_VERTICAL_RATE_MS) {
        isAnomalous[i] = 1;
      } else {
        break;
      }
    }
  }

  await yieldUI();

  // 3단계: 보정 — in-place 수정
  prevNormalIdx = buildPrevNormalIdx(isAnomalous, n);
  nextNormalIdx = buildNextNormalIdx(isAnomalous, n);

  let correctedCount = 0;
  for (let i = 0; i < n; i++) {
    if (!isAnomalous[i]) continue;

    const leftIdx = prevNormalIdx[i];
    const rightIdx = nextNormalIdx[i];

    let newAlt: number;
    if (leftIdx >= 0 && rightIdx >= 0) {
      const left = points[leftIdx];
      const right = points[rightIdx];
      const totalDt = right.timestamp - left.timestamp;
      if (totalDt > 0) {
        const t = (points[i].timestamp - left.timestamp) / totalDt;
        newAlt = left.altitude + (right.altitude - left.altitude) * t;
      } else {
        newAlt = left.altitude;
      }
    } else if (leftIdx >= 0) {
      newAlt = points[leftIdx].altitude;
    } else if (rightIdx >= 0) {
      newAlt = points[rightIdx].altitude;
    } else {
      continue;
    }

    correctedCount++;
    points[i] = { ...points[i], altitude: Math.round(newAlt) };
  }

  return { points, correctedCount };
}
