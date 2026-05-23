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

/** TCAS/ACAS 보고 — 트랙과 독립적으로 추출 (Rust TcasReport 대응) */
export interface TcasReport {
  /** Unix timestamp */
  timestamp: number;
  /** 시각이 직전 레코드에서 추정된 값인지 (I140 부재) */
  time_estimated: boolean;
  /** 보고 항공기 Mode-S */
  mode_s: string;
  /** 0 = I048/260 ACAS RA, 1 = I048/250 BDS 3,0 RA, 2 = I048/250 BDS 1,6 Coordination */
  source: number;
  /** BDS 페이로드 7바이트 */
  payload: number[];
  /** WGS84 (없으면 null) */
  latitude: number | null;
  longitude: number | null;
  /** 고도 (m, 없으면 null) */
  altitude: number | null;
  /** 이 보고가 추출된 CAT048 레코드 원본 바이트 (프레임 전문) */
  raw_frame: number[];
}
