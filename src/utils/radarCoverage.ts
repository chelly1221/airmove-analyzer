// ─── 공개 타입 ──────────────────────────────────────

export interface CoverageBearing {
  deg: number;
  maxRangeKm: number;
  lat: number;
  lon: number;
}

export interface CoverageLayer {
  altitudeFt: number;
  altitudeM: number;
  bearings: CoverageBearing[];
  coneRadiusKm: number; // Cone of Silence 내부 반경
}

export interface MultiCoverageResult {
  radarName: string;
  radarLat: number;
  radarLon: number;
  radarAltitude: number;
  antennaHeight: number;
  maxElevDeg: number;
  layers: CoverageLayer[];
  computedAt: number;
}

// ─── 상수 ───────────────────────────────────────────

/** 커버리지 고도 범위 상수 */
export const COVERAGE_MIN_ALT_FT = 100;
export const COVERAGE_MAX_ALT_FT = 30000;
export const COVERAGE_ALT_STEP_FT = 100;

// ─── GPU 커버리지 API 재수출 ────────────────────────

export {
  computeMainCoverage,
  computeLayersForAltitudes,
  computeLayersForAltitudesAsync,
  isGPUCacheValidFor,
  isWorkerReady,
  invalidateGPUCache,
  hasCoverageCache,
  build3DSurfaceAsync,
  renderCoverageImageAsync,
  queryMinDetectionAlt,
} from "./gpuCoverage";

export type { Coverage3DQuad, CoverageImageResult } from "./gpuCoverage";

/** DB storage key (per-radar) */
export function coverageMapKey(radarName: string): string {
  return `coverage_map_${radarName}`;
}
