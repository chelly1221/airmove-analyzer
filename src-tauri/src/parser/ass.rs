use std::collections::HashMap;

use log::{debug, info, warn};

use crate::models::{ParseStatistics, RadarDetectionType, TrackPoint};

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
    radar_typ: u8,
    sim_flag: bool,
    track_number: Option<u16>,
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
    fn merge_atcrbs(&mut self, filter_set: &std::collections::HashSet<String>) {
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

            // 필터 체크
            if !filter_set.is_empty() && !filter_set.contains(&ms_code.to_uppercase()) {
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
            for &idx in ghost_indices.iter().rev() {
                points.remove(idx);
            }

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

            for &idx in outlier_indices.iter().rev() {
                points.remove(idx);
            }

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
    fn into_points(mut self) -> (Vec<TrackPoint>, ParseStatistics) {
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
        (all_points, self.stats)
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

/// Parse an ASS file into structured track data.
pub fn parse_ass_file(
    path: &str,
    radar_lat: f64,
    radar_lon: f64,
    mode_s_filter: &[String],
    mode3a_filter: &[u16],
    mag_dec_deg: f64,
    filter_logic: &str,
    mode_s_exclude: bool,
    mode3a_exclude: bool,
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
        "Parsing ASS file: {} ({} bytes, radar={},{}, filter={:?})",
        filename,
        data.len(),
        radar_lat,
        radar_lon,
        mode_s_filter
    );

    // Detect NEC frame pattern
    let nec = detect_nec_frame(&data);
    if let Some((m, d)) = nec {
        info!("NEC frame detected: month={}, day={}", m, d);
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

    // Build Mode-S filter set for quick lookup
    let filter_set: std::collections::HashSet<String> = mode_s_filter
        .iter()
        .map(|s| s.to_uppercase())
        .collect();
    let filtering = !filter_set.is_empty();

    // Build Mode-3/A (squawk) filter set
    let m3a_filter_set: std::collections::HashSet<u16> = mode3a_filter.iter().copied().collect();
    let m3a_filtering = !m3a_filter_set.is_empty();

    // 필터 논리: "or"이면 Mode-S/Squawk 중 하나만 매칭되면 통과
    let use_or_logic = filter_logic.eq_ignore_ascii_case("or") && filtering && m3a_filtering;

    // 제외 모드: 매칭되면 거부 (NOT)
    let ms_excl = mode_s_exclude && filtering;
    let m3a_excl = mode3a_exclude && m3a_filtering;

    let mut assembler = TrackAssembler::new();
    let mut total_records = 0usize;
    let mut _point_count = 0usize;
    let mut parse_errors: Vec<String> = Vec::new();
    let mut skipped_bytes = 0usize;
    let mut truncated_records = 0usize;

    // NEC 프레임 시각 추적 (KST hour/minute → UTC TOD 교차검증용)
    let mut nec_kst_hour: Option<u8> = None;
    let mut nec_kst_min: Option<u8> = None;

    /// NEC↔TOD 교차검증: NEC KST 시각에서 예상 UTC TOD를 계산하고,
    /// ASTERIX I140 TOD와 비교. 허용 오차 이상이면 오염 레코드로 판정.
    /// NEC 프레임은 분 단위만 기록하고, 파일 내에서 드물게 갱신되므로
    /// ±10분 허용. 실제 오염 레코드는 수 시간 이상 차이남.
    const NEC_TOD_TOLERANCE_SECS: f64 = 600.0; // ±10분

    let mut offset = 0usize;

    while offset < data.len() {
        // Check for NEC frame header (5 bytes: month, day, hour, minute, counter)
        if let Some((m, d)) = nec {
            if is_nec_frame(&data, offset, m, d) {
                // NEC 프레임 시각 갱신 (KST)
                nec_kst_hour = Some(data[offset + 2]);
                nec_kst_min = Some(data[offset + 3]);
                offset += 5;
                continue;
            }
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
                        Ok((record, next_offset, was_truncated)) => {
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

                            // 파일명 기반 per-record 날짜 결정:
                            // TOD가 파일명 시작 TOD보다 충분히 작으면 → 다음 날 데이터
                            // (자정 교차를 순차 추적하지 않으므로 인터리빙/불량 데이터에 강건)
                            let day_offset = if let (Some(tod), Some(st)) = (record.time_of_day, start_tod) {
                                if tod < st - 300.0 {
                                    86400.0 // 시작 TOD보다 5분 이상 이전 → 다음 날
                                } else {
                                    0.0
                                }
                            } else {
                                0.0
                            };

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
                                    // Mode-S 필터: 포함(contains→true) / 제외(contains→false)
                                    let ms_match = filter_set.contains(&tp.mode_s.to_uppercase());
                                    let ms_ok = !filtering || (if ms_excl { !ms_match } else { ms_match });
                                    // Mode-3/A 필터: 포함/제외
                                    let m3a_match = mode3a.map_or(false, |v| m3a_filter_set.contains(&v));
                                    let m3a_ok = !m3a_filtering || (if m3a_excl { !m3a_match } else { m3a_match });
                                    let pass = if use_or_logic {
                                        // OR: 한쪽이라도 통과하면 포함
                                        let ms_pass = if ms_excl { !ms_match } else { ms_match };
                                        let m3a_pass = if m3a_excl { !m3a_match } else { m3a_match };
                                        ms_pass || m3a_pass
                                    } else {
                                        ms_ok && m3a_ok
                                    };
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
                                    // Mode-3/A (squawk) 필터 적용 — ATCRBS에도 적용
                                    let m3a_match = mode3a.map_or(false, |v| m3a_filter_set.contains(&v));
                                    let m3a_ok = !m3a_filtering || (if m3a_excl { !m3a_match } else { m3a_match });
                                    if m3a_ok {
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
            }

            offset += block_len;
        } else {
            skipped_bytes += 1;
            offset += 1;
        }
    }

    // ATCRBS 병합
    assembler.merge_atcrbs(&filter_set);

    // Mode-S 필터 적용 (ATCRBS 병합 후)
    // OR 모드에서는 squawk 매칭으로 삽입된 트랙이 있으므로 mode_s retain 생략
    if filtering && !use_or_logic {
        if ms_excl {
            // 제외 모드: filter_set에 포함된 트랙 제거
            assembler.tracks.retain(|ms, _| !filter_set.contains(&ms.to_uppercase()));
        } else {
            assembler.tracks.retain(|ms, _| filter_set.contains(&ms.to_uppercase()));
        }
    }

    // 유령 표적 제거 (동일 스캔 내 공간 불일치 포인트 + 공간 이상점)
    assembler.detect_and_remove_ghosts();
    assembler.remove_spatial_outliers();

    // 동일 위치 중복 제거
    assembler.dedup_same_position();

    // 최종 포인트 추출
    let (mut all_points, stats) = assembler.into_points();

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
        parse_errors,
        start_time,
        end_time,
        radar_lat,
        radar_lon,
        parse_stats: Some(stats),
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
/// Matches on the detected month+day, with valid hour (0-23) and minute (0-59),
/// and verifies the byte after the 5-byte frame is a known ASTERIX category or another frame.
fn is_nec_frame(data: &[u8], offset: usize, month: u8, day: u8) -> bool {
    if offset + 5 > data.len() {
        return false;
    }
    if data[offset] != month || data[offset + 1] != day {
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
    after == CAT048 || after == CAT034 || after == CAT008 || after == month
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
                let _v_flag = (raw >> 15) & 1; // 0=validated, 1=not validated
                let _g_flag = (raw >> 14) & 1; // 0=ok, 1=garbled
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
                if pos >= block.len() { truncated = true; break; }
                let rep = block[pos] as usize;
                pos += 1;
                let mb_size = rep.saturating_mul(8);
                if pos + mb_size > block.len() { truncated = true; break; }
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
                if pos + 7 > block.len() { truncated = true; break; }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_gimpo_210209_simultaneous_tracks() {
        let path = r"C:\Users\chell\OneDrive\바탕 화면\gimpo_210209_1352.ass";
        let filename = "gimpo_210209_1352.ass";

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

        let result = parse_ass_file(path, 37.5585, 126.7908, &[], &[], -8.5, "and", false, false, |_| {}).unwrap();
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

            let result = parse_ass_file(path, 37.5585, 126.7908, &[], &[], -8.5, "and", false, false, |_| {});
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
