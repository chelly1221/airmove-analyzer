/** 공통 GIS 유틸리티 (Haversine 거리, 방위각, 방위+거리 통합) */

const R_EARTH = 6371; // km
const DEG2RAD = Math.PI / 180;

/** Haversine 대원 거리 (km) */
export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * DEG2RAD;
  const dLon = (lon2 - lon1) * DEG2RAD;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.sin(dLon / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Haversine 대원 거리 (m) */
export function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return haversineKm(lat1, lon1, lat2, lon2) * 1000;
}

/** 초기 방위각 (°, 0=N, CW) */
export function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLon = (lon2 - lon1) * DEG2RAD;
  const y = Math.sin(dLon) * Math.cos(lat2 * DEG2RAD);
  const x =
    Math.cos(lat1 * DEG2RAD) * Math.sin(lat2 * DEG2RAD) -
    Math.sin(lat1 * DEG2RAD) * Math.cos(lat2 * DEG2RAD) * Math.cos(dLon);
  let deg = (Math.atan2(y, x) * 180) / Math.PI;
  return (deg + 360) % 360;
}

/** 방위(°) + 거리(km) 통합 계산 (평면 근사, 근거리용) */
export function azimuthAndDist(
  radarLat: number, radarLon: number,
  lat: number, lon: number,
): { azDeg: number; distKm: number } {
  const dLat = lat - radarLat;
  const dLon = lon - radarLon;
  const latKm = dLat * 111.32;
  const lonKm = dLon * 111.32 * Math.cos(radarLat * DEG2RAD);
  const distKm = Math.sqrt(latKm * latKm + lonKm * lonKm);
  let azDeg = (Math.atan2(lonKm, latKm) * 180) / Math.PI;
  if (azDeg < 0) azDeg += 360;
  return { azDeg, distKm };
}
