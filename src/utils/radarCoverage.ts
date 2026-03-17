import { invoke } from "@tauri-apps/api/core";
import type { RadarSite } from "../types";

const R_EARTH_M = 6_371_000;

/** 실제 지구반경 곡률 보정 — 직선 LoS 기준 (m 단위 반환) */
function curvDrop(dKm: number): number {
  const dM = dKm * 1000;
  return (dM * dM) / (2 * R_EARTH_M);
}

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

/** 레이더 최대 앙각 (도) - ASR 전형적 값 */
const MAX_ELEVATION_DEG = 40;

/** ft → m 변환 */
const FT_TO_M = 0.3048;

/** 커버리지 고도 범위 상수 */
export const COVERAGE_MIN_ALT_FT = 100;
export const COVERAGE_MAX_ALT_FT = 20000;
export const COVERAGE_ALT_STEP_FT = 100;

// ─── 지형 프로파일 캐시 기반 아키텍처 ─────────────────────────────

/** 건물 정보 (커버리지 계산용) */
interface BuildingInArea {
  lat: number;
  lon: number;
  height_m: number;
}

/** 레이별 지형 프로파일 (사전 계산) */
interface RayProfile {
  bearing: number;
  /** 각 샘플 포인트의 거리 (km) */
  distances: Float64Array;
  /** 각 샘플 포인트의 보정된 지형 높이 (= 지형고도 + 건물높이 - curvDrop) */
  adjTerrains: Float64Array;
  /** 누적 최대 지형 각도 (maxAngle[i] = max(adjTerrain[j]-radarH)/dist[j] for j=0..i) */
  maxAngles: Float64Array;
  /** 각 샘플 좌표 */
  lats: Float64Array;
  lons: Float64Array;
}

/** 지형 프로파일 캐시 (고도 데이터 + 건물 + 사전 계산 각도) */
export interface CoverageTerrainProfile {
  radarName: string;
  radarLat: number;
  radarLon: number;
  radarHeight: number; // altitude + antenna_height (m)
  maxRangeKm: number;
  maxElevDeg: number;
  rays: RayProfile[];
  computedAt: number;
}

/** 모듈 레벨 캐시 — 고도 슬라이더 변경 시 재사용 */
let _cachedProfile: CoverageTerrainProfile | null = null;

/**
 * 지형 프로파일 계산 (고도 데이터 조회 + 건물 통합 + maxAngle 사전 계산)
 * - 이 함수가 무거운 부분 (SRTM 조회 + 건물 DB 쿼리)
 * - 결과는 모듈 캐시에 저장되어 고도 변경 시 재사용
 */
