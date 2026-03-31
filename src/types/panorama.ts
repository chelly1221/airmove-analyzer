/** LoS 파노라마 포인트 — 지형 (방위별 최대 앙각) */
export interface PanoramaPoint {
  azimuth_deg: number;
  elevation_angle_deg: number;
  distance_km: number;
  obstacle_height_m: number;
  ground_elev_m: number;
  obstacle_type: "terrain";
  name: string | null;
  address: string | null;
  usage: string | null;
  lat: number;
  lon: number;
  polygon?: [number, number][];
}

/** 건물 장애물 — 정확한 방위 범위, 빈 양자화 없음 */
export interface BuildingObstacle {
  azimuth_start_deg: number;
  azimuth_end_deg: number;
  elevation_angle_deg: number;
  distance_km: number;
  height_m: number;
  ground_elev_m: number;
  /** 지반고 출처: "srtm" (NASA) | "manual" (수동 등록) */
  ground_source: "srtm" | "manual";
  obstacle_type: "gis_building" | "manual_building";
  name: string | null;
  address: string | null;
  usage: string | null;
  lat: number;
  lon: number;
  polygon?: [number, number][];
}

/** 파노라마 병합 결과 (지형 + 건물 분리) */
export interface PanoramaMergeResult {
  terrain: PanoramaPoint[];
  buildings: BuildingObstacle[];
}
