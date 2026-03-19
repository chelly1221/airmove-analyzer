/**
 * WebGPU 커버리지 맵 가속 (0.01° 고해상도, 36,000 rays)
 *
 * 아키텍처:
 *   Phase 1: Rust rayon — SRTM + 건물 높이 프리샘플 → base64 IPC (배치)
 *   Phase 2a: GPU Pass 1 — 곡률 보정 + running max angle 누적
 *   Phase 2b: GPU Pass 2 — 고도별 이진 탐색 → max_range_km
 *   Phase 3: JS — CoverageLayer[] 변환 (다운샘플링 없이 전체 출력)
 *
 * GPU 미지원 시 동일 프리샘플 → JS CPU 계산 (해상도 동일)
 */

import { invoke } from "@tauri-apps/api/core";
import { getGPUDevice, createBuffer, readBuffer, runComputeShader } from "./gpuCompute";
import type { CoverageLayer } from "./radarCoverage";

// ─── Rust 결과 타입 ──────────────────────────────────

interface PreSampledCoverage {
  elev_b64: string;
  num_rays: number;
  num_samples: number;
  radar_height_m: number;
  max_range_km: number;
  bearing_step_deg: number;
}

// ─── WGSL Compute Shader ─────────────────────────────

// Pass 1: 곡률 보정 지형 + running max angle → intermediate storage
const PASS1_SHADER = /* wgsl */ `
const R_EARTH_M: f32 = 6371000.0;

struct Params {
  radar_height_m: f32,
  max_range_km: f32,
  num_samples: u32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> elevations: array<f32>;
@group(0) @binding(2) var<storage, read_write> max_angles: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ray = gid.x;
  let base = ray * params.num_samples;
  var running_max: f32 = -1e10;

  for (var s = 0u; s < params.num_samples; s++) {
    let dist_m = (f32(s + 1u) / f32(params.num_samples)) * params.max_range_km * 1000.0;
    let elev = elevations[base + s];

    // 곡률 보정: adj = elev - d²/(2R)
    let curv_drop = dist_m * dist_m / (2.0 * R_EARTH_M);
    let adj = elev - curv_drop;

    // running max angle (기울기)
    let angle = (adj - params.radar_height_m) / dist_m;
    if (angle > running_max) { running_max = angle; }
    max_angles[base + s] = running_max;
  }
}
`;

// Pass 2: 고도별 이진 탐색 → max_range_km
const PASS2_SHADER = /* wgsl */ `
const R_EARTH_M: f32 = 6371000.0;
const FT_TO_M: f32 = 0.3048;

struct Params {
  radar_height_m: f32,
  max_range_km: f32,
  num_samples: u32,
  num_altitudes: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> elevations: array<f32>;
@group(0) @binding(2) var<storage, read> max_angles: array<f32>;
@group(0) @binding(3) var<storage, read> alt_fts: array<f32>;
@group(0) @binding(4) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ray = gid.x / params.num_altitudes;
  let alt_idx = gid.x % params.num_altitudes;
  let alt_m = alt_fts[alt_idx] * FT_TO_M;
  let base = ray * params.num_samples;
  let n = params.num_samples;
  let max_range = params.max_range_km;

  // 이진 탐색: max_angles에서 LOS 차단점
  var los_block: u32 = n;
  var lo: u32 = 1u;
  var hi: u32 = n - 1u;
  while (lo <= hi) {
    let mid = (lo + hi) / 2u;
    let dist = (f32(mid + 1u) / f32(n)) * max_range * 1000.0;
    let curv_drop = dist * dist / (2.0 * R_EARTH_M);
    let adj_alt = alt_m - curv_drop;
    let target_angle = (adj_alt - params.radar_height_m) / dist;
    if (max_angles[base + mid - 1u] > target_angle) {
      los_block = mid;
      if (mid == 0u) { break; }
      hi = mid - 1u;
    } else {
      lo = mid + 1u;
    }
  }

  // 선형 탐색: 지형 직접 차단점
  var terrain_block: u32 = n;
  for (var i = 0u; i < los_block; i++) {
    let dist = (f32(i + 1u) / f32(n)) * max_range * 1000.0;
    let curv_drop = dist * dist / (2.0 * R_EARTH_M);
    let adj_alt = alt_m - curv_drop;
    if (elevations[base + i] - curv_drop > adj_alt) {
      terrain_block = i;
      break;
    }
  }

  let block_idx = min(los_block, terrain_block);
  let range_km = (f32(block_idx) / f32(n)) * max_range;
  output[ray * params.num_altitudes + alt_idx] = range_km;
}
`;

