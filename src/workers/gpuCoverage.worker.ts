/**
 * GPU 커버리지 계산 전용 Worker
 *
 * 메인 스레드의 UI 블로킹을 완전히 제거하기 위해,
 * WebGPU 디바이스 초기화·셰이더 실행·버퍼 관리를 모두 이 Worker에서 수행한다.
 *
 * 메인 스레드와의 통신:
 *   Main → Worker:
 *     COMPUTE          — 다중 해상도 커버리지 계산 시작
 *     COMPUTE_OM       — OM 보고서용 단일 heightmap 계산
 *     HEIGHTMAP_DATA   — 요청한 heightmap 바이너리 (Transfer)
 *     ABORT            — 진행 중인 계산 중단
 *
 *   Worker → Main:
 *     GPU_READY        — GPU 디바이스 초기화 완료 + limits 보고
 *     NEED_HEIGHTMAP   — heightmap 요청 (메인에서 Rust IPC 호출 필요)
 *     PROGRESS         — 진행률
 *     RESULT           — 계산 완료, ranges Transfer
 *     OM_RESULT        — OM 계산 완료
 *     ERROR            — 에러
 */

// ─── 상수 ───────────────────────────────────────────

const BEARING_STEP_DEG = 0.001; // 360,000 rays
const NUM_SAMPLES = 2400;

// ─── HeightmapResult 타입 ───────────────────────────

interface HeightmapMeta {
  width: number;
  height: number;
  pixel_size_m: number;
  center_lat: number;
  center_lon: number;
  radar_height_m: number;
  max_range_km: number;
}

interface BandInfo {
  innerKm: number;
  outerKm: number;
  pixelM: number;
  sampleStart: number;
  sampleEnd: number;
  isLast: boolean;
}

// ─── WGSL Compute Shader ────────────────────────────

const HEIGHTMAP_PASS1_SHADER = /* wgsl */ `
const R_EFF_M: f32 = 8494666.7;
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
  if (ray >= params.batch_rays) { return; }
  let global_ray = ray + params.ray_offset;
  let bearing_rad = f32(global_ray) * params.bearing_step_deg * PI / 180.0;
  let sin_b = sin(bearing_rad);
  let cos_b = cos(bearing_rad);
  let base = ray * params.num_samples;
  var running_max: f32 = -1e10;
  if (params.sample_start > 0u) {
    running_max = max_angles[base + params.sample_start - 1u];
  }
  for (var s = params.sample_start; s < params.sample_end; s++) {
    let dist_m = (f32(s + 1u) / f32(params.num_samples)) * params.max_range_km * 1000.0;
    let east_m = dist_m * sin_b;
    let north_m = dist_m * cos_b;
    let elev = sample_hm(east_m, north_m);
    let curv_drop = dist_m * dist_m / (2.0 * R_EFF_M);
    let adj = elev - curv_drop;
    let angle = (adj - params.radar_height_m) / dist_m;
    if (angle > running_max) { running_max = angle; }
    max_angles[base + s] = running_max;
  }
}
`;

