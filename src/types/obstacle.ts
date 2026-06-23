/** 방위 구간 */
export interface AzSector {
  start_deg: number;
  end_deg: number;
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

/**
 * 추가 차단영역 소실율 산출용 (방위×양각) 시간 히스토그램 셀.
 * 건물-무관 원자료 — 프론트가 건물별 angleWith/angleWithout 컷오프로
 * 추가 차단영역 밴드 셀을 합산해 소실율을 산출한다.
 * 양각은 ITU 4/3 유효지구 곡률(k=4/3) 기준 — pointElevAngleDeg와 동일 프레임.
 * 빈 정의(Rust HIST_* 상수와 일치): az_bin = floor(az/0.1) 0..3600,
 * elev_bin = floor((elev+1.0)/0.05) 0..140 (elev 범위 [-1°, 6°)).
 */
export interface AzElevCell {
  az_bin: number;
  elev_bin: number;
  track_time_s: number;
  loss_time_s: number;
  /** 정상 추적 스캔 포인트 수 (gap ≤ threshold 인 연속 스캔 1건 = 1포인트) */
  track_count: number;
  /** 보간 소실 포인트 수 (소실 gap의 total_missed 보간점을 셀별로 집계) */
  loss_count: number;
}

/** 일별 통계 */
export interface DailyStats {
  date: string;
  day_of_month: number;
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
  /** 전방위 기준선 표본량 — 베이스라인 비율의 가중치(섹터 표본량과 모집단 불일치 방지) */
  baseline_track_time_secs: number;
  baseline_ssr_points: number;
  /** 필터링된 전체 항적 좌표 (LoS 단면도 오버레이용) */
  track_points_geo?: TrackPointGeo[];
  /** 추가 차단영역 분석용 방위×양각 시간 히스토그램 (건물-무관 원자료) */
  az_elev_histogram?: AzElevCell[];
}

/** 추가 차단영역 소실율 — 일별 시계열 항목 */
export interface AddedBlockageDay {
  /** day_of_month */
  day: number;
  /** 그 날 추가 차단영역 소실율 (%) */
  ratePct: number;
  /** 그 날 추가 차단영역 노출시간 (추적+소실, 초) */
  exposureS: number;
}

/**
 * 건물별 추가 차단영역 소실율 결과 (헤드라인 심각도 지표).
 * 노출 조건부 소실율 = Σ(추가 차단영역 내 소실시간) / Σ(추가 차단영역 내 노출시간) × 100%.
 */
export interface AddedBlockageResult {
  /** 월간 추가 차단영역 소실율 (%) */
  lossRatePct: number;
  /** 일별 추세 기울기 (%p/day) */
  trendSlopePctPerDay: number;
  /** 추세 방향 */
  trendDir: "증가" | "감소" | "안정";
  /** 총 노출시간 (추적+소실, 초) */
  exposureTrackTimeS: number;
  /** 총 노출 포인트 수 (추적+소실 스캔 포인트, 밴드 겹침비율 frac 가중 합) */
  exposurePointCount: number;
  /** 소실 포인트 수 (보간 소실 스캔 포인트, 밴드 겹침비율 frac 가중 합) */
  lossPointCount: number;
  /** 관측일수 */
  dayCount: number;
  /** 노출>0 인 일수 */
  daysWithExposure: number;
  /** 일별 시계열 */
  series: AddedBlockageDay[];
  /** 등급 (gradeAddedBlockage) */
  grade: { label: string; color: string };
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
  /**
   * 건물별 추가 차단영역 소실율 결과 (key: `${radarName}_${buildingId}`).
   * 파노라마 준비(panoramaStatus==="done") 후 ReportApp 에서 computeAddedBlockage 으로 1회 산출한다.
   * 라이브 세션 한정 — 저장 기능이 없어 영속/직렬화(SerializedOMData) 대상이 아니며,
   * 보고서 창에서 파노라마 done 직후 풀 result(omDataCacheRef)로부터 재산출된다.
   */
  addedBlockageByKey?: Record<string, AddedBlockageResult>;
}
