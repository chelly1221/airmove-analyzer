import type { TrackPoint } from "./track";
import type { LossPoint, LossSegment } from "./loss";

/** 비행 (분석 기본 단위) */
export interface Flight {
  /** `${mode_s}_${start_time}` */
  id: string;
  mode_s: string;
  /** Aircraft.name 매칭 */
  aircraft_name?: string;
  /** 콜사인 */
  callsign?: string;
  departure_airport?: string;
  arrival_airport?: string;
  start_time: number;
  end_time: number;
  /** @deprecated Worker 소유 — queryViewportPoints/queryFlightPoints로 접근. 빈 배열. */
  track_points: TrackPoint[];
  loss_points: LossPoint[];
  loss_segments: LossSegment[];
  total_loss_time: number;
  total_track_time: number;
  loss_percentage: number;
  max_radar_range_km: number;
  /** 매칭 방식 */
  match_type: "gap" | "manual";
  /** 파싱 시 사용된 레이더 사이트 이름 (필터링용) */
  radar_name?: string;

  // ─── Worker 사전 계산 메타데이터 ───
  /** 트랙 포인트 수 (track_points.length 대체) */
  point_count: number;
  /** 경위도 바운딩 박스 */
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number };
  /** 레이더 탐지 유형별 카운트 */
  radar_type_counts: Record<string, number>;
  /** 60NM 이내 PSR 통계 (buildFlight에서 사전 계산) */
  within_60nm_stats?: { total: number; psr: number };
}

/** 수동 병합 기록 */
export interface ManualMergeRecord {
  source_flight_ids: string[];
  mode_s: string;
}
