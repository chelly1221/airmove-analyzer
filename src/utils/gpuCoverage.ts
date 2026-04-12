/**
 * 커버리지 맵 — Per-pixel 무한해상도 렌더링 (Rust Rayon)
 *
 * 아키텍처:
 *   1. init: Rust에서 SRTM + 건물 데이터 프리로드 + 캐시
 *   2. 레이어: Rust compute_coverage_terrain_profile + compute_coverage_layers_batch (3600 rays)
 *   3. 비트맵: Rust render_coverage_bitmap — 뷰포트 per-pixel ray tracing (무한해상도)
 *
 * GPU Worker는 파노라마/도면 계산에만 사용 (커버리지에서 완전 제거)
 */

import { invoke } from "@tauri-apps/api/core";
import type { CoverageLayer, CoverageBearing, MultiCoverageResult } from "./radarCoverage";
import type { RadarSite } from "../types";

// ─── 상수 ───────────────────────────────────────────

const MAX_ELEV_DEG = 40;
const FT_TO_M = 0.3048;

// ─── Rust heightmap 결과 타입 (OM 보고서용) ─────────

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

// ─── destinationPoint (OM buildLayers용) ────────────

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

/** Rust IPC → base64 decode → ArrayBuffer (OM 보고서용) */
async function fetchHeightmapBuffer(
  radarLat: number, radarLon: number,
  radarAltitude: number, antennaHeight: number,
  outerKm: number, pixelSizeM: number,
  excludeManualIds?: number[],
): Promise<{ buffer: ArrayBuffer; meta: Omit<HeightmapResult, "data_b64"> }> {
  const rangeNm = outerKm / 1.852;
  const meta = await invoke<HeightmapResult>("build_heightmap", {
    radarLat, radarLon, radarAltitude, antennaHeight, rangeNm,
    pixelSizeM, excludeManualIds,
  });
  const ab = await decodeBase64OffThread(meta.data_b64);
  meta.data_b64 = "";
  const { data_b64: _, ...metaWithout } = meta;
  return { buffer: ab, meta: metaWithout };
}

// ═══════════════════════════════════════════════════
// GPU Worker 관리 — 파노라마/도면 계산에만 사용
// ═══════════════════════════════════════════════════

let _gpuWorker: Worker | null = null;
let _gpuWorkerReady = false;
let _gpuWorkerLimits: { maxStorageBufferBindingSize: number; maxBufferSize: number } | null = null;
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
        _gpuWorkerLimits = {
          maxStorageBufferBindingSize: e.data.maxStorageBufferBindingSize,
          maxBufferSize: e.data.maxBufferSize,
        };
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

/** GPU Worker용 OM 보고서 계산 */
async function runGPUComputationOM(
  heightmapBuffer: ArrayBuffer,
  meta: Omit<HeightmapResult, "data_b64">,
  bearingStepDeg: number,
  altFts: number[],
): Promise<Float32Array> {
  await ensureGPUWorker();
  const worker = _gpuWorker!;
  const seq = Date.now();
  return new Promise<Float32Array>((resolve, reject) => {
    const handler = (e: MessageEvent) => {
      const msg = e.data;
      if (msg.seq !== undefined && msg.seq !== seq) return;
      if (msg.type === "OM_RESULT") {
        worker.removeEventListener("message", handler);
        resolve(new Float32Array(msg.ranges));
      } else if (msg.type === "ERROR") {
        worker.removeEventListener("message", handler);
        reject(new Error(msg.error));
      }
    };
    worker.addEventListener("message", handler);
    worker.postMessage(
      { type: "COMPUTE_OM", seq, bearingStepDeg, altFts, heightmapBuffer, meta },
      [heightmapBuffer],
    );
  });
}

function abortGPUWorker(): void {
  if (_gpuWorker) {
    _gpuWorker.postMessage({ type: "ABORT", seq: -1 });
  }
}

/** GPU Worker 인스턴스 공유 — gpuPanorama, gpuDrawingCompute 등에서 사용 */
export async function getGPUWorkerInstance(): Promise<Worker> {
  await ensureGPUWorker();
  return _gpuWorker!;
}

