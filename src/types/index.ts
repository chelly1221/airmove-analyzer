/** 비행검사기 (Flight Inspector Aircraft) */
export interface Aircraft {
  /** UUID */
  id: string;
  /** 이름 (예: 1호기, 2호기) */
  name: string;
  /** 등록번호 (예: FL7779) */
  registration: string;
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
  /** 레이더 탐지 유형 (I020 TYP 기반 6종 분류) */
  radar_type: "mode_ac" | "mode_ac_psr" | "mode_s_allcall" | "mode_s_rollcall" | "mode_s_allcall_psr" | "mode_s_rollcall_psr";
  /** Original bytes as number array */
  raw_data: number[];
  /** 파싱 시 사용된 레이더 사이트 이름 (필터링용) */
  radar_name?: string;
}

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
  mapScreenshot?: string;
  chartScreenshot?: string;
  timestamp: number;
}

/** LOS 경로 상의 건물 */
export interface BuildingOnPath {
  distance_km: number;
  height_m: number;
  ground_elev_m: number;
  total_height_m: number;
  name: string | null;
  address: string | null;
  usage: string | null;
  lat: number;
  lon: number;
}

/** 건물 데이터 임포트 상태 */
export interface BuildingImportStatus {
  region: string;
  file_date: string;
  imported_at: number;
  record_count: number;
}

/** 도형 유형 */
export type GeometryType = "point" | "rectangle" | "circle" | "line";

/** 건물 그룹 */
export interface BuildingGroup {
  id: number;
  name: string;
  /** 색상 (hex) */
  color: string;
  memo: string;
}

/** 수동 등록 건물 */
export interface ManualBuilding {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  /** 건물 높이 (m) */
  height: number;
  /** 지면 표고 (m) */
  ground_elev: number;
  memo: string;
  /** 도형 유형 */
  geometry_type: GeometryType;
  /** 도형 좌표 JSON */
  geometry_json: string | null;
  /** 소속 그룹 ID (null이면 미분류) */
  group_id: number | null;
}

/** LoS 파노라마 포인트 (방위별 최대 앙각 장애물) */
export interface PanoramaPoint {
  /** 방위 (°, 정북=0, 시계방향) */
  azimuth_deg: number;
  /** 앙각 (°, 4/3 유효지구 모델) */
  elevation_angle_deg: number;
  /** 장애물까지 지표 거리 (km) */
  distance_km: number;
  /** 장애물 높이 (m) */
  obstacle_height_m: number;
  /** 지면 표고 (m ASL) */
  ground_elev_m: number;
  /** 장애물 유형 */
  obstacle_type: "terrain" | "gis_building" | "manual_building";
  /** 장애물 이름 */
  name: string | null;
  /** 주소 (건물) */
  address: string | null;
  /** 용도 (건물) */
  usage: string | null;
  /** 장애물 위치 WGS84 */
  lat: number;
  lon: number;
}

/** ADS-B 트랙 포인트 (OpenSky Network) */
export interface AdsbPoint {
  time: number;
  latitude: number;
  longitude: number;
  altitude: number;
  heading: number;
  on_ground: boolean;
}

/** ADS-B 트랙 (한 비행 구간) */
export interface AdsbTrack {
  icao24: string;
  callsign: string | null;
  start_time: number;
  end_time: number;
  path: AdsbPoint[];
}

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

/** 시간별 기상 데이터 (Open-Meteo Archive API) */
export interface WeatherHourly {
  /** Unix timestamp */
  timestamp: number;
  /** 기온 (°C) */
  temperature: number;
  /** 강수량 (mm) */
  precipitation: number;
  /** 전체 운량 (%) */
  cloud_cover: number;
  /** 하층 운량 (%) */
  cloud_cover_low: number;
  /** 중층 운량 (%) */
  cloud_cover_mid: number;
  /** 상층 운량 (%) */
  cloud_cover_high: number;
  /** 시정 (m) */
  visibility: number;
  /** 풍속 (m/s) */
  wind_speed: number;
  /** 풍향 (degrees) */
  wind_direction: number;
  /** 해면기압 (hPa) */
  pressure: number;
  /** 이슬점 (°C) */
  dewpoint: number;
}

