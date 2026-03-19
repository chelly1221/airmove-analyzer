import { invoke } from "@tauri-apps/api/core";
import type { RadarSite } from "../types";

// ─── Rust IPC 응답 타입 (snake_case) ───────────────────────────

interface RustCoverageBearing {
  deg: number;
  max_range_km: number;
  lat: number;
  lon: number;
}

interface RustCoverageLayer {
  altitude_ft: number;
  altitude_m: number;
  bearings: RustCoverageBearing[];
  cone_radius_km: number;
}

interface RustProfileMeta {
  radar_name: string;
  radar_height: number;
  max_range_km: number;
  max_elev_deg: number;
  num_rays: number;
  samples_per_ray: number;
}

// ─── 기존 공개 타입 (camelCase) ──────────────────────────────

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

/** 지형 프로파일 메타데이터 (경량 — 실제 데이터는 Rust 측에 캐시) */
export interface CoverageTerrainProfile {
  radarName: string;
  radarLat: number;
  radarLon: number;
  radarHeight: number; // altitude + antenna_height (m)
  maxRangeKm: number;
  maxElevDeg: number;
  numRays: number;
  samplesPerRay: number;
  computedAt: number;
}

/** 레이더 최대 앙각 (도) - ASR 전형적 값 */
const MAX_ELEVATION_DEG = 40;

/** ft -> m 변환 */
const FT_TO_M = 0.3048;

/** 커버리지 고도 범위 상수 */
export const COVERAGE_MIN_ALT_FT = 100;
export const COVERAGE_MAX_ALT_FT = 30000;
export const COVERAGE_ALT_STEP_FT = 100;

// ─── 방위각+거리→좌표 (GeoJSON 변환용) ─────────────────────

/** 방위각+거리로 목적지 좌표 계산 (WGS-84) */
function destinationPoint(
  lat: number, lon: number, bearingDeg: number, distanceKm: number
): [number, number] {
  const R = 6371;
  const d = distanceKm / R;
  const brng = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lon1 = (lon * Math.PI) / 180;
  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
  );
  const lon2 =
    lon1 +
    Math.atan2(
      Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );
  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

// ─── 메타데이터 캐시 ──────────────────────────────────────

/** 모듈 레벨 캐시 — 경량 메타데이터만 (실제 프로파일은 Rust 측) */
let _cachedProfile: CoverageTerrainProfile | null = null;

/**
 * 지형 프로파일 계산 (Rust IPC 위임)
 * - SRTM 조회 + 건물 DB 쿼리 + maxAngle 사전 계산은 모두 Rust에서 수행
 * - 결과 프로파일 데이터는 Rust 측에 캐시되고, TS에는 경량 메타데이터만 반환
 */
export async function computeCoverageTerrainProfile(
  radar: RadarSite,
  onProgress?: (pct: number, msg: string) => void,
): Promise<CoverageTerrainProfile> {
  onProgress?.(3, "지형 프로파일 계산 중 (Rust)...");

  const meta: RustProfileMeta = await invoke("compute_coverage_terrain_profile", {
    radarName: radar.name,
    radarLat: radar.latitude,
    radarLon: radar.longitude,
    radarAltitude: radar.altitude,
    antennaHeight: radar.antenna_height,
    rangeNm: radar.range_nm,
  });

  onProgress?.(100, "완료");

  const profile: CoverageTerrainProfile = {
    radarName: meta.radar_name,
    radarLat: radar.latitude,
    radarLon: radar.longitude,
    radarHeight: meta.radar_height,
    maxRangeKm: meta.max_range_km,
    maxElevDeg: meta.max_elev_deg,
    numRays: meta.num_rays,
    samplesPerRay: meta.samples_per_ray,
    computedAt: Date.now(),
  };

  _cachedProfile = profile;
  return profile;
}

/** 캐시된 지형 프로파일 메타데이터 반환 */
export function getCachedTerrainProfile(): CoverageTerrainProfile | null {
  return _cachedProfile;
}

/** 캐시가 해당 레이더 사이트에 유효한지 확인 (이름+좌표+고도 기반) */
export function isCacheValidFor(radar: RadarSite): boolean {
  if (!_cachedProfile) return false;
  return (
    _cachedProfile.radarName === radar.name &&
    _cachedProfile.radarLat === radar.latitude &&
    _cachedProfile.radarLon === radar.longitude &&
    _cachedProfile.radarHeight === radar.altitude + radar.antenna_height
  );
}

/** 캐시 무효화 */
export function invalidateTerrainCache(): void {
  _cachedProfile = null;
}

/**
 * 동기 폴백 — 빈 레이어 반환
 * 기존 callers (TrackMap.tsx, ReportGeneration.tsx) 호환용
 * 실제 계산은 computeLayersFromProfile() 사용
 */
export function computeLayerFromProfile(
  _profile: CoverageTerrainProfile | null,
  _altFt: number,
  _bearingStep = 1,
): CoverageLayer {
  return {
    altitudeFt: _altFt,
    altitudeM: _altFt * FT_TO_M,
    bearings: [],
    coneRadiusKm: 0,
  };
}

