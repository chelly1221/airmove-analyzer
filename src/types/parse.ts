import type { TrackPoint } from "./track";
import type { LossSegment } from "./loss";

/** 파싱 통계 */
export interface ParseStatistics {
  total_asterix_records: number;
  discarded_psr_none: number;

  atcrbs_merged: number;
  atcrbs_unmatched: number;
  /** [mode_ac, mode_ac_psr, mode_s_allcall, mode_s_rollcall, mode_s_allcall_psr, mode_s_rollcall_psr] */
  points_by_type: [number, number, number, number, number, number];
  mode3a_invalid: number;
}

/** 파싱 결과 (Parse Result) */
export interface ParsedFile {
  filename: string;
  total_records: number;
  track_points: TrackPoint[];
  parse_errors: string[];
  start_time: number | null;
  end_time: number | null;
  radar_lat: number;
  radar_lon: number;
  parse_stats?: ParseStatistics;
}

/** 분석 결과 (Analysis Result) */
export interface AnalysisResult {
  file_info: ParsedFile;
  loss_segments: LossSegment[];
  total_loss_time: number;
  total_track_time: number;
  loss_percentage: number;
  /** 추정된 레이더 최대 탐지거리 (km) */
  max_radar_range_km: number;
}
