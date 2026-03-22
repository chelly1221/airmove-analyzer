/** 레이더 사이트 설정 (Radar Site Configuration) */
export interface RadarSite {
  name: string;
  /** WGS84 latitude */
  latitude: number;
  /** WGS84 longitude */
  longitude: number;
  /** Meters above sea level */
  altitude: number;
  /** Antenna height in meters */
  antenna_height: number;
  /** 제원상 지원범위 (NM) */
  range_nm: number;
}
