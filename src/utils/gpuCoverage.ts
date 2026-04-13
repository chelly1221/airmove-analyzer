/**
 * 커버리지 맵 — Per-pixel 무한해상도 렌더링 (Rust Rayon)
 *
 * 아키텍처:
 *   1. init: Rust에서 SRTM + 건물 데이터 프리로드 + 캐시
 *   2. 비트맵: Rust render_coverage_bitmap — 뷰포트 per-pixel ray tracing (무한해상도)
 *   3. OM 보고서 polar 레이어: Rust compute_coverage_terrain_profile[_excluding]
 *      + compute_coverage_layers_batch[_excluded] (픽셀 기반 bearing step)
 *
 * GPU Worker는 파노라마/도면 계산에만 사용 (커버리지에서 완전 제거)
 */

import { invoke } from "@tauri-apps/api/core";
import type { CoverageLayer, MultiCoverageResult } from "./radarCoverage";
import type { RadarSite } from "../types";

// ─── 상수 ───────────────────────────────────────────

const MAX_ELEV_DEG = 40;

// ─── Base64 디코딩 (별도 Worker) ────────────────────

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

// ═══════════════════════════════════════════════════
// GPU Worker 관리 — 파노라마/도면 계산에만 사용
// ═══════════════════════════════════════════════════

let _gpuWorker: Worker | null = null;
let _gpuWorkerReady = false;
let _gpuWorkerInitPromise: Promise<void> | null = null;

function ensureGPUWorker(): Promise<void> {
  if (_gpuWorkerReady) return Promise.resolve();
  if (_gpuWorkerInitPromise) return _gpuWorkerInitPromise;

  _gpuWorkerInitPromise = new Promise<void>((resolve, reject) => {
    _gpuWorker = new Worker(
      new URL("../workers/gpuCoverage.worker.ts", import.meta.url),
      { type: "module" },
    );
    const onMessage = (e: MessageEvent) => {
      if (e.data.type === "GPU_READY") {
        _gpuWorker!.removeEventListener("message", onMessage);
        _gpuWorkerReady = true;
        resolve();
      } else if (e.data.type === "ERROR") {
        _gpuWorker!.removeEventListener("message", onMessage);
        reject(new Error(e.data.error));
      }
    };
    _gpuWorker.addEventListener("message", onMessage);
    _gpuWorker.onerror = (err) => reject(new Error(`GPU Worker 초기화 실패: ${err.message}`));
    _gpuWorker.postMessage({ type: "INIT_GPU" });
  });
  return _gpuWorkerInitPromise;
}

/** GPU Worker 인스턴스 공유 — gpuPanorama, gpuDrawingCompute 등에서 사용 */
export async function getGPUWorkerInstance(): Promise<Worker> {
  await ensureGPUWorker();
  return _gpuWorker!;
}

// ═══════════════════════════════════════════════════
// Per-pixel 커버리지 — 공개 API
// ═══════════════════════════════════════════════════

let _pixelCacheReady = false;
let _currentRadarKey = "";

function radarKey(radar: RadarSite): string {
  return `${radar.name}_${radar.latitude}_${radar.longitude}_${radar.altitude + radar.antenna_height}`;
}

/**
 * 메인 커버리지맵 초기화 — Rust per-pixel 캐시 준비
 * SRTM + 건물 데이터 프리로드만 수행, 비트맵은 renderCoverageImageAsync에서 on-demand
 */
export async function computeMainCoverage(
  radar: RadarSite,
  onProgress?: (pct: number, msg: string) => void,
): Promise<MultiCoverageResult> {
  onProgress?.(10, "SRTM/건물 데이터 로드 중...");
  await invoke("init_pixel_coverage", {
    radarLat: radar.latitude,
    radarLon: radar.longitude,
    radarAltitude: radar.altitude,
    antennaHeight: radar.antenna_height,
    rangeNm: radar.range_nm,
  });
  _pixelCacheReady = true;
  _currentRadarKey = radarKey(radar);

  onProgress?.(100, "완료");
  return {
    radarName: radar.name, radarLat: radar.latitude, radarLon: radar.longitude,
    radarAltitude: radar.altitude, antennaHeight: radar.antenna_height,
    maxElevDeg: MAX_ELEV_DEG, layers: [], computedAt: Date.now(),
  };
}

/**
 * Per-pixel 커버리지 비트맵 렌더링 — Rust에서 뷰포트 해상도로 직접 렌더링
 * 해상도 = 뷰포트 픽셀 (무한, 줌인할수록 세밀)
 */