// ─── destination_point ───────────────────────────────

function destinationPoint(
  latDeg: number, lonDeg: number, bearingDeg: number, distKm: number,
): [number, number] {
  const R = 6371.0;
  const d = distKm / R;
  const brg = (bearingDeg * Math.PI) / 180;
  const lat1 = (latDeg * Math.PI) / 180;
  const lon1 = (lonDeg * Math.PI) / 180;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brg));
  const lon2 = lon1 + Math.atan2(Math.sin(brg) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

// ─── Web Worker (base64 디코딩 + CPU 계산을 메인 스레드에서 분리) ───

const WORKER_CODE = `
self.onmessage = (e) => {
  const { type } = e.data;
  if (type === "decode") {
    const bin = atob(e.data.b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    self.postMessage({ buffer: bytes.buffer }, [bytes.buffer]);
  } else if (type === "compute") {
    const { elevBuf, batchRays, numSamples, radarHeightM, maxRangeKm, altFts } = e.data;
    const elevF32 = new Float32Array(elevBuf);
    const R = 6371000 * 4 / 3;
    const FT_TO_M = 0.3048;
    const numAlts = altFts.length;
    const result = new Float32Array(batchRays * numAlts);
    for (let ray = 0; ray < batchRays; ray++) {
      const base = ray * numSamples;
      let runningMax = -1e10;
      const maxAngles = new Float32Array(numSamples);
      for (let s = 0; s < numSamples; s++) {
        const distM = ((s + 1) / numSamples) * maxRangeKm * 1000;
        const curvDrop = (distM * distM) / (2 * R);
        const adj = elevF32[base + s] - curvDrop;
        const angle = (adj - radarHeightM) / distM;
        if (angle > runningMax) runningMax = angle;
        maxAngles[s] = runningMax;
      }
      for (let ai = 0; ai < numAlts; ai++) {
        const altM = altFts[ai] * FT_TO_M;
        let losBlock = numSamples;
        let lo = 1, hi = numSamples - 1;
        while (lo <= hi) {
          const mid = (lo + hi) >>> 1;
          const dist = ((mid + 1) / numSamples) * maxRangeKm * 1000;
          const curvDrop = (dist * dist) / (2 * R);
          const adjAlt = altM - curvDrop;
          const targetAngle = (adjAlt - radarHeightM) / dist;
          if (maxAngles[mid - 1] > targetAngle) { losBlock = mid; if (mid === 0) break; hi = mid - 1; }
          else { lo = mid + 1; }
        }
        let terrainBlock = numSamples;
        for (let i = 0; i < losBlock; i++) {
          const dist = ((i + 1) / numSamples) * maxRangeKm * 1000;
          const curvDrop = (dist * dist) / (2 * R);
          const adjAlt = altM - curvDrop;
          if (elevF32[base + i] - curvDrop > adjAlt) { terrainBlock = i; break; }
        }
        result[ray * numAlts + ai] = (Math.min(losBlock, terrainBlock) / numSamples) * maxRangeKm;
      }
    }
    self.postMessage({ buffer: result.buffer }, [result.buffer]);
  }
};
`;

let _worker: Worker | null = null;
let _workerUrl: string | null = null;

function getWorker(): Worker {
  if (_worker) return _worker;
  const blob = new Blob([WORKER_CODE], { type: "application/javascript" });
  _workerUrl = URL.createObjectURL(blob);
  _worker = new Worker(_workerUrl);
  return _worker;
}

/** base64 → Float32Array (Worker에서 비동기 디코딩, 메인 스레드 논블로킹) */
function decodeBase64F32Async(b64: string): Promise<Float32Array> {
  return new Promise((resolve) => {
    const w = getWorker();
    const handler = (e: MessageEvent) => {
      w.removeEventListener("message", handler);
      resolve(new Float32Array(e.data.buffer));
    };
    w.addEventListener("message", handler);
    w.postMessage({ type: "decode", b64 });
  });
}

/** CPU 커버리지 계산 (Worker에서 비동기 실행, 메인 스레드 논블로킹) */
function computeBatchCPUAsync(
  elevF32: Float32Array, batchRays: number, numSamples: number,
  radarHeightM: number, maxRangeKm: number, altFts: number[],
): Promise<Float32Array> {
  return new Promise((resolve) => {
    const w = getWorker();
    const handler = (e: MessageEvent) => {
      w.removeEventListener("message", handler);
      resolve(new Float32Array(e.data.buffer));
    };
    w.addEventListener("message", handler);
    w.postMessage(
      { type: "compute", elevBuf: elevF32.buffer, batchRays, numSamples, radarHeightM, maxRangeKm, altFts },
      [elevF32.buffer],
    );
  });
}

// ─── Rust 프리샘플 호출 공통 ─────────────────────────

interface ProfileParams {
  radarLat: number;
  radarLon: number;
  radarAltitude: number;
  antennaHeight: number;
  rangeNm: number;
  bearingStepDeg: number;
  excludeManualIds?: number[];
}

async function fetchPresample(
  params: ProfileParams, startRay: number, rayCount: number,
): Promise<PreSampledCoverage> {
  return invoke<PreSampledCoverage>("presample_coverage_elevations", {
    radarLat: params.radarLat,
    radarLon: params.radarLon,
    radarAltitude: params.radarAltitude,
    antennaHeight: params.antennaHeight,
    rangeNm: params.rangeNm,
    bearingStepDeg: params.bearingStepDeg,
    excludeManualIds: params.excludeManualIds,
    batchStartRay: startRay,
    batchRayCount: rayCount,
  });
}

// ─── GPU 배치 계산 ───────────────────────────────────

async function computeBatchGPU(
  device: GPUDevice,
  elevF32: Float32Array,
  batchRays: number,
  numSamples: number,
  radarHeightM: number,
  maxRangeKm: number,
  altFts: number[],
): Promise<Float32Array> {
  // Pass 1 uniform
  const p1Buf = new ArrayBuffer(16);
  new Float32Array(p1Buf).set([radarHeightM, maxRangeKm]);
  new Uint32Array(p1Buf, 8).set([numSamples, 0]);

  const uniformBuf1 = createBuffer(device, new Float32Array(p1Buf), GPUBufferUsage.UNIFORM);
  const elevBuf = createBuffer(device, elevF32, GPUBufferUsage.STORAGE);
  const maxAnglesBuf = device.createBuffer({
    size: batchRays * numSamples * 4,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  await runComputeShader(device, PASS1_SHADER, [
    { buffer: uniformBuf1, type: "uniform" },
    { buffer: elevBuf, type: "read-only-storage" },
    { buffer: maxAnglesBuf, type: "storage" },
  ], [Math.ceil(batchRays / 64), 1, 1]);

  // Pass 2 uniform
  const p2Buf = new ArrayBuffer(16);
  new Float32Array(p2Buf).set([radarHeightM, maxRangeKm]);
  new Uint32Array(p2Buf, 8).set([numSamples, altFts.length]);

  const uniformBuf2 = createBuffer(device, new Float32Array(p2Buf), GPUBufferUsage.UNIFORM);
  const altBuf = createBuffer(device, new Float32Array(altFts), GPUBufferUsage.STORAGE);
  const outSize = batchRays * altFts.length * 4;
  const outputBuf = device.createBuffer({
    size: outSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  await runComputeShader(device, PASS2_SHADER, [
    { buffer: uniformBuf2, type: "uniform" },
    { buffer: elevBuf, type: "read-only-storage" },
    { buffer: maxAnglesBuf, type: "read-only-storage" },
    { buffer: altBuf, type: "read-only-storage" },
    { buffer: outputBuf, type: "storage" },
  ], [Math.ceil((batchRays * altFts.length) / 64), 1, 1]);

  const result = await readBuffer(device, outputBuf, outSize);

  uniformBuf1.destroy();
  uniformBuf2.destroy();
  elevBuf.destroy();
  maxAnglesBuf.destroy();
  altBuf.destroy();
  outputBuf.destroy();

  return result;
}

// ─── 단일 프로파일 계산 (GPU/CPU 통합, 전부 논블로킹) ──

async function computeProfile(
  device: GPUDevice | null,
  params: ProfileParams,
  altFts: number[],
  onProgress?: (msg: string) => void,
): Promise<CoverageLayer[]> {
  const totalRays = Math.floor(360 / params.bearingStepDeg);
  const numSamples = 2400;
  const bytesPerRay = numSamples * 4;

  // 배치 크기: GPU는 maxStorageBufferBindingSize, CPU는 ~128MB
  const maxBufBytes = device ? device.limits.maxStorageBufferBindingSize : 128 * 1024 * 1024;
  const maxRaysPerBatch = Math.floor(maxBufBytes / bytesPerRay);
  const numBatches = Math.ceil(totalRays / maxRaysPerBatch);
  const mode = device ? "GPU" : "CPU";

  const allRanges = new Float32Array(totalRays * altFts.length);

  for (let b = 0; b < numBatches; b++) {
    const startRay = b * maxRaysPerBatch;
    const batchRays = Math.min(maxRaysPerBatch, totalRays - startRay);

    onProgress?.(`커버리지 ${mode} 계산 중... (배치 ${b + 1}/${numBatches}, ${batchRays} rays)`);

    // Rust 프리샘플
    const ps = await fetchPresample(params, startRay, batchRays);
    // Worker에서 base64 디코딩 (메인 스레드 논블로킹)
    const elevF32 = await decodeBase64F32Async(ps.elev_b64);
    ps.elev_b64 = "";

    // GPU 또는 CPU(Worker) 계산 — 둘 다 메인 스레드 논블로킹
    const batchResult = device
      ? await computeBatchGPU(device, elevF32, batchRays, numSamples, ps.radar_height_m, ps.max_range_km, altFts)
      : await computeBatchCPUAsync(elevF32, batchRays, numSamples, ps.radar_height_m, ps.max_range_km, altFts);

    // 병합
    for (let r = 0; r < batchRays; r++) {
      for (let a = 0; a < altFts.length; a++) {
        allRanges[(startRay + r) * altFts.length + a] = batchResult[r * altFts.length + a];
      }
    }
  }

  // CoverageLayer[] 변환 (전체 bearings, 다운샘플링 없음)
  const radarHeight = params.radarAltitude + params.antennaHeight;
  const maxElevRad = (40 * Math.PI) / 180;

  return altFts.map((altFt, altIdx) => {
    const altM = altFt * 0.3048;
    const heightAbove = altM - radarHeight;
    const coneRadiusKm = heightAbove > 0 ? (heightAbove / Math.tan(maxElevRad)) / 1000 : 0;

    const bearings: { deg: number; maxRangeKm: number; lat: number; lon: number }[] = [];
    for (let r = 0; r < totalRays; r++) {
      const deg = r * params.bearingStepDeg;
      const range = allRanges[r * altFts.length + altIdx];
      const [lat, lon] = range > 0
        ? destinationPoint(params.radarLat, params.radarLon, deg, range)
        : [params.radarLat, params.radarLon];
      bearings.push({ deg, maxRangeKm: range, lat, lon });
    }

    return { altitudeFt: altFt, altitudeM: altM, bearings, coneRadiusKm };
  });
}

// ─── 공개 API ────────────────────────────────────────

export interface CoverageOMParams {
  radarName: string;
  radarLat: number;
  radarLon: number;
  radarAltitude: number;
  antennaHeight: number;
  rangeNm: number;
  bearingStepDeg: number;
}

/**
 * OM 보고서용 커버리지 레이어 계산
 * - GPU 가속 (WebGPU) 또는 CPU (동일 해상도, 동일 프리샘플)
 * - 다운샘플링 없음: bearingStepDeg 그대로 전체 출력
 */
export async function computeCoverageLayersOM(
  params: CoverageOMParams,
  altFts: number[],
  excludeManualIds: number[],
  onProgress?: (msg: string) => void,
): Promise<{ layersWith: CoverageLayer[]; layersWithout: CoverageLayer[] }> {
  const device = await getGPUDevice();
  const mode = device ? "GPU" : "CPU";
  console.log(`[Coverage] ${mode} 모드, ${params.bearingStepDeg}° (${Math.floor(360 / params.bearingStepDeg)} rays)`);

  onProgress?.(`커버리지 ${mode} 계산 중... ${params.radarName} (건물 포함)`);
  const layersWith = await computeProfile(device, params, altFts, onProgress);

  onProgress?.(`커버리지 ${mode} 계산 중... ${params.radarName} (건물 제외)`);
  const layersWithout = await computeProfile(device, { ...params, excludeManualIds }, altFts, onProgress);

  return { layersWith, layersWithout };
}
