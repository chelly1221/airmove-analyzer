use std::collections::HashMap;

use log::{debug, info, warn};

use crate::models::{ParseStatistics, RadarDetectionType, TcasReport, TrackPoint, WeatherVector};

const CAT048: u8 = 0x30;
const CAT034: u8 = 0x22;
const CAT008: u8 = 0x08;
const MAX_BLOCK_LEN: usize = 65535;

const MAX_TIME_OF_DAY: f64 = 86401.0;
const MAX_FLIGHT_LEVEL: f64 = 1300.0;
const MAX_SPEED_KTS: f64 = 2000.0;

// UAP (User Application Profile) item indices for CAT048
const UAP_I010: usize = 0;
const UAP_I140: usize = 1;
const UAP_I020: usize = 2;
const UAP_I040: usize = 3;
const UAP_I070: usize = 4;
const UAP_I090: usize = 5;
const UAP_I130: usize = 6;
const UAP_I220: usize = 7;
const UAP_I240: usize = 8;
const UAP_I250: usize = 9;
const UAP_I161: usize = 10;
const UAP_I042: usize = 11;
const UAP_I200: usize = 12;
const UAP_I170: usize = 13;
const UAP_I210: usize = 14;
const UAP_I030: usize = 15;
const UAP_I080: usize = 16;
const UAP_I100: usize = 17;
const UAP_I110: usize = 18;
const UAP_I120: usize = 19;
const UAP_I230: usize = 20;
const UAP_I260: usize = 21;
const UAP_I055: usize = 22;
const UAP_I050: usize = 23;
const UAP_I065: usize = 24;
const UAP_I060: usize = 25;
const UAP_SP: usize = 26;
const UAP_RE: usize = 27;
const UAP_MAX: usize = 28;

// ─── ATCRBS 병합 상수 ───
/// Mode-S와 ATCRBS가 같은 스캔이려면 이 시간 이내
const ATCRBS_MERGE_TIME_GAP: f64 = 6.0;
/// 최대 이동속도 km/s (500kts ≈ 0.257 km/s)
const ATCRBS_MERGE_MAX_SPEED_KMS: f64 = 0.257;
/// 거리 마진 (레이더 위치 오차 등)
const ATCRBS_MERGE_MARGIN_KM: f64 = 2.0;

#[derive(Debug)]
pub enum ParseError {
    FileReadError(String),
    InvalidFormat(String),
    RecordError { offset: usize, message: String },
}

impl std::fmt::Display for ParseError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ParseError::FileReadError(e) => write!(f, "File read error: {}", e),
            ParseError::InvalidFormat(e) => write!(f, "Invalid format: {}", e),
            ParseError::RecordError { offset, message } => {
                write!(f, "Record error at offset {:#x}: {}", offset, message)
            }
        }
    }
}

impl std::error::Error for ParseError {}

/// Parsed CAT048 record (internal representation before conversion to TrackPoint)
#[derive(Default)]
struct Cat048Record {
    sac: u8,
    sic: u8,
    time_of_day: Option<f64>,
    rho_nm: Option<f64>,
    theta_deg: Option<f64>,
    cart_x_nm: Option<f64>,
    cart_y_nm: Option<f64>,
    flight_level: Option<f64>,
    ground_speed_kts: Option<f64>,
    heading_deg: Option<f64>,
    mode_s_address: Option<u32>,
    mode3a: Option<u16>,
    mode3a_garbled: bool,
    /// I048/090 V 플래그 (1 = 고도 미검증) — 통계 전용, 고도 채택 정책에는 미개입
    fl_v_flag: bool,
    /// I048/090 G 플래그 (1 = 고도 garbled) — 통계 전용, 고도 채택 정책에는 미개입
    fl_g_flag: bool,
    radar_typ: u8,
    sim_flag: bool,
    track_number: Option<u16>,
    /// I048/260 ACAS RA Report (7바이트) — 있을 때만
    acas_ra_report: Option<[u8; 7]>,
    /// I048/250 Mode-S MB 블록 중 BDS 3,0 (ACAS Active RA) 의 7바이트 페이로드
    bds30_mb: Option<[u8; 7]>,
    /// I048/250 Mode-S MB 블록 중 BDS 1,6 (ACAS Coordination Reply) 의 7바이트 페이로드
    bds16_mb: Option<[u8; 7]>,
    /// I048/250 MB 블록별 BDS 식별 바이트(BDS1<<4|BDS2) — 통계 전용, 최대 8개 고정 배열(힙 할당 없음)
    bds_regs: [u8; 8],
    /// bds_regs 유효 길이 (REP > 8 초과분은 무시)
    bds_regs_len: u8,
    /// I048/250 Mode-S MB 블록 중 BDS 2,0 (항공기 식별) 의 7바이트 페이로드 — 최초 1개만
    bds20_mb: Option<[u8; 7]>,
}

/// 유령 표적 탐지용 추가 데이터 (극좌표 + Track Number)
struct RecordExtra {
    rho_nm: f64,
    theta_deg: f64,
    track_number: Option<u16>,
}

/// 내부 표현: TrackPoint + 유령 탐지용 극좌표/트랙번호
struct RichTrackPoint {
    point: TrackPoint,
    _track_number: Option<u16>,
    _rho_nm: f64,
    _theta_deg: f64,
}

/// 분류 결과
enum RecordOutcome {
    /// 폐기 (PSR-only, 좌표 없음, TYP 무효 등)
    Discard,
    /// Mode-S 식별된 포인트 (TrackPoint, Mode 3/A for ATCRBS 매핑, RecordExtra)
    ModesSPoint(TrackPoint, Option<u16>, RecordExtra),
    /// ATCRBS 포인트 (Mode-S 없음, 이후 병합 대상)
    AtcrbsPoint(TrackPoint, Option<u16>),
}

/// 빠른 Haversine 근사 (km)
fn quick_dist_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    6371.0 * 2.0 * a.sqrt().asin()
}

/// 항적 조립기 — Mode-S별 포인트 + ATCRBS 병합 + 유령 표적 제거 + 중복 제거
struct TrackAssembler {
    /// Mode-S별 확정 항적 (mode_s → Vec<RichTrackPoint>)
    tracks: HashMap<String, Vec<RichTrackPoint>>,
    /// Mode-S → 해당 스캔 시각들(+좌표) (ATCRBS 근접 검증용)
    ms_timestamps: HashMap<String, Vec<(f64, f64, f64)>>, // (timestamp, lat, lon)
    /// Mode 3/A → Mode-S 매핑 (ATCRBS 병합용)
    mode3a_to_modes: HashMap<u16, String>,
    /// ATCRBS 포인트 임시 보관 (병합 전)
    atcrbs_pool: Vec<(TrackPoint, Option<u16>)>,
    /// 항적에서 제거된 유령표적 포인트 보존분 (이중표적 분석용, 전수 보존)
    removed_ghosts: Vec<TrackPoint>,
    /// 통계
    stats: ParseStatistics,
}

impl TrackAssembler {
    fn new() -> Self {
        Self {
            tracks: HashMap::new(),
            ms_timestamps: HashMap::new(),
            mode3a_to_modes: HashMap::new(),
            atcrbs_pool: Vec::new(),
            removed_ghosts: Vec::new(),
            stats: ParseStatistics::default(),
        }
    }

    /// Mode-S 포인트 삽입 (Mode 3/A → Mode-S 매핑 갱신)
    fn insert(&mut self, rtp: RichTrackPoint, mode3a: Option<u16>) {
        let ms = rtp.point.mode_s.clone();
        let ts = rtp.point.timestamp;
        let lat = rtp.point.latitude;
        let lon = rtp.point.longitude;

        // 타입별 카운트 (6종 분류)
        match rtp.point.radar_type {
            RadarDetectionType::ModeAC => self.stats.points_by_type[0] += 1,
            RadarDetectionType::ModeACPsr => self.stats.points_by_type[1] += 1,
            RadarDetectionType::ModeSAllCall => self.stats.points_by_type[2] += 1,
            RadarDetectionType::ModeSRollCall => self.stats.points_by_type[3] += 1,
            RadarDetectionType::ModeSAllCallPsr => self.stats.points_by_type[4] += 1,
            RadarDetectionType::ModeSRollCallPsr => self.stats.points_by_type[5] += 1,
        }

        self.tracks.entry(ms.clone()).or_default().push(rtp);
        self.ms_timestamps
            .entry(ms.clone())
            .or_default()
            .push((ts, lat, lon));

        // Mode 3/A → Mode-S 매핑 갱신 (SSR Mode S 응답에 Mode 3/A도 포함된 경우)
        if let Some(m3a) = mode3a {
            self.mode3a_to_modes.entry(m3a).or_insert(ms);
        }
    }

    /// ATCRBS 포인트 임시 보관
    fn insert_atcrbs(&mut self, tp: TrackPoint, mode3a: Option<u16>) {
        self.atcrbs_pool.push((tp, mode3a));
    }

    /// ATCRBS 병합: Mode 3/A 매핑 + 시공간 근접 검증
    fn merge_atcrbs(&mut self, incl_ms: &std::collections::HashSet<String>, excl_ms: &std::collections::HashSet<String>) {
        if self.atcrbs_pool.is_empty() {
            return;
        }

        let pool = std::mem::take(&mut self.atcrbs_pool);
        let mut merged = 0usize;
        let mut unmatched = 0usize;
        let mut no_mode3a = 0usize;

        // Mode-S 별 시각 인덱스 (이진 탐색용 정렬)
        let mut ms_sorted: HashMap<&str, Vec<usize>> = HashMap::new();
        for (ms, timestamps) in &self.ms_timestamps {
            let mut indices: Vec<usize> = (0..timestamps.len()).collect();
            indices.sort_by(|&a, &b| {
                timestamps[a]
                    .0
                    .partial_cmp(&timestamps[b].0)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });
            ms_sorted.insert(ms.as_str(), indices);
        }

        let ms_timestamps = &self.ms_timestamps;

        for (point, mode3a) in pool {
            // Mode 3/A로 Mode-S 매핑 검색
            let matched_ms = match mode3a {
                Some(m3a) => self.mode3a_to_modes.get(&m3a).cloned(),
                None => {
                    no_mode3a += 1;
                    None
                }
            };

            // 매칭된 Mode-S가 없으면 skip
            let ms_code = match &matched_ms {
                Some(ms) => ms.as_str(),
                None => {
                    unmatched += 1;
                    continue;
                }
            };

            // 포함/제외 필터 체크
            let ms_upper = ms_code.to_uppercase();
            if !incl_ms.is_empty() && !incl_ms.contains(&ms_upper) {
                continue;
            }
            if excl_ms.contains(&ms_upper) {
                continue;
            }

            // 시공간 근접 검증
            let distance_ok = if let Some(ref_pts) = ms_timestamps.get(ms_code) {
                if let Some(sorted_idx) = ms_sorted.get(ms_code) {
                    // 이진 탐색으로 시간 근접 후보 찾기
                    let target_ts = point.timestamp;
                    let search_pos = sorted_idx.partition_point(|&idx| ref_pts[idx].0 < target_ts - ATCRBS_MERGE_TIME_GAP);
                    let end_pos = sorted_idx.len().min(search_pos + 20); // 최대 20개만 검사

                    let candidates = &sorted_idx[search_pos..end_pos];
                    candidates.iter().any(|&idx| {
                        let (ts, lat, lon) = ref_pts[idx];
                        let dt = (point.timestamp - ts).abs();
                        if dt > ATCRBS_MERGE_TIME_GAP {
                            return false;
                        }
                        let dist = quick_dist_km(point.latitude, point.longitude, lat, lon);
                        let max_dist = ATCRBS_MERGE_MAX_SPEED_KMS * dt + ATCRBS_MERGE_MARGIN_KM;
                        dist <= max_dist
                    })
                } else {
                    false
                }
            } else {
                false
            };

            if distance_ok {
                let mut merged_point = point;
                merged_point.mode_s = ms_code.to_string();
                let rtp = RichTrackPoint {
                    point: merged_point,
                    _track_number: None,
                    _rho_nm: 0.0,
                    _theta_deg: 0.0,
                };
                self.tracks.entry(ms_code.to_string()).or_default().push(rtp);
                merged += 1;
            } else {
                unmatched += 1;
            }
        }

        self.stats.atcrbs_merged = merged;
        self.stats.atcrbs_unmatched = unmatched;

        if merged > 0 || unmatched > 0 || no_mode3a > 0 {
            info!(
                "ATCRBS merge: merged={}, unmatched={}, no_mode3a={}",
                merged, unmatched, no_mode3a
            );
        }
    }