export async function computeCoverageTerrainProfile(
  radar: RadarSite,
  onProgress?: (pct: number, msg: string) => void,
): Promise<CoverageTerrainProfile> {
  const radarHeight = radar.altitude + radar.antenna_height;
  const maxRangeKm = radar.range_nm * 1.852;
  const BEARING_STEP = 0.1;
  const NUM_BEARINGS = Math.floor(360 / BEARING_STEP);
  const SAMPLES_PER_RAY = 2400;

  // 1) 모든 방위의 샘플 포인트 생성
  const allLats: number[] = [];
  const allLons: number[] = [];
  const rayMeta: { start: number; count: number; bearing: number }[] = [];

  for (let b = 0; b < NUM_BEARINGS; b++) {
    const bearing = b * BEARING_STEP;
    const start = allLats.length;
    for (let s = 1; s <= SAMPLES_PER_RAY; s++) {
      const dist = (s / SAMPLES_PER_RAY) * maxRangeKm;
      const [lat, lon] = destinationPoint(radar.latitude, radar.longitude, bearing, dist);
      allLats.push(lat);
      allLons.push(lon);
    }
    rayMeta.push({ start, count: SAMPLES_PER_RAY, bearing });
  }

  // 2) 고도 데이터 조회 (SRTM 캐시)
  onProgress?.(3, "고도 데이터 조회 중...");
  const elevArr: number[] = await invoke("fetch_elevation", {
    latitudes: allLats,
    longitudes: allLons,
  });
  const allElevations = new Float64Array(elevArr);
  onProgress?.(70, "고도 데이터 조회 완료");

  // 3) 건물 데이터 조회 (GIS + 수동 등록)
  onProgress?.(72, "건물 데이터 조회 중...");
  const rangeDeg = maxRangeKm / 111.0;
  let buildings: BuildingInArea[] = [];
  try {
    buildings = await invoke("query_buildings_in_bbox", {
      minLat: radar.latitude - rangeDeg,
      maxLat: radar.latitude + rangeDeg,
      minLon: radar.longitude - rangeDeg,
      maxLon: radar.longitude + rangeDeg,
      minHeightM: 3.0,
    });
  } catch {
    // 건물 데이터 없으면 무시
  }
  onProgress?.(75, `건물 ${buildings.length.toLocaleString()}건 로드`);

  // 4) 건물을 레이/샘플에 매핑
  // 각 건물의 방위각과 거리를 계산하여 가장 가까운 레이와 샘플에 할당
  const buildingHeights = new Float64Array(allLats.length); // 0으로 초기화
  if (buildings.length > 0) {
    const cosRadarLat = Math.cos((radar.latitude * Math.PI) / 180);
    for (const bld of buildings) {
      const dLat = bld.lat - radar.latitude;
      const dLon = (bld.lon - radar.longitude) * cosRadarLat;
      const distDeg = Math.sqrt(dLat * dLat + dLon * dLon);
      const distKm = distDeg * 111.0;
      if (distKm < 0.01 || distKm > maxRangeKm) continue;

      // 방위각 계산
      let bearingDeg = (Math.atan2(dLon, dLat) * 180) / Math.PI;
      if (bearingDeg < 0) bearingDeg += 360;

      // 가장 가까운 레이 인덱스
      const rayIdx = Math.round(bearingDeg / BEARING_STEP) % NUM_BEARINGS;
      // 가장 가까운 샘플 인덱스
      const sampleIdx = Math.round((distKm / maxRangeKm) * SAMPLES_PER_RAY) - 1;
      if (sampleIdx < 0 || sampleIdx >= SAMPLES_PER_RAY) continue;

      const globalIdx = rayMeta[rayIdx].start + sampleIdx;
      // 해당 위치에 가장 높은 건물만 유지
      if (bld.height_m > buildingHeights[globalIdx]) {
        buildingHeights[globalIdx] = bld.height_m;
      }
    }
  }

  // 5) 레이별 프로파일 계산 (adjTerrain + maxAngle)
  onProgress?.(78, "지형 프로파일 계산 중...");
  const rays: RayProfile[] = [];

  for (const meta of rayMeta) {
    const distances = new Float64Array(SAMPLES_PER_RAY);
    const adjTerrains = new Float64Array(SAMPLES_PER_RAY);
    const maxAngles = new Float64Array(SAMPLES_PER_RAY);
    const lats = new Float64Array(SAMPLES_PER_RAY);
    const lons = new Float64Array(SAMPLES_PER_RAY);

    let runningMaxAngle = -Infinity;

    for (let s = 0; s < SAMPLES_PER_RAY; s++) {
      const globalIdx = meta.start + s;
      const dist = ((s + 1) / SAMPLES_PER_RAY) * maxRangeKm;
      distances[s] = dist;
      lats[s] = allLats[globalIdx];
      lons[s] = allLons[globalIdx];

      // 지형 + 건물 높이 → 4/3 유효지구 프레임 보정
      const terrainWithBuilding = allElevations[globalIdx] + buildingHeights[globalIdx];
      const adj = terrainWithBuilding - curvDrop(dist);
      adjTerrains[s] = adj;

      // 레이더에서 본 지형 각도 (높이/거리 비율)
      const angle = (adj - radarHeight) / dist;
      if (angle > runningMaxAngle) runningMaxAngle = angle;
      maxAngles[s] = runningMaxAngle;
    }

    rays.push({ bearing: meta.bearing, distances, adjTerrains, maxAngles, lats, lons });
  }

  onProgress?.(100, "완료");

  const profile: CoverageTerrainProfile = {
    radarName: radar.name,
    radarLat: radar.latitude,
    radarLon: radar.longitude,
    radarHeight,
    maxRangeKm,
    maxElevDeg: MAX_ELEVATION_DEG,
    rays,
    computedAt: Date.now(),
  };

  _cachedProfile = profile;
  return profile;
}

/** 캐시된 지형 프로파일 반환 */
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
 * 캐시된 지형 프로파일에서 특정 고도 레이어의 커버리지 경계 계산
 * - LOS 차단: 이진 탐색 O(log N) — maxAngles 단조증가 특성 활용
 * - 지형 차단: 이진 탐색 결과까지만 선형 탐색 (대부분 조기 종료)
 * - bearingStep: 출력 해상도 조절 (10 = 매 10번째 ray = 1° 간격, 기본 1)
 */
