/** 토지이용계획 존 (DB 조회 결과) */
export interface LandUseZone {
  zone_type_code: string;
  zone_type_name: string;
  polygon_json: string; // JSON string of [[lat,lon],...]
  centroid_lat: number;
  centroid_lon: number;
  area_sqm: number | null;
}

/** 토지이용계획 임포트 상태 */
export interface LandUseImportStatus {
  region: string;
  file_date: string;
  imported_at: number;
  record_count: number;
}
