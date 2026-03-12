/** 비행검사기 (Flight Inspector Aircraft) */
export interface Aircraft {
  /** UUID */
  id: string;
  /** 기체 이름 */
  name: string;
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
}

/** 파싱 결과 (Parse Result) */
export interface ParsedFile {
  filename: string;
  total_records: number;
  track_points: TrackPoint[];
  parse_errors: string[];
  start_time: number | null;
  end_time: number | null;
}

/** 분석 결과 (Analysis Result) */
export interface AnalysisResult {
  file_info: ParsedFile;
  loss_segments: LossSegment[];
  total_loss_time: number;
  total_track_time: number;
  loss_percentage: number;
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
}

/** Line of Sight 계산 결과 */
export interface LineOfSightResult {
  in_sight: boolean;
  slant_range_km: number;
  elevation_deg: number;
  max_range_km: number;
  target_altitude: number;
}

/** UI 페이지 */
export type PageId =
  | "dashboard"
  | "aircraft"
  | "upload"
  | "map"
  | "analysis"
  | "report";

/** 파일 업로드 상태 */
export interface UploadedFile {
  path: string;
  name: string;
  status: "pending" | "parsing" | "done" | "error";
  error?: string;
  parsedFile?: ParsedFile;
}