    /// 유령 표적 제거: 동일 Mode-S 동일 스캔(0.5초 이내) 내 공간적으로 불일치하는 포인트 제거.
    ///
    /// 판정 조건 (모두 AND):
    /// 1. 동일 Mode-S, 동일 스캔(0.5초 이내)에 2개 이상 포인트 존재
    /// 2. 포인트 간 공간 거리 > 5km
    /// 3. ghost가 전후 정상 궤적 보간 위치로부터 10km 이상 이탈
    /// 4. ghost 제거 시 새로운 gap이 생기지 않음 (Loss 경계 보호)
    fn detect_and_remove_ghosts(&mut self) {
        use crate::analysis::loss::calculate_haversine_distance;

        const SCAN_WINDOW_SECS: f64 = 0.5;
        const MIN_SPATIAL_DIST_KM: f64 = 5.0;
        const TRAJECTORY_DEVIATION_KM: f64 = 10.0;

        for (ms, points) in self.tracks.iter_mut() {
            if points.len() < 3 {
                continue;
            }
            points.sort_by(|a, b| {
                a.point.timestamp
                    .partial_cmp(&b.point.timestamp)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            let mut deltas: Vec<f64> = Vec::new();
            for w in points.windows(2) {
                let dt = (w[1].point.timestamp - w[0].point.timestamp).abs();
                if dt > 0.5 && dt < 30.0 {
                    deltas.push(dt);
                }
            }
            deltas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let median_scan = if deltas.is_empty() { 7.0 } else { deltas[deltas.len() / 2] };
            let gap_threshold = median_scan * 2.0;

            let mut ghost_indices: Vec<usize> = Vec::new();

            let mut cluster_start = 0usize;
            for i in 1..=points.len() {
                let end_cluster = if i == points.len() {
                    true
                } else {
                    (points[i].point.timestamp - points[cluster_start].point.timestamp).abs()
                        > SCAN_WINDOW_SECS
                };

                if !end_cluster {
                    continue;
                }

                let cluster_len = i - cluster_start;
                if cluster_len < 2 {
                    cluster_start = i;
                    continue;
                }

                for a in cluster_start..i {
                    for b in (a + 1)..i {
                        let dist = calculate_haversine_distance(
                            points[a].point.latitude,
                            points[a].point.longitude,
                            points[b].point.latitude,
                            points[b].point.longitude,
                        );
                        if dist < MIN_SPATIAL_DIST_KM {
                            continue;
                        }

                        let prev_idx =
                            if cluster_start > 0 { Some(cluster_start - 1) } else { None };
                        let next_idx = if i < points.len() { Some(i) } else { None };

                        let deviation_a =
                            Self::trajectory_deviation(points, a, prev_idx, next_idx);
                        let deviation_b =
                            Self::trajectory_deviation(points, b, prev_idx, next_idx);

                        let ghost_idx = if deviation_a > deviation_b
                            && deviation_a > TRAJECTORY_DEVIATION_KM
                        {
                            Some(a)
                        } else if deviation_b > TRAJECTORY_DEVIATION_KM {
                            Some(b)
                        } else {
                            None
                        };

                        if let Some(gi) = ghost_idx {
                            let would_create_gap = Self::removal_creates_gap(
                                points,
                                gi,
                                &ghost_indices,
                                gap_threshold,
                            );
                            if !would_create_gap && !ghost_indices.contains(&gi) {
                                ghost_indices.push(gi);
                            }
                        }
                    }
                }

                cluster_start = i;
            }

            if ghost_indices.is_empty() {
                continue;
            }

            ghost_indices.sort_unstable();
            ghost_indices.dedup();
            let removed_count = ghost_indices.len();
            // 제거분은 버리지 않고 보존 (이중표적 분석용) — 항적 제거 동작 자체는 기존과 동일
            for &idx in ghost_indices.iter().rev() {
                let removed = points.remove(idx);
                self.removed_ghosts.push(removed.point);
            }
            self.stats.ghost_points_removed += removed_count;

            if removed_count > 0 {
                info!(
                    "Ghost points removed for {}: {} points",
                    ms, removed_count
                );
            }
        }
    }

    /// 포인트 제거 시 새로운 gap이 생기는지 확인 (Loss 경계 보호)
    fn removal_creates_gap(
        points: &[RichTrackPoint],
        target: usize,
        already_removed: &[usize],
        gap_threshold: f64,
    ) -> bool {
        // target 제거 후 양쪽에 남는 포인트 찾기
        let prev = (0..target)
            .rev()
            .find(|i| !already_removed.contains(i));
        let next = ((target + 1)..points.len())
            .find(|i| !already_removed.contains(i));

        match (prev, next) {
            (Some(pi), Some(ni)) => {
                let gap = (points[ni].point.timestamp - points[pi].point.timestamp).abs();
                gap > gap_threshold
            }
            // 제거하면 끝이나 시작이 잘림 → 보호
            _ => true,
        }
    }

    /// 궤적 이탈도 계산: target 포인트가 prev→next 보간 직선으로부터 얼마나 벗어났는지 (km)
    fn trajectory_deviation(
        points: &[RichTrackPoint],
        target: usize,
        prev_idx: Option<usize>,
        next_idx: Option<usize>,
    ) -> f64 {
        use crate::analysis::loss::calculate_haversine_distance;

        let t = &points[target];

        match (prev_idx, next_idx) {
            (Some(pi), Some(ni)) => {
                let p = &points[pi];
                let n = &points[ni];
                let dt_total = n.point.timestamp - p.point.timestamp;
                if dt_total <= 0.0 {
                    return 0.0;
                }
                let ratio = (t.point.timestamp - p.point.timestamp) / dt_total;
                let interp_lat = p.point.latitude + (n.point.latitude - p.point.latitude) * ratio;
                let interp_lon =
                    p.point.longitude + (n.point.longitude - p.point.longitude) * ratio;
                calculate_haversine_distance(
                    t.point.latitude,
                    t.point.longitude,
                    interp_lat,
                    interp_lon,
                )
            }
            (Some(pi), None) => {
                let p = &points[pi];
                calculate_haversine_distance(
                    t.point.latitude,
                    t.point.longitude,
                    p.point.latitude,
                    p.point.longitude,
                )
            }
            (None, Some(ni)) => {
                let n = &points[ni];
                calculate_haversine_distance(
                    t.point.latitude,
                    t.point.longitude,
                    n.point.latitude,
                    n.point.longitude,
                )
            }
            (None, None) => 0.0,
        }
    }

    /// 공간 이상점 제거: 전후 포인트 대비 비정상적으로 먼 단독 ghost 제거.
    /// Loss 경계 보호: 제거 시 gap이 생기면 보존.
    fn remove_spatial_outliers(&mut self) {
        use crate::analysis::loss::calculate_haversine_distance;

        for (ms, points) in self.tracks.iter_mut() {
            if points.len() < 5 {
                continue;
            }
            points.sort_by(|a, b| {
                a.point.timestamp
                    .partial_cmp(&b.point.timestamp)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            // 중앙값 스캔 주기 계산
            let mut deltas: Vec<f64> = Vec::new();
            for w in points.windows(2) {
                let dt = (w[1].point.timestamp - w[0].point.timestamp).abs();
                if dt > 0.5 && dt < 30.0 {
                    deltas.push(dt);
                }
            }
            deltas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let median_scan = if deltas.is_empty() {
                7.0
            } else {
                deltas[deltas.len() / 2]
            };
            let gap_threshold = median_scan * 2.0;

            let mut outlier_indices: Vec<usize> = Vec::new();

            for i in 1..points.len() - 1 {
                let prev = &points[i - 1];
                let curr = &points[i];
                let next = &points[i + 1];

                let dt_prev = (curr.point.timestamp - prev.point.timestamp).abs();
                let dt_next = (next.point.timestamp - curr.point.timestamp).abs();

                // gap 경계 포인트 보호: 한쪽이라도 gap이면 Loss 경계이므로 건드리지 않음
                if dt_prev > gap_threshold || dt_next > gap_threshold {
                    continue;
                }

                // 시간 간격이 극단적이면 건너뛰기
                if dt_prev > 60.0 || dt_next > 60.0 || dt_prev < 0.1 || dt_next < 0.1 {
                    continue;
                }

                let d_prev = calculate_haversine_distance(
                    prev.point.latitude, prev.point.longitude,
                    curr.point.latitude, curr.point.longitude,
                );
                let d_next = calculate_haversine_distance(
                    curr.point.latitude, curr.point.longitude,
                    next.point.latitude, next.point.longitude,
                );
                let d_pn = calculate_haversine_distance(
                    prev.point.latitude, prev.point.longitude,
                    next.point.latitude, next.point.longitude,
                );

                // 속도 기반: prev→next 예상 속도의 6배 이상이고, 양쪽 모두 비정상
                let dt_pn = dt_prev + dt_next;
                let expected_speed = if dt_pn > 0.0 { d_pn / dt_pn } else { 0.0 };
                let speed_to_prev = d_prev / dt_prev;
                let speed_to_next = d_next / dt_next;
                let speed_implausible = speed_to_prev > expected_speed.max(0.05) * 6.0
                    && speed_to_next > expected_speed.max(0.05) * 6.0;

                // 삼각형: prev→next 직선 대비 극단적 우회 (0.2배 미만) + 최소 10km 이상
                let triangle_outlier =
                    d_pn < d_prev.min(d_next) * 0.2 && d_prev.min(d_next) > 10.0;

                if speed_implausible && triangle_outlier {
                    // 최종 보호: 제거해도 gap이 안 생기는지 확인
                    if !Self::removal_creates_gap(points, i, &outlier_indices, gap_threshold) {
                        outlier_indices.push(i);
                    }
                }
            }

            if outlier_indices.is_empty() {
                continue;
            }

            // 제거분은 버리지 않고 보존 (이중표적 분석용) — 항적 제거 동작 자체는 기존과 동일
            for &idx in outlier_indices.iter().rev() {
                let removed = points.remove(idx);
                self.removed_ghosts.push(removed.point);
            }
            self.stats.ghost_points_removed += outlier_indices.len();

            info!(
                "Spatial outlier removal for {}: {} outlier points removed",
                ms, outlier_indices.len()
            );
        }
    }

    /// 동일 위치 중복 제거 (같은 Mode-S, 2초 이내, 1km 미만 거리 → 우선순위 낮은 레이더 타입 제거)
    fn dedup_same_position(&mut self) {
        for (_ms, points) in self.tracks.iter_mut() {
            if points.len() < 2 {
                continue;
            }
            // 시간순 정렬
            points.sort_by(|a, b| {
                a.point.timestamp
                    .partial_cmp(&b.point.timestamp)
                    .unwrap_or(std::cmp::Ordering::Equal)
            });

            let mut removed_total = 0usize;
            loop {
                let mut to_remove = Vec::new();
                let len = points.len();
                for i in 0..len.saturating_sub(1) {
                    let j = i + 1;
                    if j >= points.len() {
                        break;
                    }
                    let dt = (points[j].point.timestamp - points[i].point.timestamp).abs();
                    if dt > 2.0 {
                        break;
                    }
                    // 같은 스캔 내 중복 — 우선순위 낮은 쪽 제거
                    let dist = quick_dist_km(
                        points[i].point.latitude,
                        points[i].point.longitude,
                        points[j].point.latitude,
                        points[j].point.longitude,
                    );
                    if dist < 1.0 {
                        if points[i].point.radar_type.priority() >= points[j].point.radar_type.priority() {
                            to_remove.push(j);
                        } else {
                            to_remove.push(i);
                        }
                    }
                }
                to_remove.sort_unstable();
                to_remove.dedup();
                let removed_this_pass = to_remove.len();
                for &idx in to_remove.iter().rev() {
                    points.remove(idx);
                }
                removed_total += removed_this_pass;
                if removed_this_pass == 0 {
                    break;
                }
            }

            if removed_total > 0 {
                let _ = removed_total;
            }
        }
    }

    /// 최종 결과: 모든 Mode-S 항적을 하나의 Vec로 병합 (RichTrackPoint → TrackPoint)
    /// 반환: (항적 포인트, 유령표적 보존분, 통계) — 둘 다 시간순 정렬
    fn into_points(mut self) -> (Vec<TrackPoint>, Vec<TrackPoint>, ParseStatistics) {
        let mut all_points = Vec::new();
        for (_ms, pts) in self.tracks.drain() {
            for rtp in pts {
                all_points.push(rtp.point);
            }
        }
        // 전체 시간순 정렬
        all_points.sort_by(|a, b| {
            a.timestamp
                .partial_cmp(&b.timestamp)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        // 유령표적 보존분도 시간순 정렬 (전수 — 다운샘플링/상한 없음)
        let mut ghost_points = std::mem::take(&mut self.removed_ghosts);
        ghost_points.sort_by(|a, b| {
            a.timestamp
                .partial_cmp(&b.timestamp)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        (all_points, ghost_points, self.stats)
    }
}

/// Convert polar coordinates to lat/lon using the radar site as reference.
/// NEC 레이더의 THETA는 자북(Magnetic North) 기준 → mag_dec_deg로 진북 보정
fn polar_to_latlon(rho_nm: f64, theta_deg: f64, radar_lat: f64, radar_lon: f64, mag_dec_deg: f64) -> (f64, f64) {
    let rho_km = rho_nm * 1.852;
    // 자북 → 진북 보정: True Bearing = Magnetic Bearing + Declination
    let true_theta = theta_deg + mag_dec_deg;
    let theta_rad = true_theta.to_radians();
    let lat_rad = radar_lat.to_radians();
    let earth_r = 6371.0;

    let delta = rho_km / earth_r;
    let lat2 = (lat_rad.sin() * delta.cos() + lat_rad.cos() * delta.sin() * theta_rad.cos())
        .asin();
    let lon2 = radar_lon.to_radians()
        + (theta_rad.sin() * delta.sin() * lat_rad.cos())
            .atan2(delta.cos() - lat_rad.sin() * lat2.sin());

    (lat2.to_degrees(), lon2.to_degrees())
}

/// Convert Cartesian (x, y in NM) to lat/lon using radar site as reference.
/// NEC 레이더의 X/Y는 자북 기준 → mag_dec_deg로 진북 회전 보정
fn cartesian_to_latlon(x_nm: f64, y_nm: f64, radar_lat: f64, radar_lon: f64, mag_dec_deg: f64) -> (f64, f64) {
    let x_km = x_nm * 1.852;
    let y_km = y_nm * 1.852;
    // 자북 → 진북 좌표 회전 (declination 만큼 반시계 회전)
    let rot_rad = mag_dec_deg.to_radians();
    let x_true = x_km * rot_rad.cos() - y_km * rot_rad.sin();
    let y_true = x_km * rot_rad.sin() + y_km * rot_rad.cos();
    let lat_offset = y_true / 111.32;
    let lon_offset = x_true / (111.32 * radar_lat.to_radians().cos());
    (radar_lat + lat_offset, radar_lon + lon_offset)
}

/// I020 TYP 값을 RadarDetectionType으로 분류하고, TrackPoint 변환
fn classify_and_convert(
    record: &Cat048Record,
    base_date_secs: f64,
    radar_lat: f64,
    radar_lon: f64,
    mag_dec_deg: f64,
) -> RecordOutcome {
    // TYP=0,1 → Discard
    match record.radar_typ {
        0 | 1 => return RecordOutcome::Discard,
        _ => {}
    }

    // Require time
    let tod = match record.time_of_day {
        Some(t) => t,
        None => return RecordOutcome::Discard,
    };

    // Convert position from polar or Cartesian to lat/lon
    let (lat, lon) = if let (Some(rho), Some(theta)) = (record.rho_nm, record.theta_deg) {
        polar_to_latlon(rho, theta, radar_lat, radar_lon, mag_dec_deg)
    } else if let (Some(x_nm), Some(y_nm)) = (record.cart_x_nm, record.cart_y_nm) {
        cartesian_to_latlon(x_nm, y_nm, radar_lat, radar_lon, mag_dec_deg)
    } else {
        return RecordOutcome::Discard;
    };

    // Validate coordinates (동아시아 확장 범위 — 국제선 진입/이탈 구간 포함)
    if lat < 25.0 || lat > 50.0 || lon < 115.0 || lon > 145.0 {
        return RecordOutcome::Discard;
    }

    // Compute timestamp
    let timestamp = if base_date_secs > 0.0 {
        base_date_secs + tod
    } else {
        // 파일명에서 날짜 추출 실패 → 폴백 타임스탬프 (2023-11-14 부근)
        // 월간 보고서에서 분석월 필터 시 날짜 불일치로 "데이터 없음" 발생 가능
        1700000000.0 + tod
    };

    // Altitude from flight level (1 FL = 100 ft → meters)
    let altitude = record
        .flight_level
        .map(|fl| fl * 100.0 * 0.3048)
        .unwrap_or(0.0);

    // I020 TYP → RadarDetectionType (6종 분류)
    // TYP=2: SSR only (Mode A/C 응답기)
    // TYP=3: SSR + PSR (Mode A/C Combined)
    // TYP=4: Mode S All-Call (PSR 없음)
    // TYP=5: Mode S Roll-Call (PSR 없음)
    // TYP=6: Mode S All-Call + PSR
    // TYP=7: Mode S Roll-Call + PSR
    let radar_type = match record.radar_typ {
        2 => RadarDetectionType::ModeAC,
        3 => RadarDetectionType::ModeACPsr,
        4 => RadarDetectionType::ModeSAllCall,
        5 => RadarDetectionType::ModeSRollCall,
        6 => RadarDetectionType::ModeSAllCallPsr,
        7 => RadarDetectionType::ModeSRollCallPsr,
        _ => return RecordOutcome::Discard,
    };

    let speed = record.ground_speed_kts.unwrap_or(0.0);
    let heading = record.heading_deg.unwrap_or(0.0);

    // Mode-S address 기반 식별
    let mode_s = match record.mode_s_address {
        Some(addr) if addr > 0 => format!("{:06X}", addr),
        _ => String::new(), // Mode-S 없는 ATCRBS 레코드
    };

    let point = TrackPoint {
        timestamp,
        mode_s: if mode_s.is_empty() { "NO_MODES".to_string() } else { mode_s.clone() },
        latitude: lat,
        longitude: lon,
        altitude,
        speed,
        heading,
        radar_type: radar_type.clone(),
        raw_data: Vec::new(),
    };

    if radar_type.is_atcrbs() && mode_s.is_empty() {
        RecordOutcome::AtcrbsPoint(point, record.mode3a)
    } else {
        let extra = RecordExtra {
            rho_nm: record.rho_nm.unwrap_or(0.0),
            theta_deg: record.theta_deg.unwrap_or(0.0),
            track_number: record.track_number,
        };
        RecordOutcome::ModesSPoint(point, record.mode3a, extra)
    }
}

/// CAT008 블록에서 기상 극좌표 벡터(I008/034)를 전수 추출.
/// 한 블록에 11바이트 레코드 N개. UAP: FRN1 I008/010(SAC/SIC),
/// FRN2 I008/000(메시지타입), FRN3 I008/020(벡터 한정자/강도, FX),
/// FRN4 I008/036(직교벡터, 미사용), FRN5 I008/034(극좌표벡터).
/// 극좌표벡터 = REP(1) + REP×4옥텟[시작거리, 끝거리, 방위 16-bit].
/// 방위 LSB = 360/2^16 deg. 강도 = I008/020 옥텟1 bits 7-5.
/// 거리는 bin 그대로 보관(스케일은 프론트에서 적용). 방위는 자북→진북 보정 적용.
fn extract_weather_vectors(
    block: &[u8],
    time: f64,
    mag_dec_deg: f64,
    out: &mut Vec<WeatherVector>,
) {
    let mut p = 3usize; // CAT(1)+LEN(2) 이후
    while p < block.len() {
        // FSPEC (FX 체인)
        let mut present = [false; 8];
        let mut item = 0usize;
        loop {
            if p >= block.len() {
                return;
            }
            let byte = block[p];
            p += 1;
            for bit in (1..=7).rev() {
                if item < 8 {
                    present[item] = (byte >> bit) & 1 == 1;
                }
                item += 1;
            }
            if byte & 0x01 == 0 {
                break;
            }
        }
        // FRN1 I008/010 Data Source Identifier (SAC, SIC)
        if present[0] {
            if p + 2 > block.len() {
                return;
            }
            p += 2;
        }
        // FRN2 I008/000 Message Type
        if present[1] {
            if p >= block.len() {
                return;
            }
            p += 1;
        }
        // FRN3 I008/020 Vector Qualifier (강도 = bits 7-5 of 옥텟1, FX 확장)
        let mut intensity = 0u8;
        if present[2] {
            if p >= block.len() {
                return;
            }
            intensity = (block[p] >> 4) & 0x07;
            while p < block.len() {
                let o = block[p];
                p += 1;
                if o & 0x01 == 0 {
                    break;
                }
            }
        }
        // FRN4 I008/036 Sequence of Cartesian Vectors (관측 데이터엔 없음, 정렬 유지용 스킵)
        if present[3] {
            if p >= block.len() {
                return;
            }
            let rep = block[p] as usize;
            p += 1 + rep * 3; // REP + REP×3옥텟(X,Y,Length)
            if p > block.len() {
                return;
            }
        }
        // FRN5 I008/034 Sequence of Polar Vectors
        if present[4] {
            if p >= block.len() {
                return;
            }
            let rep = block[p] as usize;
            p += 1;
            for _ in 0..rep {
                if p + 4 > block.len() {
                    return;
                }
                let start_bin = block[p];
                let end_bin = block[p + 1];
                let az_raw = ((block[p + 2] as u16) << 8) | (block[p + 3] as u16);
                p += 4;
                let az_deg = az_raw as f64 * (360.0 / 65536.0) + mag_dec_deg;
                let az_norm = az_deg.rem_euclid(360.0);
                out.push(WeatherVector {
                    time,
                    azimuth: az_norm as f32,
                    start_bin,
                    end_bin,
                    intensity,
                });
            }
        }
        // 관측 데이터의 FSPEC는 항상 [I010,I000,I020,I034] → 여기서 p는 다음 레코드 경계.
        // 그 외 항목(FRN6+)이 있으면 정렬을 보장할 수 없으므로 블록 파싱 중단.
        if present[5] || present[6] || present[7] {
            return;
        }
    }
}

/// TCAS/ACAS 보고를 트랙과 독립적으로 전수 추출.
/// classify_and_convert의 discard 조건(좌표/시간/TYP)과 무관하게,
/// I260/BDS3,0/BDS1,6 페이로드가 있으면 보고로 수집한다.
///
/// 시각: I140 있으면 사용 + last_valid_ts 갱신. 없으면 직전 유효 시각으로 추정.
/// 좌표/고도: 레코드에 있으면 채우고 없으면 None.
fn extract_tcas_reports(
    record: &Cat048Record,
    // 폴백 전문(해당 CAT048 블록). NEC 프레이밍이 있으면 프레임 경계에서 전체 프레임으로 덮어씀.
    fallback_frame: &[u8],
    base_secs: f64,
    radar_lat: f64,
    radar_lon: f64,
    mag_dec_deg: f64,
    last_valid_ts: &mut Option<f64>,
    out: &mut Vec<TcasReport>,
) {
    // 시각 결정 + 직전 유효 시각 갱신
    let (ts_opt, estimated) = match record.time_of_day {
        Some(tod) => {
            let t = if base_secs > 0.0 { base_secs + tod } else { 1_700_000_000.0 + tod };
            *last_valid_ts = Some(t);
            (Some(t), false)
        }
        None => (*last_valid_ts, true),
    };

    let has_tcas = record.acas_ra_report.is_some()
        || record.bds30_mb.is_some()
        || record.bds16_mb.is_some();
    if !has_tcas {
        return;
    }
    let ts = match ts_opt {
        Some(t) => t,
        None => return, // 시각을 전혀 알 수 없으면 보류
    };

    // 좌표 (있으면)
    let (lat, lon) = if let (Some(rho), Some(theta)) = (record.rho_nm, record.theta_deg) {
        let (la, lo) = polar_to_latlon(rho, theta, radar_lat, radar_lon, mag_dec_deg);
        (Some(la), Some(lo))
    } else if let (Some(x), Some(y)) = (record.cart_x_nm, record.cart_y_nm) {
        let (la, lo) = cartesian_to_latlon(x, y, radar_lat, radar_lon, mag_dec_deg);
        (Some(la), Some(lo))
    } else {
        (None, None)
    };
    let altitude = record.flight_level.map(|fl| fl * 100.0 * 0.3048);
    let mode_s = match record.mode_s_address {
        Some(addr) if addr > 0 => format!("{:06X}", addr),
        _ => "NO_MODES".to_string(),
    };

    // RA: I260 우선, 없으면 BDS 3,0
    if let Some(ra) = record.acas_ra_report.or(record.bds30_mb) {
        let source = if record.acas_ra_report.is_some() { 0 } else { 1 };
        out.push(TcasReport {
            timestamp: ts,
            time_estimated: estimated,
            mode_s: mode_s.clone(),
            source,
            payload: ra.to_vec(),
            latitude: lat,
            longitude: lon,
            altitude,
            raw_frame: fallback_frame.to_vec(),
        });
    }
    // Coordination: BDS 1,6
    if let Some(coord) = record.bds16_mb {
        out.push(TcasReport {
            timestamp: ts,
            time_estimated: estimated,
            mode_s,
            source: 2,
            payload: coord.to_vec(),
            latitude: lat,
            longitude: lon,
            altitude,
            raw_frame: fallback_frame.to_vec(),
        });
    }
}

/// Parse an ASS file into structured track data.
pub fn parse_ass_file(
    path: &str,
    radar_lat: f64,
    radar_lon: f64,
    mode_s_include: &[String],
    mode_s_exclude: &[String],
    mode3a_include: &[u16],
    mode3a_exclude: &[u16],
    mag_dec_deg: f64,
    _progress: impl Fn(f64),
) -> Result<crate::models::ParsedFile, ParseError> {
    let data = std::fs::read(path).map_err(|e| ParseError::FileReadError(e.to_string()))?;

    if data.len() < 10 {
        return Err(ParseError::InvalidFormat(
            "File too small to contain valid data".into(),
        ));
    }

    let filename = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    info!(
        "Parsing ASS file: {} ({} bytes, radar={},{}, include={:?}, exclude={:?})",
        filename,
        data.len(),
        radar_lat,
        radar_lon,
        mode_s_include,
        mode_s_exclude
    );

    // Detect NEC frame pattern
    let nec = detect_nec_frame(&data);
    if let Some((m, d)) = nec {
        info!("NEC frame detected: month={}, day={}", m, d);
    }

    // 자정(KST) 교차 대응: 프레임 헤더 날짜는 KST 자정마다 바뀌므로, 검출 날짜 D와
    // 다음 2일(D+1, D+2)까지 NEC 프레임으로 인식한다. ≤24.7h 녹화는 최대 3개 연속
    // 날짜에 걸친다(예: 23:5x 시작 파일 → D/D+1/D+2 3일).
    // 단일 날짜 고정 시 자정 이후 프레임 미인식 → nec_kst 고정 → NEC↔TOD 교차검증이
    // 자정 이후 레코드를 전부 폐기하던 버그 수정.
    let valid_dates: Vec<(i64, u8, u8)> = if let Some((m, d)) = nec {
        let year: i64 = extract_date_from_filename(path)
            .and_then(|s| s.get(0..4).and_then(|y| y.parse::<i64>().ok()))
            .unwrap_or(2026);
        let (y1, m1, d1) = next_day(year, m, d);
        let (y2, m2, d2) = next_day(y1, m1, d1);
        vec![(year, m, d), (y1, m1, d1), (y2, m2, d2)]
    } else {
        Vec::new()
    };

    // I140 TOD 타임존 자동판별 (레이더 기종별 UTC/KST 인코딩 차이 흡수).
    // KST 인코딩 파일은 여기서 산출한 shift 로 파싱 시 UTC 로 정규화 → NEC↔TOD 교차검증·
    // timestamp·day_offset·통합·월필터가 전부 UTC 로 공통 동작한다.
    let tod_utc_shift = detect_tod_utc_shift(&data, &valid_dates);
    if tod_utc_shift != 0.0 {
        info!(
            "TOD 타임존 보정 적용: {} → I140 TOD 를 {:+.0}h 시프트하여 UTC 정규화 (로컬시각 인코딩 감지)",
            filename,
            tod_utc_shift / 3600.0
        );
    }

    // Extract base date + start TOD from filename
    let (base_date_secs, start_tod) = extract_base_date_and_start_tod(&filename);

    if base_date_secs > 0.0 {
        info!(
            "Base date from filename: {:.0}s, start_tod={:.0} ({})",
            base_date_secs,
            start_tod.unwrap_or(-1.0),
            start_tod.map(|t| {
                let s = t as u32;
                format!("{:02}:{:02} UTC", s / 3600, (s % 3600) / 60)
            }).unwrap_or("N/A".into())
        );
    }

    // 포함/제외 필터 셋 구성
    let incl_ms: std::collections::HashSet<String> = mode_s_include.iter().map(|s| s.to_uppercase()).collect();
    let excl_ms: std::collections::HashSet<String> = mode_s_exclude.iter().map(|s| s.to_uppercase()).collect();
    let incl_m3a: std::collections::HashSet<u16> = mode3a_include.iter().copied().collect();
    let excl_m3a: std::collections::HashSet<u16> = mode3a_exclude.iter().copied().collect();
    let has_incl_ms = !incl_ms.is_empty();
    let has_incl_m3a = !incl_m3a.is_empty();

    let mut assembler = TrackAssembler::new();
    let mut total_records = 0usize;
    let mut _point_count = 0usize;
    let mut parse_errors: Vec<String> = Vec::new();
    let mut skipped_bytes = 0usize;
    let mut truncated_records = 0usize;

    // NEC 프레임 시각 추적 (KST hour/minute → UTC TOD 교차검증용)
    let mut nec_kst_hour: Option<u8> = None;
    let mut nec_kst_min: Option<u8> = None;
    // 직전 NEC 프레임의 절대 UTC 시각(초) — per-record day_offset 산정 기준
    let mut nec_frame_utc_abs: Option<f64> = None;

    /// NEC↔TOD 교차검증: NEC KST 시각에서 예상 UTC TOD를 계산하고,
    /// ASTERIX I140 TOD와 비교. 허용 오차 이상이면 오염 레코드로 판정.
    /// NEC 프레임은 분 단위만 기록하고, 파일 내에서 드물게 갱신되므로
    /// ±10분 허용. 실제 오염 레코드는 수 시간 이상 차이남.
    const NEC_TOD_TOLERANCE_SECS: f64 = 600.0; // ±10분

    // TCAS 보고 전수 추출용 (트랙 독립)
    let mut tcas_reports: Vec<TcasReport> = Vec::new();
    let mut last_valid_tcas_ts: Option<f64> = None;
    // CAT008 기상 극좌표 벡터 전수 추출용 (트랙 독립)
    let mut weather_vectors: Vec<WeatherVector> = Vec::new();
    // 프레임 전문 캡처: NEC 헤더~다음 헤더 직전까지 전체 바이트를 해당 프레임의 보고에 기록.
    // 경계(다음 헤더/EOF)를 만나야 끝을 알 수 있으므로 보고를 모았다가 일괄 기록한다.
    let mut tcas_frame_start: Option<usize> = None; // 현재 NEC 프레임 헤더 시작 오프셋
    let mut tcas_frame_report_idx: usize = 0; // 현재 프레임에서 시작된 보고의 인덱스

    let mut offset = 0usize;

    while offset < data.len() {
        // Check for NEC frame header (5 bytes: month, day, hour, minute, counter)
        if !valid_dates.is_empty() && is_nec_frame(&data, offset, &valid_dates) {
            // 직전 프레임 확정: [직전 헤더 .. 현재 헤더) 전체를 그 프레임 보고의 전문으로 기록
            if let Some(fs) = tcas_frame_start {
                if tcas_reports.len() > tcas_frame_report_idx {
                    let frame = data[fs..offset].to_vec();
                    for r in &mut tcas_reports[tcas_frame_report_idx..] {
                        r.raw_frame = frame.clone();
                    }
                }
            }
            tcas_frame_start = Some(offset);
            tcas_frame_report_idx = tcas_reports.len();

            let fm = data[offset];
            let fd = data[offset + 1];
            let fh = data[offset + 2];
            let fmin = data[offset + 3];
            // NEC 프레임 시각 갱신 (KST)
            nec_kst_hour = Some(fh);
            nec_kst_min = Some(fmin);
            // 프레임 절대 UTC 시각 (KST 벽시계 - 9h). 매칭된 날짜의 연도 사용.
            let fyear = valid_dates
                .iter()
                .find(|&&(_, m, d)| m == fm && d == fd)
                .map(|&(y, _, _)| y)
                .unwrap_or(2026);
            nec_frame_utc_abs = Some(
                days_from_epoch(fyear, fm as u32, fd as u32) as f64 * 86400.0
                    + fh as f64 * 3600.0
                    + fmin as f64 * 60.0
                    - 9.0 * 3600.0,
            );
            offset += 5;
            continue;
        }

        // Try to read an ASTERIX block
        if is_valid_block_start(&data, offset) {
            let cat = data[offset];
            let block_len = ((data[offset + 1] as usize) << 8) | (data[offset + 2] as usize);

            if cat == CAT048 {
                let block_data = &data[offset..offset + block_len];
                let mut rec_offset = 3; // Skip CAT(1) + LEN(2)
                let mut after_recovery = false;

                while rec_offset < block_data.len() {
                    match parse_cat048_record(block_data, rec_offset) {
                        Ok((mut record, next_offset, was_truncated)) => {
                            total_records += 1;
                            assembler.stats.total_asterix_records += 1;
                            if after_recovery {
                                assembler.stats.recovered_records += 1;
                                after_recovery = false;
                            }

                            // 블록 경계 truncation된 레코드는 skip (부정확한 데이터 방지)
                            if was_truncated {
                                truncated_records += 1;
                                rec_offset = next_offset;
                                continue;
                            }

                            // TOD → UTC 정규화 (KST 인코딩 레이더 흡수). 이후 교차검증·
                            // timestamp·day_offset 이 모두 UTC 기준으로 동작한다.
                            if tod_utc_shift != 0.0 {
                                if let Some(t) = record.time_of_day {
                                    record.time_of_day = Some(normalize_tod(t, tod_utc_shift));
                                }
                            }

                            if record.mode3a_garbled {
                                assembler.stats.mode3a_invalid += 1;
                            }

                            // NEC↔TOD 교차검증: NEC KST 시각과 ASTERIX TOD(UTC) 비교
                            if let (Some(tod), Some(nec_h), Some(nec_m)) =
                                (record.time_of_day, nec_kst_hour, nec_kst_min)
                            {
                                // NEC KST → 예상 UTC TOD
                                let nec_utc_h = ((nec_h as i32 - 9 + 24) % 24) as f64;
                                let expected_tod = nec_utc_h * 3600.0 + nec_m as f64 * 60.0;

                                // 순환 거리 (0↔86400 경계 처리)
                                let diff = (tod - expected_tod).abs();
                                let circular_diff = diff.min(86400.0 - diff);

                                if circular_diff > NEC_TOD_TOLERANCE_SECS {
                                    assembler.stats.nec_tod_mismatch += 1;
                                    rec_offset = next_offset;
                                    continue;
                                }
                            }

                            // per-record 날짜(day_offset) 결정 (compute_day_offset 참고).
                            let day_offset = compute_day_offset(
                                record.time_of_day,
                                nec_frame_utc_abs,
                                base_date_secs,
                                start_tod,
                            );

                            // TCAS 보고 전수 추출 (트랙 독립 — discard와 무관)
                            // 폴백 전문은 해당 CAT048 블록. NEC 프레이밍이 있으면
                            // 프레임 경계에서 전체 프레임 바이트로 덮어쓴다.
                            extract_tcas_reports(
                                &record,
                                block_data,
                                base_date_secs + day_offset,
                                radar_lat,
                                radar_lon,
                                mag_dec_deg,
                                &mut last_valid_tcas_ts,
                                &mut tcas_reports,
                            );

                            match classify_and_convert(
                                &record,
                                base_date_secs + day_offset,
                                radar_lat,
                                radar_lon,
                                mag_dec_deg,
                            ) {
                                RecordOutcome::Discard => {
                                    assembler.stats.discarded_psr_none += 1;
                                }
                                RecordOutcome::ModesSPoint(tp, mode3a, extra) => {
                                    // 포함 판정: 포함 목록이 비어있으면 통과, 아니면 매칭 필요
                                    let ms_upper = tp.mode_s.to_uppercase();
                                    let incl_ok = (!has_incl_ms || incl_ms.contains(&ms_upper))
                                        && (!has_incl_m3a || mode3a.map_or(false, |v| incl_m3a.contains(&v)));
                                    // 제외 판정: 제외 목록에 있으면 거부
                                    let not_excluded = !excl_ms.contains(&ms_upper)
                                        && !mode3a.map_or(false, |v| excl_m3a.contains(&v));
                                    let pass = incl_ok && not_excluded;
                                    if pass {
                                        let rtp = RichTrackPoint {
                                            point: tp,
                                            _track_number: extra.track_number,
                                            _rho_nm: extra.rho_nm,
                                            _theta_deg: extra.theta_deg,
                                        };
                                        assembler.insert(rtp, mode3a);
                                        _point_count += 1;
                                    }
                                }
                                RecordOutcome::AtcrbsPoint(tp, mode3a) => {
                                    // ATCRBS: squawk 포함/제외 필터 적용
                                    let m3a_incl_ok = !has_incl_m3a || mode3a.map_or(false, |v| incl_m3a.contains(&v));
                                    let m3a_not_excluded = !mode3a.map_or(false, |v| excl_m3a.contains(&v));
                                    // Mode-S 포함 필터가 있으면 ATCRBS는 통과 불가 (Mode-S 없으므로)
                                    let ms_incl_ok = !has_incl_ms;
                                    if ms_incl_ok && m3a_incl_ok && m3a_not_excluded {
                                        assembler.insert_atcrbs(tp, mode3a);
                                    }
                                }
                            }

                            rec_offset = next_offset;
                        }
                        Err(e) => {
                            debug!(
                                "CAT048 record parse error at {:#x}: {}, scanning for next valid record",
                                offset + rec_offset, e
                            );
                            parse_errors.push(format!(
                                "CAT048@{:#x}: {}",
                                offset + rec_offset, e
                            ));
                            // 바이트 스캔으로 다음 유효 레코드 탐색
                            let mut scan_pos = rec_offset + 1;
                            let mut recovered = false;
                            while scan_pos < block_data.len().saturating_sub(2) {
                                if let Ok((_, _, _)) = parse_cat048_record(block_data, scan_pos) {
                                    debug!(
                                        "Recovered valid record at block offset {:#x} (skipped {} bytes)",
                                        scan_pos, scan_pos - rec_offset
                                    );
                                    rec_offset = scan_pos;
                                    recovered = true;
                                    after_recovery = true;
                                    break;
                                }
                                scan_pos += 1;
                            }
                            if !recovered {
                                break;
                            }
                        }
                    }
                }
            } else if cat == CAT008 {
                // CAT008 기상 극좌표 벡터 추출 (트랙 독립). CAT008엔 시각필드가 없어
                // 직전 NEC 프레임 헤더의 분 단위 UTC를 타임스탬프로 사용.
                let block_data = &data[offset..offset + block_len];
                let t = nec_frame_utc_abs.unwrap_or(base_date_secs);
                extract_weather_vectors(block_data, t, mag_dec_deg, &mut weather_vectors);
            }

            offset += block_len;
        } else {
            skipped_bytes += 1;
            offset += 1;
        }
    }

    // 마지막 프레임 확정: [마지막 헤더 .. EOF) 전체를 전문으로 기록
    if let Some(fs) = tcas_frame_start {
        if tcas_reports.len() > tcas_frame_report_idx {
            let end = offset.min(data.len());
            let frame = data[fs..end].to_vec();
            for r in &mut tcas_reports[tcas_frame_report_idx..] {
                r.raw_frame = frame.clone();
            }
        }
    }

    // ATCRBS 병합
    assembler.merge_atcrbs(&incl_ms, &excl_ms);

    // Mode-S 포함/제외 필터 적용 (ATCRBS 병합 후)
    if has_incl_ms {
        assembler.tracks.retain(|ms, _| incl_ms.contains(&ms.to_uppercase()));
    }
    if !excl_ms.is_empty() {
        assembler.tracks.retain(|ms, _| !excl_ms.contains(&ms.to_uppercase()));
    }

    // 유령 표적 제거 (동일 스캔 내 공간 불일치 포인트 + 공간 이상점)
    assembler.detect_and_remove_ghosts();
    assembler.remove_spatial_outliers();

    // 동일 위치 중복 제거
    assembler.dedup_same_position();

    // 최종 포인트 추출
    let (mut all_points, ghost_points, stats) = assembler.into_points();

    // 고도 보간 (altitude=0인 포인트에 직전/직후 유효 고도 적용)
    interpolate_missing_altitudes(&mut all_points);

    let start_time = all_points.first().map(|p| p.timestamp);
    let end_time = all_points.last().map(|p| p.timestamp);

    info!(
        "Parsed {}: {} ASTERIX records → {} points (skipped {} bytes, {} parse errors, {} truncated, {} recovered, {} NEC-TOD mismatch filtered). Stats: {:?}",
        filename,
        total_records,
        all_points.len(),
        skipped_bytes,
        parse_errors.len(),
        truncated_records,
        stats.recovered_records,
        stats.nec_tod_mismatch,
        stats
    );

    Ok(crate::models::ParsedFile {
        filename,
        total_records,
        track_points: all_points,
        ghost_points,
        parse_errors,
        start_time,
        end_time,
        radar_lat,
        radar_lon,
        parse_stats: Some(stats),
        tcas_reports,
        weather_vectors,
    })
}

/// Quick check if a position looks like a valid ASTERIX block start.
fn is_valid_block_start(data: &[u8], offset: usize) -> bool {
    if offset + 3 > data.len() {
        return false;
    }
    let cat = data[offset];
    if cat != CAT048 && cat != CAT034 && cat != CAT008 {
        return false;
    }
    let len = ((data[offset + 1] as usize) << 8) | (data[offset + 2] as usize);
    len >= 3 && len <= MAX_BLOCK_LEN && offset + len <= data.len()
}

/// Detect the NEC framing pattern from the file data.
/// Returns (month, day) — hour and minute vary across frames so we only lock on the date.
/// Requires confirmation: the same month/day must appear at least twice with valid time bytes.
fn detect_nec_frame(data: &[u8]) -> Option<(u8, u8)> {
    let scan_len = data.len().min(100_000); // 100KB로 확장 (50KB → 100KB)

    for i in 0..scan_len.saturating_sub(8) {
        let b0 = data[i];     // month
        let b1 = data[i + 1]; // day
        let b2 = data[i + 2]; // hour
        let b3 = data[i + 3]; // minute

        // Validate as date/time: month (1-12), day (1-31), hour (0-23), minute (0-59)
        if !(b0 >= 1 && b0 <= 12 && b1 >= 1 && b1 <= 31 && b2 <= 23 && b3 <= 59) {
            continue;
        }

        // Check if byte at +5 is a known ASTERIX category
        if i + 5 >= data.len() {
            continue;
        }
        let b5 = data[i + 5];
        if b5 != CAT048 && b5 != CAT034 && b5 != CAT008 {
            continue;
        }

        // Verify the ASTERIX block length makes sense
        if i + 8 > data.len() {
            continue;
        }
        let block_len = ((data[i + 6] as usize) << 8) | (data[i + 7] as usize);
        if block_len < 3 || block_len > MAX_BLOCK_LEN {
            continue;
        }

        // REQUIRE confirmation: another NEC frame (same month+day, valid hour+minute)
        // must appear after this ASTERIX block
        let next_pos = i + 5 + block_len;
        if next_pos + 4 < scan_len
            && data[next_pos] == b0
            && data[next_pos + 1] == b1
            && data[next_pos + 2] <= 23
            && data[next_pos + 3] <= 59
        {
            return Some((b0, b1));
        }
    }

    None
}

/// Check if the data at `offset` looks like a NEC frame header.
/// 검출 날짜 D와 다음 2일(D+1, D+2) 중 하나에 해당하면 인식한다(자정 교차 대응).
/// 시(0-23)/분(0-59)이 유효하고, 5바이트 프레임 뒤 바이트가 알려진 ASTERIX 카테고리이거나
/// 다음 프레임의 월 바이트인지 확인한다.
fn is_nec_frame(data: &[u8], offset: usize, valid_dates: &[(i64, u8, u8)]) -> bool {
    if offset + 5 > data.len() {
        return false;
    }
    let mo = data[offset];
    let dy = data[offset + 1];
    if !valid_dates.iter().any(|&(_, m, d)| m == mo && d == dy) {
        return false;
    }
    if data[offset + 2] > 23 || data[offset + 3] > 59 {
        return false;
    }
    // Validate what follows the 5-byte frame
    if offset + 5 >= data.len() {
        return true; // Frame at EOF
    }
    let after = data[offset + 5];
    after == CAT048
        || after == CAT034
        || after == CAT008
        || valid_dates.iter().any(|&(_, m, _)| after == m)
}

/// 윤년 판정 (그레고리력)
fn is_leap_year(year: i64) -> bool {
    (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
}

/// 해당 월의 일수
fn days_in_month(year: i64, month: u8) -> u8 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap_year(year) { 29 } else { 28 },
        _ => 31,
    }
}

/// 다음 날짜 (월/연 경계 처리). 반환: (year, month, day)
fn next_day(year: i64, month: u8, day: u8) -> (i64, u8, u8) {
    if day < days_in_month(year, month) {
        (year, month, day + 1)
    } else if month < 12 {
        (year, month + 1, 1)
    } else {
        (year + 1, 1, 1)
    }
}

/// per-record day_offset(초) 산정.
///
/// 직전 NEC 프레임의 절대 UTC 시각(`frame_abs`)으로 정확히 산정한다:
///   `k = round((frame_abs - tod - base) / 86400)`,  `day_offset = k * 86400`
/// 이렇게 하면 >24h 녹화에서 시작 TOD를 다시 지나치는 꼬리 구간(다음날 데이터가
/// 시작 TOD보다 큰 TOD를 갖는 구간)도 올바른 날짜에 배치된다. 프레임 시각은 초당
/// 수십 회 갱신되고 NEC↔TOD 교차검증(±10분)을 이미 통과하므로 record당 독립 계산이라
/// 인터리빙/불량 데이터에 강건하다.
///
/// 프레임 또는 base 날짜가 없으면 파일명 시작 TOD 기반 폴백(시작 TOD보다 5분 이상
/// 이전 TOD → 다음 날)을 사용한다.
fn compute_day_offset(
    tod: Option<f64>,
    frame_abs: Option<f64>,
    base_date_secs: f64,
    start_tod: Option<f64>,
) -> f64 {
    match (tod, frame_abs) {
        (Some(tod), Some(frame_abs)) if base_date_secs > 0.0 => {
            let k = ((frame_abs - tod - base_date_secs) / 86400.0).round();
            k.max(0.0) * 86400.0
        }
        _ => {
            if let (Some(tod), Some(st)) = (tod, start_tod) {
                if tod < st - 300.0 {
                    86400.0
                } else {
                    0.0
                }
            } else {
                0.0
            }
        }
    }
}

/// I048/140 Time-of-Day 를 UTC 로 정규화.
/// `shift_secs` 만큼 더한 뒤 하루(86400s)로 wrap. shift=0 이면 이미 UTC 이므로 무변화.
fn normalize_tod(tod: f64, shift_secs: f64) -> f64 {
    (tod + shift_secs).rem_euclid(86400.0)
}

/// I048/140 TOD 타임존을 파일 단위로 자동 판별한다.
///
/// **배경**: NEC 레이더 기종별로 I140 TOD 인코딩 타임존이 다르다.
/// - 김포#1(SIC1): TOD = UTC (파일 전반이 UTC 자정 기준)
/// - 김포#2(SIC7): TOD = KST(로컬 벽시계) — UTC 보다 +9h 앞섬
///
/// KST 로 인코딩된 파일을 그대로 두면 NEC↔TOD 교차검증(NEC KST→UTC 기대값 대비)이
/// 매 레코드 ~9h 불일치로 전건 폐기 → 해당 레이더 항적이 통째로 사라진다.
///
/// **판별**: NEC 프레임(KST 벽시계) 뒤에 오는 CAT048 첫 레코드의 TOD 를 여러 표본에서 읽어
/// `TOD − expected_utc`(expected_utc = NEC KST − 9h) 의 중앙값을 시(hour) 단위로 반올림한다.
/// - 중앙값 ≈ 0 → 이미 UTC → shift 0
/// - 중앙값 ≈ +9h → KST → shift −9h (TOD 에서 9h 빼 UTC 로)
///
/// 반환값 = TOD 에 더해 UTC 로 만드는 보정초. NEC 프레임/표본이 부족하면 0(무보정, 기존 동작).
fn detect_tod_utc_shift(data: &[u8], valid_dates: &[(i64, u8, u8)]) -> f64 {
    if valid_dates.is_empty() {
        return 0.0;
    }
    // 파일 앞부분만 스캔 — NEC 프레임은 촘촘하므로 소량으로 충분
    let scan_len = data.len().min(4_000_000);
    let mut offsets: Vec<f64> = Vec::new();
    let mut i = 0usize;
    while i + 8 < scan_len && offsets.len() < 200 {
        if is_nec_frame(data, i, valid_dates) {
            let nec_h = data[i + 2] as i32;
            let nec_m = data[i + 3] as i32;
            // NEC 5바이트 프레임 뒤가 CAT048 블록이면 첫 레코드 TOD 표본 추출
            let bpos = i + 5;
            if bpos + 3 <= data.len() && data[bpos] == CAT048 {
                let blen = ((data[bpos + 1] as usize) << 8) | (data[bpos + 2] as usize);
                if blen >= 3 && bpos + blen <= data.len() {
                    let block = &data[bpos..bpos + blen];
                    if let Ok((rec, _, false)) = parse_cat048_record(block, 3) {
                        if let Some(tod) = rec.time_of_day {
                            let expected = (((nec_h - 9 + 24) % 24) * 3600 + nec_m * 60) as f64;
                            // 순환 차이를 [-43200, 43200) 로 매핑
                            let mut d = (tod - expected).rem_euclid(86400.0);
                            if d > 43200.0 {
                                d -= 86400.0;
                            }
                            offsets.push(d);
                        }
                    }
                }
            }
            i += 5;
            continue;
        }
        i += 1;
    }
    // 표본이 충분해야 신뢰 (소수 오염 레코드에 흔들리지 않도록 중앙값 사용)
    if offsets.len() < 8 {
        return 0.0;
    }
    offsets.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = offsets[offsets.len() / 2];
    // 시 단위 반올림 → UTC 로 만드는 보정 = -round(median/3600)*3600
    -(median / 3600.0).round() * 3600.0
}

/// 파일명에서 날짜 추출 (YYYY-MM-DD 형식 반환). 편각 조회용.
/// "gimpo_260304_0415.ass" → "2026-03-04"
pub fn extract_date_from_filename(path: &str) -> Option<String> {
    let filename = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let stem = filename.rsplit_once('.').map(|(s, _)| s).unwrap_or(&filename);
    for part in stem.split('_') {
        if part.len() == 6 {
            if let (Ok(yy), Ok(mm), Ok(dd)) = (
                part[0..2].parse::<u32>(),
                part[2..4].parse::<u32>(),
                part[4..6].parse::<u32>(),
            ) {
                if mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 {
                    return Some(format!("{:04}-{:02}-{:02}", 2000 + yy, mm, dd));
                }
            }
        }
    }
    None
}

/// Extract a base Unix timestamp (UTC midnight) from a filename like "gimpo_260304_0415.ass".
///
/// 파일명의 날짜는 KST(UTC+9) 기준. ASTERIX I140 TOD는 UTC 자정 기준이므로,
/// KST 시각이 09:00 미만이면 UTC 날짜가 하루 전이다.
/// 예: gimpo_260311_0829.ass → 08:29 KST = 23:29 UTC (March 10) → base = March 10 00:00 UTC
/// 파일명에서 base date (UTC midnight) + 시작 TOD 추출
///
/// 파일명: "gimpo_231014_0111.ass" → KST 2023-10-14 01:11
/// - base = KST 날짜의 UTC midnight (KST<9면 하루 전)
/// - start_tod = KST 시각을 UTC로 변환한 TOD (초)
///
/// 반환: (base_date_secs, Option<start_tod>)
fn extract_base_date_and_start_tod(filename: &str) -> (f64, Option<f64>) {
    let stem = filename.rsplit_once('.').map(|(s, _)| s).unwrap_or(filename);
    let parts: Vec<&str> = stem.split('_').collect();

    let mut date_ymd: Option<(i64, u32, u32)> = None;
    let mut time_hm: Option<(u32, u32)> = None; // (KST hour, KST minute)

    for part in &parts {
        if part.len() == 6 && date_ymd.is_none() {
            if let (Ok(yy), Ok(mm), Ok(dd)) = (
                part[0..2].parse::<i64>(),
                part[2..4].parse::<u32>(),
                part[4..6].parse::<u32>(),
            ) {
                if mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 {
                    date_ymd = Some((2000 + yy, mm, dd));
                }
            }
        } else if part.len() == 4 && time_hm.is_none() {
            if let (Ok(hh), Ok(mm)) = (
                part[0..2].parse::<u32>(),
                part[2..4].parse::<u32>(),
            ) {
                if hh <= 23 && mm <= 59 {
                    time_hm = Some((hh, mm));
                }
            }
        }
    }

    if let Some((year, month, day)) = date_ymd {
        let base = days_from_epoch(year, month, day) as f64 * 86400.0;

        if let Some((kst_hour, kst_min)) = time_hm {
            // KST → UTC 변환: UTC hour = KST hour - 9
            let utc_hour = (kst_hour as i32 - 9 + 24) % 24;
            let start_tod = utc_hour as f64 * 3600.0 + kst_min as f64 * 60.0;

            // KST<9이면 UTC 날짜는 하루 전
            let base_adjusted = if kst_hour < 9 {
                base - 86400.0
            } else {
                base
            };

            (base_adjusted, Some(start_tod))
        } else {
            (base, None)
        }
    } else {
        log::warn!(
            "[ASS] 파일명에서 날짜 추출 실패: '{}' — YYMMDD 패턴 없음. 타임스탬프가 부정확할 수 있습니다.",
            filename,
        );
        (0.0, None)
    }
}

fn days_from_epoch(year: i64, month: u32, day: u32) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400) as u32;
    let m = month;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe as i64 - 719468
}

// ─── ASTERIX CAT048 Record Parsing ───

fn parse_fspec(data: &[u8], mut offset: usize) -> Result<(Vec<usize>, usize), ParseError> {
    let mut present = Vec::new();
    let mut item_idx = 0usize;

    loop {
        if offset >= data.len() {
            return Err(ParseError::RecordError {
                offset,
                message: "FSPEC extends past end of data".into(),
            });
        }
        let byte = data[offset];
        offset += 1;

        for bit in (1..=7).rev() {
            if item_idx < UAP_MAX && (byte >> bit) & 1 == 1 {
                present.push(item_idx);
            }
            item_idx += 1;
        }

        if byte & 0x01 == 0 {
            break;
        }
    }

    Ok((present, offset))
}

fn skip_fx_extended(data: &[u8], offset: usize) -> usize {
    let mut pos = offset;
    loop {
        if pos >= data.len() {
            return pos - offset;
        }
        let byte = data[pos];
        pos += 1;
        if byte & 0x01 == 0 {
            break;
        }
    }
    pos - offset
}

/// Parse a single CAT048 record. Returns (record, next_offset, truncated).
fn parse_cat048_record(
    block: &[u8],
    offset: usize,
) -> Result<(Cat048Record, usize, bool), ParseError> {
    let (present_items, mut pos) = parse_fspec(block, offset)?;
    let mut record = Cat048Record::default();
    let mut truncated = false; // 블록 경계 truncation 감지

    for &item_idx in &present_items {
        if pos >= block.len() {
            truncated = true;
            break;
        }

        match item_idx {
            UAP_I010 => {
                if pos + 2 > block.len() { truncated = true; break; }
                record.sac = block[pos];
                record.sic = block[pos + 1];
                pos += 2;
            }

            UAP_I140 => {
                if pos + 3 > block.len() { truncated = true; break; }
                let raw = ((block[pos] as u32) << 16)
                    | ((block[pos + 1] as u32) << 8)
                    | (block[pos + 2] as u32);
                let tod = raw as f64 / 128.0;
                if tod < MAX_TIME_OF_DAY {
                    record.time_of_day = Some(tod);
                }
                pos += 3;
            }

            UAP_I020 => {
                // I020 Target Report Descriptor (FX-extended)
                // 첫 바이트 bits 7-5: TYP (레이더 탐지 유형)
                // 첫 바이트 bit 4: SIM (0=actual, 1=simulated)
                if pos >= block.len() { truncated = true; break; }
                let first_byte = block[pos];
                record.radar_typ = (first_byte >> 5) & 0x07;
                record.sim_flag = (first_byte >> 4) & 0x01 == 1;
                let consumed = skip_fx_extended(block, pos);
                if consumed == 0 { truncated = true; break; }
                pos += consumed;
            }

            UAP_I040 => {
                if pos + 4 > block.len() { truncated = true; break; }
                let rho_raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                let theta_raw = u16::from_be_bytes([block[pos + 2], block[pos + 3]]);
                let rho_nm = rho_raw as f64 / 256.0;
                // Validate range: 0.1 to 256 NM (skip zero-range targets and overflows)
                if rho_nm >= 0.1 && rho_nm < 256.0 {
                    record.rho_nm = Some(rho_nm);
                    record.theta_deg = Some(theta_raw as f64 * 360.0 / 65536.0);
                }
                pos += 4;
            }

            UAP_I070 => {
                if pos + 2 > block.len() { truncated = true; break; }
                let v_flag = (block[pos] >> 7) & 1;
                let g_flag = (block[pos] >> 6) & 1;
                if v_flag == 0 && g_flag == 0 {
                    record.mode3a = Some(((block[pos] as u16 & 0x0F) << 8) | block[pos + 1] as u16);
                } else {
                    record.mode3a_garbled = true;
                }
                pos += 2;
            }

            UAP_I090 => {
                if pos + 2 > block.len() { truncated = true; break; }
                let raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                let v_flag = (raw >> 15) & 1; // 0=validated, 1=not validated
                let g_flag = (raw >> 14) & 1; // 0=ok, 1=garbled
                // 통계 집계용으로만 보존 — 아래 고도 채택 로직은 기존 정책 그대로 유지
                record.fl_v_flag = v_flag == 1;
                record.fl_g_flag = g_flag == 1;
                // I090: bits 15=V, 14=G, bits 13-0 = Flight Level (14-bit signed, LSB=1/4 FL)
                // V=1(미검증)이어도 고도 정보 활용 (데이터 손실 방지)
                // G=1(garbled)이어도 대략 유효한 경우가 많으므로 수용
                let fl_unsigned = raw & 0x3FFF; // 14 bits
                let fl_signed = if fl_unsigned & 0x2000 != 0 {
                    // negative: sign-extend
                    (fl_unsigned | 0xC000) as i16
                } else {
                    fl_unsigned as i16
                };
                let fl = fl_signed as f64 * 0.25;
                if fl >= -10.0 && fl <= MAX_FLIGHT_LEVEL {
                    record.flight_level = Some(fl);
                }
                pos += 2;
            }

            UAP_I130 => {
                if pos >= block.len() { truncated = true; break; }
                let sub_fspec = block[pos];
                pos += 1;
                let mut i130_ok = true;
                for bit in (1..=7).rev() {
                    if (sub_fspec >> bit) & 1 == 1 {
                        if pos >= block.len() { i130_ok = false; break; }
                        pos += 1;
                    }
                }
                if !i130_ok { truncated = true; break; }
            }

            UAP_I220 => {
                if pos + 3 > block.len() { truncated = true; break; }
                let addr = ((block[pos] as u32) << 16)
                    | ((block[pos + 1] as u32) << 8)
                    | (block[pos + 2] as u32);
                // Mode-S address 0x000000 is technically valid but usually means "no address"
                if addr > 0 {
                    record.mode_s_address = Some(addr);
                }
                pos += 3;
            }

            UAP_I240 => {
                if pos + 6 > block.len() { truncated = true; break; }
                pos += 6;
            }

            UAP_I250 => {
                // I048/250 Mode-S MB Data: REP × 8바이트.
                // 각 8바이트의 byte 8 상위 4비트 = BDS1, 하위 4비트 = BDS2.
                // BDS 3,0 (ACAS Active RA) 발견 시 앞 7바이트를 보관.
                if pos >= block.len() { truncated = true; break; }
                let rep = block[pos] as usize;
                pos += 1;
                let mb_size = rep.saturating_mul(8);
                if pos + mb_size > block.len() { truncated = true; break; }
                for i in 0..rep {
                    let off = pos + i * 8;
                    let bds_byte = block[off + 7];
                    let bds1 = (bds_byte >> 4) & 0x0F;
                    let bds2 = bds_byte & 0x0F;
                    // 레지스터 분포 통계용 — 고정 배열에만 기록(초과분 무시, 힙 할당 없음)
                    if (record.bds_regs_len as usize) < record.bds_regs.len() {
                        record.bds_regs[record.bds_regs_len as usize] = bds_byte;
                        record.bds_regs_len += 1;
                    }
                    if bds1 == 3 && bds2 == 0 {
                        let mut buf = [0u8; 7];
                        buf.copy_from_slice(&block[off..off + 7]);
                        record.bds30_mb = Some(buf);
                    } else if bds1 == 1 && bds2 == 6 {
                        let mut buf = [0u8; 7];
                        buf.copy_from_slice(&block[off..off + 7]);
                        record.bds16_mb = Some(buf);
                    } else if bds1 == 2 && bds2 == 0 && record.bds20_mb.is_none() {
                        // 호출부호 디코드는 통계 경로에서만 — 여기서는 원문 7바이트만 보관
                        let mut buf = [0u8; 7];
                        buf.copy_from_slice(&block[off..off + 7]);
                        record.bds20_mb = Some(buf);
                    }
                }
                pos += mb_size;
            }

            UAP_I161 => {
                if pos + 2 > block.len() { truncated = true; break; }
                let raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                record.track_number = Some(raw & 0x0FFF);
                pos += 2;
            }

            UAP_I042 => {
                if pos + 4 > block.len() { truncated = true; break; }
                let x_raw = i16::from_be_bytes([block[pos], block[pos + 1]]);
                let y_raw = i16::from_be_bytes([block[pos + 2], block[pos + 3]]);
                record.cart_x_nm = Some(x_raw as f64 / 128.0);
                record.cart_y_nm = Some(y_raw as f64 / 128.0);
                pos += 4;
            }

            UAP_I200 => {
                // I200: Ground Speed (2 bytes) + Heading (2 bytes)
                // Ground Speed: LSB = 2^-14 NM/s → knots = raw / 16384 * 3600
                // Heading: LSB = 360/65536 degrees
                if pos + 4 > block.len() { truncated = true; break; }
                let gsp_raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                let hdg_raw = u16::from_be_bytes([block[pos + 2], block[pos + 3]]);
                let speed_kts = (gsp_raw as f64 * 3600.0) / 16384.0;
                if speed_kts <= MAX_SPEED_KTS {
                    record.ground_speed_kts = Some(speed_kts);
                }
                let heading = hdg_raw as f64 * 360.0 / 65536.0;
                if heading >= 0.0 && heading < 360.0 {
                    record.heading_deg = Some(heading);
                }
                pos += 4;
            }

            UAP_I170 => {
                let consumed = skip_fx_extended(block, pos);
                if consumed == 0 { truncated = true; break; }
                pos += consumed;
            }

            UAP_I210 => {
                if pos + 4 > block.len() { truncated = true; break; }
                pos += 4;
            }

            UAP_I030 => {
                let consumed = skip_fx_extended(block, pos);
                if consumed == 0 { truncated = true; break; }
                pos += consumed;
            }

            UAP_I080 => {
                if pos + 2 > block.len() { truncated = true; break; }
                pos += 2;
            }

            UAP_I100 => {
                if pos + 4 > block.len() { truncated = true; break; }
                pos += 4;
            }

            UAP_I110 => {
                if pos + 2 > block.len() { truncated = true; break; }
                pos += 2;
            }

            UAP_I120 => {
                if pos >= block.len() { truncated = true; break; }
                let sub_fspec = block[pos];
                pos += 1;
                let mut i120_ok = true;
                if (sub_fspec >> 7) & 1 == 1 {
                    if pos + 2 > block.len() { i120_ok = false; }
                    else { pos += 2; }
                }
                if i120_ok && (sub_fspec >> 6) & 1 == 1 {
                    if pos >= block.len() { i120_ok = false; }
                    else {
                        let rep = block[pos] as usize;
                        pos += 1;
                        let sz = rep.saturating_mul(6);
                        if pos + sz > block.len() { i120_ok = false; }
                        else { pos += sz; }
                    }
                }
                if !i120_ok { truncated = true; break; }
            }

            UAP_I230 => {
                if pos + 2 > block.len() { truncated = true; break; }
                pos += 2;
            }

            UAP_I260 => {
                // I048/260 ACAS Resolution Advisory Report: 7바이트 고정.
                if pos + 7 > block.len() { truncated = true; break; }
                let mut buf = [0u8; 7];
                buf.copy_from_slice(&block[pos..pos + 7]);
                record.acas_ra_report = Some(buf);
                pos += 7;
            }

            UAP_I055 => {
                if pos + 1 > block.len() { truncated = true; break; }
                pos += 1;
            }

            UAP_I050 => {
                if pos + 2 > block.len() { truncated = true; break; }
                pos += 2;
            }

            UAP_I065 => {
                if pos + 1 > block.len() { truncated = true; break; }
                pos += 1;
            }

            UAP_I060 => {
                if pos + 2 > block.len() { truncated = true; break; }
                pos += 2;
            }

            UAP_SP => {
                if pos >= block.len() { truncated = true; break; }
                let sp_len = block[pos] as usize;
                if sp_len < 1 || pos + sp_len > block.len() { truncated = true; break; }
                pos += sp_len;
            }

            UAP_RE => {
                if pos >= block.len() { truncated = true; break; }
                let re_len = block[pos] as usize;
                if re_len < 1 || pos + re_len > block.len() { truncated = true; break; }
                pos += re_len;
            }

            _ => {
                warn!("Unknown CAT048 item index {} at offset {}", item_idx, pos);
                truncated = true;
                break;
            }
        }
    }

    Ok((record, pos, truncated))
}

// ─────────────────────────────────────────────────────────────────────
// ASTERIX 전수 스캐너 — "ASTERIX 분석" 탭 전용.
//
// 트랙/비행 통합과 무관하게 모든 NEC 프레임 / ASTERIX 블록 / 레코드를 전수 순회하여
//   (1) 집계 통계(대시보드용 AsterixStats)
//   (2) 필터 기반 온디맨드 프레임 조회(AsterixQueryResult)
// 를 제공한다. framing/date/parse 헬퍼(parse_cat048_record, parse_fspec, is_nec_frame,
// is_valid_block_start, compute_day_offset, days_from_epoch 등)를 그대로 재사용하여
// 본 파서(parse_ass_file)와 정합한다. 메모리는 집계(작은 맵/셋)와 조회 상한으로 항상 유한.
// ─────────────────────────────────────────────────────────────────────

use serde::{Deserialize, Serialize};

/// 온디맨드 조회로 한 번에 반환하는 최대 프레임 수 (초과분은 필터로 좁히도록 안내).
const ASTERIX_QUERY_MAX: usize = 2000;

/// CAT048 FRN(1-28) 식별자/이름 — asterixDecoder.ts의 CAT048_UAP와 동일 순서.
const CAT048_FRN_META: [(&str, &str); UAP_MAX] = [
    ("I048/010", "데이터 출처 식별"),
    ("I048/140", "시각(TOD)"),
    ("I048/020", "표적보고 기술자"),
    ("I048/040", "측정위치(극좌표)"),
    ("I048/070", "Mode-3/A 코드"),
    ("I048/090", "고도(FL)"),
    ("I048/130", "레이더 플롯 특성"),
    ("I048/220", "항공기 주소"),
    ("I048/240", "항공기 식별(콜사인)"),
    ("I048/250", "Mode-S MB 데이터"),
    ("I048/161", "트랙 번호"),
    ("I048/042", "계산위치(직교)"),
    ("I048/200", "계산 속도(극좌표)"),
    ("I048/170", "트랙 상태"),
    ("I048/210", "트랙 품질"),
    ("I048/030", "경고/오류 조건"),
    ("I048/080", "Mode-3/A 신뢰도"),
    ("I048/100", "Mode-C 신뢰도"),
    ("I048/110", "3D 높이"),
    ("I048/120", "레이디얼 도플러 속도"),
    ("I048/230", "통신/ACAS 능력"),
    ("I048/260", "ACAS RA 보고"),
    ("I048/055", "Mode-1 코드"),
    ("I048/050", "Mode-2 코드"),
    ("I048/065", "Mode-1 신뢰도"),
    ("I048/060", "Mode-2 신뢰도"),
    ("SP", "특수목적 필드"),
    ("RE", "예약확장 필드"),
];

const TYP048_LABELS: [&str; 8] = [
    "탐지없음",
    "Single PSR",
    "Single SSR",
    "SSR+PSR",
    "Mode S All-Call",
    "Mode S Roll-Call",
    "Mode S All-Call+PSR",
    "Mode S Roll-Call+PSR",
];

fn msg_type_034_label(t: u8) -> &'static str {
    match t {
        1 => "North marker",
        2 => "섹터 통과",
        3 => "지리적 필터링",
        4 => "재밍 스트로브",
        5 => "태양 폭풍",
        _ => "기타",
    }
}
fn msg_type_008_label(t: u8) -> &'static str {
    match t {
        1 => "극좌표 벡터",
        2 => "직교 벡터",
        3 => "윤곽 기록",
        4 => "절대 직교 벡터",
        254 => "SOP 메시지",
        255 => "EOP 메시지",
        _ => "기타",
    }
}

#[derive(Serialize, Clone)]
pub struct CatCount {
    pub cat: u8,
    pub blocks: u64,
    pub records: u64,
}

#[derive(Serialize, Clone)]
pub struct FrnCount {
    pub id: String,
    pub name: String,
    pub count: u64,
}

#[derive(Serialize, Clone)]
pub struct SacSicCount {
    pub sac: u8,
    pub sic: u8,
    pub count: u64,
}

/// 키/라벨/카운트 일반 항목 (레이더 유형, Mode-S Top-N, 메시지 유형 등에 공용).
#[derive(Serialize, Clone)]
pub struct LabeledCount {
    pub key: String,
    pub label: String,
    pub count: u64,
}

/// Mode-3/A 비상코드 — 저장값이 옥탈 4자리 그대로이므로 옥탈 리터럴과 직접 비교.
/// 순서 = 대시보드 표기 순서 [비상, 통신두절, 하이재킹].
const EMERGENCY_CODES: [(u16, &str); 3] = [
    (0o7700, "7700 비상"),
    (0o7600, "7600 통신두절"),
    (0o7500, "7500 하이재킹"),
];

/// Mode-3/A 코드가 비상 3코드(7500/7600/7700) 중 하나인지.
fn is_emergency_code(code: u16) -> bool {
    EMERGENCY_CODES.iter().any(|&(c, _)| c == code)
}

/// I048/250 BDS 레지스터 식별 바이트(BDS1<<4|BDS2) → 한글 설명.
fn bds_reg_label(packed: u8) -> &'static str {
    match (packed >> 4, packed & 0x0F) {
        (0, 0) => "빈 레지스터",
        (1, 0) => "데이터링크 능력",
        (1, 6) => "ACAS 조정응답",
        (1, 7) => "공통용도 GICB",
        (2, 0) => "항공기 식별(콜사인)",
        (3, 0) => "ACAS 해결권고(RA)",
        (4, 0) => "선택고도/의도",
        (5, 0) => "트랙·선회 보고",
        (6, 0) => "기수방위·속도 보고",
        _ => "기타",
    }
}

/// BDS 2,0(항공기 식별) MB 페이로드 → 호출부호.
/// bit 1–8 = 포맷 코드 0x20, bit 9–56 = 8문자 × 6비트 IA5.
/// 포맷 코드 불일치 또는 정의되지 않은 문자코드가 하나라도 있으면 전체 폐기(None).
/// (프런트 `utils/bdsDecoder.ts` 의 ia5()/bds20() 과 동일 규칙)
fn decode_bds20_callsign(mb: &[u8; 7]) -> Option<String> {
    if mb[0] != 0x20 {
        return None;
    }
    // bit 9–56 = 뒤쪽 6바이트(48비트)
    let mut bits: u64 = 0;
    for &b in &mb[1..7] {
        bits = (bits << 8) | b as u64;
    }
    let mut cs = String::with_capacity(8);
    for i in 0..8 {
        let code = ((bits >> (42 - i * 6)) & 0x3F) as u8;
        let ch = match code {
            1..=26 => (b'A' + code - 1) as char,
            48..=57 => (b'0' + code - 48) as char,
            32 => ' ',
            _ => return None,
        };
        cs.push(ch);
    }
    let trimmed = cs.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

/// CAT034 North marker 간격(초) — 자정 wrap 보정 후 유효 범위(0.5–30초)면 Some.
fn north_interval(prev_tod: f64, cur_tod: f64) -> Option<f64> {
    let mut d = cur_tod - prev_tod;
    if d < -43200.0 {
        d += 86400.0;
    }
    if (0.5..=30.0).contains(&d) {
        Some(d)
    } else {
        None
    }
}

/// CAT034 안테나 회전주기 통계 (SAC/SIC별).
#[derive(Serialize, Clone)]
pub struct RotationStat {
    pub sac: u8,
    pub sic: u8,
    /// North marker 메시지 수
    pub north_count: u64,
    /// 유효 간격 수 (= 산출된 회전 수)
    pub interval_count: u64,
    pub period_mean_s: f64,
    pub period_std_s: f64,
    pub period_min_s: f64,
    pub period_max_s: f64,
    /// I034/041 보고 회전주기 평균 (관측 없으면 None)
    pub reported_period_s: Option<f64>,
    pub sector_msgs: u64,
    /// 1회전당 섹터 수 최빈값 (관측 없으면 None)
    pub expected_sectors: Option<u32>,
    /// Σ(expected − 실제 섹터수), 실제 < expected 인 회전만
    pub missing_sectors: u64,
}

/// BDS 2,0 에서 얻은 Mode-S 주소별 호출부호.
#[derive(Serialize, Clone)]
pub struct ModeSCallsign {
    /// 6자리 hex
    pub mode_s: String,
    pub callsign: String,
}

/// 수집 공백 구간 (분 해상도 — abs_time 분 버킷의 연속 0-run).
#[derive(Serialize, Clone)]
pub struct CollectionGap {
    /// 공백 시작 = 마지막 관측 분의 다음 분 경계 (Unix 초)
    pub start_ts: f64,
    /// 공백 끝 = 다음 관측 분 경계 (Unix 초)
    pub end_ts: f64,
    pub duration_secs: f64,
}

#[derive(Serialize, Clone)]
pub struct AsterixFileStat {
    pub filename: String,
    pub bytes: u64,
    pub frames: u64,
    pub records: u64,
    /// 파일 내 레코드 절대시각(Unix 초) 최소/최대 — abs_time 없는 파일이면 None
    pub time_min: Option<f64>,
    pub time_max: Option<f64>,
    /// I140 TOD→UTC 자동보정량(시간). 0.0 = 보정 없음. KST 인코딩 파일이면 -9.0
    pub tod_shift_hours: f64,
}

/// 시간대별 레코드 밀도 (수집 공백 시각화용). 출력 버킷 ≤ 1,440개.
#[derive(Serialize, Clone)]
pub struct TimeDensity {
    /// 첫 버킷 시작 Unix 초 (분 정렬)
    pub start_ts: f64,
    /// 버킷 폭(초), 60의 배수
    pub bucket_secs: u32,
    /// 버킷별 레코드 수 (빈 구간은 0)
    pub counts: Vec<u64>,
}

/// 대시보드 집계 통계 (전수 1패스).
#[derive(Serialize, Clone, Default)]
pub struct AsterixStats {
    pub file_count: usize,
    pub total_bytes: u64,
    pub frame_count: u64,
    pub block_count: u64,
    pub record_count: u64,
    pub skipped_bytes: u64,
    pub parse_errors: u64,
    pub truncated_records: u64,
    pub cat_counts: Vec<CatCount>,
    pub cat048_frn_counts: Vec<FrnCount>,
    pub radar_typ_counts: Vec<LabeledCount>,
    pub sac_sic_counts: Vec<SacSicCount>,
    pub modes_distinct: usize,
    pub modes_top: Vec<LabeledCount>,
    pub msg_type_034: Vec<LabeledCount>,
    pub msg_type_008: Vec<LabeledCount>,
    pub tod_min: Option<f64>,
    pub tod_max: Option<f64>,
    pub time_min: Option<f64>,
    pub time_max: Option<f64>,
    pub nec_dates: Vec<String>,
    pub acas_ra_records: u64,
    pub mode3a_garbled: u64,
    /// 시간대별 레코드 밀도 — abs_time 보유 레코드가 없으면 None
    pub time_density: Option<TimeDensity>,
    /// I048/040 ρ 10NM 구간 히스토그램 (0번 구간부터 마지막 관측 구간까지 연속)
    pub range_hist: Vec<LabeledCount>,
    /// I048/040 θ 10° 섹터 히스토그램 (관측 있으면 길이 36 고정, 없으면 빈 Vec)
    pub azimuth_hist: Vec<u64>,
    /// I048/090 고도 1,000ft 구간 히스토그램 (고도 오름차순)
    pub fl_hist: Vec<LabeledCount>,
    /// I048/090 V=1(미검증) 레코드 수
    pub fl_v_invalid: u64,
    /// I048/090 G=1(garbled) 레코드 수
    pub fl_g_garbled: u64,
    /// I048/070 유효(V/G=0) Mode-3/A 고유 코드 수
    pub mode3a_distinct: usize,
    /// I048/070 유효 Mode-3/A 보유 레코드 총수 (상위 분포 분모)
    pub mode3a_records: u64,
    /// I048/070 Mode-3/A 상위 30 (key/label = 옥탈 4자리)
    pub mode3a_top: Vec<LabeledCount>,
    /// 비상코드 — 항상 3개 고정 [7700, 7600, 7500], 0 포함
    pub emergency_counts: Vec<LabeledCount>,
    /// 비상 3코드 합계 레코드 수
    pub emergency_records: u64,
    /// I048/200 속도 50kt 구간 히스토그램 (0번 구간부터 마지막 관측 구간까지 연속)
    pub speed_hist: Vec<LabeledCount>,
    /// I048/200 속도 10kt 미만 레코드 수
    pub speed_low_records: u64,
    /// I048/200 속도 600kt 초과 레코드 수
    pub speed_high_records: u64,
    /// I048/020 SIM=1(시뮬레이션 표적) 레코드 수
    pub sim_records: u64,
    /// I048/161 트랙번호 고유 수 (SAC/SIC 구분 — 트랙번호는 레이더 로컬)
    pub track_numbers_distinct: usize,
    /// CAT034 안테나 회전주기 (SAC/SIC별, 회전수 내림차순)
    pub rotation_stats: Vec<RotationStat>,
    /// I048/250 BDS 레지스터 분포 (MB 블록 기준, 내림차순)
    pub bds_reg_counts: Vec<LabeledCount>,
    /// BDS 2,0 호출부호 (Mode-S 주소별 최초 유효값, 주소 오름차순)
    pub mode_s_callsigns: Vec<ModeSCallsign>,
    /// 수집 공백 상위 50 (길이 내림차순, 분 해상도)
    pub gaps: Vec<CollectionGap>,
    /// 전체 수집 공백 수
    pub gap_count: u64,
    pub files: Vec<AsterixFileStat>,
}

/// 온디맨드 프레임 조회 필터 (프런트는 camelCase로 전달).
#[derive(Deserialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AsterixFilter {
    /// Mode-S hex 부분일치 (대문자)
    pub mode_s: Option<String>,
    /// 특정 카테고리(0x30/0x22/0x08) 포함 프레임만
    pub cat: Option<u8>,
    /// 절대 Unix 시각(초) 범위 — 레코드 abs_time 기준
    pub time_min: Option<f64>,
    pub time_max: Option<f64>,
    /// ACAS RA(I260/BDS3,0) 포함 여부
    pub has_acas: Option<bool>,
    /// Mode-3/A 비상코드(7500/7600/7700) 포함 여부
    pub has_emergency: Option<bool>,
}

#[derive(Serialize, Clone)]
pub struct AsterixFrameSummary {
    pub file_index: usize,
    pub frame_offset: u64,
    pub byte_len: usize,
    pub cats: Vec<u8>,
    pub record_count: usize,
    pub mode_s_list: Vec<String>,
    pub tod: Option<f64>,
    pub abs_time: Option<f64>,
    pub has_acas: bool,
    /// 프레임 내 출현한 Mode-3/A 비상코드(옥탈 4자리, 중복 제거)
    pub emergency_codes: Vec<String>,
    /// 프레임 전문 hex (NEC 헤더 + 모든 블록). 프런트가 asterixDecoder로 디코드.
    pub frame_hex: String,
}

#[derive(Serialize)]
pub struct AsterixQueryResult {
    /// 필터에 매칭된 전체 프레임 수 (상한 초과 시 frames보다 큼)
    pub total_matched: usize,
    /// 상한(ASTERIX_QUERY_MAX) 초과로 일부만 반환되었는지
    pub truncated: bool,
    pub frames: Vec<AsterixFrameSummary>,
}

/// 10° 섹터 36개 카운터 — `[u64; 36]` 은 Default 파생 대상(길이 ≤32)이 아니라 얇게 감싼다.
struct AzimuthBins([u64; 36]);

impl Default for AzimuthBins {
    fn default() -> Self {
        Self([0u64; 36])
    }
}

/// 스캔 1패스에서 채우는 내부 누산기 (여러 파일에 걸쳐 공유).
#[derive(Default)]
struct StatAccum {
    frame_count: u64,
    record_count: u64,
    truncated: u64,
    mode3a_garbled: u64,
    acas_ra: u64,
    cat_records: HashMap<u8, u64>,
    cat_blocks: HashMap<u8, u64>,
    frn_counts: [u64; UAP_MAX],
    radar_typ: [u64; 8],
    sac_sic: HashMap<(u8, u8), u64>,
    modes: HashMap<u32, u64>,
    msg034: HashMap<u8, u64>,
    msg008: HashMap<u8, u64>,
    tod_min: Option<f64>,
    tod_max: Option<f64>,
    time_min: Option<f64>,
    time_max: Option<f64>,
    nec_dates: std::collections::BTreeSet<(u8, u8)>,
    total_bytes: u64,
    skipped_bytes: u64,
    parse_errors: u64,
    block_count: u64,
    /// 분 단위 버킷 → 레코드 수 (key = (abs_time / 60.0).floor())
    time_buckets: HashMap<i64, u64>,
    /// I040 ρ 10NM 구간 (idx = (rho/10), ρ<256 보장이나 안전상 25로 클램프)
    range_bins: [u64; 26],
    /// I040 θ 10° 섹터
    azimuth_bins: AzimuthBins,
    /// I090 고도 구간 (key = (fl/10).floor() → 1,000ft 단위, 음수 허용)
    fl_bins: HashMap<i32, u64>,
    /// I090 V=1 레코드 수
    fl_v_invalid: u64,
    /// I090 G=1 레코드 수
    fl_g_garbled: u64,
    /// I070 Mode-3/A 코드별 레코드 수 (V/G=0 유효값만)
    mode3a_counts: HashMap<u16, u64>,
    /// I200 속도 50kt 구간 (bin = kts/50, 39 클램프)
    speed_bins: HashMap<u16, u64>,
    /// I200 속도 10kt 미만 / 600kt 초과 레코드 수
    speed_low: u64,
    speed_high: u64,
    /// I020 SIM=1 레코드 수
    sim_records: u64,
    /// I161 트랙번호 고유 집합 (SAC/SIC + 트랙번호 — 트랙번호는 레이더 로컬)
    track_ids: std::collections::HashSet<(u8, u8, u16)>,
    /// I250 BDS 식별 바이트별 MB 블록 수
    bds_counts: HashMap<u8, u64>,
    /// Mode-S 주소별 최초 유효 호출부호 (BDS 2,0)
    callsigns: HashMap<u32, String>,
    /// CAT034 SAC/SIC별 안테나 회전 누산
    rotation: HashMap<(u8, u8), RotAccum>,
}

/// CAT034 안테나 회전 누산 (SAC/SIC별) — finalize에서 RotationStat으로 확정.
#[derive(Default)]
struct RotAccum {
    north_count: u64,
    interval_count: u64,
    sum: f64,
    sumsq: f64,
    min: f64,
    max: f64,
    /// I034/041 보고 회전주기 누적
    reported_sum: f64,
    reported_count: u64,
    sector_msgs: u64,
    /// 1회전당 섹터 수 → 회전 수
    sectors_hist: HashMap<u32, u64>,
}

/// 스캔 진행 상태 (커맨드가 파일별로 누적 후 finalize).
#[derive(Default)]
pub struct AsterixScanState {
    acc: StatAccum,
    files: Vec<AsterixFileStat>,
}

/// 한 레코드의 스캔 요약 (집계/조회 공용 중간 표현).
struct ScanRecord {
    cat: u8,
    mode_s: Option<u32>,
    tod: Option<f64>,
    abs_time: Option<f64>,
    radar_typ: Option<u8>,
    sac: u8,
    sic: u8,
    has_acas: bool,
    msg_type: Option<u8>,
    frns: Vec<usize>,
    truncated: bool,
    mode3a_garbled: bool,
    /// I048/040 극좌표 (거리/방위 분포 집계용)
    rho_nm: Option<f64>,
    theta_deg: Option<f64>,
    /// I048/090 고도(FL) 및 V/G 플래그
    flight_level: Option<f64>,
    fl_v: bool,
    fl_g: bool,
    /// I048/070 Mode-3/A 코드 (V/G=0 유효값, 옥탈 4자리 그대로)
    mode3a: Option<u16>,
    /// I048/200 대지속도 (kt)
    ground_speed_kts: Option<f64>,
    /// I048/020 SIM 플래그
    sim: bool,
    /// I048/161 트랙번호
    track_number: Option<u16>,
    /// I048/250 MB 블록별 BDS 식별 바이트 (최대 8개)
    bds_regs: [u8; 8],
    bds_regs_len: u8,
    /// BDS 2,0 호출부호 (통계 경로에서만 디코드 — 메인 파서 비용 0)
    callsign: Option<String>,
    /// CAT034 I034/030 시각(TOD, 초) — tod/abs_time 과 분리(기존 시각 집계 오염 방지)
    svc_tod: Option<f64>,
    /// CAT034 I034/020 섹터번호 — 집계는 섹터 통과 "건수" 기준이라 값 자체는 미사용(전문 진단용 보존)
    #[allow(dead_code)]
    sector_number: Option<u8>,
    /// CAT034 I034/041 안테나 회전주기(초)
    antenna_period_s: Option<f64>,
}

/// 한 프레임(NEC 헤더~다음 헤더 직전, 또는 비프레이밍 시 단일 블록).
struct ScanFrame {
    start: usize,
    end: usize,
    records: Vec<ScanRecord>,
}

#[derive(Default)]
struct WalkTotals {
    skipped: u64,
    parse_errors: u64,
    block_count: u64,
    cat_blocks: HashMap<u8, u64>,
    nec_dates: std::collections::BTreeSet<(u8, u8)>,
}

/// 파일명/내용으로 NEC 날짜 컨텍스트(valid_dates, base_date_secs, start_tod) 산정.
/// parse_ass_file 선두 로직과 동일.
fn asterix_date_context(path: &str, data: &[u8]) -> (Vec<(i64, u8, u8)>, f64, Option<f64>) {
    let filename = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());
    let nec = detect_nec_frame(data);
    let valid_dates: Vec<(i64, u8, u8)> = if let Some((m, d)) = nec {
        let year: i64 = extract_date_from_filename(path)
            .and_then(|s| s.get(0..4).and_then(|y| y.parse::<i64>().ok()))
            .unwrap_or(2026);
        let (y1, m1, d1) = next_day(year, m, d);
        let (y2, m2, d2) = next_day(y1, m1, d1);
        vec![(year, m, d), (y1, m1, d1), (y2, m2, d2)]
    } else {
        Vec::new()
    };
    let (base_date_secs, start_tod) = extract_base_date_and_start_tod(&filename);
    (valid_dates, base_date_secs, start_tod)
}

/// CAT034/008 블록 선두 파싱 결과.
#[derive(Default)]
struct GenericMsg {
    msg_type: Option<u8>,
    sac: u8,
    sic: u8,
    /// CAT034 전용 — I034/030 시각(TOD, 초)
    tod: Option<f64>,
    /// CAT034 전용 — I034/020 섹터번호
    sector_number: Option<u8>,
    /// CAT034 전용 — I034/041 안테나 회전주기(초)
    antenna_period_s: Option<f64>,
}

/// CAT034/008 블록 선두에서 (메시지유형 I000, SAC, SIC) 추출 (best-effort).
/// 일반 UAP: FRN1=I010(2B), FRN2=I000(1B).
/// CAT034 는 이어서 FRN3=I034/030 TOD(3B, LSB 1/128s), FRN4=I034/020 섹터번호(1B),
/// FRN5=I034/041 안테나 회전주기(2B, LSB 1/128s)까지만 순차 파싱한다.
/// CAT008 은 FRN3부터 레이아웃이 달라 FRN2에서 중단(확장 금지).
fn parse_generic_msg(block: &[u8], cat: u8) -> GenericMsg {
    let mut out = GenericMsg::default();
    if block.len() < 4 {
        return out;
    }
    let rec = &block[3..]; // CAT(1)+LEN(2) 이후
    let mut pos = 0usize;
    let mut item = 0usize;
    let mut present: Vec<usize> = Vec::new();
    loop {
        if pos >= rec.len() || pos > 8 {
            break;
        }
        let byte = rec[pos];
        pos += 1;
        for bit in (1..=7).rev() {
            if (byte >> bit) & 1 == 1 {
                present.push(item);
            }
            item += 1;
        }
        if byte & 0x01 == 0 {
            break;
        }
    }
    let mut p = pos;
    for &fr in &present {
        // FRN3 이후는 CAT034 전용 레이아웃 — CAT008 은 I000 부재 등 어떤 FSPEC 조합에서도 확장 파싱 금지
        if fr >= 2 && cat != CAT034 {
            break;
        }
        match fr {
            // FRN1 = I010 데이터 출처 식별
            0 => {
                if p + 2 <= rec.len() {
                    out.sac = rec[p];
                    out.sic = rec[p + 1];
                    p += 2;
                } else {
                    break;
                }
            }
            // FRN2 = I000 메시지 유형
            1 => {
                if p < rec.len() {
                    out.msg_type = Some(rec[p]);
                    p += 1;
                } else {
                    break;
                }
            }
            // FRN3 = I034/030 시각(TOD)
            2 => {
                if p + 3 <= rec.len() {
                    let raw = ((rec[p] as u32) << 16) | ((rec[p + 1] as u32) << 8) | (rec[p + 2] as u32);
                    let tod = raw as f64 / 128.0;
                    if tod < MAX_TIME_OF_DAY {
                        out.tod = Some(tod);
                    }
                    p += 3;
                } else {
                    break;
                }
            }
            // FRN4 = I034/020 섹터번호
            3 => {
                if p < rec.len() {
                    out.sector_number = Some(rec[p]);
                    p += 1;
                } else {
                    break;
                }
            }
            // FRN5 = I034/041 안테나 회전주기
            4 => {
                if p + 2 <= rec.len() {
                    let raw = u16::from_be_bytes([rec[p], rec[p + 1]]);
                    out.antenna_period_s = Some(raw as f64 / 128.0);
                }
                break;
            }
            _ => break,
        }
    }
    out
}

/// 한 ASTERIX 블록의 레코드들을 스캔 요약으로 파싱.
#[allow(clippy::too_many_arguments)]
fn parse_block_records(
    data: &[u8],
    offset: usize,
    block_len: usize,
    nec_abs: Option<f64>,
    base_date_secs: f64,
    start_tod: Option<f64>,
    tod_utc_shift: f64,
    parse_errors_out: &mut u64,
) -> Vec<ScanRecord> {
    let cat = data[offset];
    let block = &data[offset..(offset + block_len).min(data.len())];
    let mut recs: Vec<ScanRecord> = Vec::new();

    if cat == CAT048 {
        let mut rec_offset = 3;
        while rec_offset < block.len() {
            match parse_cat048_record(block, rec_offset) {
                Ok((record, next, truncated)) => {
                    let frns = parse_fspec(block, rec_offset)
                        .map(|(f, _)| f)
                        .unwrap_or_default();
                    // TOD → UTC 정규화 (KST 인코딩 레이더 흡수) — parse_ass_file 와 동일 규칙.
                    let tod = record
                        .time_of_day
                        .map(|t| if tod_utc_shift != 0.0 { normalize_tod(t, tod_utc_shift) } else { t });
                    let abs_time = tod.map(|t| {
                        let base = base_date_secs
                            + compute_day_offset(Some(t), nec_abs, base_date_secs, start_tod);
                        if base > 0.0 {
                            base + t
                        } else {
                            1_700_000_000.0 + t
                        }
                    });
                    let has_acas =
                        record.acas_ra_report.is_some() || record.bds30_mb.is_some();
                    // BDS 2,0 호출부호는 통계 경로에서만 디코드 (메인 파서 핫패스 비용 0)
                    let callsign = record.bds20_mb.as_ref().and_then(decode_bds20_callsign);
                    recs.push(ScanRecord {
                        cat,
                        mode_s: record.mode_s_address,
                        tod,
                        abs_time,
                        radar_typ: Some(record.radar_typ),
                        sac: record.sac,
                        sic: record.sic,
                        has_acas,
                        msg_type: None,
                        frns,
                        truncated,
                        mode3a_garbled: record.mode3a_garbled,
                        rho_nm: record.rho_nm,
                        theta_deg: record.theta_deg,
                        flight_level: record.flight_level,
                        fl_v: record.fl_v_flag,
                        fl_g: record.fl_g_flag,
                        mode3a: record.mode3a,
                        ground_speed_kts: record.ground_speed_kts,
                        sim: record.sim_flag,
                        track_number: record.track_number,
                        bds_regs: record.bds_regs,
                        bds_regs_len: record.bds_regs_len,
                        callsign,
                        svc_tod: None,
                        sector_number: None,
                        antenna_period_s: None,
                    });
                    if next <= rec_offset {
                        break;
                    }
                    rec_offset = next;
                }
                Err(_) => {
                    *parse_errors_out += 1;
                    // 바이트 스캔으로 다음 유효 레코드 복구
                    let mut scan = rec_offset + 1;
                    let mut recovered = false;
                    while scan < block.len().saturating_sub(2) {
                        if parse_cat048_record(block, scan).is_ok() {
                            rec_offset = scan;
                            recovered = true;
                            break;
                        }
                        scan += 1;
                    }
                    if !recovered {
                        break;
                    }
                }
            }
        }
    } else if cat == CAT034 || cat == CAT008 {
        let g = parse_generic_msg(block, cat);
        recs.push(ScanRecord {
            cat,
            mode_s: None,
            // CAT034 시각은 svc_tod 로만 보관 — tod/abs_time 기반 기존 집계에 섞이지 않게 유지
            tod: None,
            abs_time: None,
            radar_typ: None,
            sac: g.sac,
            sic: g.sic,
            has_acas: false,
            msg_type: g.msg_type,
            frns: Vec::new(),
            truncated: false,
            mode3a_garbled: false,
            rho_nm: None,
            theta_deg: None,
            flight_level: None,
            fl_v: false,
            fl_g: false,
            mode3a: None,
            ground_speed_kts: None,
            sim: false,
            track_number: None,
            bds_regs: [0u8; 8],
            bds_regs_len: 0,
            callsign: None,
            svc_tod: g.tod,
            sector_number: g.sector_number,
            antenna_period_s: g.antenna_period_s,
        });
    }
    recs
}

/// 전체 데이터를 NEC 프레임 단위로 순회하며 프레임마다 on_frame 호출.
/// 비프레이밍(valid_dates 없음) 파일은 블록 1개 = 프레임 1개로 취급.
fn walk_asterix<F: FnMut(&ScanFrame)>(
    data: &[u8],
    valid_dates: &[(i64, u8, u8)],
    base_date_secs: f64,
    start_tod: Option<f64>,
    tod_utc_shift: f64,
    totals: &mut WalkTotals,
    mut on_frame: F,
) {
    let framed = !valid_dates.is_empty();
    let mut nec_abs: Option<f64> = None;
    let mut frame_start: Option<usize> = None;
    let mut frame = ScanFrame {
        start: 0,
        end: 0,
        records: Vec::new(),
    };
    let mut offset = 0usize;

    while offset < data.len() {
        if framed && is_nec_frame(data, offset, valid_dates) {
            if let Some(fs) = frame_start {
                frame.start = fs;
                frame.end = offset;
                on_frame(&frame);
                frame.records.clear();
            }
            frame_start = Some(offset);
            let fm = data[offset];
            let fd = data[offset + 1];
            let fh = data[offset + 2];
            let fmin = data[offset + 3];
            totals.nec_dates.insert((fm, fd));
            let fyear = valid_dates
                .iter()
                .find(|&&(_, m, d)| m == fm && d == fd)
                .map(|&(y, _, _)| y)
                .unwrap_or(2026);
            nec_abs = Some(
                days_from_epoch(fyear, fm as u32, fd as u32) as f64 * 86400.0
                    + fh as f64 * 3600.0
                    + fmin as f64 * 60.0
                    - 9.0 * 3600.0,
            );
            offset += 5;
            continue;
        }

        if is_valid_block_start(data, offset) {
            let cat = data[offset];
            let block_len = ((data[offset + 1] as usize) << 8) | (data[offset + 2] as usize);
            totals.block_count += 1;
            *totals.cat_blocks.entry(cat).or_insert(0) += 1;
            let recs = parse_block_records(
                data,
                offset,
                block_len,
                nec_abs,
                base_date_secs,
                start_tod,
                tod_utc_shift,
                &mut totals.parse_errors,
            );
            if framed {
                if frame_start.is_none() {
                    frame_start = Some(offset);
                }
                for r in recs {
                    frame.records.push(r);
                }
            } else {
                frame.start = offset;
                frame.end = (offset + block_len).min(data.len());
                frame.records = recs;
                on_frame(&frame);
                frame.records = Vec::new();
            }
            offset += block_len;
        } else {
            totals.skipped += 1;
            offset += 1;
        }
    }

    if framed {
        if let Some(fs) = frame_start {
            frame.start = fs;
            frame.end = offset.min(data.len());
            on_frame(&frame);
        }
    }
}

/// 한 파일을 스캔하여 누산기에 통계 누적 + 파일별 요약 추가.
pub fn asterix_scan_file(path: &str, state: &mut AsterixScanState) -> Result<(), ParseError> {
    let data = std::fs::read(path).map_err(|e| ParseError::FileReadError(e.to_string()))?;
    let filename = std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_else(|| path.to_string());

    let (valid_dates, base_date_secs, start_tod) = asterix_date_context(path, &data);
    let tod_utc_shift = detect_tod_utc_shift(&data, &valid_dates);
    let mut totals = WalkTotals::default();

    let acc = &mut state.acc;
    acc.total_bytes += data.len() as u64;

    let mut file_frames = 0u64;
    let mut file_records = 0u64;
    // 파일별 시각 범위 (파일별 요약 컬럼용)
    let mut file_time_min: Option<f64> = None;
    let mut file_time_max: Option<f64> = None;
    // CAT034 회전 산출용 파일 로컬 상태: SAC/SIC → (직전 North marker TOD, North 이후 섹터 통과 수)
    // 파일 경계에서 리셋 — 파일 간 시각 연속성은 가정하지 않는다.
    let mut north_state: HashMap<(u8, u8), (Option<f64>, u64)> = HashMap::new();

    walk_asterix(
        &data,
        &valid_dates,
        base_date_secs,
        start_tod,
        tod_utc_shift,
        &mut totals,
        |frame| {
            acc.frame_count += 1;
            file_frames += 1;
            for r in &frame.records {
                acc.record_count += 1;
                file_records += 1;
                *acc.cat_records.entry(r.cat).or_insert(0) += 1;
                if r.truncated {
                    acc.truncated += 1;
                }
                if r.mode3a_garbled {
                    acc.mode3a_garbled += 1;
                }
                if r.has_acas {
                    acc.acas_ra += 1;
                }
                if let Some(t) = r.tod {
                    acc.tod_min = Some(acc.tod_min.map_or(t, |m| m.min(t)));
                    acc.tod_max = Some(acc.tod_max.map_or(t, |m| m.max(t)));
                }
                if let Some(a) = r.abs_time {
                    acc.time_min = Some(acc.time_min.map_or(a, |m| m.min(a)));
                    acc.time_max = Some(acc.time_max.map_or(a, |m| m.max(a)));
                    file_time_min = Some(file_time_min.map_or(a, |m: f64| m.min(a)));
                    file_time_max = Some(file_time_max.map_or(a, |m: f64| m.max(a)));
                    // 분 단위 버킷 누산 (CAT 무관 — abs_time 보유 레코드 전부)
                    *acc.time_buckets.entry((a / 60.0).floor() as i64).or_insert(0) += 1;
                }
                match r.cat {
                    CAT048 => {
                        for &frn in &r.frns {
                            if frn < UAP_MAX {
                                acc.frn_counts[frn] += 1;
                            }
                        }
                        if let Some(typ) = r.radar_typ {
                            if (typ as usize) < 8 {
                                acc.radar_typ[typ as usize] += 1;
                            }
                        }
                        *acc.sac_sic.entry((r.sac, r.sic)).or_insert(0) += 1;
                        if let Some(ms) = r.mode_s {
                            *acc.modes.entry(ms).or_insert(0) += 1;
                        }
                        // 거리(10NM)·방위(10°) 분포 — I040 보유 레코드만
                        if let Some(rho) = r.rho_nm {
                            acc.range_bins[((rho / 10.0) as usize).min(25)] += 1;
                            if let Some(th) = r.theta_deg {
                                let sector = ((th / 10.0) as usize) % 36;
                                acc.azimuth_bins.0[sector] += 1;
                            }
                        }
                        // 고도(1,000ft) 분포 — I090 보유 레코드만
                        if let Some(fl) = r.flight_level {
                            *acc.fl_bins.entry((fl / 10.0).floor() as i32).or_insert(0) += 1;
                        }
                        // V/G 플래그는 고도 채택 여부와 무관하게 카운트
                        if r.fl_v {
                            acc.fl_v_invalid += 1;
                        }
                        if r.fl_g {
                            acc.fl_g_garbled += 1;
                        }
                        // Mode-3/A 코드 분포 (V/G=0 유효값만)
                        if let Some(code) = r.mode3a {
                            *acc.mode3a_counts.entry(code).or_insert(0) += 1;
                        }
                        // 속도 분포 (50kt 구간, 최대 bin 39) + 이상치
                        if let Some(kts) = r.ground_speed_kts {
                            let bin = ((kts / 50.0) as u16).min(39);
                            *acc.speed_bins.entry(bin).or_insert(0) += 1;
                            if kts < 10.0 {
                                acc.speed_low += 1;
                            }
                            if kts > 600.0 {
                                acc.speed_high += 1;
                            }
                        }
                        if r.sim {
                            acc.sim_records += 1;
                        }
                        // 트랙번호는 레이더 로컬 — SAC/SIC와 묶어 고유성 판정
                        if let Some(tn) = r.track_number {
                            acc.track_ids.insert((r.sac, r.sic, tn));
                        }
                        // BDS 레지스터 분포 (MB 블록 단위) + 호출부호 (주소별 최초값 유지)
                        for i in 0..(r.bds_regs_len as usize).min(r.bds_regs.len()) {
                            *acc.bds_counts.entry(r.bds_regs[i]).or_insert(0) += 1;
                        }
                        if let (Some(ms), Some(cs)) = (r.mode_s, r.callsign.as_ref()) {
                            acc.callsigns.entry(ms).or_insert_with(|| cs.clone());
                        }
                    }
                    CAT034 => {
                        if let Some(mt) = r.msg_type {
                            *acc.msg034.entry(mt).or_insert(0) += 1;
                        }
                        *acc.sac_sic.entry((r.sac, r.sic)).or_insert(0) += 1;
                        // 안테나 회전주기 — North marker 간격 + 회전당 섹터 통과 수
                        if r.antenna_period_s.is_some() || matches!(r.msg_type, Some(1) | Some(2)) {
                            let key = (r.sac, r.sic);
                            let rot = acc.rotation.entry(key).or_default();
                            if let Some(p) = r.antenna_period_s {
                                rot.reported_sum += p;
                                rot.reported_count += 1;
                            }
                            match r.msg_type {
                                // North marker — 직전 North 와의 간격이 유효하면 회전 1회로 확정
                                Some(1) => {
                                    let st = north_state.entry(key).or_insert((None, 0));
                                    let sectors = st.1;
                                    let delta = match (st.0, r.svc_tod) {
                                        (Some(prev), Some(cur)) => north_interval(prev, cur),
                                        _ => None,
                                    };
                                    if let Some(d) = delta {
                                        if rot.interval_count == 0 {
                                            rot.min = d;
                                            rot.max = d;
                                        } else {
                                            if d < rot.min {
                                                rot.min = d;
                                            }
                                            if d > rot.max {
                                                rot.max = d;
                                            }
                                        }
                                        rot.interval_count += 1;
                                        rot.sum += d;
                                        rot.sumsq += d * d;
                                        *rot.sectors_hist.entry(sectors as u32).or_insert(0) += 1;
                                    }
                                    rot.north_count += 1;
                                    st.0 = r.svc_tod;
                                    st.1 = 0;
                                }
                                // 섹터 통과
                                Some(2) => {
                                    rot.sector_msgs += 1;
                                    north_state.entry(key).or_insert((None, 0)).1 += 1;
                                }
                                _ => {}
                            }
                        }
                    }
                    CAT008 => {
                        if let Some(mt) = r.msg_type {
                            *acc.msg008.entry(mt).or_insert(0) += 1;
                        }
                        *acc.sac_sic.entry((r.sac, r.sic)).or_insert(0) += 1;
                    }
                    _ => {}
                }
            }
        },
    );

    acc.skipped_bytes += totals.skipped;
    acc.parse_errors += totals.parse_errors;
    acc.block_count += totals.block_count;
    for (cat, n) in totals.cat_blocks {
        *acc.cat_blocks.entry(cat).or_insert(0) += n;
    }
    for d in totals.nec_dates {
        acc.nec_dates.insert(d);
    }

    state.files.push(AsterixFileStat {
        filename,
        bytes: data.len() as u64,
        frames: file_frames,
        records: file_records,
        time_min: file_time_min,
        time_max: file_time_max,
        tod_shift_hours: tod_utc_shift / 3600.0,
    });

    Ok(())
}

/// 누적된 스캔 상태를 직렬화 가능한 AsterixStats로 확정.
pub fn asterix_finalize(state: AsterixScanState) -> AsterixStats {
    let acc = state.acc;

    // 카테고리별 블록/레코드
    let mut cat_keys: Vec<u8> = acc
        .cat_blocks
        .keys()
        .chain(acc.cat_records.keys())
        .copied()
        .collect();
    cat_keys.sort_unstable();
    cat_keys.dedup();
    let cat_counts: Vec<CatCount> = cat_keys
        .iter()
        .map(|&cat| CatCount {
            cat,
            blocks: *acc.cat_blocks.get(&cat).unwrap_or(&0),
            records: *acc.cat_records.get(&cat).unwrap_or(&0),
        })
        .collect();

    // CAT048 FRN 출현 빈도
    let cat048_frn_counts: Vec<FrnCount> = (0..UAP_MAX)
        .filter(|&i| acc.frn_counts[i] > 0)
        .map(|i| FrnCount {
            id: CAT048_FRN_META[i].0.to_string(),
            name: CAT048_FRN_META[i].1.to_string(),
            count: acc.frn_counts[i],
        })
        .collect();

    // 레이더 유형 (I020 TYP)
    let radar_typ_counts: Vec<LabeledCount> = (0..8)
        .filter(|&i| acc.radar_typ[i] > 0)
        .map(|i| LabeledCount {
            key: i.to_string(),
            label: TYP048_LABELS[i].to_string(),
            count: acc.radar_typ[i],
        })
        .collect();

    // SAC/SIC (카운트 내림차순)
    let mut sac_sic_counts: Vec<SacSicCount> = acc
        .sac_sic
        .iter()
        .map(|(&(sac, sic), &count)| SacSicCount { sac, sic, count })
        .collect();
    sac_sic_counts.sort_by(|a, b| b.count.cmp(&a.count));

    // Mode-S Top-N
    let modes_distinct = acc.modes.len();
    let mut modes_vec: Vec<(u32, u64)> = acc.modes.into_iter().collect();
    modes_vec.sort_by(|a, b| b.1.cmp(&a.1));
    let modes_top: Vec<LabeledCount> = modes_vec
        .into_iter()
        .take(50)
        .map(|(ms, count)| {
            let hex = format!("{:06X}", ms);
            LabeledCount {
                key: hex.clone(),
                label: hex,
                count,
            }
        })
        .collect();

    let to_labeled = |m: HashMap<u8, u64>, label: fn(u8) -> &'static str| -> Vec<LabeledCount> {
        let mut v: Vec<LabeledCount> = m
            .into_iter()
            .map(|(t, count)| LabeledCount {
                key: t.to_string(),
                label: label(t).to_string(),
                count,
            })
            .collect();
        v.sort_by(|a, b| b.count.cmp(&a.count));
        v
    };
    let msg_type_034 = to_labeled(acc.msg034, msg_type_034_label);
    let msg_type_008 = to_labeled(acc.msg008, msg_type_008_label);

