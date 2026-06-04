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
  /** LoS 단면도 표시용 건물 방위각 목록 (±5° 이내만 track_points_geo에 포함) */
  building_bearings_deg?: number[];
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
  ssr_combined_points: number;
  psr_rate: number;
  total_track_time_secs: number;
  total_loss_time_secs: number;
  loss_rate: number;
  loss_points_summary: LossPointGeo[];
  /** 전체 방위(분석 구간 포함) 기준 Loss율 (%) */
  baseline_loss_rate: number;
  /** 전체 방위(분석 구간 포함) 기준 PSR율 (0~1) */
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
  /** 건물 그룹 메타 (배지 색·이름 표시용) — 선택된 건물의 group_id 가 참조 */
  buildingGroups: import("./building").BuildingGroup[];
  selectedRadarSites: import("./radar").RadarSite[];
  azSectorsByRadar: Map<string, AzSector[]>;
  losMap: Map<string, import("./los").LoSProfileData>;
  /** 레이더별 커버리지 레이어 (key: radarName) */
  covLayersWithBuildings: Map<string, import("../utils/radarCoverage").CoverageLayer[]>;
  covLayersWithout: Map<string, import("../utils/radarCoverage").CoverageLayer[]>;
  analysisMonth: string;
  findingsText: string;
  /** 인라인 편집 텍스트 오버라이드 (편집키 → 사용자 수정 문구). 기본 자동 문구를 덮어씀. */
  textOverrides?: Record<string, string>;
  /** 차트 줌 상태 (편집키 → [시작%, 끝%], 0~100). LoS 단면도 X축 줌 등. PDF·재로딩에 반영. */
  chartZooms?: Record<string, [number, number]>;
  panoWithTargets: Map<string, import("./panorama").PanoramaMergeResult>;
  panoWithoutTargets: Map<string, import("./panorama").PanoramaMergeResult>;
  coverageStatus: "idle" | "loading" | "done" | "error";
  panoramaStatus: "idle" | "deferred" | "loading" | "done" | "error";
}
