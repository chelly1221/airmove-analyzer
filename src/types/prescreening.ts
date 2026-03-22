/** 추가 Loss 이벤트 (건물에 의한 추가 Loss) */
export interface AdditionalLossEvent {
  mode_s: string;
  start_time: number;
  end_time: number;
  duration_secs: number;
  start_lat: number;
  start_lon: number;
  start_alt_ft: number;
  end_lat: number;
  end_lon: number;
  end_alt_ft: number;
  avg_alt_ft: number;
  radar_distance_km: number;
  azimuth_deg: number;
}

/** 건물별 사전검토 결과 */
export interface PreScreeningBuildingResult {
  building_id: number;
  building_name: string;
  building_height_m: number;
  ground_elev_m: number;
  distance_km: number;
  azimuth_deg: number;
  /** 기존 지형 앙각 (°, 최소 0.25° 적용) */
  terrain_elevation_angle_deg: number;
  /** 건물 꼭대기 앙각 (°) */
  building_elevation_angle_deg: number;
  /** 최대 건축가능 높이 (m) */
  max_buildable_height_m: number;
  /** 추가 Loss 이벤트 */
  additional_loss_events: AdditionalLossEvent[];
  /** 추가 Loss 총 시간 (초) */
  additional_loss_time_secs: number;
  /** 영향받는 고유 항공기 수 */
  affected_aircraft_count: number;
  /** 해당 섹터 총 항적 시간 (초) */
  sector_total_track_time_secs: number;
  /** 해당 섹터 기존 Loss 시간 (초) */
  sector_existing_loss_time_secs: number;
}

/** 레이더별 사전검토 결과 */
export interface PreScreeningRadarResult {
  radar_name: string;
  building_results: PreScreeningBuildingResult[];
  total_files_parsed: number;
  total_points_in_sectors: number;
  analysis_period: string;
  failed_files: string[];
}

/** 사전검토 전체 결과 */
export interface PreScreeningResult {
  radar_results: PreScreeningRadarResult[];
}