/** 기상 스냅샷 (특정 기간/위치) */
export interface WeatherSnapshot {
  radarLat: number;
  radarLon: number;
  startDate: string;
  endDate: string;
  hourly: WeatherHourly[];
  fetchedAt: number;
}

/** 구름 그리드 셀 (공간 분포) */
export interface CloudGridCell {
  lat: number;
  lon: number;
  cloud_cover: number;
  cloud_cover_low: number;
  cloud_cover_mid: number;
  cloud_cover_high: number;
}

/** 구름 그리드 (시간별 공간 분포) */
export interface CloudGridFrame {
  timestamp: number;
  cells: CloudGridCell[];
}

/** 구름 그리드 타임시리즈 */
export interface CloudGridData {
  radarLat: number;
  radarLon: number;
  frames: CloudGridFrame[];
  gridSpacingKm: number;
}

/** 보고서 메타데이터 (프리셋) */
export interface ReportMetadata {
  /** 부서명 (예: 레이더관제부) */
  department: string;
  /** 문서번호 접두사 (예: RDR-RPT) */
  docPrefix: string;
  /** 기관명 (예: 김포공항) */
  organization: string;
  /** 현장명 (예: 레이더송신소) */
  siteName: string;
  /** 하단 푸터 문구 */
  footer: string;
}

/** 수동 병합 기록 */
export interface ManualMergeRecord {
  source_flight_ids: string[];
  mode_s: string;
}

/** 저장된 보고서 요약 (목록 표시용) */
export interface SavedReportSummary {
  id: string;
  title: string;
  template: string;
  radar_name: string;
  created_at: number;
  has_pdf: boolean;
}

/** 저장된 보고서 상세 */
export interface SavedReportDetail {
  id: string;
  title: string;
  template: string;
  radar_name: string;
  created_at: number;
  report_config_json: string;
  pdf_base64?: string;
  metadata_json?: string;
}


// ─── 장애물 월간 분석 ───

/** 방위 구간 */
export interface AzSector {
  start_deg: number;
  end_deg: number;
}

/** 레이더별 파일 묶음 (IPC 입력) */
export interface RadarFileSet {
  radar_name: string;
  radar_lat: number;
  radar_lon: number;
  radar_altitude: number;
  antenna_height: number;
  file_paths: string[];
  azimuth_sectors: AzSector[];
}

/** Loss 발생 좌표 요약 */
export interface LossPointGeo {
  lat: number;
  lon: number;
  alt_ft: number;
  duration_s: number;
}

/** 일별 통계 */
export interface DailyStats {
  date: string;
  day_of_month: number;
  week_num: number;
  total_points: number;
  ssr_combined_points: number;
  psr_combined_points: number;
  psr_rate: number;
  total_track_time_secs: number;
  total_loss_time_secs: number;
  loss_rate: number;
  loss_points_summary: LossPointGeo[];
  /** 나머지 방위(분석 구간 제외) 베이스라인 Loss율 (%) */
  baseline_loss_rate: number;
  /** 나머지 방위 베이스라인 PSR율 (0~1) */
  baseline_psr_rate: number;
}

/** 레이더별 월간 결과 */
export interface RadarMonthlyResult {
  radar_name: string;
  daily_stats: DailyStats[];
  avg_loss_altitude_ft: number;
  total_files_parsed: number;
  total_points_filtered: number;
  failed_files: string[];
}

/** 장애물 월간 분석 전체 결과 */
export interface ObstacleMonthlyResult {
  radar_results: RadarMonthlyResult[];
}

/** 장애물 월간 분석 진행상황 */
export interface ObstacleMonthlyProgress {
  radar_name: string;
  stage: string;
  current: number;
  total: number;
  message: string;
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
  /** 파싱에 사용된 레이더 사이트 이름 */
  radarName?: string;
}
