/**
 * Garble 분석 유틸리티: 반사체 위치 추정 및 garble 분류
 */

const EARTH_R = 6371.0; // km

/** 극좌표 → WGS84 변환 (레이더 기준) */
export function polarToLatLon(
  rhoNm: number,
  thetaDeg: number,
  radarLat: number,
  radarLon: number
): [number, number] {
  const rhoKm = rhoNm * 1.852;
  const thetaRad = (thetaDeg * Math.PI) / 180;
  const latRad = (radarLat * Math.PI) / 180;
  const delta = rhoKm / EARTH_R;

  const lat2 = Math.asin(
    Math.sin(latRad) * Math.cos(delta) +
      Math.cos(latRad) * Math.sin(delta) * Math.cos(thetaRad)
  );
  const lon2 =
    (radarLon * Math.PI) / 180 +
    Math.atan2(
      Math.sin(thetaRad) * Math.sin(delta) * Math.cos(latRad),
      Math.cos(delta) - Math.sin(latRad) * Math.sin(lat2)
    );

  return [(lat2 * 180) / Math.PI, (lon2 * 180) / Math.PI];
}

/** Haversine 거리 (km) */
function haversineKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return EARTH_R * 2 * Math.asin(Math.sqrt(a));
}

/** 반사체 추정 위치 */
export interface ReflectorEstimate {
  lat: number;
  lon: number;
  /** 레이더에서 반사체까지 거리 (NM) */
  distanceNm: number;
  /** 반사체 방위 (degrees) */
  bearing: number;
  /** 추정 신뢰도 (0~1) */
  confidence: number;
}

/**
 * 다중경로 반사체 위치 추정
 *
 * 원리: 레이더 → 반사체 → 항공기 → 레이더 경로에서
 * ghost_rho = d_radar_reflector + d_reflector_aircraft (편도 총 경로)
 * ghost_theta = 반사체 방위 (반사 신호가 오는 방향)
 *
 * d_R (레이더→반사체) + d_A (반사체→항공기) = ghost_rho
 * 반사체 위치는 ghost_theta 방위선 위에 있음
 *
 * 이진 탐색으로 d_R을 찾아 반사체 위치 결정
 */
export function estimateReflectorPosition(
  radarLat: number,
  radarLon: number,
  ghostRhoNm: number,
  ghostThetaDeg: number,
  realLat: number,
  realLon: number
): ReflectorEstimate | null {
  // ghost 방위선 위에서 이진 탐색
  const totalPathNm = ghostRhoNm;

  let bestDr = 0;
  let bestError = Infinity;

  // 0.5 NM 단위로 탐색
  for (let drNm = 0.5; drNm < totalPathNm; drNm += 0.5) {
    const [refLat, refLon] = polarToLatLon(
      drNm,
      ghostThetaDeg,
      radarLat,
      radarLon
    );
    const daKm = haversineKm(refLat, refLon, realLat, realLon);
    const daNm = daKm / 1.852;
    const error = Math.abs(drNm + daNm - totalPathNm);

    if (error < bestError) {
      bestError = error;
      bestDr = drNm;
    }
  }

  // 오차가 5NM 이상이면 신뢰도 낮음
  if (bestError > 5.0) return null;

  const [refLat, refLon] = polarToLatLon(
    bestDr,
    ghostThetaDeg,
    radarLat,
    radarLon
  );

  const confidence = Math.max(0, 1.0 - bestError / 5.0);

  return {
    lat: refLat,
    lon: refLon,
    distanceNm: bestDr,
    bearing: ghostThetaDeg,
    confidence,
  };
}

/** Garble 요약 통계 (Mode-S별) */
export interface GarbleSummary {
  mode_s: string;
  aircraftName?: string;
  totalCount: number;
  sidelobeCount: number;
  multipathCount: number;
  timeRange: [number, number];
  avgBearingDiff: number;
  avgRangeDiff: number;
  /** 고유 ghost track number 목록 */
  trackNumbers: number[];
}

import type { GarblePoint } from "../types";

/** GarblePoint 배열에서 Mode-S별 요약 생성 */
export function summarizeGarbleByModeS(
  points: GarblePoint[],
  aircraftMap?: Map<string, string>
): GarbleSummary[] {
  const groups = new Map<string, GarblePoint[]>();
  for (const p of points) {
    const arr = groups.get(p.mode_s) || [];
    arr.push(p);
    groups.set(p.mode_s, arr);
  }

  const summaries: GarbleSummary[] = [];
  for (const [modeS, pts] of groups) {
    const sidelobe = pts.filter((p) => p.garble_type === "sidelobe");
    const multipath = pts.filter((p) => p.garble_type === "multipath");
    const timestamps = pts.map((p) => p.timestamp);
    const bearingDiffs = pts.map((p) => Math.abs(p.bearing_diff_deg));
    const rangeDiffs = pts.map((p) => Math.abs(p.range_diff_nm));
    const trackNumbers = [...new Set(pts.map((p) => p.track_number))];

    summaries.push({
      mode_s: modeS,
      aircraftName: aircraftMap?.get(modeS.toUpperCase()),
      totalCount: pts.length,
      sidelobeCount: sidelobe.length,
      multipathCount: multipath.length,
      timeRange: [Math.min(...timestamps), Math.max(...timestamps)],
      avgBearingDiff:
        bearingDiffs.reduce((a, b) => a + b, 0) / bearingDiffs.length,
      avgRangeDiff:
        rangeDiffs.reduce((a, b) => a + b, 0) / rangeDiffs.length,
      trackNumbers,
    });
  }

  return summaries.sort((a, b) => b.totalCount - a.totalCount);
}