    let nec_dates: Vec<String> = acc
        .nec_dates
        .iter()
        .map(|&(m, d)| format!("{:02}-{:02}", m, d))
        .collect();

    // 시간대별 밀도 — 분 버킷을 최대 1,440개로 리샘플 (빈 구간은 0 유지)
    let time_density = if acc.time_buckets.is_empty() {
        None
    } else {
        let min_k = *acc.time_buckets.keys().min().unwrap();
        let max_k = *acc.time_buckets.keys().max().unwrap();
        let span = (max_k - min_k + 1) as u64;
        let factor = span.div_ceil(1440).max(1);
        let n = span.div_ceil(factor) as usize;
        let mut counts = vec![0u64; n];
        for (&k, &c) in &acc.time_buckets {
            let idx = ((k - min_k) as u64 / factor) as usize;
            if idx < n {
                counts[idx] += c;
            }
        }
        Some(TimeDensity {
            start_ts: min_k as f64 * 60.0,
            bucket_secs: (60 * factor) as u32,
            counts,
        })
    };

    // 거리 분포 — 0번 구간부터 마지막 관측 구간까지 0 포함 연속 (히스토그램 모양 보존)
    let range_hist: Vec<LabeledCount> = match acc.range_bins.iter().rposition(|&c| c > 0) {
        None => Vec::new(),
        Some(last) => (0..=last)
            .map(|i| LabeledCount {
                key: (i * 10).to_string(),
                label: format!("{}\u{2013}{} NM", i * 10, (i + 1) * 10),
                count: acc.range_bins[i],
            })
            .collect(),
    };