const HEIGHTMAP_PASS2_SHADER = /* wgsl */ `
const R_EFF_M: f32 = 8494666.7;
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
  let ray = gid.x / params.num_altitudes;
  let alt_idx = gid.x % params.num_altitudes;
  let alt_m = alt_fts[alt_idx] * FT_TO_M;
  let base = ray * params.num_samples;
  let n = params.num_samples;
  let max_range = params.max_range_km;
  let global_ray = ray + params.ray_offset;
  let bearing_rad = f32(global_ray) * params.bearing_step_deg * PI / 180.0;
  let sin_b = sin(bearing_rad);
  let cos_b = cos(bearing_rad);
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

// ─── GPU 인프라 (Worker 내부 자체 보유) ─────────────

let _device: GPUDevice | null = null;
const _pipelineCache = new Map<string, { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout }>();

async function getDevice(): Promise<GPUDevice> {
  if (_device) return _device;

  const gpu = (self as any).navigator?.gpu;
  if (!gpu) throw new Error("Worker: WebGPU를 지원하지 않습니다");

  const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" });
  if (!adapter) throw new Error("Worker: GPU 어댑터를 찾을 수 없습니다");

  _device = await adapter.requestDevice({
    requiredLimits: {
      maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
      maxBufferSize: adapter.limits.maxBufferSize,
      maxComputeWorkgroupsPerDimension: adapter.limits.maxComputeWorkgroupsPerDimension,
    },
  });

  _device!.lost.then((info) => {
    console.warn(`[GPU Worker] Device lost: ${info.message}`);
    _pipelineCache.clear();
    _device = null;
  });

  console.log("[GPU Worker] Device initialized");
  return _device!;
}

function createBuffer(
  device: GPUDevice,
  data: Float32Array | Uint32Array,
  usage: GPUBufferUsageFlags,
): GPUBuffer {
  const buffer = device.createBuffer({
    size: data.byteLength,
    usage,
    mappedAtCreation: true,
  });
  if (data instanceof Float32Array) {
    new Float32Array(buffer.getMappedRange()).set(data);
  } else {
    new Uint32Array(buffer.getMappedRange()).set(data);
  }
  buffer.unmap();
  return buffer;
}

async function readBuffer(
  device: GPUDevice,
  buffer: GPUBuffer,
  size: number,
): Promise<Float32Array> {
  const readBuf = device.createBuffer({
    size,
    usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
  });
  const encoder = device.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer, 0, readBuf, 0, size);
  device.queue.submit([encoder.finish()]);
  await readBuf.mapAsync(GPUMapMode.READ);
  const result = new Float32Array(readBuf.getMappedRange().slice(0));
  readBuf.unmap();
  readBuf.destroy();
  return result;
}

function getOrCreatePipeline(
  device: GPUDevice,
  shaderCode: string,
  bindingTypes: GPUBufferBindingType[],
): { pipeline: GPUComputePipeline; layout: GPUBindGroupLayout } {
  const key = shaderCode.length + ":" + shaderCode.slice(0, 64) + "|" + bindingTypes.join(",");
  const cached = _pipelineCache.get(key);
  if (cached) return cached;

  const module = device.createShaderModule({ code: shaderCode });
  const entries: GPUBindGroupLayoutEntry[] = bindingTypes.map((type, i) => ({
    binding: i,
    visibility: GPUShaderStage.COMPUTE,
    buffer: { type },
  }));
  const layout = device.createBindGroupLayout({ entries });
  const pipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [layout] });
  const pipeline = device.createComputePipeline({
    layout: pipelineLayout,
    compute: { module, entryPoint: "main" },
  });

  const result = { pipeline, layout };
  _pipelineCache.set(key, result);
  return result;
}

async function runShader(
  device: GPUDevice,
  shaderCode: string,
  bindings: { buffer: GPUBuffer; type: GPUBufferBindingType }[],
  workgroupCount: [number, number, number],
): Promise<void> {
  const { pipeline, layout } = getOrCreatePipeline(
    device, shaderCode, bindings.map(b => b.type),
  );
  const bindGroup = device.createBindGroup({
    layout,
    entries: bindings.map((b, i) => ({ binding: i, resource: { buffer: b.buffer } })),
  });
  const encoder = device.createCommandEncoder();
  const pass = encoder.beginComputePass();
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.dispatchWorkgroups(...workgroupCount);
  pass.end();
  device.queue.submit([encoder.finish()]);
  await device.queue.onSubmittedWorkDone();
}

// ─── Heightmap 요청/수신 메커니즘 ───────────────────

/** 메인 스레드에 heightmap을 요청하고 바이너리 수신을 대기 */
let _hmResolve: ((data: { buffer: ArrayBuffer; meta: HeightmapMeta }) => void) | null = null;

function requestHeightmap(
  seq: number,
  outerKm: number,
  pixelM: number,
  excludeManualIds?: number[],
  isLast = false,
): Promise<{ buffer: ArrayBuffer; meta: HeightmapMeta }> {
  return new Promise((resolve) => {
    _hmResolve = resolve;
    self.postMessage({
      type: "NEED_HEIGHTMAP",
      seq, outerKm, pixelM, excludeManualIds, isLast,
    });
  });
}

// ─── Abort 관리 ─────────────────────────────────────

let _currentSeq = -1;
let _aborted = false;

function checkAbort(seq: number): void {
  if (_aborted || seq !== _currentSeq) {
    throw new Error("ABORTED");
  }
}

// ─── 다중 해상도 밴드 계산 (Worker 내부) ────────────

async function computeMultiBand(
  seq: number,
  maxRangeKm: number,
  bearingStepDeg: number,
  altFts: number[],
  bands: BandInfo[],
  _radarHeightM: number,
  excludeManualIds?: number[],
): Promise<Float32Array> {
  const device = await getDevice();
  const totalRays = Math.floor(360 / bearingStepDeg);
  const numAlts = altFts.length;
  const maxWorkgroups = device.limits.maxComputeWorkgroupsPerDimension;
  const maxGpuBuf = device.limits.maxStorageBufferBindingSize;

  // 레이 배치 분할
  const maxAnglesPerBatch = Math.floor(maxGpuBuf / (NUM_SAMPLES * 4));
  const rayBatchSize = Math.min(totalRays, Math.max(1024, maxAnglesPerBatch));
  const numBatches = Math.ceil(totalRays / rayBatchSize);

  console.log(`[GPU Worker] ${totalRays.toLocaleString()} rays, ${bands.length} bands, ${numBatches} batches`);

  const finalRanges = new Float32Array(totalRays * numAlts);
  const pass1Workgroups = Math.min(Math.ceil(rayBatchSize / 64), maxWorkgroups);

  // 마지막 밴드 heightmap 사전 요청 (Pass2 + Pass1 마지막 밴드 공유)
  const lastBand = bands[bands.length - 1];
  const { buffer: lastHmAB, meta: lastMeta } = await requestHeightmap(
    seq, lastBand.outerKm, lastBand.pixelM, excludeManualIds, true,
  );
  checkAbort(seq);
  const lastHm = new Float32Array(lastHmAB);
  console.log(`[GPU Worker] Pass2 heightmap: ${lastMeta.width}×${lastMeta.height} (${(lastHm.byteLength / 1024 / 1024).toFixed(1)} MB)`);

  for (let batch = 0; batch < numBatches; batch++) {
    const rayStart = batch * rayBatchSize;
    const rayEnd = Math.min(rayStart + rayBatchSize, totalRays);
    const batchRays = rayEnd - rayStart;

    const maxAnglesSize = batchRays * NUM_SAMPLES * 4;
    const maxAnglesBuf = device.createBuffer({
      size: maxAnglesSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    // ── 밴드별 Pass 1 ──
    for (let bi = 0; bi < bands.length; bi++) {
      checkAbort(seq);
      const band = bands[bi];
      if (band.sampleStart >= band.sampleEnd) continue;

      const pct = Math.round(((batch * bands.length + bi) / (numBatches * bands.length)) * 60) + 5;
      self.postMessage({ type: "PROGRESS", seq, pct, msg: `Band ${band.innerKm}~${band.outerKm}km (${band.pixelM}m)` });

      // heightmap 가져오기 (마지막 밴드는 사전 로드 재사용)
      let heightmapF32: Float32Array;
      let meta: HeightmapMeta;
      if (band.isLast) {
        heightmapF32 = lastHm;
        meta = lastMeta;
      } else {
        const result = await requestHeightmap(seq, band.outerKm, band.pixelM, excludeManualIds);
        checkAbort(seq);
        heightmapF32 = new Float32Array(result.buffer);
        meta = result.meta;
      }

      // GPU 업로드 + Pass1 실행
      const hmBuf = device.createBuffer({
        size: heightmapF32.byteLength,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
      });
      device.queue.writeBuffer(hmBuf, 0, heightmapF32);

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
      p1U32[9] = rayStart;
      p1U32[10] = batchRays;
      p1U32[11] = 0;
      const uniformBuf = createBuffer(device, new Float32Array(p1Buf), GPUBufferUsage.UNIFORM);

      await runShader(device, HEIGHTMAP_PASS1_SHADER, [
        { buffer: uniformBuf, type: "uniform" },
        { buffer: hmBuf, type: "read-only-storage" },
        { buffer: maxAnglesBuf, type: "storage" },
      ], [pass1Workgroups, 1, 1]);

      uniformBuf.destroy();
      hmBuf.destroy();
    }

    // ── Pass 2 ──
    checkAbort(seq);
    self.postMessage({ type: "PROGRESS", seq, pct: 65 + Math.round((batch / numBatches) * 20), msg: "고도별 범위 계산 중..." });

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
    p2U32[8] = rayStart;
    p2U32[9] = batchRays;
    p2U32[10] = 0;
    p2U32[11] = 0;
    const uniformBuf2 = createBuffer(device, new Float32Array(p2Buf), GPUBufferUsage.UNIFORM);

    const altBuf = createBuffer(device, new Float32Array(altFts), GPUBufferUsage.STORAGE);
    const outSize = batchRays * numAlts * 4;
    const outputBuf = device.createBuffer({
      size: outSize,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    const pass2Workgroups = Math.min(Math.ceil((batchRays * numAlts) / 64), maxWorkgroups);
    await runShader(device, HEIGHTMAP_PASS2_SHADER, [
      { buffer: uniformBuf2, type: "uniform" },
      { buffer: lastHmBuf, type: "read-only-storage" },
      { buffer: maxAnglesBuf, type: "read-only-storage" },
      { buffer: altBuf, type: "read-only-storage" },
      { buffer: outputBuf, type: "storage" },
    ], [pass2Workgroups, 1, 1]);

    const batchRanges = await readBuffer(device, outputBuf, outSize);
    finalRanges.set(batchRanges, rayStart * numAlts);

    uniformBuf2.destroy();
    lastHmBuf.destroy();
    maxAnglesBuf.destroy();
    altBuf.destroy();
    outputBuf.destroy();
    console.log(`[GPU Worker] Batch ${batch + 1}/${numBatches} done`);
  }

  return finalRanges;
}

// ─── OM 보고서용 단일 heightmap 계산 ────────────────

async function computeFromHeightmap(
  _seq: number,
  heightmapF32: Float32Array,
  meta: HeightmapMeta,
  bearingStepDeg: number,
  altFts: number[],
): Promise<Float32Array> {
  const device = await getDevice();
  const totalRays = Math.floor(360 / bearingStepDeg);
  const numAlts = altFts.length;
  const maxWorkgroups = device.limits.maxComputeWorkgroupsPerDimension;

  const hmBuf = device.createBuffer({
    size: heightmapF32.byteLength,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(hmBuf, 0, heightmapF32);

  // Pass 1
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
  p1U32[7] = 0;
  p1U32[8] = NUM_SAMPLES;
  p1U32[9] = 0;
  p1U32[10] = totalRays;
  p1U32[11] = 0;
  const uniformBuf1 = createBuffer(device, new Float32Array(p1Buf), GPUBufferUsage.UNIFORM);

  const maxAnglesSize = totalRays * NUM_SAMPLES * 4;
  const maxAnglesBuf = device.createBuffer({
    size: maxAnglesSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  await runShader(device, HEIGHTMAP_PASS1_SHADER, [
    { buffer: uniformBuf1, type: "uniform" },
    { buffer: hmBuf, type: "read-only-storage" },
    { buffer: maxAnglesBuf, type: "storage" },
  ], [Math.min(Math.ceil(totalRays / 64), maxWorkgroups), 1, 1]);

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
  p2U32[8] = 0;
  p2U32[9] = totalRays;
  p2U32[10] = 0;
  p2U32[11] = 0;
  const uniformBuf2 = createBuffer(device, new Float32Array(p2Buf), GPUBufferUsage.UNIFORM);

  const altBuf = createBuffer(device, new Float32Array(altFts), GPUBufferUsage.STORAGE);
  const outSize = totalRays * numAlts * 4;
  const outputBuf = device.createBuffer({
    size: outSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  await runShader(device, HEIGHTMAP_PASS2_SHADER, [
    { buffer: uniformBuf2, type: "uniform" },
    { buffer: hmBuf, type: "read-only-storage" },
    { buffer: maxAnglesBuf, type: "read-only-storage" },
    { buffer: altBuf, type: "read-only-storage" },
    { buffer: outputBuf, type: "storage" },
  ], [Math.min(Math.ceil((totalRays * numAlts) / 64), maxWorkgroups), 1, 1]);

  const ranges = await readBuffer(device, outputBuf, outSize);

  uniformBuf1.destroy();
  uniformBuf2.destroy();
  hmBuf.destroy();
  maxAnglesBuf.destroy();
  altBuf.destroy();
  outputBuf.destroy();

  return ranges;
}

// ═══════════════════════════════════════════════════
// 파노라마 GPU 계산
// ═══════════════════════════════════════════════════

const PANORAMA_HEIGHTMAP_SHADER = /* wgsl */ `
const R_EARTH: f32 = 6371000.0;
const RAD2DEG: f32 = 180.0 / 3.14159265358979;
const PI: f32 = 3.14159265358979;

