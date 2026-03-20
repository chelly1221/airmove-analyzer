/**
 * WebGPU 커버리지 맵 가속 (0.01° 고해상도, 36,000 rays)
 *
 * 아키텍처:
 *   Phase 1: Rust rayon — SRTM + 건물 높이 프리샘플 → base64 IPC (배치)
 *   Phase 2a: GPU Pass 1 — 곡률 보정 + running max angle 누적
 *   Phase 2b: GPU Pass 2 — 고도별 이진 탐색 → max_range_km
 *   Phase 3: JS — CoverageLayer[] 변환
 *
 * WebGPU 필수 (CPU 폴백 없음)
 */

import { invoke } from "@tauri-apps/api/core";
import { getGPUDevice, createBuffer, readBuffer, runComputeShader } from "./gpuCompute";
import type { CoverageLayer, CoverageBearing, MultiCoverageResult } from "./radarCoverage";
import type { RadarSite } from "../types";

// ─── 상수 ───────────────────────────────────────────

const BEARING_STEP_DEG = 0.01;
const MAX_ELEV_DEG = 40;
const FT_TO_M = 0.3048;

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

// ─── base64 decode (async, 논블로킹) ────────────────

async function decodeBase64F32(b64: string): Promise<Float32Array> {
  const res = await fetch(`data:application/octet-stream;base64,${b64}`);
  return new Float32Array(await res.arrayBuffer());
}

// ─── Rust 프리샘플 호출 ─────────────────────────────

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

// ─── GPU 프로파일 계산 (raw Float32Array 출력) ───────

async function computeProfileRaw(
  device: GPUDevice,
  params: ProfileParams,
  altFts: number[],
  onProgress?: (msg: string) => void,
): Promise<Float32Array> {
  const totalRays = Math.floor(360 / params.bearingStepDeg);
  const numSamples = 2400;
  const bytesPerRay = numSamples * 4;

  const maxBufBytes = device.limits.maxStorageBufferBindingSize;
  // Pass 2 workgroup 수 제한: batchRays * numAlts / 64 ≤ maxComputeWorkgroupsPerDimension
  const maxWorkgroups = device.limits.maxComputeWorkgroupsPerDimension;
  const maxRaysForWorkgroups = Math.floor(maxWorkgroups * 64 / altFts.length);
  const maxRaysPerBatch = Math.min(
    Math.floor(maxBufBytes / bytesPerRay),
    maxRaysForWorkgroups,
  );
  const numBatches = Math.ceil(totalRays / maxRaysPerBatch);

  const allRanges = new Float32Array(totalRays * altFts.length);

  for (let b = 0; b < numBatches; b++) {
    const startRay = b * maxRaysPerBatch;
    const batchRays = Math.min(maxRaysPerBatch, totalRays - startRay);

    onProgress?.(`커버리지 GPU 계산 중... (배치 ${b + 1}/${numBatches}, ${batchRays} rays)`);

    const ps = await fetchPresample(params, startRay, batchRays);
    const elevF32 = await decodeBase64F32(ps.elev_b64);
    ps.elev_b64 = "";

    const batchResult = await computeBatchGPU(
      device, elevF32, batchRays, numSamples, ps.radar_height_m, ps.max_range_km, altFts,
    );

    for (let r = 0; r < batchRays; r++) {
      for (let a = 0; a < altFts.length; a++) {
        allRanges[(startRay + r) * altFts.length + a] = batchResult[r * altFts.length + a];
      }
    }
  }

  return allRanges;
}

// ─── 세션 캐시 ──────────────────────────────────────

interface GPUCoverageCache {
  radarKey: string;
  radarLat: number;
  radarLon: number;
  radarAltitude: number;
  antennaHeight: number;
  bearingStepDeg: number;
  totalRays: number;
  altFts: number[];
  ranges: Float32Array; // totalRays × numAlts
}

let _cache: GPUCoverageCache | null = null;

/** 캐시에서 CoverageLayer[] 생성 */
function buildLayers(
  cache: GPUCoverageCache,
  altFts: number[],
  bearingStep: number,
): CoverageLayer[] {
  const radarHeight = cache.radarAltitude + cache.antennaHeight;
  const maxElevRad = (MAX_ELEV_DEG * Math.PI) / 180;
  const numAlts = cache.altFts.length;

  // 캐시된 altFts 인덱스 맵
  const altIdxMap = new Map<number, number>();
  for (let i = 0; i < cache.altFts.length; i++) {
    altIdxMap.set(cache.altFts[i], i);
  }

  return altFts
    .map((altFt) => {
      const altIdx = altIdxMap.get(altFt);
      if (altIdx === undefined) return null;

      const altM = altFt * FT_TO_M;
      const heightAbove = altM - radarHeight;
      const coneRadiusKm = heightAbove > 0 ? (heightAbove / Math.tan(maxElevRad)) / 1000 : 0;

      const bearings: CoverageBearing[] = [];
      for (let r = 0; r < cache.totalRays; r += bearingStep) {
        const deg = r * cache.bearingStepDeg;
        const range = cache.ranges[r * numAlts + altIdx];
        const [lat, lon] = range > 0
          ? destinationPoint(cache.radarLat, cache.radarLon, deg, range)
          : [cache.radarLat, cache.radarLon];
        bearings.push({ deg, maxRangeKm: range, lat, lon });
      }

      return { altitudeFt: altFt, altitudeM: altM, bearings, coneRadiusKm } as CoverageLayer;
    })
    .filter(Boolean) as CoverageLayer[];
}

