/**
 * "ASTERIX 통계" 상세 페이지 타입 — Rust(parser::ass) scan_asterix_detail 직렬화 구조와 1:1 대응.
 * 응답은 대용량 IPC 규칙에 따라 BulkRef(bulk://)로 수신 → readBulkJson<AsterixDetailStats>.
 */

import type { AsterixStats, CollectionGap, LabeledCount } from "./asterix";

/** 시각 표기 모드 (대시보드와 동일) */
export type TzMode = "UTC" | "KST";

/**
 * 상세 재집계 필터 — Rust AsterixDetailFilter(#[serde(rename_all = "camelCase")])와 1:1.
 * 레코드 단위 적용: 설정된 모든 조건 AND, 조건 대상 필드가 없는 레코드는 해당 조건 불통과.
 * 예외(시각): abs_time 없는 CAT034/008 레코드는 같은 프레임의 첫 CAT048 abs_time으로 판정,
 * 그것도 없으면 제외 — 기간 필터 하에서도 회전주기/메시지유형 통계가 유지되도록.
 */
export interface AsterixDetailFilter {
  /** 절대 Unix 초 범위 */
  timeMin?: number;
  timeMax?: number;
  /** SAC/SIC 쌍 — 둘 다 지정 시에만 의미 (한쪽만 지정도 허용: 해당 값만 일치) */
  sac?: number;
  sic?: number;
  /** Mode-S hex 부분일치 (대문자 정규화는 Rust에서) */
  modeS?: string;
  /** 특정 카테고리(0x30/0x22/0x08) 레코드만 */
  cat?: number;
  /** Mode-3/A 옥탈 4자리 정확일치 (유효 V/G=0 값만) */
  mode3a?: string;
  /** true=SIM 표적만, false=SIM 제외 (I020 부재 레코드는 비SIM 취급) */
  sim?: boolean;
  /** ACAS RA(I260) 보유 레코드만 */
  hasAcas?: boolean;
  /** 비상코드(7500/7600/7700) 레코드만 */
  hasEmergency?: boolean;
  /** I048/040 ρ 범위 (NM) */
  rangeMinNm?: number;
  rangeMaxNm?: number;
  /** I048/040 θ 범위 (도). azMin > azMax 이면 0° 통과 랩어라운드 구간 */
  azMinDeg?: number;
  azMaxDeg?: number;
  /** I048/090 FL 범위 (FL 단위 = 100ft) */
  flMin?: number;
  flMax?: number;
  /** I048/200 대지속도 범위 (kt) */
  speedMinKts?: number;
  speedMaxKts?: number;
  /**
   * PSR 채널 소실 임계 (초, 기본 7.0). 레코드 필터가 아니라 psr_channel 분석 파라미터라
   * DetailMatcher 는 무시한다 — 다만 캐시 키(filter JSON)에는 들어가므로 값이 바뀌면 재스캔된다.
   */
  psrLossThresholdSecs?: number;
}

/** Mode-S 주소별 상세 (count 내림차순, 상한 2,000) */
export interface ModeSDetailRow {
  /** 6자리 hex */
  mode_s: string;
  count: number;
  callsign: string | null;
  first_ts: number | null;
  last_ts: number | null;
  fl_min: number | null;
  fl_max: number | null;
  speed_mean_kts: number | null;
  range_min_nm: number | null;
  range_max_nm: number | null;
  /** 관측된 Mode-3/A 코드 (옥탈 4자리, 최대 8개) */
  mode3a_codes: string[];
  acas_count: number;
  emergency_count: number;
  /** 고유 트랙번호 수 (SAC/SIC 구분) */
  track_numbers: number;
}

/** Mode-3/A 코드별 상세 (count 내림차순, 전체 ≤4096) */
export interface Mode3ADetailRow {
  /** 옥탈 4자리 */
  code: string;
  count: number;
  distinct_mode_s: number;
  first_ts: number | null;
  last_ts: number | null;
}

/** 비상코드 발생 이벤트 (시각 오름차순, 상한 1,000) */
export interface EmergencyEvent {
  ts: number | null;
  mode_s: string | null;
  /** 옥탈 4자리 */
  code: string;
  sac: number;
  sic: number;
}

/** ACAS RA 발생 이벤트 (시각 오름차순, 상한 1,000) */
export interface AcasEvent {
  ts: number | null;
  mode_s: string | null;
  sac: number;
  sic: number;
}

/** BDS 레지스터별 상세 — key/label 은 기존 bds_reg_counts 규칙과 동일 */
export interface BdsRegDetailRow {
  key: string;
  label: string;
  /** MB 블록 수 */
  count: number;
  distinct_mode_s: number;
}

/** SAC/SIC 출처별 분해 (records 내림차순) */
export interface SourceBreakdownRow {
  sac: number;
  sic: number;
  records: number;
  cat048: number;
  cat034: number;
  cat008: number;
  modes_distinct: number;
  time_min: number | null;
  time_max: number | null;
}

/** PPI 히트맵 그리드 상수 — Rust와 반드시 동기 유지 */
export const AZ_GRID_SECTORS = 72; // 5° 섹터
export const RANGE_GRID_BINS = 52; // 5NM 구간 (0–260NM)