    // 방위 분포 — 관측 없으면 빈 Vec, 있으면 36섹터 고정
    let azimuth_hist: Vec<u64> = if acc.azimuth_bins.0.iter().all(|&c| c == 0) {
        Vec::new()
    } else {
        acc.azimuth_bins.0.to_vec()
    };

    // 고도 분포 — 정상 범위(≤60구간)면 사이 0 포함 연속, 오염 데이터면 관측 구간만
    let fl_hist: Vec<LabeledCount> = if acc.fl_bins.is_empty() {
        Vec::new()
    } else {
        let lo = *acc.fl_bins.keys().min().unwrap();
        let hi = *acc.fl_bins.keys().max().unwrap();
        let fl_label = |b: i32| -> String {
            let fmt = |ft: i32| -> String {
                let s = ft.unsigned_abs().to_string();
                // 천단위 콤마
                let mut out = String::new();
                for (i, ch) in s.chars().enumerate() {
                    if i > 0 && (s.len() - i) % 3 == 0 {
                        out.push(',');
                    }
                    out.push(ch);
                }
                if ft < 0 {
                    format!("\u{2212}{}", out)
                } else {
                    out
                }
            };
            format!("{}\u{2013}{} ft", fmt(b * 1000), fmt((b + 1) * 1000))
        };
        if (hi - lo) < 60 {
            (lo..=hi)
                .map(|b| LabeledCount {
                    key: b.to_string(),
                    label: fl_label(b),
                    count: *acc.fl_bins.get(&b).unwrap_or(&0),
                })
                .collect()
        } else {
            let mut keys: Vec<i32> = acc.fl_bins.keys().copied().collect();
            keys.sort_unstable();
            keys.into_iter()
                .map(|b| LabeledCount {
                    key: b.to_string(),
                    label: fl_label(b),
                    count: acc.fl_bins[&b],
                })
                .collect()
        }
    };

