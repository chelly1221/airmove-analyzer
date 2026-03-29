/**
 * WebGPU 커버리지 맵 가속 (0.01° 고해상도, 36,000 rays)
 *
 * 아키텍처 (heightmap 3D 리팩토링):
 *   Phase 1: Rust — SRTM + 건물 → 2D heightmap (ENU 그리드, 1회 IPC)
 *   Phase 2: GPU — heightmap 텍스처에서 polar→ENU 샘플링 + 가시선 계산 (1회 디스패치)
 *   Phase 3: Worker — buildLayers + 폴리곤 구성 (UI 논블로킹)
 *
 * 기존 presample 방식(36K ray × 2400 샘플 base64 배치 IPC 12회) 대비:
 *   - IPC 1회 (~20MB heightmap)로 대폭 감소
 *   - GPU가 heightmap에서 직접 샘플링 → base64 인코딩/디코딩 제거
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
const IDB_VERSION = 2;
const NUM_SAMPLES = 2400; // 레이당 거리 샘플 수
const HEIGHTMAP_PIXEL_SIZE_M = 100; // heightmap 해상도 (m/pixel)

// ─── Rust heightmap 결과 타입 ────────────────────────

interface HeightmapResult {
  data_b64: string;
  width: number;
  height: number;
  pixel_size_m: number;
  center_lat: number;
  center_lon: number;
  radar_height_m: number;
  max_range_km: number;
}

// ─── WGSL Compute Shader (heightmap 기반) ───────────

// Pass 1: heightmap에서 polar→ENU 샘플링 + 곡률 보정 + running max angle
const HEIGHTMAP_PASS1_SHADER = /* wgsl */ `
const R_EARTH_M: f32 = 6371000.0;
const PI: f32 = 3.14159265358979;

struct Params {
  radar_height_m: f32,
  max_range_km: f32,
  num_samples: u32,
  bearing_step_deg: f32,
  pixel_size_m: f32,
  hm_width: u32,
  hm_height: u32,
  _pad: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> heightmap: array<f32>;
@group(0) @binding(2) var<storage, read_write> max_angles: array<f32>;

// 바이리니어 보간 heightmap 샘플링
fn sample_hm(east_m: f32, north_m: f32) -> f32 {
  let half_w = f32(params.hm_width) * 0.5;
  let half_h = f32(params.hm_height) * 0.5;
  let fx = east_m / params.pixel_size_m + half_w;
  let fy = north_m / params.pixel_size_m + half_h;

  let x0 = u32(max(floor(fx), 0.0));
  let y0 = u32(max(floor(fy), 0.0));
  if (x0 >= params.hm_width - 1u || y0 >= params.hm_height - 1u) { return 0.0; }

  let dx = fx - f32(x0);
  let dy = fy - f32(y0);
  let w = params.hm_width;
  let v00 = heightmap[y0 * w + x0];
  let v10 = heightmap[y0 * w + x0 + 1u];
  let v01 = heightmap[(y0 + 1u) * w + x0];
  let v11 = heightmap[(y0 + 1u) * w + x0 + 1u];
  return mix(mix(v00, v10, dx), mix(v01, v11, dx), dy);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let ray = gid.x;
  let total_rays = u32(360.0 / params.bearing_step_deg);
  if (ray >= total_rays) { return; }

  let bearing_rad = f32(ray) * params.bearing_step_deg * PI / 180.0;
  let sin_b = sin(bearing_rad);
  let cos_b = cos(bearing_rad);
  let base = ray * params.num_samples;
  var running_max: f32 = -1e10;

  for (var s = 0u; s < params.num_samples; s++) {
    let dist_m = (f32(s + 1u) / f32(params.num_samples)) * params.max_range_km * 1000.0;

    // polar → ENU
    let east_m = dist_m * sin_b;
    let north_m = dist_m * cos_b;

    let elev = sample_hm(east_m, north_m);

    // 곡률 보정
    let curv_drop = dist_m * dist_m / (2.0 * R_EARTH_M);
    let adj = elev - curv_drop;

    // running max angle
    let angle = (adj - params.radar_height_m) / dist_m;
    if (angle > running_max) { running_max = angle; }
    max_angles[base + s] = running_max;
  }
}
`;

