/**
 * 김포공항 장애물 제한표면 (Obstacle Limitation Surfaces) 지오메트리 생성
 * ICAO Annex 14 / 항공안전법 시행규칙 기준
 */

/** 활주로 정의 */
interface Runway {
  name: string;
  /** 활주로 양 끝 threshold 좌표 [lat, lon] */
  threshold1: [number, number]; // 14L/14R 방향 (NW)
  threshold2: [number, number]; // 32R/32L 방향 (SE)
  /** 진입 유형 (precision/non-precision) — 양 끝 */
  approachType: "precision" | "non-precision";
}

/** OLS 파라미터 (Code 4, 정밀진입) */
const OLS_PARAMS = {
  /** strip 반폭 (중심선에서 편측, m) */
  stripHalfWidth: 150,
  /** 전이표면 경사 (1:7) */
  transitionalSlope: 1 / 7,
  /** 수평표면 높이 (m) */
  horizontalHeight: 45,
  /** 수평표면 반경 (m) */
  horizontalRadius: 4000,
  /** 원추표면 경사 (1:20) */
  conicalSlope: 1 / 20,
  /** 원추표면 수평거리 (m) */
  conicalHorizontalDist: 1100,
  /** 진입표면 내측변 반폭 (m) — strip 폭과 동일 */
  approachInnerHalfWidth: 150,
  /** 진입표면 확산율 (양쪽 각각) */
  approachDivergence: 0.15,
  /** 진입표면 1구간 길이 (m) */
  approachSection1Length: 3000,
  /** 진입표면 1구간 경사 (1:50) */
  approachSection1Slope: 1 / 50,
  /** 진입표면 2구간 이후 경사 (1:40) */
  approachSection2Slope: 1 / 40,
  /** 진입표면 총 길이 (m) */
  approachTotalLength: 15000,
};

/** 김포공항 활주로 데이터 */
/** 비행장 표고 (m AMSL) — 고도 계산 시 사용 */
export const GIMPO_ELEVATION_M = 18;

const GIMPO_RUNWAYS: Runway[] = [
  {
    name: "14L/32R",
    threshold1: [37.5585, 126.7833], // 14L (NW end)
    threshold2: [37.5370, 126.8110], // 32R (SE end)
    approachType: "precision",
  },
  {
    name: "14R/32L",
    threshold1: [37.5563, 126.7783], // 14R (NW end)
    threshold2: [37.5348, 126.8060], // 32L (SE end)
    approachType: "precision",
  },
];

// --- 지구 좌표 유틸 ---

const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const EARTH_R = 6371000; // m

/** (lat,lon)에서 bearing(°) 방향으로 dist(m) 이동한 좌표 */
function destinationPoint(lat: number, lon: number, bearing: number, dist: number): [number, number] {
  const d = dist / EARTH_R;
  const brng = bearing * DEG2RAD;
  const lat1 = lat * DEG2RAD;
  const lon1 = lon * DEG2RAD;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
  const lon2 = lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));
  return [lat2 * RAD2DEG, lon2 * RAD2DEG];
}

/** 두 점 사이의 방위각 (°) */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG2RAD);
  const x = Math.cos(lat1 * DEG2RAD) * Math.sin(lat2 * DEG2RAD) - Math.sin(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.cos(dLon);
  return ((Math.atan2(y, x) * RAD2DEG) + 360) % 360;
}

/** 방위각 정규화 (0~360) */
function normBearing(b: number): number {
  return ((b % 360) + 360) % 360;
}

/** strip 끝 좌표 (활주로 끝에서 strip은 기본 60m 연장) */
const STRIP_EXTENSION = 60; // m

/** 타원형 수평표면 + 원추표면 외곽 경계 생성 (활주로 strip을 감싸는 형태) */
function generateOvalBoundary(runways: Runway[], radius: number, steps = 72): [number, number][] {
  // 각 활주로 strip 끝점 (±60m 연장) 수집
  const stripEnds: { lat: number; lon: number; bearing: number }[] = [];
  for (const rwy of runways) {
    const [lat1, lon1] = rwy.threshold1;
    const [lat2, lon2] = rwy.threshold2;
    const brng12 = bearing(lat1, lon1, lat2, lon2);
    const brng21 = normBearing(brng12 + 180);
    // strip 끝 = threshold에서 반대 방향으로 60m 연장
    const [sLat1, sLon1] = destinationPoint(lat1, lon1, brng21, STRIP_EXTENSION);
    const [sLat2, sLon2] = destinationPoint(lat2, lon2, brng12, STRIP_EXTENSION);
    stripEnds.push({ lat: sLat1, lon: sLon1, bearing: brng21 });
    stripEnds.push({ lat: sLat2, lon: sLon2, bearing: brng12 });
  }

  // 모든 strip 끝에서 반원 호 + 접선으로 연결 → 단순화: convex hull of arc points
  const arcPoints: [number, number][] = [];
  for (const end of stripEnds) {
    // 반원 호 (strip 끝 기준, 반대 방향 ±90°)
    const centerBrng = end.bearing;
    for (let i = -90; i <= 90; i += (180 / (steps / stripEnds.length))) {
      const b = normBearing(centerBrng + i);
      const [lat, lon] = destinationPoint(end.lat, end.lon, b, radius);
      arcPoints.push([lat, lon]);
    }
  }

  // Convex hull (Gift wrapping)
  return convexHull(arcPoints);
}

