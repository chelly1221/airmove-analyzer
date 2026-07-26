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
  /**
   * 부모 gap(소실 이벤트) 전체 지속시간(초) — 이벤트 지속시간 표시용.
   * 같은 이벤트의 보간점 모두 동일 값이므로 점마다 합산하면 N×gap 과대 — 시간 합산엔 share_s 사용.
   */
  duration_s: number;
  /**
   * 소실 gap(이벤트) 고유 번호 — 레이더 결과(RadarMonthlyResult) 내에서 gap 마다 1씩 증가.
   * 같은 이벤트의 보간점들은 같은 event_id. '…건'(이벤트 건수)은 distinct event_id 개수로 집계.
   */
  event_id: number;
  /**
   * gap / total_missed — 보간점 균등 분배 시간(초). 같은 이벤트의 share_s 합 = gap.
   * 히스토그램 loss_per_pt 와 동일 값. 소실시간 합산은 Σ share_s.
   */
  share_s: number;
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
 * 방위 전체 대비 소실율 = Σ(추가 차단영역 밴드 내 소실시간) / Σ(건물 방위창 전체 항적시간) × 100%.
 * 분모는 건물 방위창(노출면 각폭, buildingExtent) 전체·전 양각의 항적시간(정상추적+소실), 분자는 밴드 소실시간.
 */
export interface AddedBlockageResult {
  /** 건물 방위창(노출면 각폭) 전체 항적시간 대비 추가 차단영역 내 소실시간 비율(%) */
  lossRatePct: number;
  /** 일별 추세 기울기 (%p/day) */
  trendSlopePctPerDay: number;
  /** 추세 방향 */
  trendDir: "증가" | "감소" | "안정";
  /** 총 노출시간 = 건물 방위창(노출면 각폭) 전체·전 양각의 항적시간 (정상추적+소실, 초) — 소실율 분모 */
  exposureTrackTimeS: number;
  /** 총 노출 포인트 수 = 방위창 전체 스캔 포인트 (정상추적+소실) — 소실율 분모 표본 */
  exposurePointCount: number;
  /** 소실 포인트 수 = 추가 차단영역 밴드 내 보간 소실 스캔 포인트 (밴드 겹침비율 frac 가중 합) */
  lossPointCount: number;
  /** 관측일수 */
  dayCount: number;
  /** 노출>0 인 일수 */
  daysWithExposure: number;
  /** 일별 시계열 */
  series: AddedBlockageDay[];
  /** 등급 (gradeAddedBlockageDelta, 또는 회색 게이트 라벨) */
  grade: { label: string; color: string };
  /**
   * 판정 방식 — 'delta': 기준데이터(참조 달) 대비 편차(Δ%p) 기준, 'noref': 기준데이터 미적용(회색 "기준데이터 없음").
   * 정합성 통과한 기준데이터가 로드되고 기준 히스토그램이 있을 때만 'delta'. 그 외는 'noref'.
   * ※ 레거시 직렬화 스냅샷에 'absolute' 가 남아 있을 수 있어, 소비처는 !== "delta" 를 전부 기준 미적용으로 취급한다.
   */
  gradingMode: "delta" | "noref";
  /** (delta 모드) 기준월 추가 차단영역 소실율 (%) */
  refLossRatePct?: number;
  /** (delta 모드) 편차 = 분석월 소실율 − 기준월 소실율 (%p). 음수면 기준보다 개선. */
  deltaPp?: number;
  /** (delta 모드) 기준월 노출 포인트 수 (frac 가중 합) — 기준 표본량 표시용 */
  refExposureCount?: number;
  /** (delta 모드) 기준월 라벨 ("YYYY-MM") */
  refMonthLabel?: string;
}

