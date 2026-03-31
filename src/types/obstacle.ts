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

/** 항적 포인트 좌표 (LoS 단면도 오버레이용) */
export interface TrackPointGeo {
  lat: number;
  lon: number;
  alt_ft: number;
  radar_type: string;
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
  /** 나머지 방위(분석 구간 제외) 베이스라인 Loss 포인트 좌표 */
  baseline_loss_points: LossPointGeo[];
  /** 나머지 방위(분석 구간 제외) 베이스라인 Loss율 (%) */
  baseline_loss_rate: number;
  /** 나머지 방위 베이스라인 PSR율 (0~1) */
  baseline_psr_rate: number;
  /** 필터링된 전체 항적 좌표 (LoS 단면도 오버레이용) */
  track_points_geo?: TrackPointGeo[];
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

/** OM 보고서 통합 상태 (12개 useState → 1개로 통합, 캐스케이딩 리렌더 방지) */
export interface OMReportData {
  result: ObstacleMonthlyResult | null;
  selectedBuildings: import("./building").ManualBuilding[];
  selectedRadarSites: import("./radar").RadarSite[];
  azSectorsByRadar: Map<string, AzSector[]>;
  losMap: Map<string, import("./los").LoSProfileData>;
  covLayersWithBuildings: import("../utils/radarCoverage").CoverageLayer[];
  covLayersWithout: import("../utils/radarCoverage").CoverageLayer[];
  analysisMonth: string;
  findingsText: string;
  recommendText: string;
  panoWithTargets: Map<string, import("./panorama").PanoramaMergeResult>;
  panoWithoutTargets: Map<string, import("./panorama").PanoramaMergeResult>;
  coverageStatus: "idle" | "loading" | "done" | "error";
  panoramaStatus: "idle" | "loading" | "done" | "error";
  /** 차트 섹션 사전 캡처 이미지 (key: sectionId, value: WebP data URL) */
  sectionImages: Map<string, string>;
}
