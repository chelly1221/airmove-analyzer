/**
 * Drawing 탭 전용 WebGPU Compute Shader
 *
 * (1) haversine 최대 거리 병렬 리덕션
 * (2) ewDists 좌표 변환 (lon/lat/alt → screenX/screenY)
 * (3) density histogram 버킷 계산
 *
 * GPU 미지원 시 CPU 폴백 함수 제공
 */

import { getGPUDevice, createBuffer, readBuffer, runComputeShader } from "./gpuCompute";

// ─── (1) Haversine 최대 거리 ──────────────────────────

const MAX_DISTANCE_SHADER = /* wgsl */ `
const R: f32 = 6371.0;
const DEG2RAD: f32 = 3.14159265358979 / 180.0;

struct Params {
  radar_lat: f32,
  radar_lon: f32,
  count: u32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> points: array<f32>;    // [lat0,lon0, lat1,lon1, ...]
@group(0) @binding(2) var<storage, read_write> results: array<f32>; // 워크그룹당 1개 max

@compute @workgroup_size(256)
fn main(
  @builtin(global_invocation_id) gid: vec3<u32>,
  @builtin(local_invocation_id) lid: vec3<u32>,
  @builtin(workgroup_id) wid: vec3<u32>,
) {
  var dist: f32 = 0.0;
  let idx = gid.x;
  if (idx < params.count) {
    let lat1 = params.radar_lat * DEG2RAD;
    let lon1 = params.radar_lon * DEG2RAD;
    let lat2 = points[idx * 2u] * DEG2RAD;
    let lon2 = points[idx * 2u + 1u] * DEG2RAD;
    let dLat = lat2 - lat1;
    let dLon = lon2 - lon1;
    let a = sin(dLat * 0.5) * sin(dLat * 0.5)
          + cos(lat1) * cos(lat2) * sin(dLon * 0.5) * sin(dLon * 0.5);
    dist = R * 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
  }

  // workgroup 내 shared memory 리덕션
  var<workgroup> shared: array<f32, 256>;
  shared[lid.x] = dist;
  workgroupBarrier();

  // 트리 리덕션
  for (var s = 128u; s > 0u; s >>= 1u) {
    if (lid.x < s) {
      shared[lid.x] = max(shared[lid.x], shared[lid.x + s]);
    }
    workgroupBarrier();
  }

  if (lid.x == 0u) {
    results[wid.x] = shared[0];
  }
}
`;

/**
 * GPU로 전체 포인트 중 레이더로부터 최대 거리(km) 계산
 * @returns maxDistKm 또는 GPU 미지원 시 null
 */