export function computeLayerFromProfile(
  profile: CoverageTerrainProfile,
  altFt: number,
  bearingStep = 1,
): CoverageLayer {
  const altM = altFt * FT_TO_M;
  const maxElevRad = (profile.maxElevDeg * Math.PI) / 180;

  // Cone of Silence 반경
  const heightAboveRadar = altM - profile.radarHeight;
  const coneRadiusKm = heightAboveRadar > 0
    ? (heightAboveRadar / Math.tan(maxElevRad)) / 1000
    : 0;

  const radarH = profile.radarHeight;
  const rays = profile.rays;
  const numRays = rays.length;
  const bearings: CoverageBearing[] = [];

  for (let r = 0; r < numRays; r += bearingStep) {
    const ray = rays[r];
    const n = ray.distances.length;

    // ── 이진 탐색: LOS 차단점 (조건 2) ──
    // maxAngles[i-1]는 단조증가, targetAngle = (altM-radarH)/d 는 단조감소
    // → 교차점 이후로는 항상 차단 → 이진 탐색 O(log N)
    let losBlockIdx = n;
    let lo = 1, hi = n - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const targetAngle = (altM - radarH) / ray.distances[mid];
      if (ray.maxAngles[mid - 1] > targetAngle) {
        losBlockIdx = mid;
        hi = mid - 1;
      } else {
        lo = mid + 1;
      }
    }

    // ── 선형 탐색: 지형 차단점 (조건 1) — losBlockIdx까지만 ──
    // adjTerrains는 비단조이므로 선형 필요하지만, 탐색 범위가 제한됨
    let terrainBlockIdx = n;
    for (let i = 0; i < losBlockIdx; i++) {
      if (ray.adjTerrains[i] > altM) {
        terrainBlockIdx = i;
        break;
      }
    }

    const blockIdx = Math.min(losBlockIdx, terrainBlockIdx);

    if (blockIdx < n) {
      if (blockIdx > 0) {
        bearings.push({ deg: ray.bearing, maxRangeKm: ray.distances[blockIdx - 1], lat: ray.lats[blockIdx - 1], lon: ray.lons[blockIdx - 1] });
      } else {
        bearings.push({ deg: ray.bearing, maxRangeKm: 0, lat: profile.radarLat, lon: profile.radarLon });
      }
    } else {
      bearings.push({ deg: ray.bearing, maxRangeKm: profile.maxRangeKm, lat: ray.lats[n - 1], lon: ray.lons[n - 1] });
    }
  }

  return { altitudeFt: altFt, altitudeM: altM, bearings, coneRadiusKm };
}

/**
 * 호환용: 전체 고도 레이어 커버리지 맵 계산 (기존 인터페이스 유지)
 * - 지형 프로파일 계산 후 모든 100ft 레이어 생성
 */
export async function computeMultiAltitudeCoverage(
  radar: RadarSite,
  onProgress?: (pct: number, msg: string) => void,
): Promise<MultiCoverageResult> {
  const profile = await computeCoverageTerrainProfile(radar, onProgress);

  const layers: CoverageLayer[] = [];
  for (let altFt = COVERAGE_MIN_ALT_FT; altFt <= COVERAGE_MAX_ALT_FT; altFt += COVERAGE_ALT_STEP_FT) {
    layers.push(computeLayerFromProfile(profile, altFt));
  }

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

/** MultiCoverageResult를 GeoJSON FeatureCollection으로 변환 (도넛 폴리곤) */
export function multiCoverageToGeoJSON(
  coverage: MultiCoverageResult
): GeoJSON.FeatureCollection<GeoJSON.Polygon> {
  const features: GeoJSON.Feature<GeoJSON.Polygon>[] = [];

  for (const layer of coverage.layers) {
    // 외부 경계 (시계 방향)
    const outerRing: [number, number][] = layer.bearings.map((b) => [b.lon, b.lat]);
    if (outerRing.length > 0) outerRing.push(outerRing[0]);

    const coordinates: [number, number][][] = [outerRing];

    // Cone of Silence 내부 hole (반시계 방향)
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

/** Cone of Silence 경계선만 GeoJSON으로 (라인 렌더링용) */
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

/** DB 저장 키 생성 (레이더별 단일 키) */
export function coverageMapKey(radarName: string): string {
  return `coverage_map_${radarName}`;
}