struct Params {
  radar_height_m: f32,
  range_step_m: f32,
  num_steps: u32,
  num_azimuths: u32,
  azimuth_step_deg: f32,
  pixel_size_m: f32,
  hm_width: u32,
  hm_height: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> heightmap: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;

fn sample_hm_p(east_m: f32, north_m: f32) -> f32 {
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
  let az_idx = gid.x;
  if (az_idx >= params.num_azimuths) { return; }
  let bearing_rad = f32(az_idx) * params.azimuth_step_deg * PI / 180.0;
  let sin_b = sin(bearing_rad);
  let cos_b = cos(bearing_rad);
  var best_angle: f32 = -90.0;
  var best_step: u32 = 0u;
  var best_elev: f32 = 0.0;
  for (var s = 0u; s < params.num_steps; s++) {
    let d = f32(s + 1u) * params.range_step_m;
    let east_m = d * sin_b;
    let north_m = d * cos_b;
    let elev = sample_hm_p(east_m, north_m);
    let dh = elev - params.radar_height_m;
    let curv_drop = d * d / (2.0 * R_EARTH);
    let angle = atan((dh - curv_drop) / d) * RAD2DEG;
    if (angle > best_angle) {
      best_angle = angle;
      best_step = s + 1u;
      best_elev = elev;
    }
  }
  if (best_angle < -89.0) { best_angle = 0.0; }
  let out_base = az_idx * 4u;
  output[out_base] = best_angle;
  output[out_base + 1u] = f32(best_step);
  output[out_base + 2u] = best_elev;
  output[out_base + 3u] = 0.0;
}
`;

async function computePanorama(
  heightmapF32: Float32Array,
  meta: HeightmapMeta,
  radarHeightM: number,
  rangeStepM: number,
  azimuthStepDeg: number,
): Promise<Float32Array> {
  const device = await getDevice();
  const numAzimuths = Math.round(360 / azimuthStepDeg);
  const maxRangeM = meta.max_range_km * 1000;
  const numSteps = Math.floor(maxRangeM / rangeStepM);

  const hmBuf = createBuffer(device, heightmapF32, GPUBufferUsage.STORAGE);

  const paramsData = new ArrayBuffer(32);
  const pf = new Float32Array(paramsData);
  const pu = new Uint32Array(paramsData);
  pf[0] = radarHeightM;
  pf[1] = rangeStepM;
  pu[2] = numSteps;
  pu[3] = numAzimuths;
  pf[4] = azimuthStepDeg;
  pf[5] = meta.pixel_size_m;
  pu[6] = meta.width;
  pu[7] = meta.height;
  const uniformBuf = createBuffer(device, new Float32Array(paramsData), GPUBufferUsage.UNIFORM);

  const outputSize = numAzimuths * 4 * 4;
  const outputBuf = device.createBuffer({
    size: outputSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  const workgroups = Math.ceil(numAzimuths / 64);
  await runShader(device, PANORAMA_HEIGHTMAP_SHADER, [
    { buffer: uniformBuf, type: "uniform" },
    { buffer: hmBuf, type: "read-only-storage" },
    { buffer: outputBuf, type: "storage" },
  ], [workgroups, 1, 1]);

  const result = await readBuffer(device, outputBuf, outputSize);
  uniformBuf.destroy();
  hmBuf.destroy();
  outputBuf.destroy();
  return result;
}

// ═══════════════════════════════════════════════════
// Drawing GPU 계산 (최대거리, EW거리, 히스토그램)
// ═══════════════════════════════════════════════════

const MAX_DISTANCE_SHADER = /* wgsl */ `
const R: f32 = 6371.0;
const DEG2RAD: f32 = 3.14159265358979 / 180.0;
struct Params { radar_lat: f32, radar_lon: f32, count: u32, _pad: u32, }
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> points: array<f32>;
@group(0) @binding(2) var<storage, read_write> results: array<f32>;
var<workgroup> sdata: array<f32, 256>;
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>, @builtin(local_invocation_id) lid: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  var dist: f32 = 0.0;
  let idx = gid.x;
  if (idx < params.count) {
    let lat1 = params.radar_lat * DEG2RAD; let lon1 = params.radar_lon * DEG2RAD;
    let lat2 = points[idx * 2u] * DEG2RAD; let lon2 = points[idx * 2u + 1u] * DEG2RAD;
    let dLat = lat2 - lat1; let dLon = lon2 - lon1;
    let a = sin(dLat * 0.5) * sin(dLat * 0.5) + cos(lat1) * cos(lat2) * sin(dLon * 0.5) * sin(dLon * 0.5);
    dist = R * 2.0 * atan2(sqrt(a), sqrt(1.0 - a));
  }
  sdata[lid.x] = dist; workgroupBarrier();
  for (var s = 128u; s > 0u; s >>= 1u) { if (lid.x < s) { sdata[lid.x] = max(sdata[lid.x], sdata[lid.x + s]); } workgroupBarrier(); }
  if (lid.x == 0u) { results[wid.x] = sdata[0]; }
}
`;

const EWDIST_SHADER = /* wgsl */ `
struct Params { radar_lon: f32, cos_lat: f32, count: u32, _pad: u32, }
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

