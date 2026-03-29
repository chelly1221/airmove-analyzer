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
  buildPolygonsAsync,
  isGPUCacheValidFor,
  isWorkerReady,
  invalidateGPUCache,
  hasCoverageCache,
  build3DSurfaceAsync,
} from "./gpuCoverage";

export type { CoveragePolygonData, Coverage3DQuad } from "./gpuCoverage";

// ─── GeoJSON 변환 ───────────────────────────────────

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
    if (layer.coneRadiusKm <= 0.5) continue;
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