// Pass 2: 고도별 이진 탐색 → max_range_km (heightmap에서 재샘플)
const HEIGHTMAP_PASS2_SHADER = /* wgsl */ `
const R_EARTH_M: f32 = 6371000.0;
const PI: f32 = 3.14159265358979;
const FT_TO_M: f32 = 0.3048;

struct Params {
  radar_height_m: f32,
  max_range_km: f32,
  num_samples: u32,
  num_altitudes: u32,
  bearing_step_deg: f32,
  pixel_size_m: f32,
  hm_width: u32,
  hm_height: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> heightmap: array<f32>;
@group(0) @binding(2) var<storage, read> max_angles: array<f32>;
@group(0) @binding(3) var<storage, read> alt_fts: array<f32>;
@group(0) @binding(4) var<storage, read_write> output: array<f32>;

fn sample_hm(east_m: f32, north_m: f32) -> f32 {
  let half_w = f32(params.hm_width) * 0.5;
  let half_h = f32(params.hm_height) * 0.5;
  let fx = east_m / params.pixel_size_m + half_w;
  let fy = north_m / params.pixel_size_m + half_h;

  let x0 = u32(max(floor(fx), 0.0));
  let y0 = u32(max(floor(fy), 0.0));
  if (x0 >= params.hm_width - 1u || y0 >= params.hm_height - 1u) { return 0.0; }

  let dx = fx - f32(x0);
  let dy = fy - f32(y0);
  let w = params.hm_width;
  let v00 = heightmap[y0 * w + x0];
  let v10 = heightmap[y0 * w + x0 + 1u];
  let v01 = heightmap[(y0 + 1u) * w + x0];
  let v11 = heightmap[(y0 + 1u) * w + x0 + 1u];
  return mix(mix(v00, v10, dx), mix(v01, v11, dx), dy);
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  if (gid.x >= arrayLength(&output)) { return; }
  let ray = gid.x / params.num_altitudes;
  let alt_idx = gid.x % params.num_altitudes;
  let alt_m = alt_fts[alt_idx] * FT_TO_M;
  let base = ray * params.num_samples;
  let n = params.num_samples;
  let max_range = params.max_range_km;

  let bearing_rad = f32(ray) * params.bearing_step_deg * PI / 180.0;
  let sin_b = sin(bearing_rad);
  let cos_b = cos(bearing_rad);

  // 이진 탐색: max_angles에서 LoS 차단점
  var los_block: u32 = n;
  var lo: u32 = 1u;
  var hi: u32 = n - 1u;
  while (lo <= hi) {
    let mid = (lo + hi) / 2u;
    let dist = (f32(mid + 1u) / f32(n)) * max_range * 1000.0;
    let curv_drop = dist * dist / (2.0 * R_EARTH_M);
    let adj_alt = alt_m - curv_drop;
    let target_angle = (adj_alt - params.radar_height_m) / dist;
    if (max_angles[base + mid] > target_angle) {
      los_block = mid;
      hi = mid - 1u;
    } else {
      lo = mid + 1u;
    }
  }

  // 선형 탐색: 지형 직접 차단점 (heightmap 재샘플)
  var terrain_block: u32 = n;
  for (var i = 0u; i < los_block; i++) {
    let dist = (f32(i + 1u) / f32(n)) * max_range * 1000.0;
    let east_m = dist * sin_b;
    let north_m = dist * cos_b;
    let elev = sample_hm(east_m, north_m);
    let curv_drop = dist * dist / (2.0 * R_EARTH_M);
    let adj_alt = alt_m - curv_drop;
    if (elev - curv_drop > adj_alt) {
      terrain_block = i;
      break;
    }
  }

  let block_idx = min(los_block, terrain_block);
  let range_km = (f32(block_idx) / f32(n)) * max_range;
  output[ray * params.num_altitudes + alt_idx] = range_km;
}
`;

// ─── destinationPoint (OM 보고서용 동기 레이어 생성) ───────

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

// ─── Heightmap IPC ──────────────────────────────────