const HISTOGRAM_SHADER = /* wgsl */ `
struct Params { view_min_ts: f32, view_max_ts: f32, num_buckets: u32, count: u32, }
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

async function gpuMaxDistance(radarLat: number, radarLon: number, latLonPairs: Float32Array): Promise<number> {
  const device = await getDevice();
  const count = latLonPairs.length / 2;
  if (count === 0) return 0;

  const pb = new ArrayBuffer(16);
  new Float32Array(pb).set([radarLat, radarLon]);
  new Uint32Array(pb, 8).set([count, 0]);
  const uniformBuf = createBuffer(device, new Float32Array(pb), GPUBufferUsage.UNIFORM);
  const pointsBuf = createBuffer(device, latLonPairs, GPUBufferUsage.STORAGE);
  const numWG = Math.ceil(count / 256);
  const resultBuf = device.createBuffer({ size: numWG * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

  await runShader(device, MAX_DISTANCE_SHADER, [
    { buffer: uniformBuf, type: "uniform" },
    { buffer: pointsBuf, type: "read-only-storage" },
    { buffer: resultBuf, type: "storage" },
  ], [numWG, 1, 1]);
  const results = await readBuffer(device, resultBuf, numWG * 4);
  uniformBuf.destroy(); pointsBuf.destroy(); resultBuf.destroy();
  let max = 0;
  for (let i = 0; i < numWG; i++) if (results[i] > max) max = results[i];
  return max;
}

async function gpuEwDists(radarLon: number, cosLat: number, lons: Float32Array): Promise<{ ewDists: ArrayBuffer; minEW: number; maxEW: number }> {
  const device = await getDevice();
  const count = lons.length;
  if (count === 0) return { ewDists: new ArrayBuffer(0), minEW: 0, maxEW: 0 };

  const pb = new ArrayBuffer(16);
  new Float32Array(pb).set([radarLon, cosLat]);
  new Uint32Array(pb, 8).set([count, 0]);
  const uniformBuf = createBuffer(device, new Float32Array(pb), GPUBufferUsage.UNIFORM);
  const lonsBuf = createBuffer(device, lons, GPUBufferUsage.STORAGE);
  const outputBuf = device.createBuffer({ size: count * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });

  await runShader(device, EWDIST_SHADER, [
    { buffer: uniformBuf, type: "uniform" },
    { buffer: lonsBuf, type: "read-only-storage" },
    { buffer: outputBuf, type: "storage" },
  ], [Math.ceil(count / 256), 1, 1]);
  const ewDists = await readBuffer(device, outputBuf, count * 4);
  uniformBuf.destroy(); lonsBuf.destroy(); outputBuf.destroy();

  let minEW = 0, maxEW = 0;
  for (let i = 0; i < count; i++) { const v = ewDists[i]; if (v < minEW) minEW = v; if (v > maxEW) maxEW = v; }
  return { ewDists: ewDists.buffer, minEW, maxEW };
}

async function gpuDensityHistogram(timestamps: Float32Array, viewMinTs: number, viewMaxTs: number, numBuckets: number): Promise<number[]> {
  const device = await getDevice();
  const count = timestamps.length;
  if (count === 0 || viewMaxTs <= viewMinTs) return new Array(numBuckets).fill(0);

  const pb = new ArrayBuffer(16);
  new Float32Array(pb).set([viewMinTs, viewMaxTs]);
  new Uint32Array(pb, 8).set([numBuckets, count]);
  const uniformBuf = createBuffer(device, new Float32Array(pb), GPUBufferUsage.UNIFORM);
  const tsBuf = createBuffer(device, timestamps, GPUBufferUsage.STORAGE);
  const bucketBuf = createBuffer(device, new Uint32Array(numBuckets), GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC);

  await runShader(device, HISTOGRAM_SHADER, [
    { buffer: uniformBuf, type: "uniform" },
    { buffer: tsBuf, type: "read-only-storage" },
    { buffer: bucketBuf, type: "storage" },
  ], [Math.ceil(count / 256), 1, 1]);
  const resultF32 = await readBuffer(device, bucketBuf, numBuckets * 4);
  const resultU32 = new Uint32Array(resultF32.buffer);
  uniformBuf.destroy(); tsBuf.destroy(); bucketBuf.destroy();

  let maxCount = 1;
  for (let i = 0; i < numBuckets; i++) if (resultU32[i] > maxCount) maxCount = resultU32[i];
  const normalized: number[] = new Array(numBuckets);
  for (let i = 0; i < numBuckets; i++) normalized[i] = resultU32[i] / maxCount;
  return normalized;
}

// ─── 메시지 핸들러 ──────────────────────────────────

self.onmessage = async (e: MessageEvent) => {
  const { type } = e.data;

  switch (type) {
    // GPU 디바이스 초기화 + limits 보고
    case "INIT_GPU": {
      try {
        const device = await getDevice();
        self.postMessage({
          type: "GPU_READY",
          maxStorageBufferBindingSize: device.limits.maxStorageBufferBindingSize,
          maxBufferSize: device.limits.maxBufferSize,
          maxComputeWorkgroupsPerDimension: device.limits.maxComputeWorkgroupsPerDimension,
        });
      } catch (err) {
        self.postMessage({ type: "ERROR", seq: -1, error: String(err) });
      }
      break;
    }

    // heightmap 바이너리 수신 (메인 → Worker Transfer)
    case "HEIGHTMAP_DATA": {
      const { heightmapBuffer, meta } = e.data;
      if (_hmResolve) {
        _hmResolve({ buffer: heightmapBuffer, meta });
        _hmResolve = null;
      }
      break;
    }

    // 다중 해상도 커버리지 계산
    case "COMPUTE": {
      const { seq, maxRangeKm, bearingStepDeg, altFts, bands, radarHeightM, excludeManualIds } = e.data;
      _currentSeq = seq;
      _aborted = false;
      try {
        const ranges = await computeMultiBand(
          seq, maxRangeKm, bearingStepDeg, altFts, bands, radarHeightM, excludeManualIds,
        );
        if (_aborted || _currentSeq !== seq) break;
        self.postMessage({ type: "PROGRESS", seq, pct: 90, msg: "결과 전송 중..." });
        const buffer = ranges.buffer;
        self.postMessage(
          { type: "RESULT", seq, ranges: buffer, maxRangeKm },
          [buffer] as any,
        );
      } catch (err) {
        if (String(err).includes("ABORTED")) break;
        self.postMessage({ type: "ERROR", seq, error: String(err) });
      }
      break;
    }

    // OM 보고서용 계산
    case "COMPUTE_OM": {
      const { seq, bearingStepDeg: bStep, altFts: alts, heightmapBuffer, meta } = e.data;
      _currentSeq = seq;
      _aborted = false;
      try {
        const hmF32 = new Float32Array(heightmapBuffer);
        const ranges = await computeFromHeightmap(seq, hmF32, meta, bStep, alts);
        const buffer = ranges.buffer;
        self.postMessage(
          { type: "OM_RESULT", seq, ranges: buffer, maxRangeKm: meta.max_range_km },
          [buffer] as any,
        );
      } catch (err) {
        if (String(err).includes("ABORTED")) break;
        self.postMessage({ type: "ERROR", seq, error: String(err) });
      }
      break;
    }

    // ── 파노라마 GPU 계산 ──
    case "PANORAMA_COMPUTE": {
      const { seq, radarHeightM, rangeStepM, azimuthStepDeg, heightmapBuffer, meta } = e.data;
      try {
        const hmF32 = new Float32Array(heightmapBuffer);
        const result = await computePanorama(hmF32, meta, radarHeightM, rangeStepM, azimuthStepDeg);
        const buf = result.buffer;
        self.postMessage({ type: "PANORAMA_RESULT", seq, terrain: buf }, [buf] as any);
      } catch (err) {
        self.postMessage({ type: "ERROR", seq, error: String(err) });
      }
      break;
    }

    // ── Drawing: 최대 거리 ──
    case "MAX_DISTANCE": {
      const { seq, radarLat, radarLon, latLonPairs } = e.data;
      try {
        const pairs = new Float32Array(latLonPairs);
        const maxDistKm = await gpuMaxDistance(radarLat, radarLon, pairs);
        self.postMessage({ type: "MAX_DISTANCE_RESULT", seq, maxDistKm });
      } catch (err) {
        self.postMessage({ type: "ERROR", seq, error: String(err) });
      }
      break;
    }

    // ── Drawing: EW 거리 ──
    case "EW_DISTS": {
      const { seq, radarLon, cosLat, lons } = e.data;
      try {
        const lonsF32 = new Float32Array(lons);
        const { ewDists, minEW, maxEW } = await gpuEwDists(radarLon, cosLat, lonsF32);
        self.postMessage({ type: "EW_DISTS_RESULT", seq, ewDists, minEW, maxEW }, [ewDists] as any);
      } catch (err) {
        self.postMessage({ type: "ERROR", seq, error: String(err) });
      }
      break;
    }

    // ── Drawing: 밀도 히스토그램 ──
    case "DENSITY_HISTOGRAM": {
      const { seq, timestamps, viewMinTs, viewMaxTs, numBuckets } = e.data;
      try {
        const tsF32 = new Float32Array(timestamps);
        const buckets = await gpuDensityHistogram(tsF32, viewMinTs, viewMaxTs, numBuckets);
        self.postMessage({ type: "DENSITY_HISTOGRAM_RESULT", seq, buckets });
      } catch (err) {
        self.postMessage({ type: "ERROR", seq, error: String(err) });
      }
      break;
    }

    // 중단
    case "ABORT": {
      _aborted = true;
      _currentSeq = -1;
      // 대기 중인 heightmap 요청도 해제
      if (_hmResolve) {
        _hmResolve({ buffer: new ArrayBuffer(0), meta: {} as any });
        _hmResolve = null;
      }
      break;
    }
  }
};