    // 수집 공백 — 분 버킷(리샘플 전 원본)의 연속 0-run. 관측 버킷만 훑어 O(n log n).
    let mut gaps: Vec<CollectionGap> = Vec::new();
    if !acc.time_buckets.is_empty() {
        let mut keys: Vec<i64> = acc.time_buckets.keys().copied().collect();
        keys.sort_unstable();
        for w in keys.windows(2) {
            let span = w[1] - w[0];
            if span > 1 {
                gaps.push(CollectionGap {
                    start_ts: (w[0] + 1) as f64 * 60.0,
                    end_ts: w[1] as f64 * 60.0,
                    duration_secs: (span - 1) as f64 * 60.0,
                });
            }
        }
    }
    let gap_count = gaps.len() as u64;
    gaps.sort_by(|a, b| {
        b.duration_secs
            .partial_cmp(&a.duration_secs)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    gaps.truncate(50);

    // Mode-3/A 분포 — 상위 30 + 비상코드(항상 3개 고정, 0 포함)
    let mode3a_distinct = acc.mode3a_counts.len();
    let mode3a_records: u64 = acc.mode3a_counts.values().sum();
    let emergency_counts: Vec<LabeledCount> = EMERGENCY_CODES
        .iter()
        .map(|&(code, label)| LabeledCount {
            key: format!("{:04o}", code),
            label: label.to_string(),
            count: *acc.mode3a_counts.get(&code).unwrap_or(&0),
        })
        .collect();
    let emergency_records: u64 = emergency_counts.iter().map(|e| e.count).sum();
    let mut mode3a_vec: Vec<(u16, u64)> = acc.mode3a_counts.into_iter().collect();
    mode3a_vec.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let mode3a_top: Vec<LabeledCount> = mode3a_vec
        .into_iter()
        .take(30)
        .map(|(code, count)| {
            let oct = format!("{:04o}", code);
            LabeledCount {
                key: oct.clone(),
                label: oct,
                count,
            }
        })
        .collect();

    // 속도 분포 — 0번 구간부터 마지막 관측 구간까지 0 포함 연속
    let speed_hist: Vec<LabeledCount> = match acc.speed_bins.keys().max().copied() {
        None => Vec::new(),
        Some(last) => (0..=last)
            .map(|b| LabeledCount {
                key: (b as u32 * 50).to_string(),
                label: format!("{}\u{2013}{} kt", b as u32 * 50, (b as u32 + 1) * 50),
                count: *acc.speed_bins.get(&b).unwrap_or(&0),
            })
            .collect(),
    };

    // BDS 레지스터 분포 (MB 블록 수 기준, 내림차순)
    let mut bds_vec: Vec<(u8, u64)> = acc.bds_counts.into_iter().collect();
    bds_vec.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    let bds_reg_counts: Vec<LabeledCount> = bds_vec
        .into_iter()
        .map(|(packed, count)| {
            let key = format!("{},{}", packed >> 4, packed & 0x0F);
            LabeledCount {
                label: format!("{} {}", key, bds_reg_label(packed)),
                key,
                count,
            }
        })
        .collect();

    // BDS 2,0 호출부호 (Mode-S 주소 오름차순)
    let mut mode_s_callsigns: Vec<ModeSCallsign> = acc
        .callsigns
        .into_iter()
        .map(|(ms, callsign)| ModeSCallsign {
            mode_s: format!("{:06X}", ms),
            callsign,
        })
        .collect();
    mode_s_callsigns.sort_by(|a, b| a.mode_s.cmp(&b.mode_s));

    // CAT034 안테나 회전주기 (회전수 내림차순)
    let mut rotation_stats: Vec<RotationStat> = acc
        .rotation
        .into_iter()
        .map(|((sac, sic), r)| {
            let n = r.interval_count as f64;
            let mean = if r.interval_count > 0 { r.sum / n } else { 0.0 };
            let var = if r.interval_count > 0 {
                (r.sumsq / n - mean * mean).max(0.0)
            } else {
                0.0
            };
            // 1회전당 섹터 수 최빈값 (동률이면 작은 쪽)
            let expected_sectors = r
                .sectors_hist
                .iter()
                .max_by_key(|(k, v)| (**v, std::cmp::Reverse(**k)))
                .map(|(&k, _)| k);
            let missing_sectors: u64 = match expected_sectors {
                Some(exp) => r
                    .sectors_hist
                    .iter()
                    .filter(|&(&k, _)| k < exp)
                    .map(|(&k, &v)| (exp - k) as u64 * v)
                    .sum(),
                None => 0,
            };
            RotationStat {
                sac,
                sic,
                north_count: r.north_count,
                interval_count: r.interval_count,
                period_mean_s: mean,
                period_std_s: var.sqrt(),
                period_min_s: if r.interval_count > 0 { r.min } else { 0.0 },
                period_max_s: if r.interval_count > 0 { r.max } else { 0.0 },
                reported_period_s: if r.reported_count > 0 {
                    Some(r.reported_sum / r.reported_count as f64)
                } else {
                    None
                },
                sector_msgs: r.sector_msgs,
                expected_sectors,
                missing_sectors,
            }
        })
        .collect();
    rotation_stats.sort_by(|a, b| b.interval_count.cmp(&a.interval_count));

    AsterixStats {
        file_count: state.files.len(),
        total_bytes: acc.total_bytes,
        frame_count: acc.frame_count,
        block_count: acc.block_count,
        record_count: acc.record_count,
        skipped_bytes: acc.skipped_bytes,
        parse_errors: acc.parse_errors,
        truncated_records: acc.truncated,
        cat_counts,
        cat048_frn_counts,
        radar_typ_counts,
        sac_sic_counts,
        modes_distinct,
        modes_top,
        msg_type_034,
        msg_type_008,
        tod_min: acc.tod_min,
        tod_max: acc.tod_max,
        time_min: acc.time_min,
        time_max: acc.time_max,
        nec_dates,
        acas_ra_records: acc.acas_ra,
        mode3a_garbled: acc.mode3a_garbled,
        time_density,
        range_hist,
        azimuth_hist,
        fl_hist,
        fl_v_invalid: acc.fl_v_invalid,
        fl_g_garbled: acc.fl_g_garbled,
        mode3a_distinct,
        mode3a_records,
        mode3a_top,
        emergency_counts,
        emergency_records,
        speed_hist,
        speed_low_records: acc.speed_low,
        speed_high_records: acc.speed_high,
        sim_records: acc.sim_records,
        track_numbers_distinct: acc.track_ids.len(),
        rotation_stats,
        bds_reg_counts,
        mode_s_callsigns,
        gaps,
        gap_count,
        files: state.files,
    }
}

/// 필터 기반 온디맨드 프레임 조회 — 매칭 프레임을 상한까지 수집 + 전체 매칭 수 집계.
pub fn asterix_query(paths: &[String], filter: &AsterixFilter) -> Result<AsterixQueryResult, String> {
    let mut frames: Vec<AsterixFrameSummary> = Vec::new();
    let mut total: usize = 0;
    let ms_filter = filter
        .mode_s
        .as_ref()
        .map(|s| s.trim().to_uppercase())
        .filter(|s| !s.is_empty());

    for (file_index, path) in paths.iter().enumerate() {
        let data = std::fs::read(path).map_err(|e| e.to_string())?;
        let (valid_dates, base_date_secs, start_tod) = asterix_date_context(path, &data);
        let tod_utc_shift = detect_tod_utc_shift(&data, &valid_dates);
        let mut totals = WalkTotals::default();

        walk_asterix(
            &data,
            &valid_dates,
            base_date_secs,
            start_tod,
            tod_utc_shift,
            &mut totals,
            |frame| {
                if frame.records.is_empty() {
                    return;
                }
                // 필터
                if let Some(f) = &ms_filter {
                    let any = frame
                        .records
                        .iter()
                        .any(|r| r.mode_s.map_or(false, |m| format!("{:06X}", m).contains(f.as_str())));
                    if !any {
                        return;
                    }
                }
                if let Some(c) = filter.cat {
                    if !frame.records.iter().any(|r| r.cat == c) {
                        return;
                    }
                }
                if let Some(ha) = filter.has_acas {
                    let h = frame.records.iter().any(|r| r.has_acas);
                    if h != ha {
                        return;
                    }
                }
                if let Some(he) = filter.has_emergency {
                    let h = frame
                        .records
                        .iter()
                        .any(|r| r.mode3a.is_some_and(is_emergency_code));
                    if h != he {
                        return;
                    }
                }
                if filter.time_min.is_some() || filter.time_max.is_some() {
                    let any = frame.records.iter().any(|r| match r.abs_time {
                        Some(t) => {
                            filter.time_min.map_or(true, |mn| t >= mn)
                                && filter.time_max.map_or(true, |mx| t <= mx)
                        }
                        None => false,
                    });
                    if !any {
                        return;
                    }
                }

                total += 1;
                if frames.len() >= ASTERIX_QUERY_MAX {
                    return;
                }

                // 요약 생성
                let mut cats: Vec<u8> = Vec::new();
                let mut mode_s_list: Vec<String> = Vec::new();
                let mut tod: Option<f64> = None;
                let mut abs_time: Option<f64> = None;
                let mut has_acas = false;
                let mut emergency_codes: Vec<String> = Vec::new();
                for r in &frame.records {
                    if !cats.contains(&r.cat) {
                        cats.push(r.cat);
                    }
                    if let Some(m) = r.mode_s {
                        let h = format!("{:06X}", m);
                        if !mode_s_list.contains(&h) {
                            mode_s_list.push(h);
                        }
                    }
                    if tod.is_none() {
                        tod = r.tod;
                    }
                    if abs_time.is_none() {
                        abs_time = r.abs_time;
                    }
                    if r.has_acas {
                        has_acas = true;
                    }
                    if let Some(code) = r.mode3a {
                        if is_emergency_code(code) {
                            let oct = format!("{:04o}", code);
                            if !emergency_codes.contains(&oct) {
                                emergency_codes.push(oct);
                            }
                        }
                    }
                }
                let bytes = &data[frame.start..frame.end.min(data.len())];
                let frame_hex: String = bytes.iter().map(|b| format!("{:02x}", b)).collect();
                frames.push(AsterixFrameSummary {
                    file_index,
                    frame_offset: frame.start as u64,
                    byte_len: bytes.len(),
                    cats,
                    record_count: frame.records.len(),
                    mode_s_list,
                    tod,
                    abs_time,
                    has_acas,
                    emergency_codes,
                    frame_hex,
                });
            },
        );
    }

    Ok(AsterixQueryResult {
        truncated: total > frames.len(),
        total_matched: total,
        frames,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 비상코드는 옥탈 자릿수 그대로 저장 — 옥탈 리터럴과 직접 비교되어야 한다.
    #[test]
    fn test_emergency_code_octal_match() {
        assert!(is_emergency_code(0o7700));
        assert!(is_emergency_code(0o7600));
        assert!(is_emergency_code(0o7500));
        // 십진 7700/7600/7500 은 비상코드가 아님 (옥탈 해석 확인)
        assert!(!is_emergency_code(7700));
        assert!(!is_emergency_code(7600));
        assert!(!is_emergency_code(7500));
        assert!(!is_emergency_code(0o7000));
        assert!(!is_emergency_code(0o1200));
        // 표기 형식 = 옥탈 4자리
        assert_eq!(format!("{:04o}", 0o7700u16), "7700");
        assert_eq!(format!("{:04o}", 0o0021u16), "0021");
    }

    /// BDS 2,0 IA5 디코드 — 정상 문자열 채택 / 정의되지 않은 코드 전체 폐기.
    #[test]
    fn test_decode_bds20_callsign() {
        // 8문자 × 6비트를 48비트로 pack → 6바이트
        let pack = |chars: [u8; 8]| -> [u8; 7] {
            let mut bits: u64 = 0;
            for c in chars {
                bits = (bits << 6) | c as u64;
            }
            let mut mb = [0u8; 7];
            mb[0] = 0x20;
            for i in 0..6 {
                mb[i + 1] = ((bits >> (40 - i * 8)) & 0xFF) as u8;
            }
            mb
        };

        // "KAL123  " (A=1..Z=26, 0-9=48..57, 공백=32)
        let mb = pack([11, 1, 12, 49, 50, 51, 32, 32]);
        assert_eq!(decode_bds20_callsign(&mb).as_deref(), Some("KAL123"));

        // 정의되지 않은 코드(예: 27) 포함 → 전체 폐기
        let bad = pack([11, 27, 12, 49, 50, 51, 32, 32]);
        assert_eq!(decode_bds20_callsign(&bad), None);

        // 전부 공백 → 폐기
        let blank = pack([32; 8]);
        assert_eq!(decode_bds20_callsign(&blank), None);

        // 포맷 코드(0x20) 불일치 → 폐기
        let mut wrong = pack([11, 1, 12, 49, 50, 51, 32, 32]);
        wrong[0] = 0x40;
        assert_eq!(decode_bds20_callsign(&wrong), None);
    }

    /// North marker 간격 — 자정 wrap 보정 및 유효 범위(0.5–30초) 게이트.
    #[test]
    fn test_north_interval_wrap() {
        // 통상 간격
        assert_eq!(north_interval(100.0, 104.0), Some(4.0));
        // 자정 wrap: 86398 → 2 (= 4초)
        assert_eq!(north_interval(86398.0, 2.0), Some(4.0));
        // 범위 밖은 폐기
        assert_eq!(north_interval(100.0, 100.2), None); // 0.5초 미만
        assert_eq!(north_interval(100.0, 200.0), None); // 30초 초과
        // wrap 보정 후에도 범위를 벗어나면 폐기
        assert_eq!(north_interval(86000.0, 2.0), None);
    }

    /// 수집 공백 — 분 버킷 연속 0-run 검출 (경계/길이/상한).
    #[test]
    fn test_collection_gaps() {
        let mut state = AsterixScanState::default();
        // 관측 분: 100, 101, 105(102–104 = 3분 공백), 106, 200(107–199 = 93분 공백)
        for k in [100i64, 101, 105, 106, 200] {
            state.acc.time_buckets.insert(k, 1);
        }
        let stats = asterix_finalize(state);
        assert_eq!(stats.gap_count, 2);
        // 길이 내림차순 — 93분 공백이 먼저. 길이 = 끝 − 시작 (관측 분 자체는 공백에 미포함)
        assert_eq!(stats.gaps[0].duration_secs, 93.0 * 60.0);
        assert_eq!(stats.gaps[0].start_ts, 107.0 * 60.0);
        assert_eq!(stats.gaps[0].end_ts, 200.0 * 60.0);
        assert_eq!(stats.gaps[1].duration_secs, 3.0 * 60.0);
        assert_eq!(stats.gaps[1].start_ts, 102.0 * 60.0);
        assert_eq!(stats.gaps[1].end_ts, 105.0 * 60.0);

        // 공백 없는 연속 구간이면 0곳
        let mut cont = AsterixScanState::default();
        for k in 0i64..10 {
            cont.acc.time_buckets.insert(k, 1);
        }
        assert_eq!(asterix_finalize(cont).gap_count, 0);
    }

    #[test]
    #[ignore = "로컬 ASS 데이터 파일 필요 (수동 통합 테스트)"]
    fn test_gimpo_210209_simultaneous_tracks() {
        let path = r"C:\Users\chell\OneDrive\바탕 화면\gimpo_210209_1352.ass";
        let filename = "gimpo_210209_1352.ass";
        if !std::path::Path::new(path).exists() {
            eprintln!("skip: 데이터 파일 없음: {}", path);
            return;
        }

        let ts_to_date = |ts: f64| -> String {
            let days = (ts / 86400.0).floor() as i64;
            let secs = (ts % 86400.0) as u32;
            let hh = secs / 3600;
            let mm = (secs % 3600) / 60;
            let ss = secs % 60;
            let total_days = days + 719468;
            let era = total_days.div_euclid(146097);
            let doe = total_days.rem_euclid(146097);
            let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
            let y = yoe + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = if mp < 10 { mp + 3 } else { mp - 9 };
            let y = if m <= 2 { y + 1 } else { y };
            format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC", y, m, d, hh, mm, ss)
        };

        let (base, start_tod) = extract_base_date_and_start_tod(filename);
        eprintln!("File: {}", filename);
        eprintln!("  base: {:.0} ({})", base, ts_to_date(base));
        eprintln!("  start_tod: {:.0} ({} UTC)", start_tod.unwrap_or(-1.0),
            start_tod.map(|t| {
                let s = t as u32;
                format!("{:02}:{:02}", s / 3600, (s % 3600) / 60)
            }).unwrap_or("N/A".into()));

        let result = parse_ass_file(path, 37.5585, 126.7908, &[], &[], &[], &[], -8.5, |_| {}).unwrap();
        eprintln!("  Parsed points: {}", result.track_points.len());
        // 공간 이상점 검증: 71BF78 최종 항적에 이상점 없음
        let bf78_pts: Vec<_> = result.track_points.iter().filter(|p| p.mode_s == "71BF78").collect();
        eprintln!("  71BF78: {} track pts", bf78_pts.len());

        if let (Some(first), Some(last)) = (result.track_points.first(), result.track_points.last()) {
            eprintln!("  First ts: {:.0} ({})", first.timestamp, ts_to_date(first.timestamp));
            eprintln!("  Last ts:  {:.0} ({})", last.timestamp, ts_to_date(last.timestamp));
            let dur = last.timestamp - first.timestamp;
            eprintln!("  Duration: {:.0}s ({:.1}h)", dur, dur / 3600.0);
        }

        // Mode-S별 항적 분석
        let mut modes_map: std::collections::HashMap<String, Vec<&crate::models::TrackPoint>> = std::collections::HashMap::new();
        for p in &result.track_points {
            modes_map.entry(p.mode_s.clone()).or_default().push(p);
        }

        eprintln!("\n  Mode-S tracks ({} unique):", modes_map.len());
        let mut modes_list: Vec<_> = modes_map.iter().collect();
        modes_list.sort_by(|a, b| b.1.len().cmp(&a.1.len()));

        for (ms, pts) in modes_list.iter().take(20) {
            let first_ts = pts.first().unwrap().timestamp;
            let last_ts = pts.last().unwrap().timestamp;
            let dur = last_ts - first_ts;
            eprintln!("    {}: {} pts, {} ~ {}, {:.1}h",
                ms, pts.len(),
                ts_to_date(first_ts), ts_to_date(last_ts),
                dur / 3600.0
            );

            // 시간 gap 분석 (30초 이상 gap)
            let mut gaps = Vec::new();
            for w in pts.windows(2) {
                let dt = w[1].timestamp - w[0].timestamp;
                if dt > 30.0 {
                    gaps.push((w[0].timestamp, w[1].timestamp, dt));
                }
            }
            if !gaps.is_empty() {
                eprintln!("      Large gaps (>30s): {}", gaps.len());
                for (g_start, g_end, g_dur) in gaps.iter().take(5) {
                    eprintln!("        {} → {} ({:.0}s = {:.1}h)",
                        ts_to_date(*g_start), ts_to_date(*g_end), g_dur, g_dur / 3600.0);
                }
                if gaps.len() > 5 {
                    eprintln!("        ... and {} more", gaps.len() - 5);
                }
            }
        }

        // 동시 항적 검출: 같은 시각대에 여러 Mode-S가 동시 존재하는지
        // 1시간 단위로 슬라이스해서 활성 Mode-S 수 확인
        let global_start = result.track_points.first().unwrap().timestamp;
        let global_end = result.track_points.last().unwrap().timestamp;
        eprintln!("\n  Hourly active Mode-S count:");
        let mut t = global_start;
        while t < global_end {
            let t_end = t + 3600.0;
            let active: std::collections::HashSet<&str> = result.track_points.iter()
                .filter(|p| p.timestamp >= t && p.timestamp < t_end)
                .map(|p| p.mode_s.as_str())
                .collect();
            if !active.is_empty() {
                eprintln!("    {} ~ {}: {} Mode-S active",
                    ts_to_date(t), ts_to_date(t_end), active.len());
            }
            t = t_end;
        }
    }

    #[test]
    #[ignore = "로컬 ASS 데이터 파일 필요 (수동 통합 테스트)"]
    fn test_filename_based_day_offset() {
        let files = [
            r"C:\Users\chell\OneDrive\바탕 화면\Data\gimpo_231014_0111.ass",
            r"C:\Users\chell\OneDrive\바탕 화면\Data\gimpo_231013_0035.ass",
        ];

        let ts_to_date = |ts: f64| -> String {
            let days = (ts / 86400.0).floor() as i64;
            let secs = (ts % 86400.0) as u32;
            let hh = secs / 3600;
            let mm = (secs % 3600) / 60;
            let ss = secs % 60;
            let total_days = days + 719468;
            let era = total_days.div_euclid(146097);
            let doe = total_days.rem_euclid(146097);
            let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
            let y = yoe + era * 400;
            let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
            let mp = (5 * doy + 2) / 153;
            let d = doy - (153 * mp + 2) / 5 + 1;
            let m = if mp < 10 { mp + 3 } else { mp - 9 };
            let y = if m <= 2 { y + 1 } else { y };
            format!("{:04}-{:02}-{:02} {:02}:{:02}:{:02} UTC", y, m, d, hh, mm, ss)
        };

        for path in &files {
            let filename = std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap();

            let (base, start_tod) = extract_base_date_and_start_tod(&filename);

            eprintln!("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
            eprintln!("File: {}", filename);
            eprintln!("  base_date_secs: {:.0} ({})", base, ts_to_date(base));
            eprintln!("  start_tod: {:?} ({} UTC)",
                start_tod.map(|t| format!("{:.0}", t)).unwrap_or("None".into()),
                start_tod.map(|t| {
                    let s = t as u32;
                    format!("{:02}:{:02}", s / 3600, (s % 3600) / 60)
                }).unwrap_or("N/A".into())
            );
            eprintln!("  Expected first ts >= {}", ts_to_date(base + start_tod.unwrap_or(0.0)));

            let result = parse_ass_file(path, 37.5585, 126.7908, &[], &[], &[], &[], -8.5, |_| {});
            match result {
                Ok(parsed) => {
                    eprintln!("  Parsed points: {}", parsed.track_points.len());
                    if let Some(first) = parsed.track_points.first() {
                        eprintln!("  Actual first ts: {:.0} ({})", first.timestamp, ts_to_date(first.timestamp));
                        let expected_start = base + start_tod.unwrap_or(0.0);
                        let diff = first.timestamp - expected_start;
                        eprintln!("  Diff from expected start: {:.0}s ({:.1}min)", diff, diff / 60.0);
                        assert!(
                            first.timestamp >= expected_start - 300.0,
                            "First point should be at or after expected start (with 5min margin)"
                        );
                    }
                    if let Some(last) = parsed.track_points.last() {
                        eprintln!("  Actual last ts:  {:.0} ({})", last.timestamp, ts_to_date(last.timestamp));
                        // 24시간 + 마진 이내인지 확인
                        let duration = last.timestamp - parsed.track_points.first().unwrap().timestamp;
                        eprintln!("  Duration: {:.0}s ({:.1}h)", duration, duration / 3600.0);
                        assert!(
                            duration < 86400.0 * 1.5,
                            "Recording duration should be under 36 hours, got {:.1}h",
                            duration / 3600.0
                        );
                    }
                }
                Err(e) => eprintln!("  Parse error: {}", e),
            }
            eprintln!();
        }
    }

    #[test]
    #[ignore = "로컬 ASS 데이터 파일 필요 (자정 교차 수정 수동 검증)"]
    fn test_midnight_crossing_full_coverage() {
        // 자정(KST) 교차 회귀 방지: is_nec_frame 날짜 윈도우 수정 전에는 자정 이후
        // 레코드가 NEC↔TOD 교차검증에서 폐기되어 ~14h만 커버됐다. 수정 후 전체 구간 커버.
        let path = r"C:\Users\chell\OneDrive\바탕 화면\1Data\gimpo_260201_0957.ass";
        if !std::path::Path::new(path).exists() {
            eprintln!("skip: 데이터 파일 없음: {}", path);
            return;
        }
        let parsed = parse_ass_file(path, 37.5585, 126.7908, &[], &[], &[], &[], -8.5, |_| {}).unwrap();
        let first = parsed.track_points.first().unwrap().timestamp;
        let last = parsed.track_points.last().unwrap().timestamp;
        let dur_h = (last - first) / 3600.0;
        eprintln!("points={} dur={:.2}h first={:.0} last={:.0}",
            parsed.track_points.len(), dur_h, first, last);
        assert!(dur_h > 23.0, "자정 교차 후에도 전체 구간이 파싱되어야 함, got {:.2}h", dur_h);
    }

    #[test]
    fn test_compute_day_offset_frame_anchored() {
        // base = Feb1 00:00 UTC, 시작 09:57 KST(=00:57 UTC, start_tod=3420)
        let base = days_from_epoch(2026, 2, 1) as f64 * 86400.0;
        let start_tod = Some(3420.0);
        // 프레임 절대 UTC = days_from_epoch(KST date) - 9h
        let frame_abs = |y, m, d, h, mi: f64| {
            days_from_epoch(y, m, d) as f64 * 86400.0 + h as f64 * 3600.0 + mi * 60.0 - 9.0 * 3600.0
        };

        // 1일차 정상: KST Feb1 12:00 = 03:00 UTC (tod=10800) → offset 0
        let off = compute_day_offset(Some(10800.0), Some(frame_abs(2026, 2, 1, 12, 0.0)), base, start_tod);
        assert_eq!(off, 0.0);

        // KST Feb2지만 UTC는 아직 Feb1: KST Feb2 02:00 = 17:00 UTC (tod=61200) → offset 0
        let off = compute_day_offset(Some(61200.0), Some(frame_abs(2026, 2, 2, 2, 0.0)), base, start_tod);
        assert_eq!(off, 0.0);

        // 꼬리 구간(핵심): KST Feb2 10:30 = Feb2 01:30 UTC (tod=5400) → offset +86400
        // 예전 폴백 로직은 tod(5400) >= start_tod-300 이라 0으로 잘못 배치하던 케이스.
        let off = compute_day_offset(Some(5400.0), Some(frame_abs(2026, 2, 2, 10, 30.0)), base, start_tod);
        assert_eq!(off, 86400.0);

        // 자정 직후: KST Feb2 09:00 = Feb2 00:00 UTC (tod=0) → offset +86400
        let off = compute_day_offset(Some(0.0), Some(frame_abs(2026, 2, 2, 9, 0.0)), base, start_tod);
        assert_eq!(off, 86400.0);

        // 프레임 미가용 → 폴백(start_tod): tod < start_tod-300 → 다음 날
        assert_eq!(compute_day_offset(Some(100.0), None, base, start_tod), 86400.0);
        assert_eq!(compute_day_offset(Some(10800.0), None, base, start_tod), 0.0);
        // base 없음(파일명 실패) → 0
        assert_eq!(compute_day_offset(Some(100.0), Some(frame_abs(2026, 2, 2, 9, 0.0)), 0.0, None), 0.0);
    }

    #[test]
    fn test_next_day_boundaries() {
        // 일반
        assert_eq!(next_day(2026, 2, 1), (2026, 2, 2));
        // 월 경계 (비윤년 2월 → 3월)
        assert_eq!(next_day(2026, 2, 28), (2026, 3, 1));
        // 윤년 2월
        assert_eq!(next_day(2024, 2, 28), (2024, 2, 29));
        assert_eq!(next_day(2024, 2, 29), (2024, 3, 1));
        // 30/31일 월 경계
        assert_eq!(next_day(2026, 4, 30), (2026, 5, 1));
        assert_eq!(next_day(2026, 1, 31), (2026, 2, 1));
        // 연 경계
        assert_eq!(next_day(2025, 12, 31), (2026, 1, 1));
    }

    #[test]
    fn test_is_nec_frame_accepts_date_window() {
        // 검출 날짜 D=2/24, 윈도우 = [2/24, 2/25, 2/26] (23:5x 시작 파일이 3일에 걸침)
        let valid_dates = vec![(2026i64, 2u8, 24u8), (2026, 2, 25), (2026, 2, 26)];
        // [월][일][시][분][카운터][CAT][len_hi][len_lo]
        let mk = |m, d, h, mi| vec![m, d, h, mi, 0x00, CAT048, 0x00, 0x10];

        // D, D+1, D+2 모두 인식 (자정 교차 — 이전 버그에서 누락되던 구간)
        assert!(is_nec_frame(&mk(2, 24, 23, 59), 0, &valid_dates));
        assert!(is_nec_frame(&mk(2, 25, 0, 0), 0, &valid_dates));
        assert!(is_nec_frame(&mk(2, 26, 0, 30), 0, &valid_dates));

        // 윈도우 밖 날짜 거부
        assert!(!is_nec_frame(&mk(2, 27, 0, 0), 0, &valid_dates));
        assert!(!is_nec_frame(&mk(3, 24, 0, 0), 0, &valid_dates));

        // 시/분 범위 위반 거부
        assert!(!is_nec_frame(&mk(2, 24, 24, 0), 0, &valid_dates));
        assert!(!is_nec_frame(&mk(2, 24, 0, 60), 0, &valid_dates));

        // 5바이트 뒤가 유효 CAT도 유효 월도 아니면 거부 (false positive 방지)
        let mut bad = mk(2, 24, 10, 0);
        bad[5] = 0x99;
        assert!(!is_nec_frame(&bad, 0, &valid_dates));

        // 빈 윈도우(검출 실패)면 항상 거부
        assert!(!is_nec_frame(&mk(2, 24, 10, 0), 0, &[]));
    }
}

/// 고도 보간: Mode-S별로 altitude=0인 포인트에 직전/직후 유효 고도를 적용
fn interpolate_missing_altitudes(points: &mut [TrackPoint]) {
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, p) in points.iter().enumerate() {
        groups.entry(p.mode_s.clone()).or_default().push(i);
    }

    for (_ms, indices) in &groups {
        for &i in indices {
            if points[i].altitude == 0.0 {
                // 직전 유효 고도 찾기
                let mut prev_alt = None;
                for &j in indices.iter().rev() {
                    if j < i && points[j].altitude != 0.0 {
                        prev_alt = Some(points[j].altitude);
                        break;
                    }
                }
                // 직후 유효 고도 찾기
                let mut next_alt = None;
                for &j in indices {
                    if j > i && points[j].altitude != 0.0 {
                        next_alt = Some(points[j].altitude);
                        break;
                    }
                }
                // 보간
                match (prev_alt, next_alt) {
                    (Some(p), Some(n)) => points[i].altitude = (p + n) / 2.0,
                    (Some(p), None) => points[i].altitude = p,
                    (None, Some(n)) => points[i].altitude = n,
                    (None, None) => {}
                }
            }
        }
    }
}