/**
 * scan_asterix_detail 반환 (BulkRef → readBulkJson).
 *
 * 구조/필터 구분:
 * - 구조적(필터 무관): stats.file_count/total_bytes/frame_count/block_count/skipped_bytes/
 *   parse_errors/cat_counts[].blocks/nec_dates/files[].bytes·frames·time_min·time_max
 * - 필터 적용(레코드 파생 전부): stats.record_count, 모든 히스토그램/상위/공백/회전 통계,
 *   files[].records, 레코드 플래그 품질지표(truncated_records/mode3a_garbled/fl_v_invalid/fl_g_garbled)
 */
export interface AsterixDetailStats {
  /** 필터 적용 재집계 — 기존 대시보드 구조 그대로 재사용 */
  stats: AsterixStats;
  /** 필터 전 전체 레코드 수 (필터 커버리지 표시용: record_count / unfiltered_records) */
  unfiltered_records: number;
  /** I040 ρ 1NM 구간 [0..256), 인덱스 = floor(NM) (255 클램프) */
  range_fine: number[];
  /** I040 θ 1° 구간 [0..360) */
  azimuth_fine: number[];
  /** PPI 히트맵: AZ_GRID_SECTORS(5°) × RANGE_GRID_BINS(5NM), idx = az*RANGE_GRID_BINS + r */
  az_range_grid: number[];
  /** I090 고도 500ft 구간 (label 예: "4,000–4,500 ft", 음수 허용) */
  fl_fine: LabeledCount[];
  /** I200 속도 10kt 구간 */
  speed_fine: LabeledCount[];
  /** 시간대(hour-of-day) 레코드 수 — UTC 기준 24개 (KST 표시는 프런트 +9 시프트) */
  hourly_utc: number[];
  /** Mode-S 주소별 상세 (count 내림차순, 상한 2,000) */
  modes_table: ModeSDetailRow[];
  modes_table_truncated: boolean;
  /** Mode-3/A 코드별 상세 (전체) */
  mode3a_table: Mode3ADetailRow[];
  /** BDS 레지스터별 상세 */
  bds_detail: BdsRegDetailRow[];
  /** SAC/SIC 출처별 분해 */
  source_breakdown: SourceBreakdownRow[];
  /** 전체 수집 공백 (길이 내림차순, 상한 2,000 — 대시보드는 상위 50만) */
  gaps_all: CollectionGap[];
  gaps_all_truncated: boolean;
  /** 비상코드 발생 이벤트 (시각 오름차순, 상한 1,000) */
  emergency_events: EmergencyEvent[];
  emergency_events_truncated: boolean;
  /** ACAS RA 발생 이벤트 (시각 오름차순, 상한 1,000) */
  acas_events: AcasEvent[];
  acas_events_truncated: boolean;
  /** PSR(1차 레이더) 채널 탐지·소실 집계 */
  psr_channel: PsrChannelStats;
}

// ─── PSR(1차 레이더) 채널 (토픽 psr) ───────────────────────────────────
//
// Rust analysis::psr_channel 산출과 1:1 (serde snake_case). 거리는 전부 NM.
// 분석 단위는 파일이 아니라 **추적기 트랙(I161)** — 같은 트랙을 공유하는 SSR 계열 보고가
// "트랙은 살아있는데 PSR 이 못 봤다"는 증거가 되므로 TYP 1~7 전 보고를 입력으로 쓴다.

/** 거리 구간 집계 (5NM × RANGE_GRID_BINS, 0–260NM. 260NM 초과는 마지막 빈에 합산) */
export interface PsrRangeBin {
  from_nm: number;
  to_nm: number;
  reports: number;
  psr: number;
  /** 이 빈에 귀속된 signal_loss 런 시간 합 (런 최소 ρ 기준) */
  loss_time_s: number;
}

/** 방위 구간 집계 (5° × AZ_GRID_SECTORS). reports/psr 는 PSR 최대범위(p95) 이내 스캔만 */
export interface PsrAzBin {
  from_deg: number;
  to_deg: number;
  reports: number;
  psr: number;
  /** signal_loss 런 중점 방위 기준 시간 합 */
  loss_time_s: number;
}

/** 트랙 행 (loss_time_s 내림차순, 상한 2,000) */
export interface PsrTrackRow {
  track_number: number;
  /** 최빈 I220 주소 6자리 hex 대문자 */
  mode_s: string | null;
  /** 최빈 Mode-3/A 옥탈 4자리 */
  mode3a: string | null;
  start_ts: number;
  end_ts: number;
  /** 동일스캔 병합 후 스캔 수 */
  report_count: number;
  /** PSR 탐지 스캔 수 (typ ∈ {1,3,6,7}) */
  psr_count: number;
  /** typ==1 스캔 수 */
  psr_only_count: number;
  /** typ ∈ {2,4,5} 스캔 수 */
  ssr_only_count: number;
  min_range_nm: number;
  max_range_nm: number;
  /** psr_count / report_count (0~1) */
  psr_rate: number;
  loss_count: number;
  loss_time_s: number;
  /** PSR 탐지 0건 */
  never_psr: boolean;
  /** 모든 스캔이 typ==1 (SSR 응답 전무) */
  psr_exclusive: boolean;
}