// ─── OM 기준데이터 (참조 달 1달치, 헤드라인 Δ 판정용) ───
//
// 재설계: 등록(register_om_reference)은 원본 ASS 사본을 보관하고 메타만 남긴다. 심각성 판정용
// az×elev 히스토그램은 보고서 생성 시(analyze_obstacle_monthly)에 분석월과 완전히 동일한 쐐기
// 파이프라인으로 기준월 ASS 를 재집계해 산출하며, 각 레이더 결과의 reference(OmRefWedge)로 실려 온다.
// 같은 월 입력이면 분석월 히스토그램과 비트 동일 → Δ=0 이 구조적으로 보장된다.
// 커맨드: register_om_reference(등록=복사만) / list_om_references / delete_om_reference.
// (좌표·안테나고 정합성 게이트는 재집계가 항상 현재 설정을 쓰므로 폐지됨.)

/** OM 기준데이터 메타 (list_om_references·register_om_reference 반환, snake_case Rust 미러) */
export interface OmReferenceMeta {
  radar_name: string;
  month_label: string;
  file_count: number;
  first_date: string;
  last_date: string;
  created_at: string;
  radar_lat: number;
  radar_lon: number;
  radar_altitude: number;
  antenna_height: number;
  /** 보관된 원본 ASS 파일 합계 바이트 — 0이면 미보관(구버전/보관 실패), 재집계 불가 → "재등록 필요" */
  ass_bytes: number;
}

/**
 * 기준월 재집계 결과 (RadarMonthlyResult.reference, Rust OmRefWedge 미러).
 * 분석월과 동일 쐐기 파이프라인으로 기준월 ASS 를 재집계한 **일별** 히스토그램을 그대로 전달한다 —
 * 월간 합산하지 않고 분석월 daily_stats 와 동일 직렬화(일별 ser_s3·hist_to_sorted_cells 정렬 셀)로 담는다.
 * computeAddedBlockage 가 분석월과 동일 코드·동일 순서로 일별 accumulateBand 합산 →
 * 표시 정밀도까지 비트 동일(같은 월 → Δ=0). totals 는 로그·유지 목적.
 */
export interface OmRefWedge {
  month_label: string;
  /** 일별 방위×양각 시간 히스토그램 (date 오름차순 — 분석월 daily_stats 와 동일 순서·직렬화) */
  daily: { date: string; az_elev_histogram: AzElevCell[] }[];
  total_track_time_secs: number;
  total_loss_time_secs: number;
  day_count: number;
  source_file_count: number;
}

/**
 * 전체표적 히트맵 그리드 (레이더 중심 ±150NM, 전방위, 전수 카운트, 월간 누적).
 * 표시 전용 — 보고서 통계 스코프(60NM)와 무관. 거리 컷(60NM) 이전에 그리드 bbox 이내 전 표적을
 * 누적하므로 60NM 밖 표적도 표시 창 안이면 포함(§1 결합 히트맵 ReportOMTargetHeatmapMap).
 * Rust TrackHeatmap 미러 (snake_case). 희소 — cells/counts 병렬 배열(점유 셀만).
 * idx = iy * nx + ix (ix: 경도 방향 0..nx, iy: 위도 방향 0..ny).
 * 셀 지오 사각형: lat0 = min_lat + iy*cell_deg_lat, lon0 = min_lon + ix*cell_deg_lon.
 */
export interface TrackHeatmap {
  min_lat: number;
  min_lon: number;
  cell_deg_lat: number;
  cell_deg_lon: number;
  nx: number;
  ny: number;
  cells: number[];
  counts: number[];
  max_count: number;
}

/** 레이더별 월간 결과 */
export interface RadarMonthlyResult {
  radar_name: string;
  daily_stats: DailyStats[];
  avg_loss_altitude_ft: number;
  total_files_parsed: number;
  total_points_filtered: number;
  failed_files: string[];
  /** 전체표적 히트맵 (±150NM 전방위 전수 밀도, 표시 전용 — 통계 스코프 60NM 와 무관) — 구버전 캐시엔 없을 수 있음 */
  track_heatmap?: TrackHeatmap | null;
  /**
   * 기준월(참조 달) 재집계 결과 — 보고서 생성 시 백엔드가 분석월과 동일 쐐기 파이프라인으로 재집계해 실어 보낸다.
   * 있으면(daily 존재) computeAddedBlockage 가 Δ 판정, 없으면 noref. 미등록/미보관/재집계 실패 시 null/undefined.
   */
  reference?: OmRefWedge | null;
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