/** Rust IPC snake_case → TS camelCase 변환 */
function mapRustLayer(l: RustCoverageLayer): CoverageLayer {
  return {
    altitudeFt: l.altitude_ft,
    altitudeM: l.altitude_m,
    bearings: l.bearings.map((b) => ({
      deg: b.deg,
      maxRangeKm: b.max_range_km,
      lat: b.lat,
      lon: b.lon,
    })),
    coneRadiusKm: l.cone_radius_km,
  };
}

/**
 * 비동기 배치 레이어 계산 (Rust IPC)
 * - 다중 고도를 한 번의 IPC 호출로 계산 (rayon 병렬)
 * - Rust 측 캐시된 프로파일 사용 — profile 파라미터는 유효성 확인용만
 */
export async function computeLayersFromProfile(
  _profile: CoverageTerrainProfile | null,
  altFts: number[],
  bearingStep = 1,
): Promise<CoverageLayer[]> {
  const layers = await invoke<RustCoverageLayer[]>("compute_coverage_layers_batch", {
    altFts,
    bearingStep,
  });
  return layers.map(mapRustLayer);
}

/**
 * 전체 고도 레이어 커버리지 맵 계산
 * - 지형 프로파일 계산 후 모든 100ft 레이어 일괄 생성
 */
export async function computeMultiAltitudeCoverage(
  radar: RadarSite,
  onProgress?: (pct: number, msg: string) => void,
): Promise<MultiCoverageResult> {
  const profile = await computeCoverageTerrainProfile(radar, onProgress);

  const altFts: number[] = [];
  for (let altFt = COVERAGE_MIN_ALT_FT; altFt <= COVERAGE_MAX_ALT_FT; altFt += COVERAGE_ALT_STEP_FT) {
    altFts.push(altFt);
  }

  const layers = await computeLayersFromProfile(profile, altFts);

  return {
    radarName: radar.name,
    radarLat: radar.latitude,
    radarLon: radar.longitude,
    radarAltitude: radar.altitude,
    antennaHeight: radar.antenna_height,
    maxElevDeg: MAX_ELEVATION_DEG,
    layers,
    computedAt: Date.now(),
  };
}

// ─── GeoJSON 변환 (기존 구현 그대로) ────────────────────────

/** Cone of Silence 원 좌표 생성 (반시계 방향 = GeoJSON hole) */
function coneCircle(
  centerLat: number, centerLon: number, radiusKm: number, clockwise: boolean
): [number, number][] {
  const POINTS = 72;
  const coords: [number, number][] = [];
  for (let i = 0; i <= POINTS; i++) {
    const deg = clockwise
      ? (i / POINTS) * 360
      : 360 - (i / POINTS) * 360;
    const [lat, lon] = destinationPoint(centerLat, centerLon, deg, radiusKm);
    coords.push([lon, lat]);
  }
  return coords;
}

/** MultiCoverageResult -> GeoJSON FeatureCollection (donut polygon) */
export function multiCoverageToGeoJSON(
  coverage: MultiCoverageResult
): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const features: GeoJSON.Feature<GeoJSON.Polygon>[] = [];

  for (const layer of coverage.layers) {
    // outer ring (clockwise)
    const outerRing: [number, number][] = layer.bearings.map((b) => [b.lon, b.lat]);
    if (outerRing.length > 0) outerRing.push(outerRing[0]);

    const coordinates: [number, number][][] = [outerRing];

    // Cone of Silence inner hole (counter-clockwise)
    if (layer.coneRadiusKm > 0.5) {
      const hole = coneCircle(coverage.radarLat, coverage.radarLon, layer.coneRadiusKm, false);
      coordinates.push(hole);
    }

    features.push({
      type: "Feature",
      properties: {
        altitudeFt: layer.altitudeFt,
        altitudeM: layer.altitudeM,
        coneRadiusKm: layer.coneRadiusKm,
      },
      geometry: {
        type: "Polygon",
        coordinates,
      },
    });
  }

  return {
    type: "FeatureCollection",
    features,
  };
}

/** Cone of Silence outline GeoJSON (for line rendering) */
export function coneOfSilenceToGeoJSON(
  coverage: MultiCoverageResult
): GeoJSON.FeatureCollection<GeoJSON.LineString> {
  const features: GeoJSON.Feature<GeoJSON.LineString>[] = [];

  for (const layer of coverage.layers) {
    if (layer.coneRadiusKm < 0.5) continue;
    const coords = coneCircle(coverage.radarLat, coverage.radarLon, layer.coneRadiusKm, true);
    features.push({
      type: "Feature",
      properties: {
        altitudeFt: layer.altitudeFt,
        coneRadiusKm: layer.coneRadiusKm,
      },
      geometry: {
        type: "LineString",
        coordinates: coords,
      },
    });
  }

  return { type: "FeatureCollection", features };
}

/** DB storage key (per-radar) */
export function coverageMapKey(radarName: string): string {
  return `coverage_map_${radarName}`;
}
