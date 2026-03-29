/** LoS 파노라마 포인트 (방위별 최대 앙각 장애물) */
export interface PanoramaPoint {
  /** 방위 (°, 정북=0, 시계방향) */
  azimuth_deg: number;
  /** 앙각 (°, 4/3 유효지구 모델) */
  elevation_angle_deg: number;
  /** 장애물까지 지표 거리 (km) */
  distance_km: number;
  /** 장애물 높이 (m) */
  obstacle_height_m: number;
  /** 지면 표고 (m ASL) */
  ground_elev_m: number;
  /** 장애물 유형 */
  obstacle_type: "terrain" | "gis_building" | "manual_building";
  /** 장애물 이름 */
  name: string | null;
  /** 주소 (건물) */
  address: string | null;
  /** 용도 (건물) */
  usage: string | null;
  /** 장애물 위치 WGS84 */
  lat: number;
  lon: number;
  /** 건물 폴리곤 [[lat, lon], ...] (건물 장애물만) */
  polygon?: [number, number][];
}
