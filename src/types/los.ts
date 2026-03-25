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
  losBlocked: boolean;
  maxBlockingPoint?: { distance: number; elevation: number; name?: string };
  mapScreenshot?: string;
  chartScreenshot?: string;
  timestamp: number;
}
