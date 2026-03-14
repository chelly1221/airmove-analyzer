use std::collections::HashMap;
use std::path::Path;

use log::{debug, info, warn};
use serde::Serialize;

use crate::models::{ParsedFile, ParseStatistics, RadarDetectionType, TrackPoint};
use crate::parser::ParseError;

/// 파싱 진행 상황 이벤트
#[derive(Clone, Serialize)]
pub struct ParseProgress {
    pub filename: String,
    pub percent: f64,
    pub records: usize,
    pub track_points: usize,
    pub errors: usize,
}

/// Default radar reference point: Gimpo Airport (WGS-84)
pub const DEFAULT_RADAR_LAT: f64 = 37.5585;
pub const DEFAULT_RADAR_LON: f64 = 126.7906;

/// Known ASTERIX category bytes
const CAT048: u8 = 0x30; // 48 - Monoradar Target Reports
const CAT034: u8 = 0x22; // 34 - Transmission of Monoradar Service Messages
const CAT008: u8 = 0x08; // 8  - Monoradar Derived Weather

// ─── CAT048 UAP item indices (position in FSPEC) ───
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

/// Maximum valid ASTERIX time of day: 86400 seconds (24 hours)
const MAX_TIME_OF_DAY: f64 = 86400.0;
/// Maximum reasonable speed in knots (Mach 2+ military + margin)
const MAX_SPEED_KTS: f64 = 1400.0;
/// Maximum reasonable flight level (FL600 = 60000 ft)
const MAX_FLIGHT_LEVEL: f64 = 600.0;
/// Maximum valid ASTERIX block length
const MAX_BLOCK_LEN: usize = 8192;

/// 최대 허용 속도 (km/s): 1200kts ≈ 0.617 km/s
const MAX_GARBLE_SPEED_KMS: f64 = 0.617;
/// 동일 스캔 중복 판단 임계값 (초)
const SAME_SCAN_DT: f64 = 2.0;
/// 최소 유효 시간 차이 (초)
const MIN_DT: f64 = 0.5;
/// ATCRBS 병합: 최대 시간차 (초) — 5초 스캔 + 1초 마진
const ATCRBS_MERGE_TIME_GAP: f64 = 6.0;
/// ATCRBS 병합: 거리 마진 (km)
const ATCRBS_MERGE_MARGIN_KM: f64 = 2.0;
/// ATCRBS 병합: 최대 속도 (km/s) — ~500kts
const ATCRBS_MERGE_MAX_SPEED_KMS: f64 = 0.257;
/// SSR 포인트와 기준 항적 간 최대 허용 거리 (km)
const MAX_ATCRBS_DEVIATION_KM: f64 = 1.5;
/// 최대 고도 변화율 (m/s): 20 m/s ≈ 3900 ft/min (비정상적 고도 점프 감지)
const MAX_ALT_RATE_MS: f64 = 20.0;
/// 고도 검사 최대 시간 윈도우 (초)
const ALT_CHECK_MAX_DT: f64 = 60.0;

/// Extracted data from a single ASTERIX CAT048 record
#[derive(Debug, Default)]
struct Cat048Record {
    time_of_day: Option<f64>,
    rho_nm: Option<f64>,
    theta_deg: Option<f64>,
    cart_x_nm: Option<f64>,
    cart_y_nm: Option<f64>,
    flight_level: Option<f64>,
    mode_s_address: Option<u32>,
    ground_speed_kts: Option<f64>,
    heading_deg: Option<f64>,
    track_number: Option<u16>,
    mode3a: Option<u16>,
    /// I020 TYP: 0=none, 1=PSR, 2=SSR, 3=combined, 4=ModeS All-Call,
    /// 5=ModeS Roll-Call, 6=ModeS All-Call+PSR, 7=ModeS Roll-Call+PSR
    radar_typ: u8,
    /// I020 SIM bit: 0=actual, 1=simulated
    sim_flag: bool,
}

/// classify_and_convert 결과
enum RecordOutcome {
    Discard,
    ModesSPoint(TrackPoint, Option<u16>),   // Mode-S 주소 있음 + mode3a
    AtcrbsPoint(TrackPoint, Option<u16>),   // Mode-S 없음 + mode3a → ATCRBS 풀
}

/// TrackAssembler: 삽입 시 실시간 garble 검증
struct TrackAssembler {
    tracks: HashMap<String, Vec<TrackPoint>>,  // Mode-S → 시간순 포인트
    atcrbs_pool: Vec<(TrackPoint, Option<u16>)>, // (포인트, mode3a)
    /// Mode-3/A → Mode-S 매핑 (Mode-S 탐지에서 학습)
    mode3a_to_modes: HashMap<u16, String>,
    stats: ParseStatistics,
}

impl TrackAssembler {
    fn new() -> Self {
        Self {
            tracks: HashMap::new(),
            atcrbs_pool: Vec::new(),
            mode3a_to_modes: HashMap::new(),
            stats: ParseStatistics::default(),
        }
    }

    /// Mode-S 포인트 삽입 (인라인 garble 검출)
    /// mode3a가 있으면 mode3a→Mode-S 매핑을 학습
    fn insert(&mut self, point: TrackPoint, mode3a: Option<u16>) {
        // Mode-3/A → Mode-S 매핑 학습
        if let Some(m3a) = mode3a {
            self.mode3a_to_modes.insert(m3a, point.mode_s.clone());
        }
        let track = self.tracks.entry(point.mode_s.clone()).or_default();

        if let Some(prev) = track.last() {
            let dt = point.timestamp - prev.timestamp;

            // 역순 도착 (dt < 0): 같은 스캔 내 순서 차이로 취급
            let dt_abs = dt.abs();

            // 동일 스캔 중복 제거 (|dt| < 2초)
            if dt_abs < SAME_SCAN_DT {
                if point.radar_type.priority() > prev.radar_type.priority() {
                    // 새 포인트가 우선순위 높음 → 이전 것 교체
                    *track.last_mut().unwrap() = point;
                }
                // 아니면 새 포인트 폐기 (이전 것이 더 좋거나 같음)
                return;
            }

            // garble 검사: 물리적으로 불가능한 속도
            if dt_abs >= MIN_DT {
                let dist = quick_dist_km(
                    prev.latitude, prev.longitude,
                    point.latitude, point.longitude,
                );
                let speed = dist / dt_abs;
                if speed > MAX_GARBLE_SPEED_KMS {
                    self.stats.garbled_removed += 1;
                    return;
                }
            }

            // 고도 급변 검사: 다른 항공기의 garbled Mode-S 감지
            // 짧은 시간(<60s)에 고도가 20m/s(≈3900ft/min) 이상 변하면 거부
            if dt_abs >= MIN_DT && dt_abs < ALT_CHECK_MAX_DT {
                let alt_rate = (point.altitude - prev.altitude).abs() / dt_abs;
                if alt_rate > MAX_ALT_RATE_MS {
                    self.stats.garbled_removed += 1;
                    return;
                }
            }

            // 갭 후 위치+고도 일관성 검사: 예상 위치와 크게 다르고 고도도 다르면 거부
            // (다른 항공기의 garbled Mode-S가 긴 갭 후에 끼어든 경우)
            if dt_abs > 30.0 && track.len() >= 2 {
                let hdg_rad = prev.heading.to_radians();
                let spd_kms = prev.speed * 1.852 / 3600.0; // kts → km/s
                let travel = spd_kms * dt_abs;

                let pred_lat = prev.latitude + hdg_rad.cos() * travel / 111.0;
                let pred_lon = prev.longitude + hdg_rad.sin() * travel
                    / (111.0 * prev.latitude.to_radians().cos());

                let pos_err = quick_dist_km(pred_lat, pred_lon, point.latitude, point.longitude);
                let alt_diff = (point.altitude - prev.altitude).abs();

                // 위치 오차가 크고(>5km) 고도도 다르면(>100m) → 다른 항공기
                if pos_err > 5.0 && alt_diff > 100.0 {
                    self.stats.garbled_removed += 1;
                    return;
                }
                // 위치 오차가 매우 크면(>30km) 고도 무관하게 거부
                if pos_err > 30.0 {
                    self.stats.garbled_removed += 1;
                    return;
                }
            }
        }

        // 타입별 통계
        match &point.radar_type {
            RadarDetectionType::Atcrbs => self.stats.points_by_type[0] += 1,
            RadarDetectionType::AtcrbsPsr => self.stats.points_by_type[1] += 1,
            RadarDetectionType::Modes => self.stats.points_by_type[2] += 1,
            RadarDetectionType::ModesPsr => self.stats.points_by_type[3] += 1,
        }

        track.push(point);
    }

