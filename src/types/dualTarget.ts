/**
 * 이중표적(레이더 반사 유령표적) 분석 타입 계약
 *
 * 데이터 흐름 (메인 창 독립 페이지 src/pages/DualTargetAnalysis.tsx, 경로 /dualtarget):
 *  1. 파서(ass.rs)가 제거하는 유령표적 포인트를 ParsedFile.ghost_points 로 보존
 *     → lib.rs 가 "parse-ghost-chunk" 이벤트로 emit → 이중표적 분석 페이지 리스너가 자체 파싱분에
 *     radar_name 태깅 후 → postGhostPointsToWorker() 로 자기 창 Worker 에 축적 (ADD_GHOST_POINTS)
 *  2. 같은 페이지의 "분석 실행" → analyzeDualTargets() → Worker ANALYZE_DUAL_TARGETS
 *     → 잔존 동일스캔 중복(scan) + 파서 보존분(parser) 병합 탐지 → DualTargetResult 반환
 *
 * 좌표·단위: WGS84 deg, 거리 km, 고도 m MSL, 방위 진북 기준 0–360°.
 */

/** 이중표적 이벤트를 구성하는 개별 관측 (레이더 기준 극좌표는 lat/lon 에서 재계산) */
export interface DualTargetObservation {
  timestamp: number;
  latitude: number;
  longitude: number;
  altitude: number;
  /** 레이더로부터의 수평 거리 (haversine, km) */
  range_km: number;
  /** 레이더 기준 방위각 (진북 0–360°) */
  azimuth_deg: number;
  radar_type: string;
}

/** 예상 반사 위치 — 레이더·실표적을 초점으로 하는 타원(경로합 = 유령 거리)과
 *  유령 방위선의 교점. extra_path_km 이 미미하면 해가 없어 null. */
export interface DualTargetReflector {
  latitude: number;
  longitude: number;
  /** 레이더 → 반사점 거리 (km) */
  range_km: number;
  /** 레이더 기준 반사점 방위 (= 유령표적 방위, deg) */
  azimuth_deg: number;
}

export interface DualTargetEvent {
  id: number;
  mode_s: string;
  radar_name: string;
  /** 실표적 관측. source==="parser" 로 동일스캔 실측 짝이 없으면 전후 궤적 보간 위치 */
  real: DualTargetObservation;
  /** 유령표적(반사) 관측 */
  ghost: DualTargetObservation;
  /** 실–유령 수평 이격 거리 (km) */
  separation_km: number;
  /** 반사 여정 초과분: ghost.range_km − real.range_km (양수 = 반사 기하 부합) */
  extra_path_km: number;
  reflector: DualTargetReflector | null;
  /** scan = 워커 잔존 중복 탐지, parser = 파싱 단계 제거 보존분 */
  source: "scan" | "parser";
  /** high = 반사 기하 부합(extra_path_km > 0.2), low = 기하 불부합/모호 */
  confidence: "high" | "low";
  /** 소속 반사 클러스터 id (reflector 없으면 null) */
  cluster_id: number | null;
}

/** 반사 위치 클러스터 (~250m 그리드 병합, count 내림차순 id 부여) */
export interface ReflectorCluster {
  id: number;
  /** 소속 이벤트 반사점의 평균 좌표 */
  latitude: number;
  longitude: number;
  count: number;
  radar_name: string;
  /** UI 단계에서 find_building_near_point 로 채움 (분석 결과에는 undefined) */
  building_name?: string | null;
}

export interface DualTargetStats {
  flights_scanned: number;
  points_scanned: number;
  /** 워커에 축적된 파서 보존 유령 포인트 수 (분석 대상 전체) */
  parser_ghosts: number;
  events_scan: number;
  events_parser: number;
  /** 실표적 짝·보간 불가로 폐기된 파서 보존분 수 */
  dropped_unmatched: number;
  /** 이벤트에 관련된 고유 mode_s 수 */
  aircraft_count: number;
  /** 레이더 사이트 좌표 미매칭으로 건너뛴 비행 수 */
  skipped_no_site: number;
}

export interface DualTargetParams {
  /** 동일 스캔 판정 윈도우 (초, 기본 0.5) */
  scan_window_s: number;
  /** 이중표적 최소 이격 거리 (km, 기본 1.0) */
  min_sep_km: number;
}

export interface DualTargetResult {
  events: DualTargetEvent[];
  clusters: ReflectorCluster[];
  stats: DualTargetStats;
  params: DualTargetParams;
}

/** 한 기체(Mode-S)의 전체 항적 — 워커 QUERY_MODE_S_TRACK 응답.
 *  메인 스레드에 TrackPoint 객체를 만들지 않도록 typed array 만 transfer 로 받는다. */
export interface ModeSTrack {
  modeS: string;
  /** 이 기체의 비행 편수 (startIndices 길이 − 1) */
  flightCount: number;
  pointCount: number;
  /** [lon0,lat0, lon1,lat1, …] 비행 순(startTime asc) 연결 */
  positions: Float64Array;
  /** 비행별 시작 인덱스(길이 flightCount+1, 마지막 = pointCount) — PathLayer binary startIndices */
  startIndices: Uint32Array;
  bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } | null;
}