// ─── 공개 API: 메인 커버리지맵 ──────────────────────

/**
 * 메인 커버리지맵 계산 (WebGPU, 0.01° 해상도, 36,000 rays)
 * - 전체 고도(100~30000ft, 100ft 단위) 사전 계산 → 세션 캐시
 * - 대표 레이어 10개 반환 (DB 저장용)
 */
export async function computeMainCoverage(
  radar: RadarSite,
  onProgress?: (pct: number, msg: string) => void,
): Promise<MultiCoverageResult> {
  const device = await getGPUDevice();
  if (!device) throw new Error("WebGPU를 사용할 수 없습니다. GPU가 필요합니다.");

  onProgress?.(1, "GPU 커버리지 계산 준비...");

  // 전체 고도 목록 (100ft ~ 30000ft, 100ft 단위 = 300개)
  const altFts: number[] = [];
  for (let alt = 100; alt <= 30000; alt += 100) altFts.push(alt);

  const params: ProfileParams = {
    radarLat: radar.latitude,
    radarLon: radar.longitude,
    radarAltitude: radar.altitude,
    antennaHeight: radar.antenna_height,
    rangeNm: radar.range_nm,
    bearingStepDeg: BEARING_STEP_DEG,
  };

  const totalRays = Math.floor(360 / BEARING_STEP_DEG);

  const ranges = await computeProfileRaw(device, params, altFts, (msg) => {
    onProgress?.(50, msg);
  });

  // 세션 캐시 저장
  _cache = {
    radarKey: cacheKey(radar),
    radarLat: radar.latitude,
    radarLon: radar.longitude,
    radarAltitude: radar.altitude,
    antennaHeight: radar.antenna_height,
    bearingStepDeg: BEARING_STEP_DEG,
    totalRays,
    altFts,
    ranges,
  };

  onProgress?.(90, "레이어 변환 중...");

  // DB 저장용 대표 레이어 (전체 해상도)
  const repAlts = [500, 1000, 2000, 3000, 5000, 10000, 15000, 20000, 25000, 30000];
  const layers = buildLayers(_cache, repAlts, 1);

  onProgress?.(100, "완료");

  return {
    radarName: radar.name,
    radarLat: radar.latitude,
    radarLon: radar.longitude,
    radarAltitude: radar.altitude,
    antennaHeight: radar.antenna_height,
    maxElevDeg: MAX_ELEV_DEG,
    layers,
    computedAt: Date.now(),
  };
}

/**
 * 캐시에서 특정 고도 레이어 추출 (슬라이더용, 동기)
 * @param bearingStep 방위 다운샘플 (기본 1: 전체 해상도)
 */
export function computeLayersForAltitudes(
  altFts: number[],
  bearingStep = 1,
): CoverageLayer[] {
  if (!_cache) return [];
  return buildLayers(_cache, altFts, bearingStep);
}

function cacheKey(radar: RadarSite): string {
  return `${radar.name}_${radar.latitude}_${radar.longitude}_${radar.altitude + radar.antenna_height}`;
}

/** 캐시 유효성 확인 */
export function isGPUCacheValidFor(radar: RadarSite): boolean {
  if (!_cache) return false;
  return _cache.radarKey === cacheKey(radar);
}

/** 캐시 무효화 */
export function invalidateGPUCache(): void {
  _cache = null;
}

// ─── 공개 API: OM 보고서용 ──────────────────────────

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
 * - WebGPU 필수
 * - 건물 포함/제외 2회 계산
 */
export async function computeCoverageLayersOM(
  params: CoverageOMParams,
  altFts: number[],
  excludeManualIds: number[],
  onProgress?: (msg: string) => void,
): Promise<{ layersWith: CoverageLayer[]; layersWithout: CoverageLayer[] }> {
  const device = await getGPUDevice();
  if (!device) throw new Error("WebGPU를 사용할 수 없습니다. GPU가 필요합니다.");

  const totalRays = Math.floor(360 / params.bearingStepDeg);
  console.log(`[Coverage] GPU 모드, ${params.bearingStepDeg}° (${totalRays} rays)`);

  onProgress?.(`커버리지 GPU 계산 중... ${params.radarName} (건물 포함)`);
  const withRanges = await computeProfileRaw(device, params, altFts, onProgress);
  const withCache: GPUCoverageCache = {
    radarKey: "",
    radarLat: params.radarLat,
    radarLon: params.radarLon,
    radarAltitude: params.radarAltitude,
    antennaHeight: params.antennaHeight,
    bearingStepDeg: params.bearingStepDeg,
    totalRays,
    altFts,
    ranges: withRanges,
  };
  const layersWith = buildLayers(withCache, altFts, 1);

  onProgress?.(`커버리지 GPU 계산 중... ${params.radarName} (건물 제외)`);
  const withoutRanges = await computeProfileRaw(device, { ...params, excludeManualIds }, altFts, onProgress);
  const withoutCache: GPUCoverageCache = { ...withCache, ranges: withoutRanges };
  const layersWithout = buildLayers(withoutCache, altFts, 1);

  return { layersWith, layersWithout };
}
