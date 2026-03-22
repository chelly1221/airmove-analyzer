 
/**
 * Web Worker — 커버리지 맵 CPU 집약 연산 오프로드
 *
 * 담당:
 *  1. buildLayers: 36K destinationPoint (삼각함수) 호출 → CoverageLayer[]
 *  2. 배치별 GPU 결과 누적 + 점진적 레이어 생성 (progressive rendering)
 *  3. 폴리곤 데이터 구성 (deck.gl PolygonLayer 용)
 *
 * Main thread 와 통신:
 *  - INIT_CACHE      : ranges Float32Array 캐시 초기화
 *  - BUILD_LAYERS    : 슬라이더 고도 변경 시 레이어 재생성
 *  - ACCUMULATE_BATCH: GPU 배치 결과 누적 + 점진적 레이어 반환
 *  - BUILD_POLYGONS  : CoverageLayer[] → 폴리곤 데이터
 */

// ─── 상수 ──────────────────────────────────────────
const MAX_ELEV_DEG = 40;
const FT_TO_M = 0.3048;

// ─── 타입 ──────────────────────────────────────────
interface CoverageBearing {
  deg: number;
  maxRangeKm: number;
  lat: number;
  lon: number;
}

interface CoverageLayer {
  altitudeFt: number;
  altitudeM: number;
  bearings: CoverageBearing[];
  coneRadiusKm: number;
}

interface WorkerCache {
  radarLat: number;
  radarLon: number;
  radarAltitude: number;
  antennaHeight: number;
  bearingStepDeg: number;
  totalRays: number;
  altFts: number[];
  ranges: Float32Array;
}

// ─── Worker 캐시 ───────────────────────────────────
let _cache: WorkerCache | null = null;

