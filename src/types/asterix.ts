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

/** CAT034 안테나 회전주기 통계 (SAC/SIC별) */
export interface RotationStat {
  sac: number;
  sic: number;
  /** North marker 메시지 수 */
  north_count: number;
  /** 유효 간격 수 (= 산출된 회전 수) */
  interval_count: number;
  period_mean_s: number;
  period_std_s: number;
  period_min_s: number;
  period_max_s: number;
  /** I034/041 보고 회전주기 평균 (관측 없으면 null) */
  reported_period_s: number | null;
  sector_msgs: number;
  /** 1회전당 섹터 수 최빈값 (관측 없으면 null) */
  expected_sectors: number | null;
  /** Σ(expected − 실제 섹터수) */
  missing_sectors: number;
}

/** BDS 2,0 에서 얻은 Mode-S 주소별 호출부호 */
export interface ModeSCallsign {
  /** 6자리 hex */
  mode_s: string;
  callsign: string;
}

/** 수집 공백 구간 (분 해상도) */
export interface CollectionGap {
  /** 공백 시작 Unix 초 (마지막 관측 분의 다음 분 경계) */
  start_ts: number;
  /** 공백 끝 Unix 초 (다음 관측 분 경계) */
  end_ts: number;
  duration_secs: number;
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
  /** I048/070 유효(V/G=0) Mode-3/A 고유 코드 수 */
  mode3a_distinct: number;
  /** I048/070 유효 Mode-3/A 보유 레코드 총수 (상위 분포 분모) */
  mode3a_records: number;
  /** I048/070 Mode-3/A 상위 30 (key/label = 옥탈 4자리) */
  mode3a_top: LabeledCount[];
  /** 비상코드 — 항상 3개 고정 [7700, 7600, 7500], 0 포함 */
  emergency_counts: LabeledCount[];
  /** 비상 3코드 합계 레코드 수 */
  emergency_records: number;
  /** I048/200 속도 50kt 구간 히스토그램 */
  speed_hist: LabeledCount[];
  /** I048/200 속도 10kt 미만 레코드 수 */
  speed_low_records: number;
  /** I048/200 속도 600kt 초과 레코드 수 */
  speed_high_records: number;
  /** I048/020 SIM=1(시뮬레이션 표적) 레코드 수 */
  sim_records: number;
  /** I048/161 트랙번호 고유 수 (SAC/SIC 구분) */
  track_numbers_distinct: number;
  /** CAT034 안테나 회전주기 (SAC/SIC별, 회전수 내림차순) */
  rotation_stats: RotationStat[];
  /** I048/250 BDS 레지스터 분포 (MB 블록 기준, 내림차순) */
  bds_reg_counts: LabeledCount[];
  /** BDS 2,0 호출부호 (Mode-S 주소 오름차순) */
  mode_s_callsigns: ModeSCallsign[];
  /** 수집 공백 상위 50 (길이 내림차순) */
  gaps: CollectionGap[];
  /** 전체 수집 공백 수 */
  gap_count: number;
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
  /** 프레임 내 출현한 Mode-3/A 비상코드 (옥탈 4자리, 중복 제거) */
  emergency_codes: string[];
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
  /** Mode-3/A 비상코드(7500/7600/7700) 포함 프레임만 */
  hasEmergency?: boolean;
}
