/**
 * Drawing 탭 전용 WebGPU Compute — GPU Worker에 위임
 *
 * (1) haversine 최대 거리 병렬 리덕션
 * (2) ewDists 좌표 변환
 * (3) density histogram 버킷 계산
 *
 * 모든 GPU 연산은 gpuCoverage Worker에서 실행 (메인 스레드 블로킹 0)
 */

import { getGPUWorkerInstance } from "./gpuCoverage";

/** Worker에 메시지 전송 후 결과 대기 (seq 기반) */
async function workerRPC<T>(
  msgType: string,
  resultType: string,
  payload: Record<string, unknown>,
  transfer?: Transferable[],
): Promise<T> {
  const worker = await getGPUWorkerInstance();
  const seq = Date.now() + Math.random();

  return new Promise<T>((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      if (e.data.seq !== seq) return;
      if (e.data.type === resultType) {
        worker.removeEventListener("message", handler);
        resolve(e.data as T);
      } else if (e.data.type === "ERROR") {
        worker.removeEventListener("message", handler);
        reject(new Error(e.data.error));
      }
    };
    worker.addEventListener("message", handler);
    worker.postMessage({ type: msgType, seq, ...payload }, transfer ?? []);
  });
}

/**
 * GPU로 전체 포인트 중 레이더로부터 최대 거리(km) 계산
 */
export async function computeMaxDistanceGPU(
  radarLat: number,
  radarLon: number,
  latLonPairs: Float32Array,
): Promise<number> {
  if (latLonPairs.length === 0) return 0;
  const copy = new Float32Array(latLonPairs);
  const result = await workerRPC<{ maxDistKm: number }>(
    "MAX_DISTANCE", "MAX_DISTANCE_RESULT",
    { radarLat, radarLon, latLonPairs: copy.buffer },
    [copy.buffer],
  );
  return result.maxDistKm;
}

export interface EwDistResult {
  ewDists: Float32Array;
  minEW: number;
  maxEW: number;
}

/**
 * GPU로 동서 거리(km) 계산 + min/max
 */
export async function computeEwDistsGPU(
  radarLon: number,
  cosLat: number,
  lons: Float32Array,
): Promise<EwDistResult> {
  if (lons.length === 0) return { ewDists: new Float32Array(0), minEW: 0, maxEW: 0 };
  const copy = new Float32Array(lons);
  const result = await workerRPC<{ ewDists: ArrayBuffer; minEW: number; maxEW: number }>(
    "EW_DISTS", "EW_DISTS_RESULT",
    { radarLon, cosLat, lons: copy.buffer },
    [copy.buffer],
  );
  return { ewDists: new Float32Array(result.ewDists), minEW: result.minEW, maxEW: result.maxEW };
}

/**
 * GPU로 밀도 히스토그램 계산
 */
export async function computeDensityHistogramGPU(
  timestamps: Float32Array,
  viewMinTs: number,
  viewMaxTs: number,
  numBuckets: number = 200,
): Promise<number[]> {
  if (timestamps.length === 0 || viewMaxTs <= viewMinTs) return new Array(numBuckets).fill(0);
  const copy = new Float32Array(timestamps);
  const result = await workerRPC<{ buckets: number[] }>(
    "DENSITY_HISTOGRAM", "DENSITY_HISTOGRAM_RESULT",
    { timestamps: copy.buffer, viewMinTs, viewMaxTs, numBuckets },
    [copy.buffer],
  );
  return result.buckets;
}
