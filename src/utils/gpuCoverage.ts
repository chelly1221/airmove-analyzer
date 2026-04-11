/**
 * WebGPU 커버리지 맵 가속 (0.001° 고해상도, 360,000 rays)
 *
 * 아키텍처 (다중 해상도 heightmap):
 *   Phase 1: Rust — 밴드별 SRTM + 건물 → 2D heightmap (ENU 그리드, 밴드당 1회 IPC)
 *   Phase 2: GPU — 밴드 순차 처리: heightmap 업로드 → Pass1(해당 거리 구간) → 해제
 *   Phase 3: GPU — Pass2: 전체 max_angles 완성 후 고도별 이진 탐색
 *   Phase 4: Worker — buildLayers + 래스터 렌더링 (UI 논블로킹)
 *
 * 밴드별 해상도 (거리별 가변):
 *   0~3km: 1m, 3~6km: 1m, 6~9km: 1m, 9~12km: 1m, 12~15km: 1m
 *   15~20km: 2m, 20~25km: 3m, 25~30km: 4m, 30km+: 30m
 *   GPU 버퍼 한도 초과 시 자동 해상도 조정
 */

import { invoke } from "@tauri-apps/api/core";
import { getGPUDevice, createBuffer, readBuffer, runComputeShader } from "./gpuCompute";
import type { CoverageLayer, CoverageBearing, MultiCoverageResult } from "./radarCoverage";
import type { RadarSite } from "../types";

// ─── 상수 ───────────────────────────────────────────

const BEARING_STEP_DEG = 0.001;  // 360,000 rays
const MAX_ELEV_DEG = 40;
const FT_TO_M = 0.3048;
const IDB_NAME = "coverage-cache";
const IDB_STORE = "ranges";
const IDB_VERSION = 5;  // bumped: multi-band heightmap + cache invalidation
const NUM_SAMPLES = 2400; // 레이당 거리 샘플 수

// ─── 다중 해상도 밴드 설정 ──────────────────────────

interface BandSpec {
  innerKm: number;
  outerKm: number;  // -1 = radar max range
  targetPixelM: number;
}

/** 밴드 0을 1km 단위 분할 (0~15km, 1m) + 점진적 해상도 밴드 */
const BAND_SPECS: BandSpec[] = [
  // 0~15km: 1m 목표 (1km 단위 분할로 GPU 버퍼 한도 내 유지)
  { innerKm: 0,  outerKm: 1,  targetPixelM: 1 },
  { innerKm: 1,  outerKm: 2,  targetPixelM: 1 },
  { innerKm: 2,  outerKm: 3,  targetPixelM: 1 },
  { innerKm: 3,  outerKm: 4,  targetPixelM: 1 },
  { innerKm: 4,  outerKm: 5,  targetPixelM: 1 },
  { innerKm: 5,  outerKm: 6,  targetPixelM: 1 },
  { innerKm: 6,  outerKm: 7,  targetPixelM: 1 },
  { innerKm: 7,  outerKm: 8,  targetPixelM: 1 },
  { innerKm: 8,  outerKm: 9,  targetPixelM: 1 },
  { innerKm: 9,  outerKm: 10, targetPixelM: 1 },
  { innerKm: 10, outerKm: 11, targetPixelM: 1 },
  { innerKm: 11, outerKm: 12, targetPixelM: 1 },
  { innerKm: 12, outerKm: 13, targetPixelM: 1 },
  { innerKm: 13, outerKm: 14, targetPixelM: 1 },
  { innerKm: 14, outerKm: 15, targetPixelM: 1 },
  // 15~30km: 점진적 해상도
  { innerKm: 15, outerKm: 20, targetPixelM: 2 },
  { innerKm: 20, outerKm: 25, targetPixelM: 3 },
  { innerKm: 25, outerKm: 30, targetPixelM: 4 },
  // 30km+: 원거리
  { innerKm: 30, outerKm: -1, targetPixelM: 30 },
];

/** GPU 버퍼 한도가 실질 제한 — base64 IPC는 V8 문자열 ~1GB까지 가능 */
const MAX_F32_BYTES = 1_500_000_000; // 1.5GB (GPU 2GB 한도 내에서 여유분 확보)