    /// ATCRBS 포인트 삽입 (별도 풀에 수집, mode3a 포함)
    fn insert_atcrbs(&mut self, point: TrackPoint, mode3a: Option<u16>) {
        self.atcrbs_pool.push((point, mode3a));
    }

    /// ATCRBS 풀을 기존 Mode-S 항적에 병합 (Mode-3/A 코드 매칭)
    ///
    /// Mode-S 탐지에서 학습한 mode3a→Mode-S 매핑을 사용하여,
    /// ATCRBS 포인트의 Mode-3/A(squawk)가 일치하는 Mode-S 항적에만 병합.
    /// 거리 검증은 보조적으로 사용 (오매칭 방지).
    fn merge_atcrbs(&mut self, filter_set: &std::collections::HashSet<String>) {
        if self.atcrbs_pool.is_empty() || self.tracks.is_empty() {
            return;
        }

        info!(
            "ATCRBS merge: {} pool points, {} mode3a mappings learned",
            self.atcrbs_pool.len(),
            self.mode3a_to_modes.len()
        );

        // 병합 대상 Mode-S 결정
        let target_modes: std::collections::HashSet<String> = if filter_set.is_empty() {
            self.tracks.iter()
                .filter(|(_, pts)| pts.len() >= 10)
                .map(|(ms, _)| ms.clone())
                .collect()
        } else {
            filter_set.clone()
        };

        if target_modes.is_empty() {
            self.stats.atcrbs_unmatched += self.atcrbs_pool.len();
            return;
        }

        // 각 대상 Mode-S의 포인트를 시간순 참조 (거리 검증용)
        let mut ms_timestamps: HashMap<&str, Vec<(f64, f64, f64)>> = HashMap::new();
        for ms in &target_modes {
            if let Some(pts) = self.tracks.get(ms.as_str()) {
                ms_timestamps.insert(ms.as_str(), pts.iter()
                    .map(|p| (p.timestamp, p.latitude, p.longitude))
                    .collect());
            }
        }

        let pool = std::mem::take(&mut self.atcrbs_pool);
        let mut merged_points: Vec<(String, TrackPoint)> = Vec::new();
        let mut unmatched = 0usize;
        let mut no_mode3a = 0usize;

        for (point, mode3a) in pool {
            // 1차: Mode-3/A 코드로 Mode-S 매핑 조회
            let matched_ms = match mode3a {
                Some(m3a) => self.mode3a_to_modes.get(&m3a).cloned(),
                None => {
                    no_mode3a += 1;
                    None
                }
            };

            let matched_ms = match matched_ms {
                Some(ms) if target_modes.contains(&ms) => ms,
                _ => {
                    unmatched += 1;
                    continue;
                }
            };

            // 2차: 거리 검증 (오매칭 방지)
            let distance_ok = if let Some(ref_pts) = ms_timestamps.get(matched_ms.as_str()) {
                let search_ts = point.timestamp;
                let pos = ref_pts.partition_point(|&(ts, _, _)| ts < search_ts);

                let candidate_indices = [pos.checked_sub(1), Some(pos)];
                let candidates: Vec<usize> = candidate_indices
                    .iter()
                    .filter_map(|x| *x)
                    .filter(|&idx| idx < ref_pts.len())
                    .collect();

                candidates.iter().any(|&idx| {
                    let (ts, lat, lon) = ref_pts[idx];
                    let dt = (point.timestamp - ts).abs();
                    if dt > ATCRBS_MERGE_TIME_GAP { return false; }
                    let dist = quick_dist_km(point.latitude, point.longitude, lat, lon);
                    let max_dist = ATCRBS_MERGE_MAX_SPEED_KMS * dt + ATCRBS_MERGE_MARGIN_KM;
                    dist <= max_dist
                })
            } else {
                false
            };

            if distance_ok {
                merged_points.push((matched_ms, point));
            } else {
                unmatched += 1;
            }
        }

        // 실제 병합
        for (ms, mut np) in merged_points {
            np.mode_s = ms.clone();
            // radar_type은 원래 값 보존 (atcrbs 또는 atcrbs_psr)
            match &np.radar_type {
                RadarDetectionType::Atcrbs => self.stats.points_by_type[0] += 1,
                RadarDetectionType::AtcrbsPsr => self.stats.points_by_type[1] += 1,
                _ => {}
            }
            self.stats.atcrbs_merged += 1;
            self.tracks.entry(ms).or_default().push(np);
        }

        self.stats.atcrbs_unmatched += unmatched;
        info!(
            "ATCRBS merge result: merged={}, unmatched={}, no_mode3a={}",
            self.stats.atcrbs_merged, unmatched, no_mode3a
        );
    }

    /// ATCRBS 포인트 중 기준 항적에서 이탈한 것 제거
    fn filter_deviated_atcrbs(&mut self) {
        let mut total_removed = 0usize;

        for (_, track) in &mut self.tracks {
            if track.len() < 3 { continue; }

            // modes 기준 포인트 수집 (인덱스, timestamp, lat, lon)
            let modes_refs: Vec<(usize, f64, f64, f64)> = track.iter()
                .enumerate()
                .filter(|(_, p)| p.radar_type.has_modes())
                .map(|(i, p)| (i, p.timestamp, p.latitude, p.longitude))
                .collect();

            if modes_refs.len() < 2 { continue; }

            let mut remove_indices: Vec<usize> = Vec::new();

            for (i, p) in track.iter().enumerate() {
                if !p.radar_type.is_atcrbs() { continue; }

                let ts = p.timestamp;
                let pos = modes_refs.partition_point(|&(_, t, _, _)| t < ts);

                let expected = if pos == 0 {
                    let (_, t, lat, lon) = modes_refs[0];
                    if (ts - t).abs() > 30.0 { continue; }
                    (lat, lon)
                } else if pos >= modes_refs.len() {
                    let (_, t, lat, lon) = modes_refs[modes_refs.len() - 1];
                    if (ts - t).abs() > 30.0 { continue; }
                    (lat, lon)
                } else {
                    let (_, t0, lat0, lon0) = modes_refs[pos - 1];
                    let (_, t1, lat1, lon1) = modes_refs[pos];
                    let dt_span = t1 - t0;
                    if dt_span < MIN_DT || dt_span > 60.0 { continue; }
                    let ratio = (ts - t0) / dt_span;
                    (lat0 + (lat1 - lat0) * ratio, lon0 + (lon1 - lon0) * ratio)
                };

                let deviation = quick_dist_km(p.latitude, p.longitude, expected.0, expected.1);
                if deviation > MAX_ATCRBS_DEVIATION_KM {
                    remove_indices.push(i);
                }
            }

            if !remove_indices.is_empty() {
                total_removed += remove_indices.len();
                let remove_set: std::collections::HashSet<usize> = remove_indices.into_iter().collect();
                let mut idx = 0;
                track.retain(|_| {
                    let keep = !remove_set.contains(&idx);
                    idx += 1;
                    keep
                });
            }
        }

        if total_removed > 0 {
            self.stats.garbled_removed += total_removed;
            info!("Removed {} deviated ATCRBS points", total_removed);
        }
    }

    /// 양방향 이웃 과속 outlier 제거 (multi-pass)
    /// 양쪽 이웃 모두와 물리적으로 불가능한 속도인 포인트를 제거.
    /// garbled Mode-S로 다른 항공기 트랙에 끼어든 포인트를 잡아냄.
    fn filter_bidirectional_outliers(&mut self) {
        let mut total_removed = 0usize;

        for (_, track) in &mut self.tracks {
            if track.len() < 3 { continue; }

            // multi-pass: 한 번 제거 후 새로운 outlier가 드러날 수 있음
            loop {
                let mut remove_set = vec![false; track.len()];
                let mut removed_this_pass = 0usize;

                for w in 1..track.len() - 1 {
                    if remove_set[w] { continue; }

                    let dt_prev = track[w].timestamp - track[w - 1].timestamp;
                    let dt_next = track[w + 1].timestamp - track[w].timestamp;
                    if dt_prev < MIN_DT || dt_next < MIN_DT { continue; }

                    let speed_prev = quick_dist_km(
                        track[w].latitude, track[w].longitude,
                        track[w - 1].latitude, track[w - 1].longitude,
                    ) / dt_prev;

                    let speed_next = quick_dist_km(
                        track[w].latitude, track[w].longitude,
                        track[w + 1].latitude, track[w + 1].longitude,
                    ) / dt_next;

                    if speed_prev > MAX_GARBLE_SPEED_KMS && speed_next > MAX_GARBLE_SPEED_KMS {
                        remove_set[w] = true;
                        removed_this_pass += 1;
                    }
                }

                if removed_this_pass == 0 { break; }
                total_removed += removed_this_pass;

                let mut idx = 0;
                track.retain(|_| {
                    let keep = !remove_set[idx];
                    idx += 1;
                    keep
                });
            }
        }

        if total_removed > 0 {
            self.stats.garbled_removed += total_removed;
            info!("Removed {} bidirectional outlier points (multi-pass)", total_removed);
        }
    }

