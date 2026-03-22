/**
 * WebGPU 커버리지 맵 가속 (0.01° 고해상도, 36,000 rays)
 *
 * 아키텍처:
 *   Phase 1: Rust rayon — SRTM + 건물 높이 프리샘플 → base64 IPC (배치)
 *   Phase 2a: GPU Pass 1 — 곡률 보정 + running max angle 누적
 *   Phase 2b: GPU Pass 2 — 고도별 이진 탐색 → max_range_km
 *   Phase 3: Worker — buildLayers + 폴리곤 구성 (UI 논블로킹)
 *
 * 최적화:
 *   - Web Worker: buildLayers (36K destinationPoint/alt) 오프로드
 *   - 점진적 렌더링: GPU 배치 완료마다 부분 폴리곤 즉시 표시
 *   - IndexedDB 캐시: 앱 재시작 시 재계산 없이 즉시 복원
 */

import { invoke } from "@tauri-apps/api/core";
import { getGPUDevice, createBuffer, readBuffer, runComputeShader } from "./gpuCompute";
import type { CoverageLayer, CoverageBearing, MultiCoverageResult } from "./radarCoverage";
import type { RadarSite } from "../types";

// ─── 상수 ───────────────────────────────────────────

const BEARING_STEP_DEG = 0.01;
const MAX_ELEV_DEG = 40;
const FT_TO_M = 0.3048;
const IDB_NAME = "coverage-cache";
const IDB_STORE = "ranges";
const IDB_VERSION = 1;

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

// ─── destination_point (OM 보고서용 동기 폴백) ───────

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

// ─── Worker 관리 ────────────────────────────────────

interface WorkerRequest {
  resolve: (value: any) => void;
  reject: (reason: any) => void;
}

let _worker: Worker | null = null;
let _workerReady = false;
const _workerPending = new Map<number, WorkerRequest>();
let _workerNextId = 0;
let _progressiveCallback: ((polygons: any[]) => void) | null = null;

function getWorker(): Worker {
  if (_worker) return _worker;
  _worker = new Worker(
    new URL("../workers/coverageBuilder.worker.ts", import.meta.url),
    { type: "module" },
  );
  _worker.onmessage = handleWorkerMessage;
  _worker.onerror = (err) => console.error("[CoverageWorker] error:", err);
  return _worker;
}

function handleWorkerMessage(e: MessageEvent) {
  const { type, id } = e.data;

  // 점진적 렌더링 콜백 (promise 없이 직접 콜백)
  if (type === "PROGRESSIVE_RESULT") {
    _progressiveCallback?.(e.data.polygons);
    return;
  }

  const req = _workerPending.get(id);
  if (!req) return;
  _workerPending.delete(id);

  if (type === "ERROR") {
    req.reject(new Error(e.data.error));
  } else {
    req.resolve(e.data);
  }
}

function workerSend(msg: any, transfer?: Transferable[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const id = _workerNextId++;
    _workerPending.set(id, { resolve, reject });
    getWorker().postMessage({ ...msg, id }, transfer ?? []);
  });
}

/** Worker에 캐시 초기화 (ranges Transfer) */
async function initWorkerCache(cache: GPUCoverageCache): Promise<void> {
  const copy = new Float32Array(cache.ranges);
  await workerSend({
    type: "INIT_CACHE",
    radarLat: cache.radarLat,
    radarLon: cache.radarLon,
    radarAltitude: cache.radarAltitude,
    antennaHeight: cache.antennaHeight,
    bearingStepDeg: cache.bearingStepDeg,
    totalRays: cache.totalRays,
    altFts: cache.altFts,
    ranges: copy.buffer,
  }, [copy.buffer]);
  _workerReady = true;
}

/** Worker에서 레이어 생성 (비동기, UI 논블로킹) */
export async function computeLayersForAltitudesAsync(
  altFts: number[],
  bearingStep = 1,
): Promise<CoverageLayer[]> {
  if (!_workerReady) return [];
  const result = await workerSend({
    type: "BUILD_LAYERS",
    altFts,
    bearingStep,
  });
  return result.layers;
}

/** Worker에서 폴리곤 데이터 구성 (비동기, UI 논블로킹) */
export async function buildPolygonsAsync(
  layers: CoverageLayer[],
  radarLat: number,
  radarLon: number,
  altScale: number,
  showCone: boolean,
): Promise<any[]> {
  const result = await workerSend({
    type: "BUILD_POLYGONS",
    layers, radarLat, radarLon, altScale, showCone,
  });
  return result.polygons;
}

