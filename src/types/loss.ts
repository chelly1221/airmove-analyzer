/** Loss 포인트 (개별 미탐지 스캔) */
export interface LossPoint {
  mode_s: string;
  /** 예상 탐지 시각 (보간) */
  timestamp: number;
  /** 보간 위도 */
  latitude: number;
  /** 보간 경도 */
  longitude: number;
  /** 보간 고도 (m) */
  altitude: number;
  /** 레이더까지 거리 (km) */
  radar_distance_km: number;
  /** "signal_loss" = 실제 Loss, "out_of_range" = 레이더 범위 이탈 */
  loss_type: string;
  /** gap 내 몇 번째 미탐지 (1-based) */
  scan_index: number;
  /** gap 내 총 미탐지 수 */
  total_missed_scans: number;
  /** gap 시작 시각 (마지막 탐지 포인트) */
  gap_start_time: number;
  /** gap 끝 시각 (다음 탐지 포인트) */
  gap_end_time: number;
  /** gap 총 지속시간 (초) */
  gap_duration_secs: number;
}

/** Loss 구간 (Loss Segment) — LossPoint에서 파생, 하위 호환용 */
export interface LossSegment {
  mode_s: string;
  start_time: number;
  end_time: number;
  start_lat: number;
  start_lon: number;
  end_lat: number;
  end_lon: number;
  duration_secs: number;
  distance_km: number;
  last_altitude: number;
  start_altitude: number;
  end_altitude: number;
  /** "signal_loss" = 실제 Loss, "out_of_range" = 레이더 범위 이탈 */
  loss_type: string;
  start_radar_dist_km: number;
  end_radar_dist_km: number;
}