/** 소실 런 위치 — interior=PSR 탐지 사이, head=범위 내 첫 스캔~첫 PSR, tail=마지막 PSR~범위 내 마지막 스캔 */
export type PsrLossKind = "interior" | "head" | "tail";

/** 소실 런 행 (signal_loss 만, duration_s 내림차순, 상한 2,000) */
export interface PsrLossRow {
  track_number: number;
  mode_s: string | null;
  kind: PsrLossKind;
  start_ts: number;
  end_ts: number;
  duration_s: number;
  missed_scans: number;
  /** 런 구간의 SSR 단독 스캔 수 — "트랙 생존 증거" */
  ssr_reports_inside: number;
  start_range_nm: number;
  end_range_nm: number;
  min_range_nm: number;
  /** 시작·끝 극좌표 평면 중점의 방위 */
  mid_azimuth_deg: number;
}

export interface PsrChannelStats {
  /** 동일스캔 병합 후 스캔 수 */
  reports_total: number;
  reports_psr: number;
  reports_psr_only: number;
  reports_ssr_only: number;
  /** 동일 트랙 Δt<1s 병합 건수 */
  same_scan_merged: number;
  tracks_total: number;
  tracks_with_psr: number;
  tracks_never_psr: number;
  /** 모든 스캔이 typ==1 인 트랙 */
  tracks_psr_exclusive: number;
  tracks_split_gap: number;
  tracks_split_mode_s: number;
  tracks_split_speed: number;
  /** 트랙별 Δt 중앙값들의 중앙값. 표본 부족이면 null (폴백 없음) */
  scan_period_s: number | null;
  /** PSR 탐지 스캔 ρ 의 p95 (NM, 클램프 없음) */
  psr_max_range_nm: number;
  loss_threshold_s: number;
  /** PSR 있는 트랙의 (end−start) 합 */
  total_track_time_s: number;
  /** signal_loss 런 시간 합 */
  total_loss_time_s: number;
  /** total_loss_time_s / total_track_time_s (0~1) */
  loss_rate: number;
  loss_runs_signal: number;
  /** 범위 밖 런 — 건수만 집계하고 목록에서는 제외 */
  loss_runs_out_of_range: number;
  /** Σin_range_psr / Σin_range_report (PSR 있는 트랙 한정) */
  psr_detect_rate_in_range: number;
  /** 5NM × RANGE_GRID_BINS */
  range_bins: PsrRangeBin[];
  /** 5° × AZ_GRID_SECTORS */
  az_bins: PsrAzBin[];
  /** PPI 격자 분모 — idx = az*RANGE_GRID_BINS + r (전 스캔) */
  ppi_reports: number[];
  /** PPI 격자 분자 — 같은 인덱스 규약 */
  ppi_psr: number[];
  tracks: PsrTrackRow[];
  tracks_truncated: boolean;
  losses: PsrLossRow[];
  losses_truncated: boolean;
  /** 분석 생략 사유 (스캔주기 추정 불가·PSR 탐지 0건). null 이면 정상 */
  analysis_skipped_reason: string | null;
}

// ─── 상세 페이지 토픽 레지스트리 (사이드바·라우팅·페이지 공용) ────────────

export type AsterixStatTopic =
  | "time"
  | "traffic"
  | "altspeed"
  | "identity"
  | "mode3a"
  | "bds"
  | "source"
  | "psr"
  | "quality";

export interface AsterixStatTopicDef {
  id: AsterixStatTopic;
  /** 사이드바(w-48) 라벨 — 짧게 유지 */
  label: string;
  /** 페이지 헤더 제목 */
  title: string;
  path: string;
}

export const ASTERIX_STAT_TOPICS: AsterixStatTopicDef[] = [
  { id: "time", label: "수집 시간", title: "수집 시간·공백 상세", path: "/asterix/stats/time" },
  { id: "traffic", label: "거리·방위", title: "거리·방위 분포 상세", path: "/asterix/stats/traffic" },
  { id: "altspeed", label: "고도·속도", title: "고도·속도 분포 상세", path: "/asterix/stats/altspeed" },
  { id: "identity", label: "Mode-S 식별", title: "Mode-S 식별 상세", path: "/asterix/stats/identity" },
  { id: "mode3a", label: "Mode-3/A·비상", title: "Mode-3/A·비상코드 상세", path: "/asterix/stats/mode3a" },
  { id: "bds", label: "BDS·ACAS", title: "BDS 레지스터·ACAS 상세", path: "/asterix/stats/bds" },
  { id: "source", label: "출처·메시지", title: "출처·메시지·회전주기 상세", path: "/asterix/stats/source" },
  { id: "psr", label: "PSR 채널", title: "PSR 채널 탐지·소실 상세", path: "/asterix/stats/psr" },
  { id: "quality", label: "품질 지표", title: "파싱 품질 상세", path: "/asterix/stats/quality" },
];
