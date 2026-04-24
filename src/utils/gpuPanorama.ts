/**
 * WebGPU 파노라마 앙각 계산 — GPU Worker에 위임
 *
 * 아키텍처:
 *   Phase 1: 메인 스레드 — Rust IPC로 heightmap 수신 + base64 decode
 *   Phase 2: GPU Worker — heightmap에서 polar→ENU 샘플링 + 앙각 계산
 *   Phase 3: 메인 스레드 — TerrainResult 배열로 변환
 */

import { invoke } from "@tauri-apps/api/core";
import { getGPUWorkerInstance } from "./gpuCoverage";

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

// ─── base64 decode (인라인 Worker) ──────────────────

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

  // 1. Rust에서 heightmap 수신
  const rangeNm = maxRangeKm / 1.852;
  console.log(`[GPU Panorama] build_heightmap invoke 시작 (lat=${radarLat.toFixed(4)}, lon=${radarLon.toFixed(4)}, rangeNm=${rangeNm.toFixed(1)})`);
  console.time("[GPU Panorama] Heightmap fetch");
  const meta = await invoke<HeightmapResult>("build_heightmap", {
    radarLat, radarLon,
    radarAltitude: radarHeightM,
    antennaHeight: 0,
    rangeNm,
    pixelSizeM: 100,
    skipBuildings: true,
  });
  console.log(`[GPU Panorama] build_heightmap 응답: ${meta.width}×${meta.height}, pixel=${meta.pixel_size_m}m, b64=${(meta.data_b64.length / 1024 / 1024).toFixed(1)}MB`);
  const ab = await decodeBase64OffThread(meta.data_b64);
  meta.data_b64 = "";
  console.timeEnd("[GPU Panorama] Heightmap fetch");
  console.log(`[GPU Panorama] ArrayBuffer decoded: ${(ab.byteLength / 1024 / 1024).toFixed(1)}MB`);
  onProgress?.("heightmap_done");
  // React paint 기회 부여 — phase 전환 상태가 UI에 반영될 틈
  await new Promise((r) => setTimeout(r, 0));

  // 2. GPU Worker에 위임
  console.log(`[GPU Panorama] GPU Worker 확보 중`);
  console.time("[GPU Panorama] Worker compute");
  const worker = await getGPUWorkerInstance();
  console.log(`[GPU Panorama] GPU Worker 준비 완료, PANORAMA_COMPUTE 전송`);
  const seq = Date.now();
  const { data_b64: _, ...metaClean } = meta;

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
