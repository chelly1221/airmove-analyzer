import type { BuildingOnPath } from "./building";

/** Line of Sight 계산 결과 */
export interface LineOfSightResult {
  in_sight: boolean;
  slant_range_km: number;
  elevation_deg: number;
  max_range_km: number;
  target_altitude: number;
}

/** 단면도 고도 샘플 포인트 */
export interface ElevationPoint {
  distance: number;
  elevation: number;
  latitude: number;
  longitude: number;
}

/** LoS 분석 단면도 결과 */
export interface LoSProfileData {
  id: string;
  radarSiteName: string;
  radarLat: number;
  radarLon: number;
  radarHeight: number;
  targetLat: number;
  targetLon: number;
  bearing: number;
  totalDistance: number;
  elevationProfile: ElevationPoint[];
  /** 레이더→타겟 경로상 200m 코리도 내 건물 — 단면도에 차폐/비차폐로 표시.
   *  OM 보고서 LoS 단면도에서 TrackMap 동작과 일관성 위해 추가. */
  pathBuildings?: BuildingOnPath[];
  losBlocked: boolean;
  maxBlockingPoint?: { distance: number; elevation: number; name?: string };
  mapScreenshot?: string;
  chartScreenshot?: string;
  timestamp: number;
}
