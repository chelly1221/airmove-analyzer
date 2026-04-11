 
/**
 * Web Worker — 커버리지 맵 CPU 집약 연산 오프로드
 *
 * 담당:
 *  1. buildLayers: destinationPoint (삼각함수) 호출 → CoverageLayer[]
 *  2. 래스터 이미지 렌더링 (OffscreenCanvas → ImageBitmap)
 *  3. 3D 커버리지 면 생성
 *
 * Main thread 와 통신:
 *  - INIT_CACHE            : ranges Float32Array 캐시 초기화
 *  - BUILD_LAYERS          : 고도별 레이어 생성
 *  - BUILD_3D_SURFACE      : 3D 커버리지 면 quad 생성
 *  - RENDER_COVERAGE_IMAGE : 래스터 이미지 렌더링
 *  - EXPORT_CACHE          : IndexedDB 저장용 캐시 반환
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
  maxRangeKm: number;
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

// ─── 메시지 핸들러 ─────────────────────────────────
self.onmessage = (e: MessageEvent) => {
  const { type, id } = e.data;

  switch (type) {
    // 캐시 초기화 (ranges Transfer로 수신)
    case "INIT_CACHE": {
      const { radarLat, radarLon, radarAltitude, antennaHeight,
              bearingStepDeg, totalRays, altFts, ranges, maxRangeKm } = e.data;
      _cache = {
        radarLat, radarLon, radarAltitude, antennaHeight,
        bearingStepDeg, totalRays, altFts, maxRangeKm: maxRangeKm ?? 0,
        ranges: new Float32Array(ranges),
      };
      self.postMessage({ type: "CACHE_READY", id });
      break;
    }

    // 슬라이더 변경 시 레이어 재생성
    case "BUILD_LAYERS": {
      try {
        if (!_cache) {
          self.postMessage({ type: "ERROR", id, error: "No cache" });
          return;
        }
        const layers = buildLayers(_cache, e.data.altFts, e.data.bearingStep);
        self.postMessage({ type: "LAYERS_RESULT", id, layers });
      } catch (err) {
        self.postMessage({ type: "ERROR", id, error: String(err) });
      }
      break;
    }

    case "BUILD_3D_SURFACE": {
      if (!_cache) {
        self.postMessage({ type: "ERROR", id, error: "No cache" });
        break;
      }
      const { maxRangeKm: msgMaxRange, surfaceRayStride, surfaceDistSteps } = e.data;
      const effectiveMaxRange = msgMaxRange || _cache.maxRangeKm || 0;
      if (effectiveMaxRange <= 0) {
        self.postMessage({ type: "3D_SURFACE_RESULT", id, quads: [] });
        break;
      }
      const numAlts = _cache.altFts.length;
      const M_TO_FT = 3.28084;
      const MAX_ALT_FT = 30000;

      const surfaceRays = Math.ceil(_cache.totalRays / surfaceRayStride);

      // 주어진 레이와 거리에서 최저 탐지 가능 고도(m) 계산
      // altFts는 오름차순(100,200,...,30000), 고도가 높을수록 range가 크거나 같음
      function minDetectAltM(rayIdx: number, distKm: number): number {
        const base = rayIdx * numAlts;
        for (let a = 0; a < numAlts; a++) {
          if (_cache!.ranges[base + a] >= distKm) {
            return _cache!.altFts[a] * FT_TO_M;
          }
        }
        return -1; // 커버리지 없음
      }

      const quads: any[] = [];
      for (let ri = 0; ri < surfaceRays - 1; ri++) {
        const r0 = ri * surfaceRayStride;
        const r1 = Math.min((ri + 1) * surfaceRayStride, _cache.totalRays - 1);
        const az0 = r0 * _cache.bearingStepDeg;
        const az1 = r1 * _cache.bearingStepDeg;

        for (let si = 0; si < surfaceDistSteps - 1; si++) {
          const d0km = ((si + 1) / surfaceDistSteps) * effectiveMaxRange;
          const d1km = ((si + 2) / surfaceDistSteps) * effectiveMaxRange;

          const alt00m = minDetectAltM(r0, d0km);
          const alt10m = minDetectAltM(r1, d0km);
          const alt01m = minDetectAltM(r0, d1km);
          const alt11m = minDetectAltM(r1, d1km);

          // 커버리지 없는 셀 제외
          if (alt00m < 0 && alt10m < 0 && alt01m < 0 && alt11m < 0) continue;

          const centerAltFt = (((alt00m < 0 ? 0 : alt00m) + (alt10m < 0 ? 0 : alt10m) +
                                (alt01m < 0 ? 0 : alt01m) + (alt11m < 0 ? 0 : alt11m)) / 4) * M_TO_FT;
          if (centerAltFt > MAX_ALT_FT || centerAltFt < 0) continue;

          const [lat00, lon00] = destinationPoint(_cache.radarLat, _cache.radarLon, az0, d0km);
          const [lat10, lon10] = destinationPoint(_cache.radarLat, _cache.radarLon, az1, d0km);
          const [lat01, lon01] = destinationPoint(_cache.radarLat, _cache.radarLon, az0, d1km);
          const [lat11, lon11] = destinationPoint(_cache.radarLat, _cache.radarLon, az1, d1km);

          const fillColor = altToColor(centerAltFt);

          quads.push({
            polygon: [
              [lon00, lat00, alt00m < 0 ? 0 : alt00m],
              [lon10, lat10, alt10m < 0 ? 0 : alt10m],
              [lon11, lat11, alt11m < 0 ? 0 : alt11m],
              [lon01, lat01, alt01m < 0 ? 0 : alt01m],
              [lon00, lat00, alt00m < 0 ? 0 : alt00m],
            ] as [number, number, number][],
            fillColor,
            altFt: Math.round(centerAltFt),
          });
        }
      }

      self.postMessage({ type: "3D_SURFACE_RESULT", id, quads });
      break;
    }

    // 커버리지 이미지 래스터화 — 픽셀 직접 계산 (ranges 캐시 기반, anti-aliasing 블렌딩 없음)
    case "RENDER_COVERAGE_IMAGE": {
      if (!_cache) {
        self.postMessage({ type: "ERROR", id, error: "No cache" });
        break;
      }
      const { altFts: imgAltFts, showCone: imgShowCone, viewport: vp } = e.data;
      const ranges = _cache.ranges;
      const numAlts = _cache.altFts.length;
      const totalRays = _cache.totalRays;
      const bearingStep = _cache.bearingStepDeg;
      const radarLat = _cache.radarLat;
      const radarLon = _cache.radarLon;
      const radarHeight = _cache.radarAltitude + _cache.antennaHeight;

      const maxRange = _cache.maxRangeKm || 200;
      const cosRadLat = Math.cos(radarLat * Math.PI / 180);

      // 뷰포트 기반: 현재 화면 영역만 화면 해상도로 렌더링
      // 뷰포트 없으면 전체 커버리지 영역 폴백
      let imgW: number, imgH: number;
      let bWest: number, bEast: number, bSouth: number, bNorth: number;
      if (vp) {
        imgW = Math.min(vp.width, 4096);
        imgH = Math.min(vp.height, 4096);
        bWest = vp.west; bEast = vp.east;
        bSouth = vp.south; bNorth = vp.north;
      } else {
        imgW = 2000; imgH = 2000;
        const MARGIN = 1.05;
        const latOff = (maxRange * MARGIN) / 111.32;
        const lonOff = (maxRange * MARGIN) / (111.32 * cosRadLat);
        bWest = radarLon - lonOff; bEast = radarLon + lonOff;
        bSouth = radarLat - latOff; bNorth = radarLat + latOff;
      }

      // 선택 고도 인덱스 매핑 (낮은→높은 순, 낮은 고도 우선 탐색)
      const sortedAlts = [...imgAltFts].sort((a, b) => a - b);
      const altIndices: number[] = [];
      const altColors: [number, number, number][] = [];
      const altIdxMap = new Map<number, number>();
      for (let i = 0; i < _cache.altFts.length; i++) altIdxMap.set(_cache.altFts[i], i);
      for (const alt of sortedAlts) {
        const idx = altIdxMap.get(alt);
        if (idx !== undefined) {
          altIndices.push(idx);
          altColors.push(altToColor(alt));
        }
      }
      const nSelAlts = altIndices.length;
      if (nSelAlts === 0) {
        // 선택된 고도 없음 — 빈 이미지
        const emptyCanvas = new OffscreenCanvas(imgW, imgH);
        const bmp = emptyCanvas.transferToImageBitmap();
        (self.postMessage as any)(
          { type: "COVERAGE_IMAGE_RESULT", id, image: bmp, bounds: [bWest, bSouth, bEast, bNorth] },
          [bmp],
        );
        break;
      }

      // Cone of Silence 반경 (최저 고도 기준)
      const lowestAltFt = sortedAlts[0];
      const lowestAltM = lowestAltFt * FT_TO_M;
      const heightAbove = lowestAltM - radarHeight;
      const maxElevRad = (MAX_ELEV_DEG * Math.PI) / 180;
      const coneRadiusKm = imgShowCone && heightAbove > 0
        ? (heightAbove / Math.tan(maxElevRad)) / 1000
        : 0;
      const coneRadiusSq = coneRadiusKm * coneRadiusKm;

      // 픽셀 직접 계산 — 각 픽셀의 방위/거리 → ranges 캐시 조회
      // 불투명 렌더링 (BitmapLayer.opacity로 투명도 실시간 조절)
      const canvas = new OffscreenCanvas(imgW, imgH);
      const ctx = canvas.getContext("2d")!;
      const imageData = ctx.createImageData(imgW, imgH);
      const pixels = imageData.data; // Uint8ClampedArray [R,G,B,A, ...]

      const RAD2DEG = 180 / Math.PI;
      const latStep = (bNorth - bSouth) / imgH;
      const lonStep = (bEast - bWest) / imgW;
      const maxRangeSq = maxRange * maxRange;

      for (let py = 0; py < imgH; py++) {
        const lat = bNorth - py * latStep;
        const dNorthKm = (lat - radarLat) * 111.32;

        for (let px = 0; px < imgW; px++) {
          const lon = bWest + px * lonStep;
          const dEastKm = (lon - radarLon) * 111.32 * cosRadLat;

          const distSq = dNorthKm * dNorthKm + dEastKm * dEastKm;
          if (distSq > maxRangeSq) continue;
          if (coneRadiusKm > 0.5 && distSq < coneRadiusSq) continue;

          const distKm = Math.sqrt(distSq);

          let bearing = Math.atan2(dEastKm, dNorthKm) * RAD2DEG;
          if (bearing < 0) bearing += 360;
          let ray = Math.round(bearing / bearingStep);
          if (ray >= totalRays) ray = 0;

          const base = ray * numAlts;
          for (let a = 0; a < nSelAlts; a++) {
            if (ranges[base + altIndices[a]] >= distKm) {
              const c = altColors[a];
              const off = (py * imgW + px) * 4;
              pixels[off]     = c[0];
              pixels[off + 1] = c[1];
              pixels[off + 2] = c[2];
              pixels[off + 3] = 255;
              break;
            }
          }
        }
      }

      ctx.putImageData(imageData, 0, 0);

      // ImageBitmap Transfer (zero-copy)
      const bmp = canvas.transferToImageBitmap();
      (self.postMessage as any)(
        { type: "COVERAGE_IMAGE_RESULT", id, image: bmp,
          bounds: [bWest, bSouth, bEast, bNorth] },
        [bmp],
      );
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
        maxRangeKm: _cache.maxRangeKm,
      };
      (postMessage as any)(msg, [copy.buffer]);
      break;
    }
  }
};
