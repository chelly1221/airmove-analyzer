/**
 * GPU 계산 전용 Worker — 파노라마 / 도면 / Drawing 계산용
 *
 * 메인 스레드와의 통신:
 *   Main → Worker:
 *     INIT_GPU          — GPU 디바이스 초기화
 *     PANORAMA_COMPUTE  — 파노라마 GPU 계산
 *     MAX_DISTANCE      — 도면: 최대 거리
 *     EW_DISTS          — 도면: 동서 거리
 *     DENSITY_HISTOGRAM — 도면: 밀도 히스토그램
 *
 *   Worker → Main:
 *     GPU_READY              — GPU 디바이스 초기화 완료
 *     PANORAMA_RESULT        — 파노라마 결과
 *     MAX_DISTANCE_RESULT    — 도면 결과
 *     EW_DISTS_RESULT
 *     DENSITY_HISTOGRAM_RESULT
 *     ERROR                  — 에러
 */

// ─── HeightmapMeta 타입 (파노라마에서 사용) ─────────

interface HeightmapMeta {
  width: number;
  height: number;
  pixel_size_m: number;
  center_lat: number;
  center_lon: number;
  radar_height_m: number;
  max_range_km: number;
}

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

  }
};
