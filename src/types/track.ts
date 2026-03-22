/** 레이더 트랙 포인트 */
export interface TrackPoint {
  /** Unix timestamp */
  timestamp: number;
  /** Mode-S code */
  mode_s: string;
  /** WGS84 latitude (degrees) */
  latitude: number;
  /** WGS84 longitude (degrees) */
  longitude: number;
  /** Altitude in meters */
  altitude: number;
  /** Speed in knots */
  speed: number;
  /** Heading in degrees */
  heading: number;
  /** 레이더 탐지 유형 (I020 TYP 기반 6종 분류) */
  radar_type: "mode_ac" | "mode_ac_psr" | "mode_s_allcall" | "mode_s_rollcall" | "mode_s_allcall_psr" | "mode_s_rollcall_psr";
  /** Original bytes as number array */
  raw_data: number[];
  /** 파싱 시 사용된 레이더 사이트 이름 (필터링용) */
  radar_name?: string;
}