    /// 이종 항적 세그먼트 제거: 갭으로 구분된 짧은 세그먼트 중
    /// 트랙 전체의 대표 고도와 크게 다른 것을 제거.
    /// (다른 항공기의 garbled Mode-S가 연속으로 끼어든 경우)
    fn filter_foreign_segments(&mut self) {
        const GAP_THRESHOLD: f64 = 8.0;
        const ALT_MISMATCH_M: f64 = 150.0;

        let mut total_removed = 0usize;

        for (ms, track) in &mut self.tracks {
            if track.len() < 30 { continue; }

            // 갭 기준으로 세그먼트 분할
            let mut segments: Vec<(usize, usize)> = Vec::new();
            let mut seg_start = 0;
            for i in 1..track.len() {
                if track[i].timestamp - track[i - 1].timestamp > GAP_THRESHOLD {
                    segments.push((seg_start, i - 1));
                    seg_start = i;
                }
            }
            segments.push((seg_start, track.len() - 1));

            if segments.len() < 3 { continue; }

            // 각 세그먼트: 길이, 중앙값 고도
            let seg_infos: Vec<(usize, usize, usize, f64)> = segments.iter().map(|&(s, e)| {
                let mut alts: Vec<f64> = (s..=e).map(|i| track[i].altitude).collect();
                alts.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                (s, e, e - s + 1, alts[alts.len() / 2])
            }).collect();

            // 대표 고도: 세그먼트 길이 가중 중앙값
            let total_pts: usize = seg_infos.iter().map(|s| s.2).sum();
            let mut weighted: Vec<(f64, usize)> = seg_infos.iter()
                .map(|s| (s.3, s.2))
                .collect();
            weighted.sort_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
            let half = total_pts / 2;
            let mut cum = 0usize;
            let main_alt = weighted.iter()
                .find(|&&(_, w)| { cum += w; cum >= half })
                .map(|&(a, _)| a)
                .unwrap_or(0.0);

            // 최장 세그먼트 기준 최소 유지 크기
            let max_seg_len = seg_infos.iter().map(|s| s.2).max().unwrap_or(0);
            let min_keep = (max_seg_len / 4).max(40);

            let mut remove_flags = vec![false; track.len()];

            for (i, &(s, e, len, median_alt)) in seg_infos.iter().enumerate() {
                if len >= min_keep { continue; } // 충분히 긴 세그먼트는 유지

                let deviation = (median_alt - main_alt).abs();
                if deviation <= ALT_MISMATCH_M { continue; } // 대표 고도와 비슷하면 유지

                // 이웃 중 하나라도 대표 고도와 비슷하면 → 이 세그먼트는 이종
                let prev_ok = i > 0 && (seg_infos[i - 1].3 - main_alt).abs() < ALT_MISMATCH_M * 2.0;
                let next_ok = i + 1 < seg_infos.len() && (seg_infos[i + 1].3 - main_alt).abs() < ALT_MISMATCH_M * 2.0;

                if prev_ok || next_ok {
                    for j in s..=e {
                        remove_flags[j] = true;
                    }
                }
            }

            let removed: usize = remove_flags.iter().filter(|&&f| f).count();
            if removed > 0 {
                total_removed += removed;
                let mut idx = 0;
                track.retain(|_| {
                    let keep = !remove_flags[idx];
                    idx += 1;
                    keep
                });
                info!("Removed {} foreign segment points from {}", removed, ms);
            }
        }

        if total_removed > 0 {
            self.stats.garbled_removed += total_removed;
        }
    }

    /// 최종화: 모든 트랙 병합 → 시간순 정렬 → 고도 보간
    fn finalize(mut self) -> (Vec<TrackPoint>, ParseStatistics) {
        // ★ 필터 실행 전에 각 트랙을 시간순 정렬 (merge_atcrbs 후 순서가 깨짐)
        for (_, pts) in &mut self.tracks {
            pts.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap_or(std::cmp::Ordering::Equal));
        }

        // ATCRBS 이탈 검사 (modes 기준 항적 대비)
        self.filter_deviated_atcrbs();

        // 양방향 outlier 제거 (multi-pass, garbled Mode-S로 다른 트랙에 끼어든 포인트)
        self.filter_bidirectional_outliers();

        // 이종 항적 세그먼트 제거 (garbled Mode-S로 끼어든 다른 항공기의 연속 포인트)
        self.filter_foreign_segments();

        let mut all_points: Vec<TrackPoint> = Vec::new();
        for (_, mut pts) in self.tracks {
            all_points.append(&mut pts); // 이미 정렬됨
        }

        // 전체 시간순 정렬
        all_points.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap_or(std::cmp::Ordering::Equal));

        // 고도 보간
        interpolate_missing_altitudes(&mut all_points);

        (all_points, self.stats)
    }
}

/// I020 TYP 값을 RadarDetectionType으로 분류하고, TrackPoint 변환
fn classify_and_convert(
    record: &Cat048Record,
    base_date_secs: f64,
    radar_lat: f64,
    radar_lon: f64,
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
        polar_to_latlon(rho, theta, radar_lat, radar_lon)
    } else if let (Some(x_nm), Some(y_nm)) = (record.cart_x_nm, record.cart_y_nm) {
        cartesian_to_latlon(x_nm, y_nm, radar_lat, radar_lon)
    } else {
        return RecordOutcome::Discard;
    };

    // Validate coordinates (Korean airspace)
    if lat < 30.0 || lat > 45.0 || lon < 120.0 || lon > 135.0 {
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

    // I020 TYP → RadarDetectionType
    let radar_type = match record.radar_typ {
        2 => RadarDetectionType::Atcrbs,
        3 => RadarDetectionType::AtcrbsPsr,
        4 | 5 => RadarDetectionType::Modes,
        6 | 7 => RadarDetectionType::ModesPsr,
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
        radar_type,
        raw_data: Vec::new(),
    };

    let mode3a = record.mode3a;

    if mode_s.is_empty() {
        RecordOutcome::AtcrbsPoint(point, mode3a)
    } else {
        RecordOutcome::ModesSPoint(point, mode3a)
    }
}

