/**
 * "ASTERIX 분석" 탭 타입 — Rust(parser::ass) 직렬화 구조와 1:1 대응 (snake_case).
 */

export interface CatCount {
  cat: number;
  blocks: number;
  records: number;
}

export interface FrnCount {
  id: string;
  name: string;
  count: number;
}

export interface SacSicCount {
  sac: number;
  sic: number;
  count: number;
}

export interface LabeledCount {
  key: string;
  label: string;
  count: number;
}

export interface AsterixFileStat {
  filename: string;
  bytes: number;
  frames: number;
  records: number;
  /** 파일 내 레코드 절대시각(Unix 초) 최소/최대 */
  time_min: number | null;
  time_max: number | null;
  /** I140 TOD→UTC 자동보정량(시간). 0 = 보정 없음 */
  tod_shift_hours: number;
}

/** 시간대별 레코드 밀도 (수집 공백 시각화용, 버킷 ≤ 1,440개) */
export interface TimeDensity {
  /** 첫 버킷 시작 Unix 초 (분 정렬) */
  start_ts: number;
  /** 버킷 폭(초), 60의 배수 */
  bucket_secs: number;
  /** 버킷별 레코드 수 (빈 구간은 0) */
  counts: number[];
}

/** 대시보드 집계 통계 (scan_asterix_batch 반환) */
export interface AsterixStats {
  file_count: number;
  total_bytes: number;
  frame_count: number;
  block_count: number;
  record_count: number;
  skipped_bytes: number;
  parse_errors: number;
  truncated_records: number;
  cat_counts: CatCount[];
  cat048_frn_counts: FrnCount[];
  radar_typ_counts: LabeledCount[];
  sac_sic_counts: SacSicCount[];
  modes_distinct: number;
  modes_top: LabeledCount[];
  msg_type_034: LabeledCount[];
  msg_type_008: LabeledCount[];
  tod_min: number | null;
  tod_max: number | null;
  time_min: number | null;
  time_max: number | null;
  nec_dates: string[];
  acas_ra_records: number;
  mode3a_garbled: number;
  /** 시간대별 레코드 밀도 — abs_time 보유 레코드가 없으면 null */
  time_density: TimeDensity | null;
  /** I048/040 ρ 10NM 구간 히스토그램 */
  range_hist: LabeledCount[];
  /** I048/040 θ 10° 섹터 히스토그램 (관측 있으면 길이 36, 없으면 빈 배열) */
  azimuth_hist: number[];
  /** I048/090 고도 1,000ft 구간 히스토그램 */
  fl_hist: LabeledCount[];
  /** I048/090 V=1(미검증) 레코드 수 */
  fl_v_invalid: number;
  /** I048/090 G=1(garbled) 레코드 수 */
  fl_g_garbled: number;
  files: AsterixFileStat[];
}

/** 온디맨드 프레임 요약 (query_asterix_frames 반환) */
export interface AsterixFrameSummary {
  file_index: number;
  frame_offset: number;
  byte_len: number;
  cats: number[];
  record_count: number;
  mode_s_list: string[];
  tod: number | null;
  abs_time: number | null;
  has_acas: boolean;
  /** 프레임 전문 hex (asterixDecoder.decodeFrame 입력) */
  frame_hex: string;
}

export interface AsterixQueryResult {
  total_matched: number;
  truncated: boolean;
  frames: AsterixFrameSummary[];
}

/** 조회 필터 — Rust AsterixFilter(camelCase)로 전송 */
export interface AsterixFilter {
  modeS?: string;
  cat?: number;
  timeMin?: number;
  timeMax?: number;
  hasAcas?: boolean;
}
