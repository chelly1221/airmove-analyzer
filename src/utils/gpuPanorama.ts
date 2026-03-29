/**
 * WebGPU Compute Shader로 360° 파노라마 앙각 계산 가속
 *
 * 아키텍처 (heightmap 3D 리팩토링):
 *   Phase 1: Rust — SRTM + 건물 → 2D heightmap (ENU 그리드, 1회 IPC)
 *   Phase 2: GPU — heightmap에서 polar→ENU 샘플링 + 4/3 유효지구 앙각 계산
 *   Phase 3: Rust — 건물 병합 (기존 panorama_merge_buildings IPC)
 *
 * 기존: presample_panorama_elevations (18M 샘플 ~96MB base64 IPC)
 * 변경: build_heightmap (~20MB heightmap, 1회 IPC) + GPU 직접 샘플링
 *
 * GPU 필수 — 미지원 시 에러 throw
 */

import { invoke } from "@tauri-apps/api/core";
import { getGPUDevice, createBuffer, readBuffer, runComputeShader } from "./gpuCompute";

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

// ─── WGSL Compute Shader (heightmap 기반 파노라마) ───
const PANORAMA_HEIGHTMAP_SHADER = /* wgsl */ `
const R_EFF: f32 = 6371000.0 * 4.0 / 3.0;
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

    // polar → ENU → heightmap 샘플링
    let east_m = d * sin_b;
    let north_m = d * cos_b;
    let elev = sample_hm(east_m, north_m);

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
 * WebGPU + heightmap으로 파노라마 앙각 계산 실행
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

  const numAzimuths = Math.round(360 / azimuthStepDeg);
  const maxRangeM = maxRangeKm * 1000;
  const numSteps = Math.floor(maxRangeM / rangeStepM);

  // 1. Rust에서 heightmap 1회 수신
  // rangeNm 계산: maxRangeKm → NM (파노라마는 rangeNm이 아닌 maxRangeKm으로 호출됨)
  const rangeNm = maxRangeKm / 1.852;
  console.time("[GPU Panorama] Heightmap fetch");
  const meta = await invoke<HeightmapResult>("build_heightmap", {
    radarLat, radarLon,
    radarAltitude: radarHeightM, // panorama는 radarHeightM = altitude + antenna
    antennaHeight: 0, // radarHeightM에 이미 포함
    rangeNm,
    pixelSizeM: 100,
  });

  // base64 디코딩
  const res = await fetch(`data:application/octet-stream;base64,${meta.data_b64}`);
  const heightmapF32 = new Float32Array(await res.arrayBuffer());
  meta.data_b64 = "";
  console.timeEnd("[GPU Panorama] Heightmap fetch");

  console.log(`[GPU Panorama] Heightmap ${meta.width}×${meta.height}, ${numAzimuths} azimuths × ${numSteps} steps`);

  // 2. GPU 버퍼 생성
  console.time("[GPU Panorama] compute");
  const hmBuf = createBuffer(device, heightmapF32, GPUBufferUsage.STORAGE);

  const paramsData = new ArrayBuffer(32);
  const paramsF32 = new Float32Array(paramsData);
  const paramsU32 = new Uint32Array(paramsData);
  paramsF32[0] = radarHeightM;
  paramsF32[1] = rangeStepM;
  paramsU32[2] = numSteps;
  paramsU32[3] = numAzimuths;
  paramsF32[4] = azimuthStepDeg;
  paramsF32[5] = meta.pixel_size_m;
  paramsU32[6] = meta.width;
  paramsU32[7] = meta.height;

  const uniformBuf = createBuffer(device, new Float32Array(paramsData), GPUBufferUsage.UNIFORM);

  const outputSize = numAzimuths * 4 * 4;
  const outputBuf = device.createBuffer({
    size: outputSize,
    usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
  });

  // 3. Compute shader 실행
  const workgroups = Math.ceil(numAzimuths / 64);
  await runComputeShader(device, PANORAMA_HEIGHTMAP_SHADER, [
    { buffer: uniformBuf, type: "uniform" },
    { buffer: hmBuf, type: "read-only-storage" },
    { buffer: outputBuf, type: "storage" },
  ], [workgroups, 1, 1]);
  console.timeEnd("[GPU Panorama] compute");

  // 4. 결과 읽기
  const resultF32 = await readBuffer(device, outputBuf, outputSize);

  // 5. 버퍼 정리
  uniformBuf.destroy();
  hmBuf.destroy();
  outputBuf.destroy();

  // 6. TerrainResult 배열로 변환
  const results: TerrainResult[] = new Array(numAzimuths);
  for (let i = 0; i < numAzimuths; i++) {
    const base = i * 4;
    const bestAngle = resultF32[base];
    const bestStep = resultF32[base + 1];
    const bestElev = resultF32[base + 2];
    const distKm = bestStep * rangeStepM / 1000;

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
