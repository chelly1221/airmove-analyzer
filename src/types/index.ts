/** 비행검사기 (Flight Inspector Aircraft) */
export interface Aircraft {
  /** UUID */
  id: string;
  /** 이름 (예: 1호기, 2호기) */
  name: string;
  /** 기체 모델 (예: Embraer Praetor 600) */
  model: string;
  /** Mode-S 코드 (hex string) */
  mode_s_code: string;
  /** 운용 기관 */
  organization: string;
  memo: string;
  active: boolean;
}

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
  /** 레이더 탐지 유형 (4종 분류) */
  radar_type: "atcrbs" | "atcrbs_psr" | "modes" | "modes_psr";
  /** Original bytes as number array */
  raw_data: number[];
}

/** Loss 구간 (Loss Segment) */
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

/** 파싱 통계 */
export interface ParseStatistics {
  total_asterix_records: number;
  discarded_psr_none: number;
  garbled_removed: number;
  atcrbs_merged: number;
  atcrbs_unmatched: number;
  /** [atcrbs, atcrbs_psr, modes, modes_psr] */
  points_by_type: [number, number, number, number];
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

/** Line of Sight 계산 결과 */
export interface LineOfSightResult {
  in_sight: boolean;
  slant_range_km: number;
  elevation_deg: number;
  max_range_km: number;
  target_altitude: number;
}

/** 단면도 고도 샘플 포인트 */
export interface ElevationPoint {
  distance: number;
  elevation: number;
  latitude: number;
  longitude: number;
}

/** LOS 분석 단면도 결과 */
export interface LOSProfileData {
  id: string;
  radarSiteName: string;
  radarLat: number;
  radarLon: number;
  radarHeight: number;
  targetLat: number;
  targetLon: number;
  bearing: number;
  totalDistance: number;
  elevationProfile: ElevationPoint[];
  losBlocked: boolean;
  maxBlockingPoint?: { distance: number; elevation: number; name?: string };
  timestamp: number;
}

/** UI 페이지 */
export type PageId =
  | "upload"
  | "map"
  | "drawing"
  | "tracks"
  | "analysis"
  | "report"
  | "settings";

/** 파일 업로드 상태 */
export interface UploadedFile {
  path: string;
  name: string;
  status: "pending" | "parsing" | "done" | "error";
  error?: string;
  parsedFile?: ParsedFile;
}