/** GPU Worker limits 조회 */
export function getGPUWorkerLimits(): { maxStorageBufferBindingSize: number; maxBufferSize: number } | null {
  return _gpuWorkerLimits;
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

/** @deprecated per-pixel 방식에서는 비트맵이 직접 렌더링되므로 불필요 */
export async function computeLayersForAltitudesAsync(
  _altFts: number[],
  _bearingStep = 1,
): Promise<CoverageLayer[]> {
  return [];
}

/** @deprecated per-pixel 방식에서는 비트맵이 직접 렌더링되므로 불필요 */
export function computeLayersForAltitudes(
  _altFts: number[],
  _bearingStep = 1,
): CoverageLayer[] {
  return [];
}

export function isGPUCacheValidFor(radar: RadarSite): boolean {
  return _pixelCacheReady && _currentRadarKey === radarKey(radar);
}

export function invalidateGPUCache(): void {
  _pixelCacheReady = false;
  _currentRadarKey = "";
  abortGPUWorker();
}

export function isWorkerReady(): boolean {
  return _pixelCacheReady;
}

export function hasCoverageCache(): boolean {
  return _pixelCacheReady;
}

/** @deprecated */
export const hasSurfaceAngles = hasCoverageCache;

/** 특정 좌표의 최저 탐지고도(ft) 조회 — Rust PIXEL_STATE 캐시 사용 */
export async function queryMinDetectionAlt(lat: number, lon: number): Promise<number | null> {
  if (!_pixelCacheReady) return null;
  return invoke<number | null>("query_min_detection_alt", { lat, lon });
}

// ─── 3D 커버리지 면 (미구현, 빈 배열) ──────────────

export interface Coverage3DQuad {
  polygon: [number, number, number][];
  fillColor: [number, number, number];
  altFt: number;
}

export async function build3DSurfaceAsync(): Promise<Coverage3DQuad[]> {
  return [];
}

// ─── OM 보고서용 (GPU Worker 경로 유지) ─────────────

export interface CoverageOMParams {
  radarName: string;
  radarLat: number;
  radarLon: number;
  radarAltitude: number;
  antennaHeight: number;
  rangeNm: number;
  bearingStepDeg: number;
}

interface OMCoverageCache {
  radarKey: string;
  radarLat: number;
  radarLon: number;
  radarAltitude: number;
  antennaHeight: number;
  bearingStepDeg: number;
  totalRays: number;
  altFts: number[];
  ranges: Float32Array;
}

function buildLayersOM(
  cache: OMCoverageCache,
  altFts: number[],
): CoverageLayer[] {
  const radarHeight = cache.radarAltitude + cache.antennaHeight;
  const maxElevRad = (MAX_ELEV_DEG * Math.PI) / 180;
  const numAlts = cache.altFts.length;
  const altIdxMap = new Map<number, number>();
  for (let i = 0; i < cache.altFts.length; i++) altIdxMap.set(cache.altFts[i], i);

  return altFts
    .map((altFt) => {
      const altIdx = altIdxMap.get(altFt);
      if (altIdx === undefined) return null;
      const altM = altFt * FT_TO_M;
      const heightAbove = altM - radarHeight;
      const coneRadiusKm = heightAbove > 0 ? (heightAbove / Math.tan(maxElevRad)) / 1000 : 0;
      const bearings: CoverageBearing[] = [];
      for (let r = 0; r < cache.totalRays; r++) {
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

/**
 * OM 보고서용 커버리지 레이어 계산 — GPU Worker 경로 유지
 */
export async function computeCoverageLayersOM(
  params: CoverageOMParams,
  altFts: number[],
  excludeManualIds: number[],
  onProgress?: (msg: string) => void,
): Promise<{ layersWith: CoverageLayer[]; layersWithout: CoverageLayer[] }> {
  const totalRays = Math.floor(360 / params.bearingStepDeg);

  // 건물 포함
  onProgress?.(`Heightmap 생성 중... ${params.radarName} (건물 포함)`);
  const { buffer: bufWith, meta: metaWith } = await fetchHeightmapBuffer(
    params.radarLat, params.radarLon,
    params.radarAltitude, params.antennaHeight,
    params.rangeNm * 1.852, 100,
  );
  onProgress?.(`GPU 커버리지 계산 중... ${params.radarName} (건물 포함)`);
  const rangesWith = await runGPUComputationOM(bufWith, metaWith, params.bearingStepDeg, altFts);
  const withCache: OMCoverageCache = {
    radarKey: "", radarLat: params.radarLat, radarLon: params.radarLon,
    radarAltitude: params.radarAltitude, antennaHeight: params.antennaHeight,
    bearingStepDeg: params.bearingStepDeg, totalRays, altFts, ranges: rangesWith,
  };
  const layersWith = buildLayersOM(withCache, altFts);

  // 건물 제외
  onProgress?.(`Heightmap 생성 중... ${params.radarName} (건물 제외)`);
  const { buffer: bufWithout, meta: metaWithout } = await fetchHeightmapBuffer(
    params.radarLat, params.radarLon,
    params.radarAltitude, params.antennaHeight,
    params.rangeNm * 1.852, 100,
    excludeManualIds,
  );
  onProgress?.(`GPU 커버리지 계산 중... ${params.radarName} (건물 제외)`);
  const rangesWithout = await runGPUComputationOM(bufWithout, metaWithout, params.bearingStepDeg, altFts);
  const withoutCache: OMCoverageCache = { ...withCache, ranges: rangesWithout };
  const layersWithout = buildLayersOM(withoutCache, altFts);

  return { layersWith, layersWithout };
}