/** 2D convex hull (Gift wrapping / Jarvis march) */
function convexHull(points: [number, number][]): [number, number][] {
  if (points.length < 3) return [...points];
  // 최좌하단 점 찾기
  let start = 0;
  for (let i = 1; i < points.length; i++) {
    if (points[i][1] < points[start][1] || (points[i][1] === points[start][1] && points[i][0] < points[start][0])) {
      start = i;
    }
  }
  const hull: [number, number][] = [];
  let current = start;
  do {
    hull.push(points[current]);
    let next = 0;
    for (let i = 1; i < points.length; i++) {
      if (i === current) continue;
      if (next === current) { next = i; continue; }
      const cross =
        (points[i][1] - points[current][1]) * (points[next][0] - points[current][0]) -
        (points[i][0] - points[current][0]) * (points[next][1] - points[current][1]);
      if (cross > 0) next = i;
      else if (cross === 0) {
        // 더 먼 점 선택
        const d1 = (points[i][0] - points[current][0]) ** 2 + (points[i][1] - points[current][1]) ** 2;
        const d2 = (points[next][0] - points[current][0]) ** 2 + (points[next][1] - points[current][1]) ** 2;
        if (d1 > d2) next = i;
      }
    }
    current = next;
  } while (current !== start && hull.length < points.length);
  hull.push(hull[0]); // close ring
  return hull;
}

/** 진입표면 사다리꼴 생성 (활주로 한쪽 끝 기준) */
function generateApproachSurface(
  thresholdLat: number, thresholdLon: number,
  outwardBearing: number, // 활주로에서 바깥쪽 방위
): [number, number][] {
  const p = OLS_PARAMS;
  const perpL = normBearing(outwardBearing - 90);
  const perpR = normBearing(outwardBearing + 90);

  // strip 끝 (threshold에서 60m 연장)
  const [eLat, eLon] = destinationPoint(thresholdLat, thresholdLon, outwardBearing, STRIP_EXTENSION);

  // 내측변 (300m = 150m × 2)
  const [iL_lat, iL_lon] = destinationPoint(eLat, eLon, perpL, p.approachInnerHalfWidth);
  const [iR_lat, iR_lon] = destinationPoint(eLat, eLon, perpR, p.approachInnerHalfWidth);

  // 외측변 (15km 지점에서의 반폭)
  const totalLength = p.approachTotalLength;
  const outerHalfWidth = p.approachInnerHalfWidth + totalLength * p.approachDivergence;
  const [farCenter_lat, farCenter_lon] = destinationPoint(eLat, eLon, outwardBearing, totalLength);
  const [oL_lat, oL_lon] = destinationPoint(farCenter_lat, farCenter_lon, perpL, outerHalfWidth);
  const [oR_lat, oR_lon] = destinationPoint(farCenter_lat, farCenter_lon, perpR, outerHalfWidth);

  // 사다리꼴 (닫힘)
  return [
    [iL_lat, iL_lon],
    [oL_lat, oL_lon],
    [oR_lat, oR_lon],
    [iR_lat, iR_lon],
    [iL_lat, iL_lon], // close
  ];
}

