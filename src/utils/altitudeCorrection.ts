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

function buildNextNormalIdx(isAnomalous: boolean[], n: number): Int32Array {
  const next = new Int32Array(n).fill(-1);
  for (let i = n - 2; i >= 0; i--) {
    if (!isAnomalous[i + 1]) {
      next[i] = i + 1;
    } else {
      next[i] = next[i + 1];
    }
  }
  return next;
}

function buildPrevNormalIdx(isAnomalous: boolean[], n: number): Int32Array {
  const prev = new Int32Array(n).fill(-1);
  for (let i = 1; i < n; i++) {
    if (!isAnomalous[i - 1]) {
      prev[i] = i - 1;
    } else {
      prev[i] = prev[i - 1];
    }
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
  const isAnomalous = new Array<boolean>(n).fill(false);

  // 1단계: 절대 범위 검사
  for (let i = 0; i < n; i++) {
    const alt = points[i].altitude;
    if (alt < MIN_VALID_ALTITUDE_M || alt > MAX_VALID_ALTITUDE_M) {
      isAnomalous[i] = true;
    }
  }

  await yieldUI();

  // 2단계: 수직속도 기반 이상값 감지
  // 가장 가까운 정상 이전 포인트와 비교 (연속 이상값도 탐지 가능)
  {
    let lastSeenNormal = -1;
    // Step 1에서 index 0이 정상이면 초기화
    if (!isAnomalous[0]) lastSeenNormal = 0;
    for (let i = 1; i < n - 1; i++) {
      if (isAnomalous[i]) continue;

      const curr = points[i];
      const next = points[i + 1];

      // lastSeenNormal은 i 이전에서 가장 가까운 정상 포인트 (Step 2에서 새로 마킹된 것도 반영됨)
      const prevIdx = lastSeenNormal;
      // 현재 포인트가 정상이면 lastSeenNormal 갱신 (마킹 전에 갱신하면 안 되므로 아래서 처리)
      if (prevIdx < 0) {
        // 이전에 정상 포인트 없으면 건너뜀 (갱신은 마킹 판정 후)
        lastSeenNormal = i; // 현재는 아직 정상
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

      // 앞뒤 모두 수직속도 초과 → 이 포인트가 이상값
      if (vrPrev > MAX_VERTICAL_RATE_MS && vrNext > MAX_VERTICAL_RATE_MS) {
        isAnomalous[i] = true;
      }
      // 한쪽이라도 극단적 수직속도 (500 m/s ≈ 100,000 ft/min, 물리적 불가) → 이상값
      // Loss gap 직후 단일 스파이크 포인트 탐지용 (앞 포인트가 멀어 vrPrev가 낮은 경우)
      else if (vrPrev > 500 || vrNext > 500) {
        isAnomalous[i] = true;
      }

      if (!isAnomalous[i]) {
        lastSeenNormal = i;
      }
    }
  }

  await yieldUI();

  // 2.5단계: 단일 포인트 스파이크 탐지
  // 앞뒤 정상 포인트 간 선형 보간 대비 크게 벗어나는 포인트 탐지
  // (수직속도 기반으로 잡히지 않는 중간 크기 스파이크 보완)
  const SPIKE_DEVIATION_M = 300;
  {
    // Step 2에서 isAnomalous가 변경되었으므로 nextNormalIdx 재빌드
    const nextNormal = buildNextNormalIdx(isAnomalous, n);
    let lastSeenNormal25 = -1;
    if (!isAnomalous[0]) lastSeenNormal25 = 0;
    for (let i = 1; i < n - 1; i++) {
      if (isAnomalous[i]) continue;

      // 가장 가까운 양쪽 정상 포인트 찾기
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

      // 선형 보간으로 예상 고도 계산
      const t = (curr.timestamp - left.timestamp) / totalDt;
      const expectedAlt = left.altitude + (right.altitude - left.altitude) * t;
      const deviation = Math.abs(curr.altitude - expectedAlt);

      if (deviation > SPIKE_DEVIATION_M) {
        isAnomalous[i] = true;
      }

      if (!isAnomalous[i]) {
        lastSeenNormal25 = i;
      }
    }
  }

  await yieldUI();

  // 첫 포인트 검사: 인접 정상 포인트와 비교
  if (!isAnomalous[0] && n >= 2) {
    // 첫 번째, 두 번째 정상 포인트 찾기
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
            // 정상 포인트 2개 있으면 추세 비교: 1→2 정상이면 0이 튄 것
            const dt12 = points[secondNormal].timestamp - points[firstNormal].timestamp;
            const vr12 = dt12 > 0 ? Math.abs(points[secondNormal].altitude - points[firstNormal].altitude) / dt12 : 0;
            if (vr12 <= MAX_VERTICAL_RATE_MS) {
              isAnomalous[0] = true;
            }
          } else {
            // 정상 포인트가 1개뿐이면 수직속도만으로 판정
            isAnomalous[0] = true;
          }
        }
      }
    }
  }

  // 끝 포인트 검사: 인접 정상 포인트와 비교
  if (!isAnomalous[n - 1] && n >= 2) {
    // 끝에서부터 첫 번째, 두 번째 정상 포인트 찾기
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
              isAnomalous[n - 1] = true;
            }
          } else {
            // 정상 포인트가 1개뿐이면 수직속도만으로 판정
            isAnomalous[n - 1] = true;
          }
        }
      }
    }
  }

  await yieldUI();

  // Step 2.5 이후 양쪽 lookup 배열 재빌드 (전파/보간 단계에서 사용)
  let nextNormalIdx = buildNextNormalIdx(isAnomalous, n);
  let prevNormalIdx = buildPrevNormalIdx(isAnomalous, n);

  // 앞쪽 연속 이상값 전파: 첫 포인트가 이상값이면 뒤따르는 포인트도 검사
  // (2단계에서 prevIdx < 0으로 건너뛴 포인트들)
  if (isAnomalous[0]) {
    let lastSeenNormalFwd = -1;
    for (let i = 1; i < n - 1; i++) {
      if (isAnomalous[i]) continue;

      // 이전에 정상 포인트가 없으면 → 다음 정상 포인트와 비교
      if (lastSeenNormalFwd >= 0) break; // 정상 포인트 나오면 전파 중단

      // 다음 정상 포인트 찾기
      const nextIdx = nextNormalIdx[i];
      if (nextIdx < 0) continue;

      const dtNext = points[nextIdx].timestamp - points[i].timestamp;
      if (dtNext <= 0) continue;

      const vrNext = Math.abs(points[nextIdx].altitude - points[i].altitude) / dtNext;
      // 다음 정상 포인트와도 수직속도 이상 → 이 포인트도 이상값
      if (vrNext > MAX_VERTICAL_RATE_MS) {
        isAnomalous[i] = true;
      } else {
        break; // 정상 포인트 도달, 전파 중단
      }

      if (!isAnomalous[i]) {
        lastSeenNormalFwd = i;
      }
    }
  }

  // 뒤쪽 연속 이상값 전파: 끝 포인트가 이상값이면 앞쪽 포인트도 검사
  if (isAnomalous[n - 1]) {
    let lastSeenNormalBwd = -1;
    for (let i = n - 2; i > 0; i--) {
      if (isAnomalous[i]) continue;

      // 뒤에 정상 포인트가 없으면 → 이전 정상 포인트와 비교
      if (lastSeenNormalBwd >= 0) break;

      const prevIdx = prevNormalIdx[i];
      if (prevIdx < 0) continue;

      const dtPrev = points[i].timestamp - points[prevIdx].timestamp;
      if (dtPrev <= 0) continue;

      const vrPrev = Math.abs(points[i].altitude - points[prevIdx].altitude) / dtPrev;
      if (vrPrev > MAX_VERTICAL_RATE_MS) {
        isAnomalous[i] = true;
      } else {
        break;
      }

      if (!isAnomalous[i]) {
        lastSeenNormalBwd = i;
      }
    }
  }

  await yieldUI();

  // 3단계: 이상값 보정 — 가장 가까운 양쪽 정상 포인트로 선형 보간
  // 전파 단계에서 isAnomalous 변경되었으므로 lookup 배열 재빌드
  prevNormalIdx = buildPrevNormalIdx(isAnomalous, n);
  nextNormalIdx = buildNextNormalIdx(isAnomalous, n);

  let correctedCount = 0;
  const corrected = points.map((p, i) => {
    if (!isAnomalous[i]) return p;

    // 왼쪽/오른쪽 정상 포인트 O(1) 조회
    const leftIdx = prevNormalIdx[i];
    const rightIdx = nextNormalIdx[i];

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