function effectivePixelSize(
  outerKm: number,
  targetPixelM: number,
  maxGpuBufferBytes: number,
): number {
  const extent = 2 * outerKm * 1000; // 전체 범위 (m)
  const dim = Math.ceil(extent / targetPixelM);
  const bytes = dim * dim * 4;
  const maxBytes = Math.min(MAX_F32_BYTES, maxGpuBufferBytes);
  if (bytes <= maxBytes) return targetPixelM;
  // 한도에 맞는 최소 pixel size
  const maxDim = Math.floor(Math.sqrt(maxBytes / 4));
  return Math.ceil(extent / maxDim);
}

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
// 밴드 순차 처리: sample_start~sample_end 구간만 처리, 이전 밴드의 running max 이어받기
const HEIGHTMAP_PASS1_SHADER = /* wgsl */ `
const R_EFF_M: f32 = 8494666.7; // 4/3 유효지구 반경 (6371000 * 4/3)
const PI: f32 = 3.14159265358979;

struct Params {
  radar_height_m: f32,
  max_range_km: f32,
  num_samples: u32,
  bearing_step_deg: f32,
  pixel_size_m: f32,
  hm_width: u32,
  hm_height: u32,
  sample_start: u32,
  sample_end: u32,
  ray_offset: u32,
  batch_rays: u32,
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
  let ray = gid.x; // 배치 내 로컬 인덱스
  if (ray >= params.batch_rays) { return; }

  let global_ray = ray + params.ray_offset; // 전체 레이 인덱스
  let bearing_rad = f32(global_ray) * params.bearing_step_deg * PI / 180.0;
  let sin_b = sin(bearing_rad);
  let cos_b = cos(bearing_rad);
  let base = ray * params.num_samples;

  // 이전 밴드의 running max 이어받기
  var running_max: f32 = -1e10;
  if (params.sample_start > 0u) {
    running_max = max_angles[base + params.sample_start - 1u];
  }

  for (var s = params.sample_start; s < params.sample_end; s++) {
    let dist_m = (f32(s + 1u) / f32(params.num_samples)) * params.max_range_km * 1000.0;

    // polar → ENU
    let east_m = dist_m * sin_b;
    let north_m = dist_m * cos_b;

    let elev = sample_hm(east_m, north_m);

    // 곡률 보정
    let curv_drop = dist_m * dist_m / (2.0 * R_EFF_M);
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
const R_EFF_M: f32 = 8494666.7; // 4/3 유효지구 반경 (6371000 * 4/3)
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
  ray_offset: u32,
  batch_rays: u32,
  _pad1: u32,
  _pad2: u32,
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
  if (gid.x >= params.batch_rays * params.num_altitudes) { return; }
  let ray = gid.x / params.num_altitudes; // 배치 내 로컬 인덱스
  let alt_idx = gid.x % params.num_altitudes;
  let alt_m = alt_fts[alt_idx] * FT_TO_M;
  let base = ray * params.num_samples;
  let n = params.num_samples;
  let max_range = params.max_range_km;

  let global_ray = ray + params.ray_offset; // 전체 레이 인덱스
  let bearing_rad = f32(global_ray) * params.bearing_step_deg * PI / 180.0;
  let sin_b = sin(bearing_rad);
  let cos_b = cos(bearing_rad);

  // 이진 탐색: max_angles에서 LoS 차단점
  var los_block: u32 = n;
  var lo: u32 = 1u;
  var hi: u32 = n - 1u;
  while (lo <= hi) {
    let mid = (lo + hi) / 2u;
    let dist = (f32(mid + 1u) / f32(n)) * max_range * 1000.0;
    let curv_drop = dist * dist / (2.0 * R_EFF_M);
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
    let curv_drop = dist * dist / (2.0 * R_EFF_M);
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

/** Base64 디코딩을 별도 Worker 스레드에서 수행 (메인 스레드 blocking 방지) */
function decodeBase64OffThread(base64: string): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const code = `self.onmessage=function(e){try{var b=atob(e.data),n=b.length,u=new Uint8Array(n);for(var i=0;i<n;i++)u[i]=b.charCodeAt(i);postMessage(u.buffer,[u.buffer])}catch(err){postMessage({error:String(err)})}}`;
    const blob = new Blob([code], { type: "text/javascript" });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    w.onmessage = (e) => {
      if (e.data instanceof ArrayBuffer) resolve(e.data);
      else reject(new Error(e.data?.error ?? "Base64 decode failed"));
      w.terminate();
      URL.revokeObjectURL(url);
    };
    w.onerror = (err) => { reject(err); w.terminate(); URL.revokeObjectURL(url); };
    w.postMessage(base64);
  });
}

/** 밴드 1개의 heightmap 가져오기 */
async function fetchBandHeightmap(
  radarLat: number, radarLon: number,
  radarAltitude: number, antennaHeight: number,
  outerKm: number, pixelSizeM: number,
  excludeManualIds?: number[],
): Promise<{ heightmapF32: Float32Array; meta: HeightmapResult }> {
  const rangeNm = outerKm / 1.852;
  const meta = await invoke<HeightmapResult>("build_heightmap", {
    radarLat, radarLon, radarAltitude, antennaHeight, rangeNm,
    pixelSizeM: pixelSizeM,
    excludeManualIds,
  });
  const ab = await decodeBase64OffThread(meta.data_b64);
  meta.data_b64 = "";
  const heightmapF32 = new Float32Array(ab);
  return { heightmapF32, meta };
}

// ─── GPU 계산 (다중 해상도 밴드 순차 처리) ───────────

interface CoverageGPUResult {
  ranges: Float32Array; // totalRays × numAlts
  maxRangeKm: number;
}

/** 이벤트 루프 양보 — 무거운 동기 작업 사이에 삽입하여 UI 프리징 방지 */
const yieldToUI = () => new Promise<void>(r => setTimeout(r, 0));

/**
 * 다중 해상도 밴드 순차 GPU 처리
 * 각 밴드: heightmap 업로드 → Pass1(해당 거리 구간) → heightmap 해제
 * 전체 밴드 완료 후 Pass2 실행 (고도별 이진 탐색)
 */
async function computeMultiBand(
  device: GPUDevice,
  radar: RadarSite,
  maxRangeKm: number,
  bearingStepDeg: number,
  altFts: number[],
  onProgress?: (pct: number, msg: string) => void,
  excludeManualIds?: number[],
): Promise<CoverageGPUResult> {
  const totalRays = Math.floor(360 / bearingStepDeg);
  const numAlts = altFts.length;
  const maxWorkgroups = device.limits.maxComputeWorkgroupsPerDimension;
  const maxGpuBuf = device.limits.maxStorageBufferBindingSize;

  // 레이 배치: max_angles 버퍼가 GPU 한도 내에 들어오도록 분할
  const maxAnglesPerBatch = Math.floor(maxGpuBuf / (NUM_SAMPLES * 4));
  const rayBatchSize = Math.min(totalRays, Math.max(1024, maxAnglesPerBatch));
  const numBatches = Math.ceil(totalRays / rayBatchSize);

  console.log(`[Coverage Multi-Band] ════════════════════════════════════`);
  console.log(`[Coverage Multi-Band] 총 ${totalRays.toLocaleString()} rays (${bearingStepDeg}°), ${NUM_SAMPLES} samples/ray`);
  console.log(`[Coverage Multi-Band] GPU maxStorageBufferBindingSize: ${(maxGpuBuf / 1024 / 1024).toFixed(0)} MB`);
  console.log(`[Coverage Multi-Band] GPU maxBufferSize: ${(device.limits.maxBufferSize / 1024 / 1024).toFixed(0)} MB`);
  console.log(`[Coverage Multi-Band] 레이 배치: ${numBatches}개 × ${rayBatchSize.toLocaleString()} rays`);
  console.log(`[Coverage Multi-Band] max_angles/batch: ${((rayBatchSize * NUM_SAMPLES * 4) / 1024 / 1024).toFixed(0)} MB`);

  // 밴드별 실제 해상도 계산
  const bands = BAND_SPECS.map((spec) => {
    const outerKm = spec.outerKm < 0 ? maxRangeKm : spec.outerKm;
    if (outerKm > maxRangeKm) return null; // 레이더 범위 밖 밴드 제외
    const pixelM = effectivePixelSize(outerKm, spec.targetPixelM, maxGpuBuf);
    const sampleStart = Math.floor((spec.innerKm / maxRangeKm) * NUM_SAMPLES);
    const sampleEnd = Math.min(NUM_SAMPLES, Math.ceil((outerKm / maxRangeKm) * NUM_SAMPLES));
    return { ...spec, outerKm, pixelM, sampleStart, sampleEnd };
  }).filter(Boolean) as Array<BandSpec & { outerKm: number; pixelM: number; sampleStart: number; sampleEnd: number }>;

  console.log(`[Coverage Multi-Band] ── 밴드 설정 (${bands.length}개) ──`);
  for (const b of bands) {
    const dim = Math.ceil(2 * b.outerKm * 1000 / b.pixelM);
    const hmMB = (dim * dim * 4 / 1024 / 1024).toFixed(0);
    const adjusted = b.pixelM !== b.targetPixelM ? ` ⚠ 조정됨(target ${b.targetPixelM}m)` : "";
    console.log(`[Coverage Multi-Band]   ${b.innerKm}~${b.outerKm}km: ${b.pixelM}m/px, ${dim}×${dim} (${hmMB} MB), samples ${b.sampleStart}~${b.sampleEnd}${adjusted}`);
  }
  console.log(`[Coverage Multi-Band] ════════════════════════════════════`);
  const totalStartTime = performance.now();

  // 최종 출력 버퍼 (CPU 측, 배치별 결과 누적)
  const finalRanges = new Float32Array(totalRays * numAlts);
  const pass1Workgroups = Math.min(Math.ceil(rayBatchSize / 64), maxWorkgroups);

  for (let batch = 0; batch < numBatches; batch++) {
    const rayStart = batch * rayBatchSize;
    const rayEnd = Math.min(rayStart + rayBatchSize, totalRays);
    const batchRays = rayEnd - rayStart;

    // max_angles 버퍼 (이 배치 전용)
    const maxAnglesSize = batchRays * NUM_SAMPLES * 4;
    const maxAnglesBuf = device.createBuffer({
      size: maxAnglesSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // ── 밴드별 Pass 1 ──
    for (let bi = 0; bi < bands.length; bi++) {
      const band = bands[bi];
      if (band.sampleStart >= band.sampleEnd) continue;

      const bandPct = Math.round(((batch * bands.length + bi) / (numBatches * bands.length)) * 60) + 5;
      onProgress?.(bandPct, `Band ${band.innerKm}~${band.outerKm}km (${band.pixelM}m) 처리 중...`);

      // Heightmap 가져오기 + GPU 업로드
      const bandStart = performance.now();
      const { heightmapF32, meta } = await fetchBandHeightmap(
        radar.latitude, radar.longitude,
        radar.altitude, radar.antenna_height,
        band.outerKm, band.pixelM,
        excludeManualIds,
      );
      const fetchMs = performance.now() - bandStart;
      console.log(`[Coverage Multi-Band]   Band ${band.innerKm}~${band.outerKm}km: Rust heightmap ${meta.width}×${meta.height} (${(heightmapF32.byteLength / 1024 / 1024).toFixed(1)} MB) 수신 ${fetchMs.toFixed(0)}ms`);

      const hmBuf = device.createBuffer({
        size: heightmapF32.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(hmBuf, 0, heightmapF32);

      // Pass 1 uniform (48 bytes = 12 × u32/f32)
      const p1Buf = new ArrayBuffer(48);
      const p1F32 = new Float32Array(p1Buf);
      const p1U32 = new Uint32Array(p1Buf);
      p1F32[0] = meta.radar_height_m;
      p1F32[1] = maxRangeKm;
      p1U32[2] = NUM_SAMPLES;
      p1F32[3] = bearingStepDeg;
      p1F32[4] = meta.pixel_size_m;
      p1U32[5] = meta.width;
      p1U32[6] = meta.height;
      p1U32[7] = band.sampleStart;
      p1U32[8] = band.sampleEnd;
      p1U32[9] = rayStart;   // ray_offset
      p1U32[10] = batchRays; // batch_rays
      p1U32[11] = 0;         // _pad
      const uniformBuf = createBuffer(device, new Float32Array(p1Buf), GPUBufferUsage.UNIFORM);

      await runComputeShader(device, HEIGHTMAP_PASS1_SHADER, [
        { buffer: uniformBuf, type: "uniform" },
        { buffer: hmBuf, type: "read-only-storage" },
        { buffer: maxAnglesBuf, type: "storage" },
      ], [pass1Workgroups, 1, 1]);

      // Heightmap 즉시 해제
      uniformBuf.destroy();
      hmBuf.destroy();
      const bandElapsed = performance.now() - bandStart;
      console.log(`[Coverage Multi-Band]   Band ${band.innerKm}~${band.outerKm}km: Pass1 완료 (총 ${bandElapsed.toFixed(0)}ms)`);
      await yieldToUI();
    }

    // ── Pass 2: 이 배치의 고도별 이진 탐색 ──
    onProgress?.(65 + Math.round((batch / numBatches) * 20), "고도별 범위 계산 중...");

    // Pass 2에서 heightmap이 필요한데 (terrain_block 선형 탐색), 마지막 밴드(전체 범위)를 사용
    const lastBand = bands[bands.length - 1];
    const { heightmapF32: lastHm, meta: lastMeta } = await fetchBandHeightmap(
      radar.latitude, radar.longitude,
      radar.altitude, radar.antenna_height,
      lastBand.outerKm, lastBand.pixelM,
      excludeManualIds,
    );
    const lastHmBuf = device.createBuffer({
      size: lastHm.byteLength,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
    });
    device.queue.writeBuffer(lastHmBuf, 0, lastHm);

    const p2Buf = new ArrayBuffer(48);
    const p2F32 = new Float32Array(p2Buf);
    const p2U32 = new Uint32Array(p2Buf);
    p2F32[0] = lastMeta.radar_height_m;
    p2F32[1] = maxRangeKm;
    p2U32[2] = NUM_SAMPLES;
    p2U32[3] = numAlts;
    p2F32[4] = bearingStepDeg;
    p2F32[5] = lastMeta.pixel_size_m;
    p2U32[6] = lastMeta.width;
    p2U32[7] = lastMeta.height;
    p2U32[8] = rayStart;   // ray_offset
    p2U32[9] = batchRays;  // batch_rays
    p2U32[10] = 0;         // _pad1
    p2U32[11] = 0;         // _pad2
    const uniformBuf2 = createBuffer(device, new Float32Array(p2Buf), GPUBufferUsage.UNIFORM);

    const altBuf = createBuffer(device, new Float32Array(altFts), GPUBufferUsage.STORAGE);
    const outSize = batchRays * numAlts * 4;
    const outputBuf = device.createBuffer({
      size: outSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const pass2Workgroups = Math.min(Math.ceil((batchRays * numAlts) / 64), maxWorkgroups);

    await runComputeShader(device, HEIGHTMAP_PASS2_SHADER, [
      { buffer: uniformBuf2, type: "uniform" },
      { buffer: lastHmBuf, type: "read-only-storage" },
      { buffer: maxAnglesBuf, type: "read-only-storage" },
      { buffer: altBuf, type: "read-only-storage" },
      { buffer: outputBuf, type: "storage" },
    ], [pass2Workgroups, 1, 1]);

    // 결과 읽기 + 최종 버퍼에 복사
    const batchRanges = await readBuffer(device, outputBuf, outSize);
    finalRanges.set(batchRanges, rayStart * numAlts);

    // 배치 버퍼 정리
    uniformBuf2.destroy();
    lastHmBuf.destroy();
    maxAnglesBuf.destroy();
    altBuf.destroy();
    outputBuf.destroy();
    console.log(`[Coverage Multi-Band] Batch ${batch + 1}/${numBatches} 완료 (rays ${rayStart}~${rayEnd})`);
    await yieldToUI();
  }

  const totalElapsed = performance.now() - totalStartTime;
  console.log(`[Coverage Multi-Band] ════════════════════════════════════`);
  console.log(`[Coverage Multi-Band] 전체 완료: ${(totalElapsed / 1000).toFixed(1)}초`);
  console.log(`[Coverage Multi-Band] 결과: ${totalRays.toLocaleString()} rays × ${numAlts} alts = ${(finalRanges.byteLength / 1024 / 1024).toFixed(0)} MB`);
  console.log(`[Coverage Multi-Band] ════════════════════════════════════`);
  return { ranges: finalRanges, maxRangeKm };
}

// ─── OM 보고서용 단일 heightmap 함수 (레거시) ───────

/** 단일 heightmap 가져오기 (OM 보고서용) */
async function fetchHeightmap(
  radarLat: number, radarLon: number,
  radarAltitude: number, antennaHeight: number,
  rangeNm: number,
  excludeManualIds?: number[],
): Promise<{ heightmapF32: Float32Array; meta: HeightmapResult }> {
  const meta = await invoke<HeightmapResult>("build_heightmap", {
    radarLat, radarLon, radarAltitude, antennaHeight, rangeNm,
    pixelSizeM: 100, // OM 보고서는 기존 100m 해상도 유지
    excludeManualIds,
  });
  const ab = await decodeBase64OffThread(meta.data_b64);
  meta.data_b64 = "";
  const heightmapF32 = new Float32Array(ab);
  return { heightmapF32, meta };
}

/** 단일 heightmap GPU 계산 (OM 보고서용 — Pass1 전체 범위 + Pass2) */
async function computeFromHeightmap(
  device: GPUDevice,
  heightmapF32: Float32Array,
  meta: HeightmapResult,
  bearingStepDeg: number,
  altFts: number[],
): Promise<CoverageGPUResult> {
  const totalRays = Math.floor(360 / bearingStepDeg);
  const numAlts = altFts.length;

  const hmBuf = device.createBuffer({
    size: heightmapF32.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(hmBuf, 0, heightmapF32);
  await yieldToUI();

  // Pass 1 (전체 범위)
  const p1Buf = new ArrayBuffer(48);
  const p1F32 = new Float32Array(p1Buf);
  const p1U32 = new Uint32Array(p1Buf);
  p1F32[0] = meta.radar_height_m;
  p1F32[1] = meta.max_range_km;
  p1U32[2] = NUM_SAMPLES;
  p1F32[3] = bearingStepDeg;
  p1F32[4] = meta.pixel_size_m;
  p1U32[5] = meta.width;
  p1U32[6] = meta.height;
  p1U32[7] = 0; // sample_start
  p1U32[8] = NUM_SAMPLES; // sample_end
  p1U32[9] = 0;            // ray_offset
  p1U32[10] = totalRays;   // batch_rays
  p1U32[11] = 0;
  const uniformBuf1 = createBuffer(device, new Float32Array(p1Buf), GPUBufferUsage.UNIFORM);

  const maxAnglesSize = totalRays * NUM_SAMPLES * 4;
  const maxAnglesBuf = device.createBuffer({
    size: maxAnglesSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const maxWorkgroups = device.limits.maxComputeWorkgroupsPerDimension;
  await runComputeShader(device, HEIGHTMAP_PASS1_SHADER, [
    { buffer: uniformBuf1, type: "uniform" },
    { buffer: hmBuf, type: "read-only-storage" },
    { buffer: maxAnglesBuf, type: "storage" },
  ], [Math.min(Math.ceil(totalRays / 64), maxWorkgroups), 1, 1]);
  await yieldToUI();

  // Pass 2
  const p2Buf = new ArrayBuffer(48);
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
  p2U32[8] = 0;          // ray_offset
  p2U32[9] = totalRays;  // batch_rays
  p2U32[10] = 0;
  p2U32[11] = 0;
  const uniformBuf2 = createBuffer(device, new Float32Array(p2Buf), GPUBufferUsage.UNIFORM);

  const altBuf = createBuffer(device, new Float32Array(altFts), GPUBufferUsage.STORAGE);
  const outSize = totalRays * numAlts * 4;
  const outputBuf = device.createBuffer({
    size: outSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  await runComputeShader(device, HEIGHTMAP_PASS2_SHADER, [
    { buffer: uniformBuf2, type: "uniform" },
    { buffer: hmBuf, type: "read-only-storage" },
    { buffer: maxAnglesBuf, type: "read-only-storage" },
    { buffer: altBuf, type: "read-only-storage" },
    { buffer: outputBuf, type: "storage" },
  ], [Math.min(Math.ceil((totalRays * numAlts) / 64), maxWorkgroups), 1, 1]);
  await yieldToUI();

  const ranges = await readBuffer(device, outputBuf, outSize);

  uniformBuf1.destroy();
  uniformBuf2.destroy();
  hmBuf.destroy();
  maxAnglesBuf.destroy();
  altBuf.destroy();
  outputBuf.destroy();
  await yieldToUI();

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
  const copy = new Float32Array(cache.ranges); // ~41MB 복사
  await yieldToUI(); // 대량 복사 후 UI 양보
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

// ─── 커버리지 이미지 렌더링 ─────────────────────────

/** Worker에서 커버리지를 래스터 이미지로 렌더링 (OffscreenCanvas → ImageBitmap) */
export interface CoverageImageResult {
  image: ImageBitmap;
  bounds: [number, number, number, number]; // [west, south, east, north]
}

export async function renderCoverageImageAsync(
  altFts: number[],
  showCone: boolean,
  viewport?: { width: number; height: number; west: number; south: number; east: number; north: number },
): Promise<CoverageImageResult | null> {
  if (!_workerReady) return null;
  const result = await workerSend({
    type: "RENDER_COVERAGE_IMAGE",
    altFts,
    showCone,
    viewport,
  });
  return { image: result.image, bounds: result.bounds };
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
 * 메인 커버리지맵 계산 (WebGPU + heightmap, 0.001° 해상도, 360,000 rays)
 * - Rust에서 2D heightmap 1회 수신 → GPU에서 전체 가시선 1회 계산
 */
export async function computeMainCoverage(
  radar: RadarSite,
  onProgress?: (pct: number, msg: string) => void,
): Promise<MultiCoverageResult> {
  const key = cacheKey(radar);

  // IndexedDB 캐시 확인
  onProgress?.(1, "캐시 확인 중...");
  const idbCache = await loadFromIDB(key);
  if (idbCache) {
    console.log("[Coverage] IndexedDB 캐시 복원 (다중 해상도 재계산 건너뜀)");
    _cache = idbCache;
    await yieldToUI(); // IDB 로드 후 UI 양보

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

  // GPU 다중 해상도 밴드 계산
  const device = await getGPUDevice();

  const altFts: number[] = [];
  for (let alt = 100; alt <= 30000; alt += 100) altFts.push(alt);

  const totalRays = Math.floor(360 / BEARING_STEP_DEG);
  const maxRangeKm = radar.range_nm * 1.852;

  onProgress?.(2, "다중 해상도 커버리지 계산 시작...");

  const result = await computeMultiBand(
    device, radar, maxRangeKm, BEARING_STEP_DEG, altFts,
    onProgress,
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
    ranges: result.ranges,
    maxRangeKm: result.maxRangeKm,
  };

  // 3. Worker에 캐시 전달
  onProgress?.(70, "Worker 캐시 초기화 중...");
  await initWorkerCache(_cache);

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

/** 캐시 무효화 (세션 + IDB) */
export function invalidateGPUCache(): void {
  _cache = null;
  _workerReady = false;
  // IDB 캐시도 삭제
  try {
    const req = indexedDB.open(IDB_NAME, IDB_VERSION);
    req.onsuccess = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(IDB_STORE)) {
        const tx = db.transaction(IDB_STORE, "readwrite");
        tx.objectStore(IDB_STORE).clear();
      }
      db.close();
    };
  } catch { /* ignore */ }
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