/** 전이표면 생성 (활주로 측면 + 진입표면 측면 경사) */
function generateTransitionalSurface(rwy: Runway): [number, number][][] {
  const p = OLS_PARAMS;
  const [lat1, lon1] = rwy.threshold1;
  const [lat2, lon2] = rwy.threshold2;
  const brng12 = bearing(lat1, lon1, lat2, lon2);
  const brng21 = normBearing(brng12 + 180);
  const perpL = normBearing(brng12 - 90);
  const perpR = normBearing(brng12 + 90);

  // 전이표면 수평 폭 = 45m / (1/7) = 315m
  const transitionalWidth = p.horizontalHeight / p.transitionalSlope;
  const innerDist = p.stripHalfWidth;
  const outerDist = innerDist + transitionalWidth; // 465m

  // strip 끝점 (±60m 연장)
  const [s1Lat, s1Lon] = destinationPoint(lat1, lon1, brng21, STRIP_EXTENSION);
  const [s2Lat, s2Lon] = destinationPoint(lat2, lon2, brng12, STRIP_EXTENSION);

  const polys: [number, number][][] = [];

  // 왼쪽 전이표면
  const li1 = destinationPoint(s1Lat, s1Lon, perpL, innerDist);
  const li2 = destinationPoint(s2Lat, s2Lon, perpL, innerDist);
  const lo1 = destinationPoint(s1Lat, s1Lon, perpL, outerDist);
  const lo2 = destinationPoint(s2Lat, s2Lon, perpL, outerDist);
  polys.push([li1, lo1, lo2, li2, li1]);

  // 오른쪽 전이표면
  const ri1 = destinationPoint(s1Lat, s1Lon, perpR, innerDist);
  const ri2 = destinationPoint(s2Lat, s2Lon, perpR, innerDist);
  const ro1 = destinationPoint(s1Lat, s1Lon, perpR, outerDist);
  const ro2 = destinationPoint(s2Lat, s2Lon, perpR, outerDist);
  polys.push([ri1, ro1, ro2, ri2, ri1]);

  return polys;
}

export interface OLSSurfaceData {
  /** 수평표면 외곽 폴리곤 [lon, lat][] */
  horizontalRing: [number, number][];
  /** 원추표면 외곽 폴리곤 [lon, lat][] */
  conicalRing: [number, number][];
  /** 진입표면 사다리꼴 [lon, lat][][] (활주로 양끝 × 활주로 수) */
  approachPolygons: [number, number][][];
  /** 전이표면 폴리곤 [lon, lat][][] (활주로 양측 × 활주로 수) */
  transitionalPolygons: [number, number][][];
}

/** 김포공항 OLS 전체 지오메트리 생성 */
export function generateGimpoOLS(): OLSSurfaceData {
  const p = OLS_PARAMS;

  // 수평표면 (반경 4km)
  const horizontalLatLon = generateOvalBoundary(GIMPO_RUNWAYS, p.horizontalRadius, 120);
  const horizontalRing = horizontalLatLon.map(([lat, lon]) => [lon, lat] as [number, number]);

  // 원추표면 (반경 4km + 1.1km = 5.1km)
  const conicalLatLon = generateOvalBoundary(GIMPO_RUNWAYS, p.horizontalRadius + p.conicalHorizontalDist, 120);
  const conicalRing = conicalLatLon.map(([lat, lon]) => [lon, lat] as [number, number]);

  // 진입표면 (각 활주로 양끝)
  const approachPolygons: [number, number][][] = [];
  for (const rwy of GIMPO_RUNWAYS) {
    const [lat1, lon1] = rwy.threshold1;
    const [lat2, lon2] = rwy.threshold2;
    const brng12 = bearing(lat1, lon1, lat2, lon2);
    const brng21 = normBearing(brng12 + 180);

    // threshold1 방향 (14L/14R → NW 방향 진입표면)
    const app1 = generateApproachSurface(lat1, lon1, brng21);
    approachPolygons.push(app1.map(([lat, lon]) => [lon, lat] as [number, number]));

    // threshold2 방향 (32R/32L → SE 방향 진입표면)
    const app2 = generateApproachSurface(lat2, lon2, brng12);
    approachPolygons.push(app2.map(([lat, lon]) => [lon, lat] as [number, number]));
  }

  // 전이표면 (각 활주로 양측)
  const transitionalPolygons: [number, number][][] = [];
  for (const rwy of GIMPO_RUNWAYS) {
    const polys = generateTransitionalSurface(rwy);
    for (const poly of polys) {
      transitionalPolygons.push(poly.map(([lat, lon]) => [lon, lat] as [number, number]));
    }
  }

  return { horizontalRing, conicalRing, approachPolygons, transitionalPolygons };
}

/** OLS 표면 색상 */
export const OLS_COLORS = {
  approach: [255, 165, 0] as [number, number, number],       // 주황
  transitional: [0, 191, 255] as [number, number, number],   // 하늘색
  horizontal: [0, 255, 127] as [number, number, number],     // 초록
  conical: [255, 255, 0] as [number, number, number],        // 노랑
};