async function fetchHeightmap(
  radarLat: number, radarLon: number,
  radarAltitude: number, antennaHeight: number,
  rangeNm: number,
  excludeManualIds?: number[],
): Promise<{ heightmapF32: Float32Array; meta: HeightmapResult }> {
  const meta = await invoke<HeightmapResult>("build_heightmap", {
    radarLat, radarLon, radarAltitude, antennaHeight, rangeNm,
    pixelSizeM: HEIGHTMAP_PIXEL_SIZE_M,
    excludeManualIds,
  });

  // base64 디코딩
  const res = await fetch(`data:application/octet-stream;base64,${meta.data_b64}`);
  const heightmapF32 = new Float32Array(await res.arrayBuffer());
  meta.data_b64 = ""; // 메모리 해제
  return { heightmapF32, meta };
}

// ─── GPU 계산 (heightmap 기반, 배치 없음) ────────────

interface CoverageGPUResult {
  ranges: Float32Array; // totalRays × numAlts
  maxRangeKm: number;
}

async function computeFromHeightmap(
  device: GPUDevice,
  heightmapF32: Float32Array,
  meta: HeightmapResult,
  bearingStepDeg: number,
  altFts: number[],
): Promise<CoverageGPUResult> {
  const totalRays = Math.floor(360 / bearingStepDeg);
  const numAlts = altFts.length;

  // Heightmap 버퍼 (GPU에 1회 업로드)
  const hmBuf = createBuffer(device, heightmapF32, GPUBufferUsage.STORAGE);

  // ── Pass 1: running max angle ──
  const p1Buf = new ArrayBuffer(32);
  const p1F32 = new Float32Array(p1Buf);
  const p1U32 = new Uint32Array(p1Buf);
  p1F32[0] = meta.radar_height_m;
  p1F32[1] = meta.max_range_km;
  p1U32[2] = NUM_SAMPLES;
  p1F32[3] = bearingStepDeg;
  p1F32[4] = meta.pixel_size_m;
  p1U32[5] = meta.width;
  p1U32[6] = meta.height;
  p1U32[7] = 0;
  const uniformBuf1 = createBuffer(device, new Float32Array(p1Buf), GPUBufferUsage.UNIFORM);

  const maxAnglesSize = totalRays * NUM_SAMPLES * 4;
  const maxAnglesBuf = device.createBuffer({
    size: maxAnglesSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const maxWorkgroups = device.limits.maxComputeWorkgroupsPerDimension;
  const pass1Workgroups = Math.min(Math.ceil(totalRays / 64), maxWorkgroups);

  await runComputeShader(device, HEIGHTMAP_PASS1_SHADER, [
    { buffer: uniformBuf1, type: "uniform" },
    { buffer: hmBuf, type: "read-only-storage" },
    { buffer: maxAnglesBuf, type: "storage" },
  ], [pass1Workgroups, 1, 1]);

  // ── Pass 2: 고도별 이진 탐색 ──
  const p2Buf = new ArrayBuffer(32);
  const p2F32 = new Float32Array(p2Buf);
  const p2U32 = new Uint32Array(p2Buf);
  p2F32[0] = meta.radar_height_m;
  p2F32[1] = meta.max_range_km;
  p2U32[2] = NUM_SAMPLES;
  p2U32[3] = numAlts;
  p2F32[4] = bearingStepDeg;
  p2F32[5] = meta.pixel_size_m;
  p2U32[6] = meta.width;
  p2U32[7] = meta.height;
  const uniformBuf2 = createBuffer(device, new Float32Array(p2Buf), GPUBufferUsage.UNIFORM);

  const altBuf = createBuffer(device, new Float32Array(altFts), GPUBufferUsage.STORAGE);
  const outSize = totalRays * numAlts * 4;
  const outputBuf = device.createBuffer({
    size: outSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const pass2Workgroups = Math.min(Math.ceil((totalRays * numAlts) / 64), maxWorkgroups);

  await runComputeShader(device, HEIGHTMAP_PASS2_SHADER, [
    { buffer: uniformBuf2, type: "uniform" },
    { buffer: hmBuf, type: "read-only-storage" },
    { buffer: maxAnglesBuf, type: "read-only-storage" },
    { buffer: altBuf, type: "read-only-storage" },
    { buffer: outputBuf, type: "storage" },
  ], [pass2Workgroups, 1, 1]);

  const ranges = await readBuffer(device, outputBuf, outSize);

  // 버퍼 정리
  uniformBuf1.destroy();
  uniformBuf2.destroy();
  hmBuf.destroy();
  maxAnglesBuf.destroy();
  altBuf.destroy();
  outputBuf.destroy();

  return { ranges, maxRangeKm: meta.max_range_km };
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
const _progressiveCallbacks = new Map<number, (polygons: any[]) => void>();

function getWorker(): Worker {
  if (_worker) return _worker;
  _worker = new Worker(
    new URL("../workers/coverageBuilder.worker.ts", import.meta.url),
    { type: "module" },
  );
  _worker.onmessage = handleWorkerMessage;
  _worker.onerror = (err) => {
    console.error("[CoverageWorker] error:", err);
    for (const [, req] of _workerPending) {
      req.reject(new Error("Worker crashed"));
    }
    _workerPending.clear();
    _workerReady = false;
  };
  return _worker;
}

function handleWorkerMessage(e: MessageEvent) {
  const { type, id } = e.data;

  if (type === "PROGRESSIVE_RESULT") {
    const cb = _progressiveCallbacks.get(e.data.computeId);
    cb?.(e.data.polygons);
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
    maxRangeKm: cache.maxRangeKm,
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

// ─── 점진적 렌더링 ─────────────────────────────────

/** 점진적 렌더링 콜백을 받는 폴리곤 데이터 타입 */
export interface CoveragePolygonData {
  polygon: [number, number, number][][];
  outerRing: [number, number, number][];
  coneRing: [number, number, number][] | null;
  fillColor: [number, number, number];
  altM: number;
  altFt: number;
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
  maxRangeKm?: number;
}

let _cache: GPUCoverageCache | null = null;

/** 캐시에서 CoverageLayer[] 생성 (OM 보고서용 동기 레이어 생성) */
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

// ─── IndexedDB 캐시 ─────────────────────────────────

function openIDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if ((event as IDBVersionChangeEvent).oldVersion < 2 && db.objectStoreNames.contains(IDB_STORE)) {
        db.deleteObjectStore(IDB_STORE);
      }
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
    const record: any = {
      radarKey: cache.radarKey,
      radarLat: cache.radarLat,
      radarLon: cache.radarLon,
      radarAltitude: cache.radarAltitude,
      antennaHeight: cache.antennaHeight,
      bearingStepDeg: cache.bearingStepDeg,
      totalRays: cache.totalRays,
      altFts: cache.altFts,
      ranges: cache.ranges.buffer,
      maxRangeKm: cache.maxRangeKm,
      savedAt: Date.now(),
    };
    store.put(record);
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

    const cache: GPUCoverageCache = {
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
    cache.maxRangeKm = result.maxRangeKm;
    return cache;
  } catch (e) {
    console.warn("[Coverage IDB] 로드 실패:", e);
    return null;
  }
}

// ─── 공개 API: 메인 커버리지맵 ──────────────────────

/**
 * 메인 커버리지맵 계산 (WebGPU + heightmap, 0.01° 해상도, 36,000 rays)
 * - Rust에서 2D heightmap 1회 수신 → GPU에서 전체 가시선 1회 계산
 * - 점진적 렌더링: GPU 완료 후 Worker에서 폴리곤 점진 생성
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

  // GPU 계산 (heightmap 방식)
  const device = await getGPUDevice();

  onProgress?.(2, "Heightmap 생성 중...");

  const altFts: number[] = [];
  for (let alt = 100; alt <= 30000; alt += 100) altFts.push(alt);

  const totalRays = Math.floor(360 / BEARING_STEP_DEG);

  // 1. Rust에서 heightmap 1회 수신
  const { heightmapF32, meta } = await fetchHeightmap(
    radar.latitude, radar.longitude,
    radar.altitude, radar.antenna_height,
    radar.range_nm,
  );

  console.log(`[Coverage] Heightmap ${meta.width}×${meta.height} (${(heightmapF32.byteLength / 1024 / 1024).toFixed(1)} MB), range=${meta.max_range_km.toFixed(1)}km`);

  onProgress?.(30, "GPU 커버리지 계산 중...");

  // 2. GPU 1회 디스패치
  const result = await computeFromHeightmap(device, heightmapF32, meta, BEARING_STEP_DEG, altFts);

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
    ranges: result.ranges,
    maxRangeKm: result.maxRangeKm,
  };

  // 3. Worker에 전체 결과 전달 → 점진적 폴리곤 생성
  onProgress?.(70, "레이어 변환 중...");
  await initWorkerCache(_cache);

  // 점진적 렌더링: Worker에서 주요 고도 폴리곤 즉시 생성
  if (onProgressivePolygons) {
    const progressiveAlts = [500, 1000, 2000, 5000, 10000, 20000];
    const partialLayers = await computeLayersForAltitudesAsync(progressiveAlts, 10);
    const partialPolygons = await buildPolygonsAsync(partialLayers, radar.latitude, radar.longitude, 0, false);
    onProgressivePolygons(partialPolygons);
  }

  const repAlts = [500, 1000, 2000, 3000, 5000, 10000, 15000, 20000, 25000, 30000];
  const layers = await computeLayersForAltitudesAsync(repAlts, 1);

  // IndexedDB에 비동기 저장
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
 * 캐시에서 특정 고도 레이어 추출 (슬라이더용, 동기)
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

/** 커버리지 캐시 보유 여부 */
export function hasCoverageCache(): boolean {
  return !!_cache?.ranges;
}

/** @deprecated Use hasCoverageCache instead */
export const hasSurfaceAngles = hasCoverageCache;

// ─── 공개 API: 3D 커버리지 면 ──────────────────────

/** 3D 커버리지 면 quad 타입 */
export interface Coverage3DQuad {
  polygon: [number, number, number][]; // 4개 꼭짓점 [lon, lat, altM]
  fillColor: [number, number, number];
  altFt: number;
}

/**
 * 3D 커버리지 면 생성 (Worker 비동기)
 */
export async function build3DSurfaceAsync(): Promise<Coverage3DQuad[]> {
  if (!_cache || !_workerReady || !_cache.maxRangeKm) return [];
  const result = await workerSend({
    type: "BUILD_3D_SURFACE",
    maxRangeKm: _cache.maxRangeKm,
    surfaceRayStride: 100,
    surfaceDistSteps: 240,
  });
  return result.quads;
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
 * OM 보고서용 커버리지 레이어 계산 (heightmap 방식)
 * - 건물 포함/제외 각각 heightmap 1회 + GPU 1회 = 총 2회 IPC
 */
export async function computeCoverageLayersOM(
  params: CoverageOMParams,
  altFts: number[],
  excludeManualIds: number[],
  onProgress?: (msg: string) => void,
): Promise<{ layersWith: CoverageLayer[]; layersWithout: CoverageLayer[] }> {
  const device = await getGPUDevice();

  const totalRays = Math.floor(360 / params.bearingStepDeg);
  console.log(`[Coverage OM] Heightmap 모드, ${params.bearingStepDeg}° (${totalRays} rays)`);

  // 건물 포함
  onProgress?.(`Heightmap 생성 중... ${params.radarName} (건물 포함)`);
  const { heightmapF32: hmWith, meta: metaWith } = await fetchHeightmap(
    params.radarLat, params.radarLon,
    params.radarAltitude, params.antennaHeight,
    params.rangeNm,
  );

  onProgress?.(`GPU 커버리지 계산 중... ${params.radarName} (건물 포함)`);
  const withResult = await computeFromHeightmap(device, hmWith, metaWith, params.bearingStepDeg, altFts);
  const withCache: GPUCoverageCache = {
    radarKey: "",
    radarLat: params.radarLat,
    radarLon: params.radarLon,
    radarAltitude: params.radarAltitude,
    antennaHeight: params.antennaHeight,
    bearingStepDeg: params.bearingStepDeg,
    totalRays,
    altFts,
    ranges: withResult.ranges,
  };
  const layersWith = buildLayers(withCache, altFts, 1);

  // 건물 제외
  onProgress?.(`Heightmap 생성 중... ${params.radarName} (건물 제외)`);
  const { heightmapF32: hmWithout, meta: metaWithout } = await fetchHeightmap(
    params.radarLat, params.radarLon,
    params.radarAltitude, params.antennaHeight,
    params.rangeNm,
    excludeManualIds,
  );

  onProgress?.(`GPU 커버리지 계산 중... ${params.radarName} (건물 제외)`);
  const withoutResult = await computeFromHeightmap(device, hmWithout, metaWithout, params.bearingStepDeg, altFts);
  const withoutCache: GPUCoverageCache = { ...withCache, ranges: withoutResult.ranges };
  const layersWithout = buildLayers(withoutCache, altFts, 1);

  return { layersWith, layersWithout };
}