// ─── GPU 배치 루프 + 점진적 렌더링 ─────────────────

/** 점진적 렌더링 콜백을 받는 폴리곤 데이터 타입 */
export interface CoveragePolygonData {
  polygon: [number, number, number][][];
  outerRing: [number, number, number][];
  coneRing: [number, number, number][] | null;
  fillColor: [number, number, number];
  altM: number;
  altFt: number;
}

async function computeProfileRawWithProgressive(
  device: GPUDevice,
  params: ProfileParams,
  altFts: number[],
  onProgress?: (pct: number, msg: string) => void,
  onProgressivePolygons?: (polygons: CoveragePolygonData[]) => void,
): Promise<Float32Array> {
  const totalRays = Math.floor(360 / params.bearingStepDeg);
  const numSamples = 2400;
  const bytesPerRay = numSamples * 4;

  const maxBufBytes = device.limits.maxStorageBufferBindingSize;
  const maxWorkgroups = device.limits.maxComputeWorkgroupsPerDimension;
  const maxRaysForWorkgroups = Math.floor(maxWorkgroups * 64 / altFts.length);
  const maxRaysPerBatch = Math.min(
    Math.floor(maxBufBytes / bytesPerRay),
    maxRaysForWorkgroups,
  );
  const numBatches = Math.ceil(totalRays / maxRaysPerBatch);

  // Worker 준비 (점진적 렌더링용)
  const worker = getWorker();
  const progressiveAlts = [500, 1000, 2000, 5000, 10000, 20000];

  // 점진적 렌더링 콜백 설정
  if (onProgressivePolygons) {
    _progressiveCallback = onProgressivePolygons;
  }

  for (let b = 0; b < numBatches; b++) {
    const startRay = b * maxRaysPerBatch;
    const batchRays = Math.min(maxRaysPerBatch, totalRays - startRay);
    const batchPct = Math.round(((b + 0.5) / numBatches) * 80) + 5;

    onProgress?.(batchPct, `커버리지 GPU 계산 중... (배치 ${b + 1}/${numBatches}, ${batchRays} rays)`);

    const ps = await fetchPresample(params, startRay, batchRays);
    const elevF32 = await decodeBase64F32(ps.elev_b64);
    ps.elev_b64 = "";

    const batchResult = await computeBatchGPU(
      device, elevF32, batchRays, numSamples, ps.radar_height_m, ps.max_range_km, altFts,
    );

    // GPU 결과를 Worker에 보내서 누적 + 점진적 폴리곤 생성 (논블로킹)
    const batchCopy = new Float32Array(batchResult);
    worker.postMessage({
      type: "ACCUMULATE_BATCH",
      id: _workerNextId++, // PROGRESSIVE_RESULT는 promise 없이 콜백
      startRay,
      batchRays,
      batchResult: batchCopy.buffer,
      numAlts: altFts.length,
      totalRays,
      radarLat: params.radarLat,
      radarLon: params.radarLon,
      radarAltitude: params.radarAltitude,
      antennaHeight: params.antennaHeight,
      bearingStepDeg: params.bearingStepDeg,
      altFts,
      progressiveAlts: onProgressivePolygons ? progressiveAlts : null,
      altScale: 0,
      showCone: false,
    }, [batchCopy.buffer]);
  }

  // 점진적 렌더링 콜백 해제
  _progressiveCallback = null;

  // Worker 캐시에서 최종 ranges 추출 (EXPORT_CACHE)
  const exported = await workerSend({ type: "EXPORT_CACHE" });
  const allRanges = new Float32Array(exported.ranges);

  // Worker는 이미 캐시를 가지고 있으므로 _workerReady = true
  _workerReady = true;

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

/** 캐시에서 CoverageLayer[] 생성 (OM 보고서용 동기 폴백) */
function buildLayers(
  cache: GPUCoverageCache,
  altFts: number[],
  bearingStep: number,
): CoverageLayer[] {
  const radarHeight = cache.radarAltitude + cache.antennaHeight;
  const maxElevRad = (MAX_ELEV_DEG * Math.PI) / 180;
  const numAlts = cache.altFts.length;

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

// ─── IndexedDB 캐시 (Phase 4) ──────────────────────

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) {
        db.createObjectStore(IDB_STORE, { keyPath: "radarKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveToIDB(cache: GPUCoverageCache): Promise<void> {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, "readwrite");
    const store = tx.objectStore(IDB_STORE);
    store.put({
      radarKey: cache.radarKey,
      radarLat: cache.radarLat,
      radarLon: cache.radarLon,
      radarAltitude: cache.radarAltitude,
      antennaHeight: cache.antennaHeight,
      bearingStepDeg: cache.bearingStepDeg,
      totalRays: cache.totalRays,
      altFts: cache.altFts,
      ranges: cache.ranges.buffer, // ArrayBuffer 저장
      savedAt: Date.now(),
    });
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    console.log(`[Coverage IDB] 캐시 저장 완료 (${(cache.ranges.byteLength / 1024 / 1024).toFixed(1)} MB)`);
  } catch (e) {
    console.warn("[Coverage IDB] 저장 실패:", e);
  }
}

async function loadFromIDB(radarKey: string): Promise<GPUCoverageCache | null> {
  try {
    const db = await openIDB();
    const tx = db.transaction(IDB_STORE, "readonly");
    const store = tx.objectStore(IDB_STORE);
    const req = store.get(radarKey);
    const result = await new Promise<any>((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();

    if (!result) return null;

    return {
      radarKey: result.radarKey,
      radarLat: result.radarLat,
      radarLon: result.radarLon,
      radarAltitude: result.radarAltitude,
      antennaHeight: result.antennaHeight,
      bearingStepDeg: result.bearingStepDeg,
      totalRays: result.totalRays,
      altFts: result.altFts,
      ranges: new Float32Array(result.ranges),
    };
  } catch (e) {
    console.warn("[Coverage IDB] 로드 실패:", e);
    return null;
  }
}

// ─── 공개 API: 메인 커버리지맵 ──────────────────────

/**
 * 메인 커버리지맵 계산 (WebGPU, 0.01° 해상도, 36,000 rays)
 * - 전체 고도(100~30000ft, 100ft 단위) 사전 계산 → 세션 캐시 + IndexedDB
 * - Worker를 통한 논블로킹 레이어 생성
 * - 점진적 렌더링 콜백 지원
 */
export async function computeMainCoverage(
  radar: RadarSite,
  onProgress?: (pct: number, msg: string) => void,
  onProgressivePolygons?: (polygons: CoveragePolygonData[]) => void,
): Promise<MultiCoverageResult> {
  const key = cacheKey(radar);

  // IndexedDB 캐시 확인
  onProgress?.(1, "캐시 확인 중...");
  const idbCache = await loadFromIDB(key);
  if (idbCache) {
    console.log("[Coverage] IndexedDB 캐시 복원");
    _cache = idbCache;

    // Worker에 캐시 전달
    await initWorkerCache(_cache);

    onProgress?.(90, "레이어 변환 중...");

    const repAlts = [500, 1000, 2000, 3000, 5000, 10000, 15000, 20000, 25000, 30000];
    const layers = await computeLayersForAltitudesAsync(repAlts, 1);

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

  // GPU 계산
  const device = await getGPUDevice();
  if (!device) throw new Error("WebGPU를 사용할 수 없습니다. GPU가 필요합니다.");

  onProgress?.(2, "GPU 커버리지 계산 준비...");

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

  // GPU 계산 + 점진적 렌더링 (Worker에서 배치별 폴리곤 생성)
  const ranges = await computeProfileRawWithProgressive(
    device, params, altFts,
    onProgress,
    onProgressivePolygons,
  );

  // 세션 캐시 저장
  _cache = {
    radarKey: key,
    radarLat: radar.latitude,
    radarLon: radar.longitude,
    radarAltitude: radar.altitude,
    antennaHeight: radar.antenna_height,
    bearingStepDeg: BEARING_STEP_DEG,
    totalRays,
    altFts,
    ranges,
  };

  onProgress?.(88, "레이어 변환 중...");

  // Worker에서 최종 레이어 생성 (논블로킹)
  const repAlts = [500, 1000, 2000, 3000, 5000, 10000, 15000, 20000, 25000, 30000];
  const layers = await computeLayersForAltitudesAsync(repAlts, 1);

  // IndexedDB에 비동기 저장 (fire-and-forget)
  onProgress?.(95, "캐시 저장 중...");
  saveToIDB(_cache).catch(() => {});

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
 * 캐시에서 특정 고도 레이어 추출 (슬라이더용, 동기 폴백)
 * Worker가 준비되지 않았을 때만 사용
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
  _workerReady = false;
}

/** Worker 준비 여부 */
export function isWorkerReady(): boolean {
  return _workerReady;
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

// OM 보고서용 GPU 계산 (동기 buildLayers — Worker 불필요, 보고서 자체가 백그라운드)
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