export interface CoverageImageResult {
  image: ImageBitmap;
  bounds: [number, number, number, number];
  /** 화면에 실제 렌더링된 고도 목록 (ft, 오름차순) */
  usedAltFts: number[];
}

export async function renderCoverageImageAsync(
  altFts: number[],
  showCone: boolean,
  viewport?: { width: number; height: number; west: number; south: number; east: number; north: number },
): Promise<CoverageImageResult | null> {
  if (!_pixelCacheReady || !viewport) return null;

  const w = Math.min(viewport.width, 2048);
  const h = Math.min(viewport.height, 2048);

  const result = await invoke<{
    bitmap_b64: string;
    width: number;
    height: number;
    bounds: [number, number, number, number];
    used_alt_fts: number[];
  }>("render_coverage_bitmap", {
    altFts,
    showCone,
    west: viewport.west,
    south: viewport.south,
    east: viewport.east,
    north: viewport.north,
    width: w,
    height: h,
  });

  // base64 → RGBA → ImageBitmap
  const ab = await decodeBase64OffThread(result.bitmap_b64);
  const rgba = new Uint8ClampedArray(ab);
  const imageData = new ImageData(rgba, result.width, result.height);
  const image = await createImageBitmap(imageData);

  return { image, bounds: result.bounds, usedAltFts: result.used_alt_fts };
}

export function isGPUCacheValidFor(radar: RadarSite): boolean {
  return _pixelCacheReady && _currentRadarKey === radarKey(radar);
}

export function invalidateGPUCache(): void {
  _pixelCacheReady = false;
  _currentRadarKey = "";
}

export function hasCoverageCache(): boolean {
  return _pixelCacheReady;
}

/** 특정 좌표의 최저 탐지고도(ft) 조회 — Rust PIXEL_STATE 캐시 사용 */
export async function queryMinDetectionAlt(lat: number, lon: number): Promise<number | null> {
  if (!_pixelCacheReady) return null;
  return invoke<number | null>("query_min_detection_alt", { lat, lon });
}

// ─── OM 보고서용 polar 레이어 ───────────────────────
// TrackMap per-pixel 방식과 동일한 Rust 지형 프로파일 엔진 사용.
// 외곽 원 둘레를 100m 단위로 쪼개는 "지형 픽셀" bearing step로 가는 장애물도 포착.

export interface CoverageOMParams {
  radarName: string;
  radarLat: number;
  radarLon: number;
  radarAltitude: number;
  antennaHeight: number;
  rangeNm: number;
}

/** 외곽 둘레 100m = ray 1개 기준 bearing step (deg). 최소 0.005° 클램프. */
function pixelBearingStepDeg(rangeNm: number): number {
  const maxRangeKm = rangeNm * 1.852;
  if (maxRangeKm <= 0) return 0.1;
  const stepRad = 100 / (maxRangeKm * 1000);
  const stepDeg = (stepRad * 180) / Math.PI;
  return Math.max(stepDeg, 0.005);
}

/**
 * OM 보고서용 커버리지 레이어 계산
 * — compute_coverage_terrain_profile[_excluding] + compute_coverage_layers_batch[_excluded]
 */
export async function computeCoverageLayersOM(
  params: CoverageOMParams,
  altFts: number[],
  excludeManualIds: number[],
  onProgress?: (msg: string) => void,
): Promise<{ layersWith: CoverageLayer[]; layersWithout: CoverageLayer[] }> {
  const bearingStepDeg = pixelBearingStepDeg(params.rangeNm);

  onProgress?.(`지형 프로파일 계산 중... ${params.radarName} (건물 포함)`);
  await invoke("compute_coverage_terrain_profile", {
    radarName: params.radarName,
    radarLat: params.radarLat,
    radarLon: params.radarLon,
    radarAltitude: params.radarAltitude,
    antennaHeight: params.antennaHeight,
    rangeNm: params.rangeNm,
    bearingStepDeg,
  });
  const layersWith = await invoke<CoverageLayer[]>("compute_coverage_layers_batch", {
    altFts,
    bearingStep: 1,
  });

  onProgress?.(`지형 프로파일 계산 중... ${params.radarName} (건물 제외)`);
  await invoke("compute_coverage_terrain_profile_excluding", {
    radarName: params.radarName,
    radarLat: params.radarLat,
    radarLon: params.radarLon,
    radarAltitude: params.radarAltitude,
    antennaHeight: params.antennaHeight,
    rangeNm: params.rangeNm,
    excludeManualIds,
    bearingStepDeg,
  });
  const layersWithout = await invoke<CoverageLayer[]>("compute_coverage_layers_batch_excluded", {
    altFts,
    bearingStep: 1,
  });

  return { layersWith, layersWithout };
}