/// Parse an ASS file (NEC RDRS recording containing ASTERIX data).
/// `radar_lat`/`radar_lon` specify the radar reference point for coordinate conversion.
/// `mode_s_filter` — 빈 벡터이면 전체 데이터 파싱, 값이 있으면 해당 Mode-S만 포함.
/// `on_progress` is called periodically with progress info.
pub fn parse_ass_file<F>(
    path: &str,
    radar_lat: f64,
    radar_lon: f64,
    mode_s_filter: &[String],
    mut on_progress: F,
) -> Result<ParsedFile, ParseError>
where
    F: FnMut(&ParseProgress),
{
    let file_path = Path::new(path);
    let filename = file_path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    info!("Parsing ASS file: {}", path);

    let data = std::fs::read(file_path)?;
    if data.len() < 8 {
        return Err(ParseError::InvalidFormat(
            "File too small to contain valid records".into(),
        ));
    }

    info!("File size: {} bytes", data.len());

    let nec_frame = detect_nec_frame(&data);
    if let Some((month, day)) = nec_frame {
        info!("Detected NEC frame: month={}, day={}", month, day);
    }

    // Mode-S 필터 셋 (대문자 정규화)
    let filter_set: std::collections::HashSet<String> = mode_s_filter
        .iter()
        .map(|s| s.to_uppercase())
        .collect();
    let filtering = !filter_set.is_empty();
    if filtering {
        info!("Mode-S filter active: {:?}", filter_set);
    }

    let mut assembler = TrackAssembler::new();
    let mut parse_errors = Vec::new();
    let mut total_records = 0usize;
    let mut offset = 0usize;
    let mut skipped_bytes = 0usize;

    let base_date_secs = extract_base_date_from_filename(&filename);
    let mut day_offset_secs: f64 = 0.0; // 자정 넘김 보정용
    let mut prev_tod: f64 = 0.0; // 이전 레코드의 time_of_day
    let data_len = data.len();
    let mut last_reported_pct = 0u32;
    let mut point_count = 0usize; // 진행률 보고용

    while offset < data.len() {
        // 진행률 보고 (1% 단위)
        let pct = ((offset as f64 / data_len as f64) * 100.0) as u32;
        if pct > last_reported_pct {
            last_reported_pct = pct;
            on_progress(&ParseProgress {
                filename: filename.clone(),
                percent: pct as f64,
                records: total_records,
                track_points: point_count,
                errors: parse_errors.len(),
            });
        }

        // Check for NEC framing header (5 bytes: month, day, hour, minute, counter)
        if let Some((month, day)) = nec_frame {
            if is_nec_frame(&data, offset, month, day) {
                offset += 5;
                continue;
            }
        }

        // Try to parse an ASTERIX block with chain validation
        if let Some(block_len) = try_asterix_block(&data, offset, nec_frame) {
            let cat = data[offset];

            if cat == CAT048 {
                let block_data = &data[offset..offset + block_len];
                let mut rec_offset = 3; // Skip CAT(1) + LEN(2)

                while rec_offset < block_data.len() {
                    match parse_cat048_record(block_data, rec_offset) {
                        Ok((record, next_offset)) => {
                            total_records += 1;
                            assembler.stats.total_asterix_records += 1;

                            // 자정 넘김 감지: tod가 이전보다 크게 줄어들면 날짜 변경
                            if let Some(tod) = record.time_of_day {
                                if prev_tod > 70000.0 && tod < 16000.0 {
                                    day_offset_secs += 86400.0;
                                    info!("Midnight wrap detected: prev_tod={:.0}, tod={:.0}, day_offset=+{:.0}s", prev_tod, tod, day_offset_secs);
                                }
                                prev_tod = tod;
                            }

                            match classify_and_convert(
                                &record,
                                base_date_secs + day_offset_secs,
                                radar_lat,
                                radar_lon,
                            ) {
                                RecordOutcome::Discard => {
                                    assembler.stats.discarded_psr_none += 1;
                                }
                                RecordOutcome::ModesSPoint(tp, mode3a) => {
                                    // Mode-S 필터 적용
                                    if !filtering || filter_set.contains(&tp.mode_s.to_uppercase()) {
                                        assembler.insert(tp, mode3a);
                                        point_count += 1;
                                    }
                                }
                                RecordOutcome::AtcrbsPoint(tp, mode3a) => {
                                    assembler.insert_atcrbs(tp, mode3a);
                                }
                            }

                            rec_offset = next_offset;
                        }
                        Err(e) => {
                            debug!(
                                "CAT048 record parse error at {:#x}: {}",
                                offset + rec_offset, e
                            );
                            parse_errors.push(format!(
                                "CAT048@{:#x}: {}",
                                offset + rec_offset, e
                            ));
                            break;
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

    // 100% 완료 보고
    on_progress(&ParseProgress {
        filename: filename.clone(),
        percent: 100.0,
        records: total_records,
        track_points: point_count,
        errors: parse_errors.len(),
    });

    // ATCRBS 병합
    assembler.merge_atcrbs(&filter_set);

    // Mode-S 필터 적용 (ATCRBS 병합 후)
    if filtering {
        assembler.tracks.retain(|ms, _| filter_set.contains(&ms.to_uppercase()));
    }

    // 최종화
    let (track_points, stats) = assembler.finalize();

    let start_time = track_points.first().map(|p| p.timestamp);
    let end_time = track_points.last().map(|p| p.timestamp);

    if skipped_bytes > 0 {
        debug!("Skipped {} unrecognized bytes", skipped_bytes);
    }

    info!(
        "Parsed {} track points from {} ASTERIX records ({} errors, {} skipped bytes)",
        track_points.len(),
        total_records,
        parse_errors.len(),
        skipped_bytes
    );
    info!(
        "Stats: discarded={}, garbled={}, atcrbs_merged={}, unmatched={}, by_type={:?}",
        stats.discarded_psr_none, stats.garbled_removed,
        stats.atcrbs_merged, stats.atcrbs_unmatched, stats.points_by_type
    );

    Ok(ParsedFile {
        filename,
        total_records,
        track_points,
        parse_errors,
        start_time,
        end_time,
        radar_lat,
        radar_lon,
        parse_stats: Some(stats),
    })
}

// ─── Preserved validated functions ───

/// Check if there's a valid ASTERIX block at `offset`.
/// Validates by checking if the block chains to another valid block or NEC frame.
/// Returns the block length if valid, None otherwise.
fn try_asterix_block(data: &[u8], offset: usize, nec_frame: Option<(u8, u8)>) -> Option<usize> {
    if offset + 3 > data.len() {
        return None;
    }

    let cat = data[offset];
    if cat != CAT048 && cat != CAT034 && cat != CAT008 {
        return None;
    }

    let block_len = ((data[offset + 1] as usize) << 8) | (data[offset + 2] as usize);

    // Validate block length
    if block_len < 3 || block_len > MAX_BLOCK_LEN || offset + block_len > data.len() {
        return None;
    }

    // Chain validation: what follows this block?
    let next_offset = offset + block_len;

    if next_offset >= data.len() {
        // Block reaches EOF - valid if length is reasonable
        return Some(block_len);
    }

    // Check if next position starts another ASTERIX block
    if is_valid_block_start(data, next_offset) {
        return Some(block_len);
    }

    // Check if next position is a NEC frame
    if let Some((month, day)) = nec_frame {
        if is_nec_frame(data, next_offset, month, day) {
            return Some(block_len);
        }
    }

    // No valid chain - likely a false positive
    None
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
    let scan_len = data.len().min(50_000);

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

/// Extract a base Unix timestamp (UTC midnight) from a filename like "gimpo_260304_0415.ass".
///
/// 파일명의 날짜는 KST(UTC+9) 기준. ASTERIX I140 TOD는 UTC 자정 기준이므로,
/// KST 시각이 09:00 미만이면 UTC 날짜가 하루 전이다.
/// 예: gimpo_260311_0829.ass → 08:29 KST = 23:29 UTC (March 10) → base = March 10 00:00 UTC
fn extract_base_date_from_filename(filename: &str) -> f64 {
    // 확장자 제거 후 '_' 분리
    let stem = filename.rsplit_once('.').map(|(s, _)| s).unwrap_or(filename);
    let parts: Vec<&str> = stem.split('_').collect();

    let mut date_ymd: Option<(i64, u32, u32)> = None;
    let mut time_hm: Option<u32> = None; // KST hour

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
                    time_hm = Some(hh);
                }
            }
        }
    }

    if let Some((year, month, day)) = date_ymd {
        let base = days_from_epoch(year, month, day) as f64 * 86400.0;

        // KST→UTC 보정: KST hour < 9이면 UTC 날짜는 하루 전
        // (09:00 KST = 00:00 UTC 이므로, 그 전은 전날 UTC)
        if let Some(kst_hour) = time_hm {
            if kst_hour < 9 {
                return base - 86400.0;
            }
        }
        base
    } else {
        0.0
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

fn parse_cat048_record(
    block: &[u8],
    offset: usize,
) -> Result<(Cat048Record, usize), ParseError> {
    let (present_items, mut pos) = parse_fspec(block, offset)?;
    let mut record = Cat048Record::default();

    for &item_idx in &present_items {
        if pos >= block.len() {
            break;
        }

        match item_idx {
            // 모든 필드에서 truncation 발생 시 break로 처리하여
            // 이미 파싱된 데이터를 보존 (블록 경계 truncation 대응)
            UAP_I010 => {
                if pos + 2 > block.len() { break; }
                pos += 2;
            }

            UAP_I140 => {
                if pos + 3 > block.len() { break; }
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
                // 첫 바이트 bits 8-6: TYP (레이더 탐지 유형)
                // 첫 바이트 bit 5: SIM (0=actual, 1=simulated)
                if pos >= block.len() { break; }
                let first_byte = block[pos];
                record.radar_typ = (first_byte >> 5) & 0x07;
                record.sim_flag = (first_byte >> 4) & 0x01 == 1;
                let consumed = skip_fx_extended(block, pos);
                if consumed == 0 { break; }
                pos += consumed;
            }

            UAP_I040 => {
                if pos + 4 > block.len() { break; }
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
                if pos + 2 > block.len() { break; }
                let raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                record.mode3a = Some(raw & 0x0FFF);
                pos += 2;
            }

            UAP_I090 => {
                if pos + 2 > block.len() { break; }
                let raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                let v_flag = (raw >> 15) & 1; // 0=validated, 1=not validated
                let g_flag = (raw >> 14) & 1; // 0=ok, 1=garbled
                if v_flag == 0 && g_flag == 0 {
                    let fl = (raw & 0x3FFF) as f64 / 4.0;
                    if fl <= MAX_FLIGHT_LEVEL {
                        record.flight_level = Some(fl);
                    }
                }
                pos += 2;
            }

            UAP_I130 => {
                if pos >= block.len() { break; }
                let sub_fspec = block[pos];
                pos += 1;
                let mut i130_ok = true;
                for bit in (1..=7).rev() {
                    if (sub_fspec >> bit) & 1 == 1 {
                        if pos >= block.len() { i130_ok = false; break; }
                        pos += 1;
                    }
                }
                if !i130_ok { break; }
            }

            UAP_I220 => {
                if pos + 3 > block.len() { break; }
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
                if pos + 6 > block.len() { break; }
                pos += 6;
            }

            UAP_I250 => {
                if pos >= block.len() { break; }
                let rep = block[pos] as usize;
                pos += 1;
                let mb_size = rep.saturating_mul(8);
                if pos + mb_size > block.len() { break; }
                pos += mb_size;
            }

            UAP_I161 => {
                if pos + 2 > block.len() { break; }
                let raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                record.track_number = Some(raw & 0x0FFF);
                pos += 2;
            }

            UAP_I042 => {
                if pos + 4 > block.len() { break; }
                let x_raw = i16::from_be_bytes([block[pos], block[pos + 1]]);
                let y_raw = i16::from_be_bytes([block[pos + 2], block[pos + 3]]);
                record.cart_x_nm = Some(x_raw as f64 / 128.0);
                record.cart_y_nm = Some(y_raw as f64 / 128.0);
                pos += 4;
            }

            UAP_I200 => {
                if pos + 4 > block.len() { break; }
                let gsp_raw = u16::from_be_bytes([block[pos], block[pos + 1]]);
                let hdg_raw = u16::from_be_bytes([block[pos + 2], block[pos + 3]]);
                let speed_kts = (gsp_raw as f64 * 3600.0) / 16384.0;
                if speed_kts <= MAX_SPEED_KTS {
                    record.ground_speed_kts = Some(speed_kts);
                }
                record.heading_deg = Some(hdg_raw as f64 * 360.0 / 65536.0);
                pos += 4;
            }

            UAP_I170 => {
                let consumed = skip_fx_extended(block, pos);
                if consumed == 0 { break; }
                pos += consumed;
            }

            UAP_I210 => {
                if pos + 4 > block.len() { break; }
                pos += 4;
            }

            UAP_I030 => {
                let consumed = skip_fx_extended(block, pos);
                if consumed == 0 { break; }
                pos += consumed;
            }

            UAP_I080 => {
                if pos + 2 > block.len() { break; }
                pos += 2;
            }

            UAP_I100 => {
                if pos + 4 > block.len() { break; }
                pos += 4;
            }

            UAP_I110 => {
                if pos + 2 > block.len() { break; }
                pos += 2;
            }

            UAP_I120 => {
                if pos >= block.len() { break; }
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
                if !i120_ok { break; }
            }

            UAP_I230 => {
                if pos + 2 > block.len() { break; }
                pos += 2;
            }

            UAP_I260 => {
                if pos + 7 > block.len() { break; }
                pos += 7;
            }

            UAP_I055 => {
                if pos + 1 > block.len() { break; }
                pos += 1;
            }

            UAP_I050 => {
                if pos + 2 > block.len() { break; }
                pos += 2;
            }

            UAP_I065 => {
                if pos + 1 > block.len() { break; }
                pos += 1;
            }

            UAP_I060 => {
                if pos + 2 > block.len() { break; }
                pos += 2;
            }

            UAP_SP => {
                if pos >= block.len() { break; }
                let sp_len = block[pos] as usize;
                if sp_len < 1 || pos + sp_len > block.len() { break; }
                pos += sp_len;
            }

            UAP_RE => {
                if pos >= block.len() { break; }
                let re_len = block[pos] as usize;
                if re_len < 1 || pos + re_len > block.len() { break; }
                pos += re_len;
            }

            _ => {
                warn!("Unknown CAT048 item index {} at offset {}", item_idx, pos);
                break;
            }
        }
    }

    Ok((record, pos))
}

/// 고도 보간: Mode-S별로 altitude=0인 포인트에 직전/직후 유효 고도를 적용
fn interpolate_missing_altitudes(points: &mut [TrackPoint]) {
    let mut groups: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, p) in points.iter().enumerate() {
        groups.entry(p.mode_s.clone()).or_default().push(i);
    }

    for indices in groups.values() {
        // Forward pass: 직전 유효 고도로 채움
        let mut last_alt: Option<f64> = None;
        for &i in indices {
            if points[i].altitude > 0.0 {
                last_alt = Some(points[i].altitude);
            } else if let Some(alt) = last_alt {
                points[i].altitude = alt;
            }
        }
        // Backward pass: 앞에서 못 채운 포인트를 직후 유효 고도로 채움
        let mut next_alt: Option<f64> = None;
        for &i in indices.iter().rev() {
            if points[i].altitude > 0.0 {
                next_alt = Some(points[i].altitude);
            } else if let Some(alt) = next_alt {
                points[i].altitude = alt;
            }
        }
    }
}

/// 빠른 거리 계산 (Equirectangular 근사, km)
fn quick_dist_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let cos_mid = ((lat1 + lat2) / 2.0).to_radians().cos();
    let x = dlon * cos_mid;
    ((dlat * dlat + x * x).sqrt()) * 6371.0
}

fn polar_to_latlon(rho_nm: f64, theta_deg: f64, radar_lat: f64, radar_lon: f64) -> (f64, f64) {
    let rng_km = rho_nm * 1.852;
    let az_rad = theta_deg.to_radians();

    let lat_offset = rng_km * az_rad.cos() / 111.32;
    let lon_offset = rng_km * az_rad.sin() / (111.32 * radar_lat.to_radians().cos());

    (radar_lat + lat_offset, radar_lon + lon_offset)
}

fn cartesian_to_latlon(x_nm: f64, y_nm: f64, radar_lat: f64, radar_lon: f64) -> (f64, f64) {
    let x_km = x_nm * 1.852;
    let y_km = y_nm * 1.852;

    let lat_offset = y_km / 111.32;
    let lon_offset = x_km / (111.32 * radar_lat.to_radians().cos());

    (radar_lat + lat_offset, radar_lon + lon_offset)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_polar_to_latlon_north() {
        let (lat, lon) = polar_to_latlon(30.0, 0.0, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON);
        assert!((lat - (DEFAULT_RADAR_LAT + 30.0 * 1.852 / 111.32)).abs() < 0.001);
        assert!((lon - DEFAULT_RADAR_LON).abs() < 0.001);
    }

    #[test]
    fn test_polar_to_latlon_east() {
        let (lat, lon) = polar_to_latlon(20.0, 90.0, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON);
        assert!((lat - DEFAULT_RADAR_LAT).abs() < 0.01);
        assert!(lon > DEFAULT_RADAR_LON);
    }

    #[test]
    fn test_cartesian_to_latlon() {
        let (lat, lon) = cartesian_to_latlon(10.0, 10.0, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON);
        assert!(lat > DEFAULT_RADAR_LAT);
        assert!(lon > DEFAULT_RADAR_LON);
    }

    #[test]
    fn test_i16_from_be_bytes() {
        assert_eq!(i16::from_be_bytes([0xFF, 0xFF]), -1);
        assert_eq!(i16::from_be_bytes([0x80, 0x00]), -32768);
        assert_eq!(i16::from_be_bytes([0x00, 0x01]), 1);
        assert_eq!(i16::from_be_bytes([0x7F, 0xFF]), 32767);
    }

    #[test]
    fn test_parse_fspec_single_byte() {
        let data = vec![0xF0];
        let (present, next) = parse_fspec(&data, 0).unwrap();
        assert_eq!(next, 1);
        assert_eq!(present, vec![UAP_I010, UAP_I140, UAP_I020, UAP_I040]);
    }

    #[test]
    fn test_parse_fspec_two_bytes() {
        let data = vec![0xF3, 0x16];
        let (present, next) = parse_fspec(&data, 0).unwrap();
        assert_eq!(next, 2);
        assert!(present.contains(&UAP_I010));
        assert!(present.contains(&UAP_I140));
        assert!(present.contains(&UAP_I040));
        assert!(present.contains(&UAP_I130));
        assert!(present.contains(&UAP_I161));
        assert!(present.contains(&UAP_I200));
        assert!(present.contains(&UAP_I170));
    }

    #[test]
    fn test_days_from_epoch() {
        let days = days_from_epoch(2026, 3, 4);
        assert!(days > 20000);
        assert!(days < 21000);
    }

    #[test]
    fn test_extract_base_date() {
        // 04:15 KST < 09:00 → UTC date is previous day (March 3)
        let ts = extract_base_date_from_filename("gimpo_260304_0415.ass");
        assert!(ts > 0.0);
        let expected = days_from_epoch(2026, 3, 3) as f64 * 86400.0; // March 3 UTC
        assert!((ts - expected).abs() < 1.0, "0415 KST: expected March 3 UTC, got delta={}", ts - expected);

        // 09:06 KST >= 09:00 → UTC date is same day (March 12)
        let ts2 = extract_base_date_from_filename("gimpo_260312_0906.ass");
        let expected2 = days_from_epoch(2026, 3, 12) as f64 * 86400.0;
        assert!((ts2 - expected2).abs() < 1.0, "0906 KST: expected March 12 UTC, got delta={}", ts2 - expected2);

        // 08:29 KST < 09:00 → UTC date is previous day (March 10)
        let ts3 = extract_base_date_from_filename("gimpo_260311_0829.ass");
        let expected3 = days_from_epoch(2026, 3, 10) as f64 * 86400.0;
        assert!((ts3 - expected3).abs() < 1.0, "0829 KST: expected March 10 UTC, got delta={}", ts3 - expected3);

        // Two consecutive files should NOT overlap
        let base_0311 = extract_base_date_from_filename("gimpo_260311_0829.ass"); // March 10 UTC
        let base_0312 = extract_base_date_from_filename("gimpo_260312_0906.ass"); // March 12 UTC
        let gap = base_0312 - base_0311;
        assert!(gap >= 86400.0, "Bases must be ≥1 day apart, got {}s", gap);

        // No time part → fallback to filename date as UTC
        let ts4 = extract_base_date_from_filename("gimpo_260304.ass");
        let expected4 = days_from_epoch(2026, 3, 4) as f64 * 86400.0;
        assert!((ts4 - expected4).abs() < 1.0);

        // 09:00 KST exactly = 00:00 UTC → same day
        let ts5 = extract_base_date_from_filename("gimpo_260315_0900.ass");
        let expected5 = days_from_epoch(2026, 3, 15) as f64 * 86400.0;
        assert!((ts5 - expected5).abs() < 1.0);
    }

    #[test]
    fn test_skip_fx_extended() {
        let data = vec![0b10110100];
        assert_eq!(skip_fx_extended(&data, 0), 1);

        let data = vec![0b10110101, 0b00110100];
        assert_eq!(skip_fx_extended(&data, 0), 2);
    }

    #[test]
    fn test_detect_nec_frame_requires_confirmation() {
        let mut data = vec![0x03, 0x04, 0x04, 0x0f, 0x0c]; // NEC frame + counter
        data.push(0x30); // CAT048
        data.extend_from_slice(&[0x00, 0x1a]); // LEN=26
        data.extend(vec![0x00; 23]); // record data
        data.extend_from_slice(&[0x03, 0x04, 0x04, 0x10, 0x0d]); // minute changed
        data.push(0x22); // CAT034
        data.extend_from_slice(&[0x00, 0x0b]); // LEN=11
        data.extend(vec![0x00; 8]);

        let frame = detect_nec_frame(&data);
        assert_eq!(frame, Some((0x03, 0x04)));
    }

    #[test]
    fn test_detect_nec_frame_no_false_positive() {
        let mut data = vec![0x03, 0x04, 0x04, 0x0f, 0x0c];
        data.push(0x30);
        data.extend_from_slice(&[0x00, 0x1a]);
        data.extend(vec![0xAA; 23]);

        let frame = detect_nec_frame(&data);
        assert_eq!(frame, None);
    }

    #[test]
    fn test_is_nec_frame() {
        let data = vec![0x03, 0x0c, 0x09, 0x06, 0x17, 0x30, 0x00, 0x10];
        assert!(is_nec_frame(&data, 0, 0x03, 0x0c));

        let data2 = vec![0x03, 0x0c, 0x0a, 0x15, 0x20, 0x22, 0x00, 0x10];
        assert!(is_nec_frame(&data2, 0, 0x03, 0x0c));

        assert!(!is_nec_frame(&data, 0, 0x04, 0x0c));

        let data3 = vec![0x03, 0x0c, 0x18, 0x06, 0x17, 0x30];
        assert!(!is_nec_frame(&data3, 0, 0x03, 0x0c));
    }

    #[test]
    fn test_chain_validation() {
        let mut data = Vec::new();
        data.push(0x22);
        data.extend_from_slice(&[0x00, 0x05]);
        data.extend_from_slice(&[0x00, 0x00]);
        data.push(0x30);
        data.extend_from_slice(&[0x00, 0x05]);
        data.extend_from_slice(&[0x00, 0x00]);

        assert!(try_asterix_block(&data, 0, None).is_some());

        let solo = vec![0x30, 0x00, 0x05, 0x00, 0x00, 0xAA, 0xBB];
        assert!(try_asterix_block(&solo, 0, None).is_none());
    }

    #[test]
    fn test_classify_discard_typ0() {
        let record = Cat048Record {
            time_of_day: Some(50000.0),
            rho_nm: Some(10.0),
            theta_deg: Some(180.0),
            radar_typ: 0,
            ..Default::default()
        };
        assert!(matches!(
            classify_and_convert(&record, 1700000000.0, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON),
            RecordOutcome::Discard
        ));
    }

    #[test]
    fn test_classify_discard_typ1() {
        let record = Cat048Record {
            time_of_day: Some(50000.0),
            rho_nm: Some(10.0),
            theta_deg: Some(180.0),
            radar_typ: 1,
            ..Default::default()
        };
        assert!(matches!(
            classify_and_convert(&record, 1700000000.0, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON),
            RecordOutcome::Discard
        ));
    }

    #[test]
    fn test_classify_atcrbs() {
        let record = Cat048Record {
            time_of_day: Some(50000.0),
            rho_nm: Some(10.0),
            theta_deg: Some(180.0),
            radar_typ: 2,
            ..Default::default()
        };
        assert!(matches!(
            classify_and_convert(&record, 1700000000.0, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON),
            RecordOutcome::AtcrbsPoint(..)
        ));
    }

    #[test]
    fn test_classify_modes_psr() {
        let record = Cat048Record {
            time_of_day: Some(50000.0),
            rho_nm: Some(10.0),
            theta_deg: Some(180.0),
            radar_typ: 7,
            mode_s_address: Some(0x71BF79),
            ..Default::default()
        };
        match classify_and_convert(&record, 1700000000.0, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON) {
            RecordOutcome::ModesSPoint(tp, _mode3a) => {
                assert_eq!(tp.radar_type, RadarDetectionType::ModesPsr);
                assert_eq!(tp.mode_s, "71BF79");
            }
            _ => panic!("Expected ModesSPoint"),
        }
    }

    #[test]
    fn test_track_assembler_same_scan_dedup() {
        let mut asm = TrackAssembler::new();
        let p1 = TrackPoint {
            timestamp: 1000.0, mode_s: "ABC".to_string(),
            latitude: 37.5, longitude: 126.8, altitude: 3000.0,
            speed: 200.0, heading: 90.0,
            radar_type: RadarDetectionType::Atcrbs,
            raw_data: vec![],
        };
        let p2 = TrackPoint {
            timestamp: 1001.0, mode_s: "ABC".to_string(),
            latitude: 37.5, longitude: 126.8, altitude: 3000.0,
            speed: 200.0, heading: 90.0,
            radar_type: RadarDetectionType::ModesPsr,
            raw_data: vec![],
        };
        asm.insert(p1, None);
        asm.insert(p2, None);
        // 동일 스캔 → 우선순위 높은 ModesPsr이 남아야 함
        assert_eq!(asm.tracks["ABC"].len(), 1);
        assert_eq!(asm.tracks["ABC"][0].radar_type, RadarDetectionType::ModesPsr);
    }

    #[test]
    fn test_track_assembler_garble_reject() {
        let mut asm = TrackAssembler::new();
        let p1 = TrackPoint {
            timestamp: 1000.0, mode_s: "ABC".to_string(),
            latitude: 37.5, longitude: 126.8, altitude: 3000.0,
            speed: 200.0, heading: 90.0,
            radar_type: RadarDetectionType::ModesPsr,
            raw_data: vec![],
        };
        let p2 = TrackPoint {
            timestamp: 1005.0, mode_s: "ABC".to_string(),
            latitude: 35.0, longitude: 129.0, altitude: 3000.0, // ~300km jump in 5s
            speed: 200.0, heading: 90.0,
            radar_type: RadarDetectionType::ModesPsr,
            raw_data: vec![],
        };
        asm.insert(p1, None);
        asm.insert(p2, None);
        assert_eq!(asm.tracks["ABC"].len(), 1); // garbled point rejected
        assert_eq!(asm.stats.garbled_removed, 1);
    }

    #[test]
    #[ignore] // Requires actual ASS file in ass/ directory
    fn test_parse_real_ass_file() {
        let test_file = std::path::Path::new("../ass/gimpo_260312_0906.ass");
        if !test_file.exists() {
            eprintln!("Skipping: test file not found");
            return;
        }
        let result = parse_ass_file(
            test_file.to_str().unwrap(),
            DEFAULT_RADAR_LAT,
            DEFAULT_RADAR_LON,
            &[],
            |_| {},
        )
        .expect("Failed to parse ASS file");

        println!("Total records: {}", result.total_records);
        println!("Track points: {}", result.track_points.len());
        println!("Parse errors: {}", result.parse_errors.len());

        assert!(result.total_records > 10_000, "Expected >10K records, got {}", result.total_records);
        assert!(result.track_points.len() > 5_000, "Expected >5K track points, got {}", result.track_points.len());

        let error_rate = result.parse_errors.len() as f64 / result.total_records as f64;
        assert!(error_rate < 0.01, "Error rate {:.2}% too high", error_rate * 100.0);

        for tp in &result.track_points {
            assert!(tp.latitude >= 30.0 && tp.latitude <= 45.0,
                "Latitude {} out of range", tp.latitude);
            assert!(tp.longitude >= 120.0 && tp.longitude <= 135.0,
                "Longitude {} out of range", tp.longitude);
        }

        if let (Some(start), Some(end)) = (result.start_time, result.end_time) {
            let duration = end - start;
            assert!(duration > 0.0 && duration < 86400.0,
                "Duration {} seconds unreasonable", duration);
        }

        let mut mode_s_codes: std::collections::HashSet<&str> = std::collections::HashSet::new();
        for tp in &result.track_points {
            mode_s_codes.insert(&tp.mode_s);
        }
        println!("Unique Mode-S codes: {}", mode_s_codes.len());
        assert!(mode_s_codes.len() < 10_000,
            "Too many unique Mode-S codes ({}), likely parsing garbage", mode_s_codes.len());

        if let Some(stats) = &result.parse_stats {
            println!("Stats: {:?}", stats);
        }
    }

    #[test]
    #[ignore]
    fn test_debug_71bf78_radar_types() {
        let file1 = "C:\\code\\airmove-analyzer\\ass\\gimpo_260311_0829.ass";
        let file2 = "C:\\code\\airmove-analyzer\\ass\\gimpo_260312_0906.ass";

        if !std::path::Path::new(file1).exists() || !std::path::Path::new(file2).exists() {
            return;
        }

        let r1 = parse_ass_file(file1, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON, &[], |_| {}).unwrap();
        let r2 = parse_ass_file(file2, DEFAULT_RADAR_LAT, DEFAULT_RADAR_LON, &[], |_| {}).unwrap();

        let mut pts1: Vec<&TrackPoint> = r1.track_points.iter().filter(|p| p.mode_s == "71BF78").collect();
        let mut pts2: Vec<&TrackPoint> = r2.track_points.iter().filter(|p| p.mode_s == "71BF78").collect();
        pts1.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap());
        pts2.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap());

        println!("=== TIMESTAMP COMPARISON ===");
        println!("File 1 (0311): {} pts, ts range [{:.0}, {:.0}]",
            pts1.len(), pts1.first().unwrap().timestamp, pts1.last().unwrap().timestamp);
        println!("File 2 (0312): {} pts, ts range [{:.0}, {:.0}]",
            pts2.len(), pts2.first().unwrap().timestamp, pts2.last().unwrap().timestamp);

        let f1_min = pts1.first().unwrap().timestamp;
        let f1_max = pts1.last().unwrap().timestamp;
        let f2_min = pts2.first().unwrap().timestamp;
        let f2_max = pts2.last().unwrap().timestamp;

        let overlap = f1_min <= f2_max && f2_min <= f1_max;
        println!("Overlap: {}", overlap);
        if overlap {
            let o_start = f1_min.max(f2_min);
            let o_end = f1_max.min(f2_max);
            println!("  Overlap range: [{:.0}, {:.0}] ({:.0}s)",
                o_start, o_end, o_end - o_start);
        }

        // 차이 계산
        let gap = if f2_min > f1_max { f2_min - f1_max } else if f1_min > f2_max { f1_min - f2_max } else { 0.0 };
        println!("Gap between files: {:.0}s ({:.1}h)", gap, gap / 3600.0);

        // 앱에서 합쳐졌을 때 시뮬레이션
        let mut combined: Vec<&TrackPoint> = Vec::new();
        combined.extend(&pts1);
        combined.extend(&pts2);
        combined.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap());
        println!("\n=== COMBINED (simulating app) ===");
        println!("Total 71BF78 points: {}", combined.len());

        // 지그재그 탐지: 연속 포인트 간 거리가 비정상적으로 큰 경우
        let mut zigzag_count = 0;
        for i in 0..combined.len()-1 {
            let dt = combined[i+1].timestamp - combined[i].timestamp;
            if dt < 0.5 { continue; }
            let dist = quick_dist_km(
                combined[i].latitude, combined[i].longitude,
                combined[i+1].latitude, combined[i+1].longitude,
            );
            let speed_kts = (dist / dt) * 3600.0 / 1.852;
            if speed_kts > 1200.0 {
                zigzag_count += 1;
                if zigzag_count <= 20 {
                    println!("  ZIGZAG[{}] dt={:.1}s dist={:.1}km speed={:.0}kts",
                        zigzag_count, dt, dist, speed_kts);
                    println!("    A: ts={:.0} lat={:.4} lon={:.4} alt={:.0}",
                        combined[i].timestamp, combined[i].latitude, combined[i].longitude, combined[i].altitude);
                    println!("    B: ts={:.0} lat={:.4} lon={:.4} alt={:.0}",
                        combined[i+1].timestamp, combined[i+1].latitude, combined[i+1].longitude, combined[i+1].altitude);
                }
            }
        }
        println!("Total zigzag jumps (>1200kts): {}", zigzag_count);

        let result = r1;

        // ParseStatistics 출력
        if let Some(ref stats) = result.parse_stats {
            println!("=== Parse Statistics ===");
            println!("  total_asterix_records: {}", stats.total_asterix_records);
            println!("  discarded_psr_none: {}", stats.discarded_psr_none);
            println!("  garbled_removed: {}", stats.garbled_removed);
            println!("  atcrbs_merged: {}", stats.atcrbs_merged);
            println!("  atcrbs_unmatched: {}", stats.atcrbs_unmatched);
            println!("  points_by_type: [atcrbs={}, atcrbs_psr={}, modes={}, modes_psr={}]",
                stats.points_by_type[0], stats.points_by_type[1],
                stats.points_by_type[2], stats.points_by_type[3]);
        }

        let mut pts: Vec<&TrackPoint> = result.track_points.iter()
            .filter(|p| p.mode_s == "71BF78")
            .collect();
        pts.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap());

        println!("\n=== 71BF78 radar_type distribution ===");
        println!("Total points: {}", pts.len());
        let mut type_counts: std::collections::HashMap<&RadarDetectionType, usize> = std::collections::HashMap::new();
        for p in &pts {
            *type_counts.entry(&p.radar_type).or_insert(0) += 1;
        }
        for (rt, count) in &type_counts {
            println!("  {:?}: {} ({:.1}%)", rt, count, *count as f64 / pts.len() as f64 * 100.0);
        }

        // 레이더로부터의 거리 분포 (NM)
        println!("\n=== Distance from radar (Gimpo) ===");
        let radar_lat = DEFAULT_RADAR_LAT;
        let radar_lon = DEFAULT_RADAR_LON;
        let mut dists: Vec<(f64, &RadarDetectionType)> = pts.iter()
            .map(|p| {
                let dist_km = quick_dist_km(radar_lat, radar_lon, p.latitude, p.longitude);
                let dist_nm = dist_km / 1.852;
                (dist_nm, &p.radar_type)
            }).collect();

        // 60NM 이상인 포인트의 radar_type
        let beyond_60 = dists.iter().filter(|(d, _)| *d > 60.0).count();
        let beyond_60_modes = dists.iter().filter(|(d, rt)| *d > 60.0 && **rt == RadarDetectionType::Modes).count();
        let beyond_60_modes_psr = dists.iter().filter(|(d, rt)| *d > 60.0 && **rt == RadarDetectionType::ModesPsr).count();
        let within_60 = dists.iter().filter(|(d, _)| *d <= 60.0).count();

        println!("  Within 60NM: {} pts", within_60);
        println!("  Beyond 60NM: {} pts (modes={}, modes_psr={})", beyond_60, beyond_60_modes, beyond_60_modes_psr);

        // 거리별 분포 히스토그램
        let mut bins = vec![0usize; 20]; // 10NM 간격, 0-200NM
        let mut bin_types: Vec<[usize; 4]> = vec![[0; 4]; 20]; // atcrbs, atcrbs_psr, modes, modes_psr
        for (d, rt) in &dists {
            let bin = (*d / 10.0) as usize;
            if bin < 20 {
                bins[bin] += 1;
                let type_idx = match rt {
                    RadarDetectionType::Atcrbs => 0,
                    RadarDetectionType::AtcrbsPsr => 1,
                    RadarDetectionType::Modes => 2,
                    RadarDetectionType::ModesPsr => 3,
                };
                bin_types[bin][type_idx] += 1;
            }
        }
        println!("\n  Distance histogram (10NM bins):");
        for i in 0..20 {
            if bins[i] > 0 {
                println!("    {:3}-{:3}NM: {:4} pts  [atcrbs={}, atcrbs_psr={}, modes={}, modes_psr={}]",
                    i*10, (i+1)*10, bins[i],
                    bin_types[i][0], bin_types[i][1], bin_types[i][2], bin_types[i][3]);
            }
        }

        // 세그먼트 분석 + 동시 존재 탐지
        let base = days_from_epoch(2026, 3, 11) as f64 * 86400.0;

        // 동시 존재 탐지: 8초 gap으로 분할한 세그먼트들이 시간적으로 겹치는지 확인
        println!("\n=== All segments (split at 8s gaps) ===");
        let mut seg_start = 0;
        let mut all_segments: Vec<(usize, usize, f64, f64, f64, f64, f64, f64)> = Vec::new(); // start_idx, end_idx, t0, t1, lat0, lon0, lat1, lon1
        for i in 1..=pts.len() {
            let split = i == pts.len() || pts[i].timestamp - pts[i-1].timestamp > 8.0;
            if split {
                let seg = &pts[seg_start..i];
                let t0 = seg.first().unwrap().timestamp;
                let t1 = seg.last().unwrap().timestamp;
                all_segments.push((
                    seg_start, i-1, t0, t1,
                    seg.first().unwrap().latitude, seg.first().unwrap().longitude,
                    seg.last().unwrap().latitude, seg.last().unwrap().longitude,
                ));
                let tod0 = t0 - base;
                let kst_secs = tod0 + 32400.0;
                let kst_h = (kst_secs / 3600.0) as u32;
                let kst_m = ((kst_secs % 3600.0) / 60.0) as u32;
                let kst_s = (kst_secs % 60.0) as u32;
                let dur = t1 - t0;
                let avg_dist_nm = seg.iter().map(|p| {
                    quick_dist_km(radar_lat, radar_lon, p.latitude, p.longitude) / 1.852
                }).sum::<f64>() / seg.len() as f64;
                println!("  seg[{:4}-{:4}] {:3}pts {:02}:{:02}:{:02} dur={:.0}s dist={:.1}NM hdg={:.0}→{:.0} lat={:.4}→{:.4}",
                    seg_start, i-1, seg.len(), kst_h, kst_m, kst_s, dur, avg_dist_nm,
                    seg.first().unwrap().heading, seg.last().unwrap().heading,
                    seg.first().unwrap().latitude, seg.last().unwrap().latitude);
                seg_start = i;
            }
        }

        // 동시 위치 탐지: dt < 2초인데 거리가 3km 이상인 포인트 쌍
        println!("\n=== Simultaneous positions (dt<2s, dist>3km) ===");
        let mut sim_count = 0;
        for i in 0..pts.len() {
            for j in (i+1)..pts.len() {
                let dt = (pts[j].timestamp - pts[i].timestamp).abs();
                if dt > 2.0 { break; }
                let dist = quick_dist_km(pts[i].latitude, pts[i].longitude,
                                         pts[j].latitude, pts[j].longitude);
                if dist > 3.0 {
                    let tod_i = pts[i].timestamp - base;
                    let kst_h = ((tod_i + 32400.0) / 3600.0) as u32;
                    let kst_m = (((tod_i + 32400.0) % 3600.0) / 60.0) as u32;
                    let kst_s = (tod_i + 32400.0) % 60.0;
                    println!("  [{:02}:{:02}:{:04.1}] dt={:.1}s dist={:.1}km",
                        kst_h, kst_m, kst_s, dt, dist);
                    println!("    A: lat={:.4} lon={:.4} alt={:.0} hdg={:.1} type={:?}",
                        pts[i].latitude, pts[i].longitude, pts[i].altitude, pts[i].heading, pts[i].radar_type);
                    println!("    B: lat={:.4} lon={:.4} alt={:.0} hdg={:.1} type={:?}",
                        pts[j].latitude, pts[j].longitude, pts[j].altitude, pts[j].heading, pts[j].radar_type);
                    sim_count += 1;
                }
            }
        }
        println!("Total simultaneous pairs: {}", sim_count);

        // 71BF79(1호기)도 확인
        let mut pts79: Vec<&TrackPoint> = result.track_points.iter()
            .filter(|p| p.mode_s == "71BF79")
            .collect();
        pts79.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap());
        println!("\n=== 71BF79 (1호기) ===");
        println!("Total points: {}", pts79.len());
        if !pts79.is_empty() {
            let t0 = pts79.first().unwrap().timestamp - base;
            let t1 = pts79.last().unwrap().timestamp - base;
            let kst0 = t0 + 32400.0;
            let kst1 = t1 + 32400.0;
            println!("  Time range: {:.0}s ~ {:.0}s (KST {:.0}h ~ {:.0}h)",
                t0, t1, kst0/3600.0, kst1/3600.0);
            // 71BF78과 71BF79가 동시에 비행하는 구간 확인
            if !pts.is_empty() {
                let overlap_start = pts.first().unwrap().timestamp.max(pts79.first().unwrap().timestamp);
                let overlap_end = pts.last().unwrap().timestamp.min(pts79.last().unwrap().timestamp);
                if overlap_start < overlap_end {
                    let pts78_in_range = pts.iter().filter(|p| p.timestamp >= overlap_start && p.timestamp <= overlap_end).count();
                    let pts79_in_range = pts79.iter().filter(|p| p.timestamp >= overlap_start && p.timestamp <= overlap_end).count();
                    println!("  Overlapping time: {:.0}s", overlap_end - overlap_start);
                    println!("  71BF78 pts in overlap: {}", pts78_in_range);
                    println!("  71BF79 pts in overlap: {}", pts79_in_range);
                }
            }
        }

        // 기본 필터가 등록 기체만 표시하므로, 다른 등록 기체도 확인
        println!("\n=== Top 10 Mode-S by point count ===");
        let mut ms_counts: std::collections::HashMap<&str, usize> = std::collections::HashMap::new();
        for p in &result.track_points {
            *ms_counts.entry(&p.mode_s).or_insert(0) += 1;
        }
        let mut top: Vec<(&&str, &usize)> = ms_counts.iter().collect();
        top.sort_by(|a, b| b.1.cmp(a.1));
        for (ms, cnt) in top.iter().take(10) {
            println!("  {}: {} pts", ms, cnt);
        }

        // 모든 포인트 덤프 (지그재그 패턴 분석)
        println!("\n=== ALL 71BF78 points (every point) ===");
        let first_ts = pts.first().unwrap().timestamp;
        for (i, p) in pts.iter().enumerate() {
            let dt_prev = if i > 0 { p.timestamp - pts[i-1].timestamp } else { 0.0 };
            let dist_prev = if i > 0 {
                quick_dist_km(pts[i-1].latitude, pts[i-1].longitude, p.latitude, p.longitude)
            } else { 0.0 };
            let speed_kts = if i > 0 && dt_prev > 0.5 {
                (dist_prev / dt_prev) * 3600.0 / 1.852
            } else { 0.0 };
            // 방향 변화 (이전 포인트의 heading vs 현재)
            let hdg_change = if i > 0 {
                let d = (p.heading - pts[i-1].heading).abs();
                if d > 180.0 { 360.0 - d } else { d }
            } else { 0.0 };
            println!("  [{:4}] t={:.0} dt={:5.1}s lat={:.5} lon={:.5} alt={:6.0} hdg={:5.1} spd={:5.0} dist={:.2}km vspd={:.0}kts {:?}{}",
                i, p.timestamp - first_ts, dt_prev,
                p.latitude, p.longitude, p.altitude, p.heading, p.speed,
                dist_prev, speed_kts, p.radar_type,
                if hdg_change > 30.0 { " *** HDG_JUMP" } else if speed_kts > 600.0 { " *** FAST" } else { "" });
        }

    }

}
