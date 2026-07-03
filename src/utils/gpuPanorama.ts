/**
 * WebGPU 파노라마 앙각 계산 — GPU Worker에 위임
 *
 * 아키텍처:
 *   Phase 1: 메인 스레드 — Rust IPC 메타 + bulk:// fetch 로 f32 heightmap 수신
 *   Phase 2: GPU Worker — heightmap에서 polar→ENU 샘플링 + 앙각 계산
 *   Phase 3: 메인 스레드 — TerrainResult 배열로 변환
 */

import { invoke } from "@tauri-apps/api/core";
import { getGPUWorkerInstance } from "./gpuCoverage";
import { readBulkBytes } from "./bulkIpc";

// ─── Rust heightmap 결과 타입 (lib.rs HeightmapBulkResult 미러) ──

interface HeightmapBulkResult {
  bulk_id: string;
  bytes: number;
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

// ─── destination_point (좌표 복원용) ────────────────

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
 * 파노라마 앙각 계산 — GPU Worker에 위임
 */
export async function computePanoramaTerrainGPU(
  radarLat: number,
  radarLon: number,
  radarHeightM: number,
  maxRangeKm: number,
  azimuthStepDeg: number,
  rangeStepM: number,
  onProgress?: (phase: "heightmap_done" | "gpu_done") => void,
): Promise<TerrainResult[]> {
  const numAzimuths = Math.round(360 / azimuthStepDeg);

  // 1. Rust에서 heightmap 메타 수신 → bulk:// 로 f32 raw 본체 fetch
  const rangeNm = maxRangeKm / 1.852;
  console.log(`[GPU Panorama] build_heightmap invoke 시작 (lat=${radarLat.toFixed(4)}, lon=${radarLon.toFixed(4)}, rangeNm=${rangeNm.toFixed(1)})`);
  console.time("[GPU Panorama] Heightmap fetch");
  const meta = await invoke<HeightmapBulkResult>("build_heightmap", {
    radarLat, radarLon,
    radarAltitude: radarHeightM,
    antennaHeight: 0,
    rangeNm,
    pixelSizeM: 100,
    skipBuildings: true,
  });
  console.log(`[GPU Panorama] build_heightmap 응답: ${meta.width}×${meta.height}, pixel=${meta.pixel_size_m}m, raw=${(meta.bytes / 1024 / 1024).toFixed(1)}MB`);
  const ab = await readBulkBytes(meta);
  console.timeEnd("[GPU Panorama] Heightmap fetch");
  console.log(`[GPU Panorama] ArrayBuffer 수신: ${(ab.byteLength / 1024 / 1024).toFixed(1)}MB`);
  onProgress?.("heightmap_done");
  // React paint 기회 부여 — phase 전환 상태가 UI에 반영될 틈
  await new Promise((r) => setTimeout(r, 0));

  // 2. GPU Worker에 위임
  console.log(`[GPU Panorama] GPU Worker 확보 중`);
  console.time("[GPU Panorama] Worker compute");
  const worker = await getGPUWorkerInstance();
  console.log(`[GPU Panorama] GPU Worker 준비 완료, PANORAMA_COMPUTE 전송`);
  const seq = Date.now();
  // Worker HeightmapMeta — bulk 참조 필드 제외한 그리드 메타만 전달
  const metaClean = {
    width: meta.width,
    height: meta.height,
    pixel_size_m: meta.pixel_size_m,
    center_lat: meta.center_lat,
    center_lon: meta.center_lon,
    radar_height_m: meta.radar_height_m,
    max_range_km: meta.max_range_km,
  };

  const resultF32 = await new Promise<Float32Array>((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      if (e.data.seq !== seq) return;
      if (e.data.type === "PANORAMA_RESULT") {
        worker.removeEventListener("message", handler);
        resolve(new Float32Array(e.data.terrain));
      } else if (e.data.type === "ERROR") {
        worker.removeEventListener("message", handler);
        reject(new Error(e.data.error));
      }
    };
    worker.addEventListener("message", handler);
    worker.postMessage(
      { type: "PANORAMA_COMPUTE", seq, radarHeightM, rangeStepM, azimuthStepDeg, heightmapBuffer: ab, meta: metaClean },
      [ab],
    );
  });
  console.timeEnd("[GPU Panorama] Worker compute");
  onProgress?.("gpu_done");
  await new Promise((r) => setTimeout(r, 0));

  // 3. TerrainResult 배열로 변환
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
