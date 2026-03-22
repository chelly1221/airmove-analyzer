import type { TrackPoint } from "./track";
import type { LossPoint, LossSegment } from "./loss";

/** 운항이력 (OpenSky /flights/aircraft) */
export interface FlightRecord {
  icao24: string;
  first_seen: number;
  last_seen: number;
  est_departure_airport: string | null;
  est_arrival_airport: string | null;
  callsign: string | null;
}

/** 비행 (분석 기본 단위) */
export interface Flight {
  /** `${mode_s}_${start_time}` */
  id: string;
  mode_s: string;
  /** Aircraft.name 매칭 */
  aircraft_name?: string;
  /** FlightRecord에서 */
  callsign?: string;
  departure_airport?: string;
  arrival_airport?: string;
  start_time: number;
  end_time: number;
  track_points: TrackPoint[];
  loss_points: LossPoint[];
  loss_segments: LossSegment[];
  total_loss_time: number;
  total_track_time: number;
  loss_percentage: number;
  max_radar_range_km: number;
  /** 매칭 방식 */
  match_type: "opensky" | "gap" | "manual";
  /** 파싱 시 사용된 레이더 사이트 이름 (필터링용) */
  radar_name?: string;
}

/** 수동 병합 기록 */
export interface ManualMergeRecord {
  source_flight_ids: string[];
  mode_s: string;
}