// ─── destinationPoint (Worker 전용 복사) ───────────
function destinationPoint(
  latDeg: number, lonDeg: number, bearingDeg: number, distKm: number,
): [number, number] {
  const R = 6371.0;
  const d = distKm / R;
  const brg = (bearingDeg * Math.PI) / 180;
  const lat1 = (latDeg * Math.PI) / 180;
  const lon1 = (lonDeg * Math.PI) / 180;
  const sinLat1 = Math.sin(lat1);
  const cosLat1 = Math.cos(lat1);
  const sinD = Math.sin(d);
  const cosD = Math.cos(d);
  const lat2 = Math.asin(sinLat1 * cosD + cosLat1 * sinD * Math.cos(brg));
  const lon2 = lon1 + Math.atan2(Math.sin(brg) * sinD * cosLat1, cosD - sinLat1 * Math.sin(lat2));
  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

// ─── buildLayers ───────────────────────────────────
function buildLayers(
  cache: WorkerCache,
  altFts: number[],
  bearingStep: number,
  maxRay?: number,
): CoverageLayer[] {
  const radarHeight = cache.radarAltitude + cache.antennaHeight;
  const maxElevRad = (MAX_ELEV_DEG * Math.PI) / 180;
  const numAlts = cache.altFts.length;
  const effectiveRays = maxRay ?? cache.totalRays;

  const altIdxMap = new Map<number, number>();
  for (let i = 0; i < cache.altFts.length; i++) {
    altIdxMap.set(cache.altFts[i], i);
  }

  const layers: CoverageLayer[] = [];
  for (const altFt of altFts) {
    const altIdx = altIdxMap.get(altFt);
    if (altIdx === undefined) continue;

    const altM = altFt * FT_TO_M;
    const heightAbove = altM - radarHeight;
    const coneRadiusKm = heightAbove > 0 ? (heightAbove / Math.tan(maxElevRad)) / 1000 : 0;

    const bearings: CoverageBearing[] = [];
    for (let r = 0; r < effectiveRays; r += bearingStep) {
      const deg = r * cache.bearingStepDeg;
      const range = cache.ranges[r * numAlts + altIdx];
      if (range > 0) {
        const [lat, lon] = destinationPoint(cache.radarLat, cache.radarLon, deg, range);
        bearings.push({ deg, maxRangeKm: range, lat, lon });
      } else {
        bearings.push({ deg, maxRangeKm: range, lat: cache.radarLat, lon: cache.radarLon });
      }
    }

    layers.push({ altitudeFt: altFt, altitudeM: altM, bearings, coneRadiusKm });
  }

  return layers;
}

// ─── altToColor (HSL→RGB, TrackMap과 동일) ─────────
const COVERAGE_MIN_ALT_FT = 100;
const COVERAGE_MAX_ALT_FT = 30000;

function altToColor(altFt: number): [number, number, number] {
  const t = Math.min(1, Math.max(0, (altFt - COVERAGE_MIN_ALT_FT) / (COVERAGE_MAX_ALT_FT - COVERAGE_MIN_ALT_FT)));
  const hue = t * 240;
  const s = 0.85, l = 0.5;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  let r1: number, g1: number, b1: number;
  if (hue < 60)       { r1 = c; g1 = x; b1 = 0; }
  else if (hue < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (hue < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (hue < 240) { r1 = 0; g1 = x; b1 = c; }
  else                { r1 = 0; g1 = 0; b1 = c; }
  return [Math.round((r1 + m) * 255), Math.round((g1 + m) * 255), Math.round((b1 + m) * 255)];
}

// ─── buildPolygons ─────────────────────────────────
interface PolygonData {
  polygon: [number, number, number][][];
  outerRing: [number, number, number][];
  coneRing: [number, number, number][] | null;
  fillColor: [number, number, number];
  altM: number;
  altFt: number;
}

function buildPolygons(
  layers: CoverageLayer[],
  radarLat: number,
  radarLon: number,
  altScale: number,
  showCone: boolean,
): PolygonData[] {
  if (layers.length === 0) return [];

  const CONE_PTS = 72;
  const isSingle = layers.length === 1;
  const sorted = [...layers].sort((a, b) => a.altitudeFt - b.altitudeFt);

  return sorted.map((layer, idx) => {
    const zVal = isSingle ? layer.altitudeM * altScale : 0;
    const outerRing: [number, number, number][] = layer.bearings.map((b) => [b.lon, b.lat, zVal]);
    if (outerRing.length > 0) outerRing.push(outerRing[0]);

    const polygon: [number, number, number][][] = [outerRing];
    let coneRing: [number, number, number][] | null = null;

    // 범위 모드: 안쪽 레이어를 구멍으로
    const innerLayer = !isSingle && idx > 0 ? sorted[idx - 1] : null;
    if (innerLayer) {
      const innerHole: [number, number, number][] = innerLayer.bearings.map((b) => [b.lon, b.lat, zVal]);
      if (innerHole.length > 0) innerHole.push(innerHole[0]);
      innerHole.reverse();
      polygon.push(innerHole);
    }

    // Cone of Silence
    if (showCone && layer.coneRadiusKm > 0.5 && (isSingle || idx === 0)) {
      const hole: [number, number, number][] = [];
      for (let i = CONE_PTS; i >= 0; i--) {
        const deg = (i / CONE_PTS) * 360;
        const rad = (deg * Math.PI) / 180;
        const dLat = (layer.coneRadiusKm / 6371) * (180 / Math.PI);
        const lat = radarLat + dLat * Math.cos(rad);
        const lon = radarLon + (dLat / Math.cos((radarLat * Math.PI) / 180)) * Math.sin(rad);
        hole.push([lon, lat, zVal]);
      }
      polygon.push(hole);
      coneRing = [];
      for (let i = 0; i <= CONE_PTS; i++) {
        const deg = (i / CONE_PTS) * 360;
        const rad = (deg * Math.PI) / 180;
        const dLat = (layer.coneRadiusKm / 6371) * (180 / Math.PI);
        const lat = radarLat + dLat * Math.cos(rad);
        const lon = radarLon + (dLat / Math.cos((radarLat * Math.PI) / 180)) * Math.sin(rad);
        coneRing.push([lon, lat, zVal]);
      }
    }

    const fillColor = altToColor(layer.altitudeFt);
    return { polygon, outerRing, coneRing, fillColor, altM: layer.altitudeM, altFt: layer.altitudeFt };
  });
}

// ─── 메시지 핸들러 ─────────────────────────────────
self.onmessage = (e: MessageEvent) => {
  const { type, id } = e.data;

  switch (type) {
    // 캐시 초기화 (ranges Transfer로 수신)
    case "INIT_CACHE": {
      const { radarLat, radarLon, radarAltitude, antennaHeight,
              bearingStepDeg, totalRays, altFts, ranges } = e.data;
      _cache = {
        radarLat, radarLon, radarAltitude, antennaHeight,
        bearingStepDeg, totalRays, altFts,
        ranges: new Float32Array(ranges),
      };
      self.postMessage({ type: "CACHE_READY", id });
      break;
    }

    // 슬라이더 변경 시 레이어 재생성
    case "BUILD_LAYERS": {
      if (!_cache) {
        self.postMessage({ type: "ERROR", id, error: "No cache" });
        return;
      }
      const layers = buildLayers(_cache, e.data.altFts, e.data.bearingStep);
      self.postMessage({ type: "LAYERS_RESULT", id, layers });
      break;
    }

    // GPU 배치 결과 누적 + 점진적 레이어 반환
    case "ACCUMULATE_BATCH": {
      const { startRay, batchRays, batchResult, numAlts, totalRays,
              radarLat, radarLon, radarAltitude, antennaHeight,
              bearingStepDeg, altFts, progressiveAlts, altScale, showCone } = e.data;

      if (!_cache) {
        _cache = {
          radarLat, radarLon, radarAltitude, antennaHeight,
          bearingStepDeg, totalRays, altFts,
          ranges: new Float32Array(totalRays * numAlts),
        };
      }

      // 배치 결과 누적
      const batchF32 = new Float32Array(batchResult);
      for (let r = 0; r < batchRays; r++) {
        const srcBase = r * numAlts;
        const dstBase = (startRay + r) * numAlts;
        for (let a = 0; a < numAlts; a++) {
          _cache.ranges[dstBase + a] = batchF32[srcBase + a];
        }
      }

      // 점진적 레이어 생성 (완료된 레이 범위만, 다운샘플)
      const completedRays = startRay + batchRays;
      const pct = Math.round((completedRays / totalRays) * 100);
      if (progressiveAlts && progressiveAlts.length > 0) {
        // 점진적 렌더링: 낮은 해상도로 빠르게 (bearingStep=10 → 3600 rays)
        const partialLayers = buildLayers(_cache, progressiveAlts, 10, completedRays);
        const partialPolygons = buildPolygons(partialLayers, radarLat, radarLon, altScale ?? 0, showCone ?? false);
        self.postMessage({
          type: "PROGRESSIVE_RESULT", id,
          polygons: partialPolygons,
          completedRays,
          totalRays,
          pct,
        });
      } else {
        self.postMessage({ type: "BATCH_ACCUMULATED", id, pct });
      }
      break;
    }

    // 폴리곤 데이터 구성
    case "BUILD_POLYGONS": {
      const { layers, radarLat, radarLon, altScale, showCone } = e.data;
      const polygons = buildPolygons(layers, radarLat, radarLon, altScale, showCone);
      self.postMessage({ type: "POLYGONS_RESULT", id, polygons });
      break;
    }

    // 캐시 ranges 반환 (IndexedDB 저장용, Transfer)
    case "EXPORT_CACHE": {
      if (!_cache) {
        self.postMessage({ type: "ERROR", id, error: "No cache" });
        return;
      }
      const copy = new Float32Array(_cache.ranges);
      const msg = {
        type: "CACHE_EXPORTED", id,
        ranges: copy.buffer,
        radarLat: _cache.radarLat,
        radarLon: _cache.radarLon,
        radarAltitude: _cache.radarAltitude,
        antennaHeight: _cache.antennaHeight,
        bearingStepDeg: _cache.bearingStepDeg,
        totalRays: _cache.totalRays,
        altFts: _cache.altFts,
      };
      (postMessage as any)(msg, [copy.buffer]);
      break;
    }
  }
};
