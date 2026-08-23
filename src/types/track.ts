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

/** CAT008 기상 극좌표 벡터 (Rust WeatherVector 대응).
 *  레이더 1차(PSR) 강수 에코. 거리는 bin 단위 — 실거리 = bin × NM/bin. */
export interface WeatherVector {
  /** Unix timestamp (NEC 프레임 분 단위 UTC) */
  time: number;
  /** 진북 기준 방위 (도, mag_dec 보정됨) */
  azimuth: number;
  /** 시작 거리 (bin) */
  start_bin: number;
  /** 끝 거리 (bin) */
  end_bin: number;
  /** 강도 레벨 1~6 */
  intensity: number;
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

/**
 * 파서가 넘기는 경량 표적보고 (Rust models::PsrReport 와 필드 완전 일치).
 * TrackMap PSR 단독 플롯(TYP=1) 표출용 — 파서는 TYP=1 만 수집한다.
 */
export interface PsrReport {
  /** Unix 초 (UTC) — track_points 와 동일한 base_date + day_offset + TOD 산정 */
  timestamp: number;
  /** I161 추적기 트랙번호 (12bit) */
  track_number: number;
  /** I020 TYP — TrackMap 채널은 항상 1(PSR 단독) */
  typ: number;
  latitude: number;
  longitude: number;
  /** 레이더 거리 (NM) — I040 rho 그대로, I042 직교좌표면 sqrt(x²+y²) */
  rho_nm: number;
  /** 진북 방위 (deg, 0–360) — I040 theta + 자편각 보정 */
  theta_deg: number;
  /** I220 Mode-S 주소 (>0 일 때만, 없으면 null) */
  mode_s: number | null;
  /** I070 Mode 3/A (garbled/invalid 면 null) */
  mode3a: number | null;
  /** I090 FL×100ft→m (없으면 null — PSR 단독 보고는 항상 null) */
  altitude_m: number | null;
  /** I200 대지속도 (kt) — 없으면 0 */
  speed_kts: number;
  /** I200 진행방향 (deg) — 없으면 0 */
  heading_deg: number;
}