export async function computeMaxDistanceGPU(
  radarLat: number,
  radarLon: number,
  latLonPairs: Float32Array, // [lat0,lon0, lat1,lon1, ...]
): Promise<number | null> {
  const device = await getGPUDevice();
  if (!device) return null;

  const count = latLonPairs.length / 2;
  if (count === 0) return 0;

  // Params uniform
  const paramsBuf = new ArrayBuffer(16);
  const pf = new Float32Array(paramsBuf);
  const pu = new Uint32Array(paramsBuf);
  pf[0] = radarLat;
  pf[1] = radarLon;
  pu[2] = count;
  pu[3] = 0;

  const uniformBuf = createBuffer(device, new Float32Array(paramsBuf),
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const pointsBuf = createBuffer(device, latLonPairs,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);

  const numWorkgroups = Math.ceil(count / 256);
  const resultSize = numWorkgroups * 4;
  const resultBuf = device.createBuffer({
    size: resultSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  await runComputeShader(device, MAX_DISTANCE_SHADER, [
    { buffer: uniformBuf, type: "uniform" },
    { buffer: pointsBuf, type: "read-only-storage" },
    { buffer: resultBuf, type: "storage" },
  ], [numWorkgroups, 1, 1]);

  const results = await readBuffer(device, resultBuf, resultSize);

  uniformBuf.destroy();
  pointsBuf.destroy();
  resultBuf.destroy();

  // CPU에서 워크그룹별 max를 최종 리듀스
  let maxDist = 0;
  for (let i = 0; i < numWorkgroups; i++) {
    if (results[i] > maxDist) maxDist = results[i];
  }
  return maxDist;
}

// ─── (2) EW 거리 변환 ─────────────────────────────────

const EWDIST_SHADER = /* wgsl */ `
struct Params {
  radar_lon: f32,
  cos_lat: f32,
  count: u32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> lons: array<f32>;
@group(0) @binding(2) var<storage, read_write> ew_dists: array<f32>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.count) { return; }
  ew_dists[idx] = (lons[idx] - params.radar_lon) * 111.32 * params.cos_lat;
}
`;

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
): Promise<EwDistResult | null> {
  const device = await getGPUDevice();
  if (!device) return null;

  const count = lons.length;
  if (count === 0) return { ewDists: new Float32Array(0), minEW: 0, maxEW: 0 };

  const paramsBuf = new ArrayBuffer(16);
  const pf = new Float32Array(paramsBuf);
  const pu = new Uint32Array(paramsBuf);
  pf[0] = radarLon;
  pf[1] = cosLat;
  pu[2] = count;
  pu[3] = 0;

  const uniformBuf = createBuffer(device, new Float32Array(paramsBuf),
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const lonsBuf = createBuffer(device, lons,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);
  const outputSize = count * 4;
  const outputBuf = device.createBuffer({
    size: outputSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const numWorkgroups = Math.ceil(count / 256);
  await runComputeShader(device, EWDIST_SHADER, [
    { buffer: uniformBuf, type: "uniform" },
    { buffer: lonsBuf, type: "read-only-storage" },
    { buffer: outputBuf, type: "storage" },
  ], [numWorkgroups, 1, 1]);

  const ewDists = await readBuffer(device, outputBuf, outputSize);

  uniformBuf.destroy();
  lonsBuf.destroy();
  outputBuf.destroy();

  // min/max는 CPU에서 (결과 배열이 이미 GPU에서 돌아옴)
  let minEW = 0, maxEW = 0;
  for (let i = 0; i < count; i++) {
    const v = ewDists[i];
    if (v < minEW) minEW = v;
    if (v > maxEW) maxEW = v;
  }

  return { ewDists, minEW, maxEW };
}

// ─── (3) Density Histogram ────────────────────────────

const HISTOGRAM_SHADER = /* wgsl */ `
struct Params {
  view_min_ts: f32,
  view_max_ts: f32,
  num_buckets: u32,
  count: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> timestamps: array<f32>;
@group(0) @binding(2) var<storage, read_write> buckets: array<atomic<u32>>;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let idx = gid.x;
  if (idx >= params.count) { return; }
  let ts = timestamps[idx];
  if (ts < params.view_min_ts || ts > params.view_max_ts) { return; }
  let span = params.view_max_ts - params.view_min_ts;
  if (span <= 0.0) { return; }
  let bucket_f = ((ts - params.view_min_ts) / span) * f32(params.num_buckets);
  let bucket_idx = min(u32(bucket_f), params.num_buckets - 1u);
  atomicAdd(&buckets[bucket_idx], 1u);
}
`;

/**
 * GPU로 밀도 히스토그램 계산
 * @returns 정규화된 밀도 배열 (0~1) 또는 GPU 미지원 시 null
 */
export async function computeDensityHistogramGPU(
  timestamps: Float32Array,
  viewMinTs: number,
  viewMaxTs: number,
  numBuckets: number = 200,
): Promise<number[] | null> {
  const device = await getGPUDevice();
  if (!device) return null;

  const count = timestamps.length;
  if (count === 0 || viewMaxTs <= viewMinTs) return new Array(numBuckets).fill(0);

  const paramsBuf = new ArrayBuffer(16);
  const pf = new Float32Array(paramsBuf);
  const pu = new Uint32Array(paramsBuf);
  pf[0] = viewMinTs;
  pf[1] = viewMaxTs;
  pu[2] = numBuckets;
  pu[3] = count;

  const uniformBuf = createBuffer(device, new Float32Array(paramsBuf),
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
  const tsBuf = createBuffer(device, timestamps,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);

  // 버킷 초기화 (0으로)
  const bucketSize = numBuckets * 4;
  const bucketBuf = createBuffer(device, new Uint32Array(numBuckets),
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);

  const numWorkgroups = Math.ceil(count / 256);
  await runComputeShader(device, HISTOGRAM_SHADER, [
    { buffer: uniformBuf, type: "uniform" },
    { buffer: tsBuf, type: "read-only-storage" },
    { buffer: bucketBuf, type: "storage" },
  ], [numWorkgroups, 1, 1]);

  const resultF32 = await readBuffer(device, bucketBuf, bucketSize);
  const resultU32 = new Uint32Array(resultF32.buffer);

  uniformBuf.destroy();
  tsBuf.destroy();
  bucketBuf.destroy();

  // 정규화
  let maxCount = 1;
  for (let i = 0; i < numBuckets; i++) {
    if (resultU32[i] > maxCount) maxCount = resultU32[i];
  }
  const normalized: number[] = new Array(numBuckets);
  for (let i = 0; i < numBuckets; i++) {
    normalized[i] = resultU32[i] / maxCount;
  }
  return normalized;
}

// ─── CPU 폴백 함수들 ─────────────────────────────────

/** CPU 폴백: haversine 최대 거리 */
export function computeMaxDistanceCPU(
  radarLat: number,
  radarLon: number,
  points: { latitude: number; longitude: number }[],
): number {
  const R = 6371;
  let maxDist = 0;
  const lat1 = radarLat * Math.PI / 180;
  const cosLat1 = Math.cos(lat1);

  for (const p of points) {
    const dLat = (p.latitude - radarLat) * Math.PI / 180;
    const dLon = (p.longitude - radarLon) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 + cosLat1 * Math.cos(p.latitude * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
    const d = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    if (d > maxDist) maxDist = d;
  }
  return maxDist;
}

/** CPU 폴백: 동서 거리 */
export function computeEwDistsCPU(
  radarLon: number,
  cosLat: number,
  points: { longitude: number }[],
): EwDistResult {
  const ewDists = new Float32Array(points.length);
  let minEW = 0, maxEW = 0;
  for (let i = 0; i < points.length; i++) {
    const d = (points[i].longitude - radarLon) * 111.32 * cosLat;
    ewDists[i] = d;
    if (d < minEW) minEW = d;
    if (d > maxEW) maxEW = d;
  }
  return { ewDists, minEW, maxEW };
}

/** CPU 폴백: 밀도 히스토그램 */
export function computeDensityHistogramCPU(
  points: { timestamp: number }[],
  viewMinTs: number,
  viewMaxTs: number,
  numBuckets: number = 200,
): number[] {
  const viewSpan = viewMaxTs - viewMinTs;
  if (viewSpan <= 0 || points.length === 0) return new Array(numBuckets).fill(0);
  const buckets = new Array(numBuckets).fill(0);
  for (const p of points) {
    if (p.timestamp < viewMinTs || p.timestamp > viewMaxTs) continue;
    const idx = Math.min(numBuckets - 1, Math.floor(((p.timestamp - viewMinTs) / viewSpan) * numBuckets));
    if (idx >= 0) buckets[idx]++;
  }
  const maxCount = Math.max(1, ...buckets);
  return buckets.map((c: number) => c / maxCount);
}
