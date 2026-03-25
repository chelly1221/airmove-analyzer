/**
 * WebGPU Compute Shader로 360° 파노라마 앙각 계산 가속
 *
 * 아키텍처 (OOM 방지):
 *   Phase 1a: Rust rayon — 18M개 destination_point + SRTM 바이리니어 보간 (CPU, ~500ms)
 *   Phase 1b: GPU compute — 18M개 4/3 유효지구 앙각 계산 + 36K azimuth별 max 탐색 (~10ms)
 *   Phase 2:  Rust — 건물 병합 (기존 IPC)
 *
 * SRTM 타일을 GPU로 전송하지 않고, Rust에서 elevation만 pre-sample하여 전송.
 * 전송 크기: ~72MB f32 (기존 raw tile 방식의 ~5GB 대비 14배 감소)
 *
 * GPU 필수 — 미지원 시 에러 throw
 */

import { invoke } from "@tauri-apps/api/core";
import { getGPUDevice, createBuffer, readBuffer, runComputeShader } from "./gpuCompute";

// ─── Rust 결과 타입 ──────────────────────────────────
interface PreSampledElevations {
  data_b64: string;
  num_azimuths: number;
  num_steps: number;
}

// ─── GPU 지형 결과 (Rust TerrainResult와 대응) ────────
export interface TerrainResult {
  azimuth_deg: number;
  elevation_angle_deg: number;
  distance_km: number;
  obstacle_height_m: number;
  ground_elev_m: number;
  lat: number;
  lon: number;
}

// ─── WGSL Compute Shader (pre-sampled elevation) ─────
// Rust가 이미 SRTM 조회를 완료했으므로 GPU는 앙각 계산 + max 탐색만 수행
const PANORAMA_SHADER = /* wgsl */ `
const R_EFF: f32 = 6371000.0 * 4.0 / 3.0;
const RAD2DEG: f32 = 180.0 / 3.14159265358979;

struct Params {
  radar_height_m: f32,
  range_step_m: f32,
  num_steps: u32,
  num_azimuths: u32,
}

@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var<storage, read> elevations: array<f32>;
@group(0) @binding(2) var<storage, read_write> output: array<f32>;

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let az_idx = gid.x;
  if (az_idx >= params.num_azimuths) { return; }

  var best_angle: f32 = -90.0;
  var best_step: u32 = 0u;
  var best_elev: f32 = 0.0;

  let base_idx = az_idx * params.num_steps;

  for (var s = 0u; s < params.num_steps; s++) {
    let d = f32(s + 1u) * params.range_step_m;
    let elev = elevations[base_idx + s];

    // 4/3 유효지구 앙각 계산
    let dh = elev - params.radar_height_m;
    let curv_drop = d * d / (2.0 * R_EFF);
    let angle = atan((dh - curv_drop) / d) * RAD2DEG;

    if (angle > best_angle) {
      best_angle = angle;
      best_step = s + 1u;
      best_elev = elev;
    }
  }

  if (best_angle < -89.0) { best_angle = 0.0; }

  // 출력: [best_angle, best_step_as_f32, best_elev, pad]
  let out_base = az_idx * 4u;
  output[out_base] = best_angle;
  output[out_base + 1u] = f32(best_step);
  output[out_base + 2u] = best_elev;
  output[out_base + 3u] = 0.0;
}
`;

// ─── destination_point (JS 구현, GPU 결과에서 좌표 복원용) ───
function destinationPoint(
  latDeg: number, lonDeg: number, bearingDeg: number, distM: number,
): [number, number] {
  const R = 6_371_000;
  const lat1 = latDeg * Math.PI / 180;
  const lon1 = lonDeg * Math.PI / 180;
  const brg = bearingDeg * Math.PI / 180;
  const dR = distM / R;

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(dR) + Math.cos(lat1) * Math.sin(dR) * Math.cos(brg),
  );
  const lon2 = lon1 + Math.atan2(
    Math.sin(brg) * Math.sin(dR) * Math.cos(lat1),
    Math.cos(dR) - Math.sin(lat1) * Math.sin(lat2),
  );
  return [lat2 * 180 / Math.PI, lon2 * 180 / Math.PI];
}

/**
 * WebGPU로 파노라마 앙각 계산 실행
 * GPU 필수 — 미지원 시 에러 throw
 */
