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
  /** 지형+경로상 건물 옥상고 병합 프로파일 (combinedElev). 차단 판정/통합 obstacle 기준. */
  elevationProfile: ElevationPoint[];
  /** 순수 지형 프로파일 (SRTM, 건물 병합 전). 단면도에서 '분석 대상 제외' 최저탐지선 계산에 사용.
   *  DB 영속화 대상 아님 — fresh 계산(computeLosBatch) 시에만 존재, 없으면 대상 제외 선 미표시. */
  terrainProfile?: ElevationPoint[];
  /** 레이더→타겟 경로상 200m 코리도 내 건물 — 단면도에 차폐/비차폐로 표시.
   *  OM 보고서 LoS 단면도에서 TrackMap 동작과 일관성 위해 추가. */
  pathBuildings?: BuildingOnPath[];
  losBlocked: boolean;
  maxBlockingPoint?: { distance: number; elevation: number; name?: string };
  mapScreenshot?: string;
  chartScreenshot?: string;
  timestamp: number;
}