export async function computePanoramaTerrainGPU(
  radarLat: number,
  radarLon: number,
  radarHeightM: number,
  maxRangeKm: number,
  azimuthStepDeg: number,
  rangeStepM: number,
): Promise<TerrainResult[]> {
  const device = await getGPUDevice();

  // 1. Rust에서 pre-sampled elevation 가져오기 (SRTM 조회는 Rust rayon이 수행)
  console.time("[GPU Panorama] Rust presample");
  const preSampled = await invoke<PreSampledElevations>("presample_panorama_elevations", {
    radarLat,
    radarLon,
    maxRangeKm,
    azimuthStepDeg,
    rangeStepM,
  });
  console.timeEnd("[GPU Panorama] Rust presample");

  const { num_azimuths: numAzimuths, num_steps: numSteps } = preSampled;

  // 2. Base64 디코딩 → Float32Array
  console.time("[GPU Panorama] decode + upload");
  const binaryStr = atob(preSampled.data_b64);
  // base64 문자열 참조 해제 (메모리 절약)
  preSampled.data_b64 = "";
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const elevF32 = new Float32Array(bytes.buffer);

  // 버퍼 크기 제한 확인
  const maxBufSize = device.limits.maxStorageBufferBindingSize;
  if (elevF32.byteLength > maxBufSize) {
    throw new Error(`파노라마 고도 데이터(${(elevF32.byteLength / 1e6).toFixed(0)}MB)가 GPU 버퍼 한계(${(maxBufSize / 1e6).toFixed(0)}MB)를 초과합니다.`);
  }

  // 3. GPU 버퍼 생성
  // Uniform (Params: 16 bytes = 4 x f32/u32)
  const paramsData = new ArrayBuffer(16);
  const paramsF32 = new Float32Array(paramsData);
  const paramsU32 = new Uint32Array(paramsData);
  paramsF32[0] = radarHeightM;
  paramsF32[1] = rangeStepM;
  paramsU32[2] = numSteps;
  paramsU32[3] = numAzimuths;

  const uniformBuf = createBuffer(device, new Float32Array(paramsData),
    GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);

  // Elevation 입력 버퍼
  const elevBuf = createBuffer(device, elevF32,
    GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST);

  // 출력 버퍼 (4 f32 per azimuth: angle, step, elev, pad)
  const outputSize = numAzimuths * 4 * 4;
  const outputBuf = device.createBuffer({
    size: outputSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  console.timeEnd("[GPU Panorama] decode + upload");

  // 4. Compute shader 실행
  console.time("[GPU Panorama] compute");
  const workgroups = Math.ceil(numAzimuths / 64);
  await runComputeShader(device, PANORAMA_SHADER, [
    { buffer: uniformBuf, type: "uniform" },
    { buffer: elevBuf, type: "read-only-storage" },
    { buffer: outputBuf, type: "storage" },
  ], [workgroups, 1, 1]);
  console.timeEnd("[GPU Panorama] compute");

  // 5. 결과 읽기
  console.time("[GPU Panorama] readback");
  const resultF32 = await readBuffer(device, outputBuf, outputSize);
  console.timeEnd("[GPU Panorama] readback");

  // 6. 버퍼 정리
  uniformBuf.destroy();
  elevBuf.destroy();
  outputBuf.destroy();

  // 7. TerrainResult 배열로 변환 (best_step으로 좌표 복원)
  const results: TerrainResult[] = new Array(numAzimuths);
  for (let i = 0; i < numAzimuths; i++) {
    const base = i * 4;
    const bestAngle = resultF32[base];
    const bestStep = resultF32[base + 1]; // step index (1-based)
    const bestElev = resultF32[base + 2];
    const distKm = bestStep * rangeStepM / 1000;

    // destination_point로 좌표 복원
    const azDeg = i * azimuthStepDeg;
    const [lat, lon] = bestStep > 0
      ? destinationPoint(radarLat, radarLon, azDeg, bestStep * rangeStepM)
      : [radarLat, radarLon];

    results[i] = {
      azimuth_deg: azDeg,
      elevation_angle_deg: bestAngle,
      distance_km: distKm,
      obstacle_height_m: bestElev,
      ground_elev_m: bestElev,
      lat,
      lon,
    };
  }

  return results;
}
