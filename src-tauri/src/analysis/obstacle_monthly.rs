//! 특정 장애물 월간 분석 모듈
//!
//! 선택된 수동 건물의 방위 구간 내 항적만 필터링하여
//! 일별 PSR 탐지율 및 Loss율을 집계한다.

use std::collections::HashMap;

use log::info;
use serde::{Deserialize, Serialize};

use crate::analysis::loss::calculate_haversine_distance;
use crate::models::{RadarDetectionType, TrackPoint};
use crate::parser;

// ─── 입력 타입 ───

/// 방위 구간 (레이더 기준, 건물 노출면의 시작~끝 방위)
#[derive(Deserialize, Clone, Debug)]
pub struct AzSector {
    pub start_deg: f64,
    pub end_deg: f64,
}

impl AzSector {
    /// 주어진 방위(0~360)가 이 구간에 포함되는지 확인.
    /// start > end인 경우 (예: 350°~10°) 북쪽 wrap-around 처리.
    pub fn contains(&self, az: f64) -> bool {
        let az = ((az % 360.0) + 360.0) % 360.0; // normalize to [0, 360)
        if self.start_deg <= self.end_deg {
            az >= self.start_deg && az <= self.end_deg
        } else {
            // wrap-around: 350° ~ 10° → 350~360 || 0~10
            az >= self.start_deg || az <= self.end_deg
        }
    }
}

/// 레이더별 파일 묶음 + 해당 레이더 기준 방위 구간
#[derive(Deserialize, Debug)]
pub struct RadarFileSet {
    pub radar_name: String,
    pub radar_lat: f64,
    pub radar_lon: f64,
    pub radar_altitude: f64,
    pub antenna_height: f64,
    pub file_paths: Vec<String>,
    pub azimuth_sectors: Vec<AzSector>,
    /// 장애물 최소 거리(km) — 이보다 먼 항적만 분석 대상
    #[serde(default)]
    pub min_obstacle_distance_km: f64,
}

// ─── 출력 타입 ───

/// Loss 발생 좌표 요약 (커버리지맵 오버레이용)
#[derive(Serialize, Clone, Debug)]
pub struct LossPointGeo {
    pub lat: f64,
    pub lon: f64,
    pub alt_ft: f64,
    pub duration_s: f64,
}

/// 항적 포인트 좌표 (LoS 단면도 오버레이용)
#[derive(Serialize, Clone, Debug)]
pub struct TrackPointGeo {
    pub lat: f64,
    pub lon: f64,
    pub alt_ft: f64,
    pub radar_type: String,
}

/// 일별 통계
#[derive(Serialize, Clone, Debug)]
pub struct DailyStats {
    pub date: String,        // "2024-01-15"
    pub day_of_month: u8,
    pub week_num: u8,        // 1~5
    pub total_points: u32,
    pub ssr_combined_points: u32,  // SSR + combined (분모)
    pub psr_combined_points: u32,  // PSR + combined (분자)
    pub psr_rate: f64,
    pub total_track_time_secs: f64,
    pub total_loss_time_secs: f64,
    pub loss_rate: f64,
    pub loss_points_summary: Vec<LossPointGeo>,
    /// 나머지 방위(분석 구간 제외) 베이스라인 Loss 포인트 좌표
    #[serde(default)]
    pub baseline_loss_points: Vec<LossPointGeo>,
    /// 나머지 방위(분석 구간 제외) 베이스라인 Loss율 (%)
    #[serde(default)]
    pub baseline_loss_rate: f64,
    /// 나머지 방위 베이스라인 PSR율 (0~1)
    #[serde(default)]
    pub baseline_psr_rate: f64,
    /// 필터링된 전체 항적 좌표 (LoS 단면도 오버레이용)
    #[serde(default)]
    pub track_points_geo: Vec<TrackPointGeo>,
}

/// 레이더별 월간 분석 결과
#[derive(Serialize, Clone, Debug)]
pub struct RadarMonthlyResult {
    pub radar_name: String,
    pub daily_stats: Vec<DailyStats>,
    pub avg_loss_altitude_ft: f64,
    pub total_files_parsed: usize,
    pub total_points_filtered: u32,
    pub failed_files: Vec<String>,
}

/// 전체 결과
#[derive(Serialize, Clone, Debug)]
pub struct ObstacleMonthlyResult {
    pub radar_results: Vec<RadarMonthlyResult>,
}

/// 진행상황 이벤트
#[derive(Clone, Serialize)]
pub struct ObstacleMonthlyProgress {
    pub radar_name: String,
    pub stage: String,    // "parsing" | "analyzing"
    pub current: usize,
    pub total: usize,
    pub message: String,
}

// ─── 경량 포인트 (메모리 최적화) ───

struct LightPoint {
    timestamp: f64,
    mode_s: String,
    latitude: f64,
    longitude: f64,
    altitude: f64,
    speed: f64,
    radar_type: RadarDetectionType,
}

impl LightPoint {
    fn from_track_point(tp: &TrackPoint) -> Self {
        Self {
            timestamp: tp.timestamp,
            mode_s: tp.mode_s.clone(),
            latitude: tp.latitude,
            longitude: tp.longitude,
            altitude: tp.altitude,
            speed: tp.speed,
            radar_type: tp.radar_type.clone(),
        }
    }
}

fn radar_type_str(rt: &RadarDetectionType) -> &'static str {
    match rt {
        RadarDetectionType::ModeAC => "mode_ac",
        RadarDetectionType::ModeACPsr => "mode_ac_psr",
        RadarDetectionType::ModeSAllCall => "mode_s_allcall",
        RadarDetectionType::ModeSRollCall => "mode_s_rollcall",
        RadarDetectionType::ModeSAllCallPsr => "mode_s_allcall_psr",
        RadarDetectionType::ModeSRollCallPsr => "mode_s_rollcall_psr",
    }
}

// ─── OM 전용 상수 ───

/// OM 분석용 최대 Loss 지속시간 (초): 5분 초과 gap은 오탐 가능성 높아 제외
const MAX_OM_LOSS_DURATION_SECS: f64 = 300.0;

/// gap 전후 실제 보고 속도 변화율 임계값: 이 비율 초과 시 오탐(트랙 스왑 등)으로 제외
const OM_SPEED_CHANGE_RATIO: f64 = 0.5;

// ─── 핵심 로직 ───

/// 포인트가 방위 구간 내에 있는지 확인
fn in_any_sector(az: f64, sectors: &[AzSector]) -> bool {
    sectors.iter().any(|s| s.contains(az))
}

/// 타임스탬프 → 날짜 문자열 (KST = UTC+9)
/// ASS 파일의 타임스탬프는 Unix epoch 초(UTC). 분석월/파일명이 KST 기준이므로
/// 일별 집계도 KST 기준으로 수행한다.
fn timestamp_to_date(ts: f64) -> String {
    const KST_OFFSET: i64 = 9 * 3600; // UTC+9
    let secs = ts as i64 + KST_OFFSET;
    let days = if secs >= 0 { secs / 86400 } else { (secs - 86399) / 86400 };
    let (y, m, d) = days_to_ymd(days);
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// Unix epoch days → (year, month, day)
/// Howard Hinnant's civil_from_days algorithm (proven correct)
fn days_to_ymd(z: i64) -> (i32, u8, u8) {
    let z = z + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32; // [0, 146096]
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365; // [0, 399]
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u8, d as u8)
}

/// day_of_month → 주차 번호 (1~5)
fn week_num(day: u8) -> u8 {
    ((day - 1) / 7 + 1).min(5)
}

/// PSR 분류: SSR+combined 포인트인지
fn is_ssr_combined(rt: &RadarDetectionType) -> bool {
    // SSR 계열: SSR 단독 또는 SSR+PSR(combined)
    // Mode A/C = SSR, Mode S = SSR 계열
    // 모든 탐지 유형이 SSR 기반 → 분모에 포함
    // PSR 단독은 없음 (파서가 제거), 따라서 전체 포인트가 분모
    matches!(
        rt,
        RadarDetectionType::ModeAC
        | RadarDetectionType::ModeACPsr
        | RadarDetectionType::ModeSAllCall
        | RadarDetectionType::ModeSRollCall
        | RadarDetectionType::ModeSAllCallPsr
        | RadarDetectionType::ModeSRollCallPsr
    )
}

/// PSR 분류: PSR 포함 (combined) 포인트인지
fn is_psr_combined(rt: &RadarDetectionType) -> bool {
    rt.has_psr()
}

/// 단일 레이더의 월간 분석 실행
pub fn analyze_radar_monthly(
    radar: &RadarFileSet,
    exclude_mode_s: &[String],
    mag_dec_deg: f64,
    cancel: &std::sync::atomic::AtomicBool,
    progress_fn: &dyn Fn(ObstacleMonthlyProgress),
) -> Result<RadarMonthlyResult, String> {
    let total_files = radar.file_paths.len();
    info!(
        "[ObstacleMonthly] 레이더 '{}' 분석 시작: {} files, {} sectors",
        radar.radar_name,
        total_files,
        radar.azimuth_sectors.len()
    );

    // 1단계: 파일별 순차 파싱 → 필터링 → 일별 버킷 누적
    let mut daily_points: HashMap<String, Vec<LightPoint>> = HashMap::with_capacity(31);
    // 베이스라인용: 분석 구간 제외 나머지 방위 포인트
    let mut daily_baseline_points: HashMap<String, Vec<LightPoint>> = HashMap::with_capacity(31);
    let mut total_filtered = 0u32;
    let mut failed_files: Vec<String> = Vec::new();
    let has_sectors = !radar.azimuth_sectors.is_empty();

    for (i, path) in radar.file_paths.iter().enumerate() {
        // 취소 체크
        if cancel.load(std::sync::atomic::Ordering::Relaxed) {
            return Err("분석이 취소되었습니다".to_string());
        }

        progress_fn(ObstacleMonthlyProgress {
            radar_name: radar.radar_name.clone(),
            stage: "parsing".to_string(),
            current: i + 1,
            total: total_files,
            message: format!(
                "{} 파싱 중... ({}/{})",
                path.split(['/', '\\']).last().unwrap_or(path),
                i + 1,
                total_files
            ),
        });

        // 파싱 (모든 항공기 포함 — 필터 없음)
        let parsed = match parser::ass::parse_ass_file(
            path,
            radar.radar_lat,
            radar.radar_lon,
            &[],   // 포함 Mode-S 없음
            &[],   // 제외 Mode-S 없음
            &[],   // 포함 Squawk 없음
            &[],   // 제외 Squawk 없음
            mag_dec_deg,
            |_| {},
        ) {
            Ok(p) => p,
            Err(e) => {
                info!("[ObstacleMonthly] 파일 파싱 실패: {} — {}", path, e);
                failed_files.push(path.clone());
                continue;
            }
        };

        let point_count = parsed.track_points.len();

        // 필터링: mode_s 제외 + 방위 구간 + 장애물 후방
        for tp in &parsed.track_points {
            // 비행검사기 제외
            if exclude_mode_s.iter().any(|ex| ex.eq_ignore_ascii_case(&tp.mode_s)) {
                continue;
            }

            // 방위 필터링
            let az = crate::geo::bearing_deg(radar.radar_lat, radar.radar_lon, tp.latitude, tp.longitude);
            let in_sector = in_any_sector(az, &radar.azimuth_sectors);

            if in_sector {
                // 장애물 후방 필터: 장애물보다 먼 항적만 포함
                if radar.min_obstacle_distance_km > 0.0 {
                    let dist = calculate_haversine_distance(
                        radar.radar_lat, radar.radar_lon, tp.latitude, tp.longitude,
                    );
                    if dist < radar.min_obstacle_distance_km {
                        continue;
                    }
                }

                let date = timestamp_to_date(tp.timestamp);
                daily_points
                    .entry(date)
                    .or_default()
                    .push(LightPoint::from_track_point(tp));
                total_filtered += 1;
            } else if has_sectors {
                // 나머지 방위 → 베이스라인 버킷 (거리 필터 동일 적용)
                if radar.min_obstacle_distance_km > 0.0 {
                    let dist = calculate_haversine_distance(
                        radar.radar_lat, radar.radar_lon, tp.latitude, tp.longitude,
                    );
                    if dist < radar.min_obstacle_distance_km {
                        continue;
                    }
                }

                let date = timestamp_to_date(tp.timestamp);
                daily_baseline_points
                    .entry(date)
                    .or_default()
                    .push(LightPoint::from_track_point(tp));
            }
        }

        info!(
            "[ObstacleMonthly] {} 파싱 완료: {} points → {} filtered (누적 {})",
            path.split(['/', '\\']).last().unwrap_or(path),
            point_count,
            total_filtered,
            daily_points.values().map(|v| v.len()).sum::<usize>()
        );

        // ParsedFile 메모리 즉시 해제 (drop)
    }

    // 2단계: 일별 집계
    let total_days = daily_points.len();
    let mut daily_stats: Vec<DailyStats> = Vec::with_capacity(total_days);
    let mut all_loss_alt_sum = 0.0f64;
    let mut all_loss_alt_count = 0u32;

    let mut sorted_dates: Vec<String> = daily_points.keys().cloned().collect();
    sorted_dates.sort();

    // 날짜 범위 진단 로그
    if sorted_dates.is_empty() {
        info!("[ObstacleMonthly] 레이더 '{}': 필터링 후 데이터 없음 (총 파일 {}개)", radar.radar_name, total_files);
    } else {
        info!(
            "[ObstacleMonthly] 레이더 '{}': 날짜 범위 {} ~ {} ({} 일, {} 포인트)",
            radar.radar_name,
            sorted_dates.first().unwrap(),
            sorted_dates.last().unwrap(),
            total_days,
            daily_points.values().map(|v| v.len()).sum::<usize>()
        );
    }

    for (di, date) in sorted_dates.iter().enumerate() {
        progress_fn(ObstacleMonthlyProgress {
            radar_name: radar.radar_name.clone(),
            stage: "analyzing".to_string(),
            current: di + 1,
            total: total_days,
            message: format!("{} 분석 중... ({}/{})", date, di + 1, total_days),
        });

        let points = daily_points.get(date).expect("date exists in daily_points keys");

        // 항적 포인트 좌표 수집 (LoS 단면도 오버레이용)
        let day_track_geo: Vec<TrackPointGeo> = points.iter().map(|p| {
            TrackPointGeo {
                lat: p.latitude,
                lon: p.longitude,
                alt_ft: p.altitude * 3.28084,
                radar_type: radar_type_str(&p.radar_type).to_string(),
            }
        }).collect();

        // PSR 통계 (60NM 이내만)
        const PSR_RANGE_KM: f64 = 60.0 * 1.852; // 60NM
        let total_pts = points.len() as u32;
        let ssr_combined = points.iter().filter(|p| {
            let dist = calculate_haversine_distance(radar.radar_lat, radar.radar_lon, p.latitude, p.longitude);
            dist <= PSR_RANGE_KM && is_ssr_combined(&p.radar_type)
        }).count() as u32;
        let psr_combined = points.iter().filter(|p| {
            let dist = calculate_haversine_distance(radar.radar_lat, radar.radar_lon, p.latitude, p.longitude);
            dist <= PSR_RANGE_KM && is_psr_combined(&p.radar_type)
        }).count() as u32;
        let psr_rate = if ssr_combined > 0 {
            psr_combined as f64 / ssr_combined as f64
        } else {
            0.0
        };

        // Loss 분석: mode_s별 그룹 → 기존 loss 알고리즘 재활용
        let mut mode_s_groups: HashMap<&str, Vec<&LightPoint>> = HashMap::new();
        for p in points {
            mode_s_groups.entry(&p.mode_s).or_default().push(p);
        }

        let mut day_track_time = 0.0f64;
        let mut day_loss_time = 0.0f64;
        let mut day_loss_points: Vec<LossPointGeo> = Vec::new();

        for (_ms, mut pts) in mode_s_groups {
            if pts.len() < 2 {
                continue;
            }
            pts.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap_or(std::cmp::Ordering::Equal));

            // 스캔 간격 추정 (median)
            let mut gaps: Vec<f64> = pts.windows(2)
                .map(|w| w[1].timestamp - w[0].timestamp)
                .filter(|&g| g > 0.5 && g < 30.0)
                .collect();
            if gaps.len() < 3 {
                // 유효 gap이 부족하면 Loss 계산 불가 — track_time도 누적하지 않음
                continue;
            }

            // 비행 시간 (gap 유효성 확인 후 누적)
            let track_time = pts.last().expect("pts has at least 2 elements").timestamp - pts.first().expect("pts has at least 2 elements").timestamp;
            day_track_time += track_time;
            gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let scan_interval = gaps[gaps.len() / 2];

            // 최대 레이더 범위 추정 (95th percentile)
            let mut distances: Vec<f64> = pts.iter()
                .map(|p| calculate_haversine_distance(radar.radar_lat, radar.radar_lon, p.latitude, p.longitude))
                .collect();
            distances.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let range_idx = ((distances.len() as f64 * 0.95) as usize).min(distances.len() - 1);
            let max_range = distances[range_idx].max(50.0);

            let threshold = scan_interval * 1.4;
            let boundary = max_range * 1.0; // OUT_OF_RANGE_THRESHOLD

            // Gap 탐지
            for window in pts.windows(2) {
                let prev = window[0];
                let next = window[1];
                let gap = next.timestamp - prev.timestamp;

                if gap > threshold && gap <= MAX_OM_LOSS_DURATION_SECS {
                    let start_dist = calculate_haversine_distance(
                        radar.radar_lat, radar.radar_lon, prev.latitude, prev.longitude,
                    );
                    let end_dist = calculate_haversine_distance(
                        radar.radar_lat, radar.radar_lon, next.latitude, next.longitude,
                    );

                    let missed = gap / scan_interval;
                    let dist = calculate_haversine_distance(prev.latitude, prev.longitude, next.latitude, next.longitude);
                    let implied_speed = (dist / gap) * 3600.0 / 1.852;
                    let speed_dev = if prev.speed > 10.0 {
                        (implied_speed - prev.speed).abs() / prev.speed
                    } else {
                        0.0
                    };

                    // gap 전후 실제 보고 속도 변화율 (트랙 스왑/그룹핑 오류 탐지)
                    let speed_change = if prev.speed > 10.0 && next.speed > 10.0 {
                        let avg_spd = (prev.speed + next.speed) / 2.0;
                        (next.speed - prev.speed).abs() / avg_spd
                    } else {
                        0.0
                    };

                    let is_oor = (start_dist >= boundary && end_dist >= boundary)
                        || (missed >= 15.0 && (start_dist >= boundary || end_dist >= boundary))
                        || speed_dev > 0.5
                        || speed_change > OM_SPEED_CHANGE_RATIO;

                    if !is_oor {
                        // signal_loss
                        day_loss_time += gap;
                        let avg_alt_ft = ((prev.altitude + next.altitude) / 2.0) * 3.28084;
                        all_loss_alt_sum += avg_alt_ft;
                        all_loss_alt_count += 1;
                        // 스캔별 보간 포인트 생성 (TrackMap Worker와 동일)
                        let total_missed = ((gap / scan_interval).round() as u32).saturating_sub(1).max(1);
                        for si in 1..=total_missed {
                            let t = si as f64 / (total_missed as f64 + 1.0);
                            day_loss_points.push(LossPointGeo {
                                lat: prev.latitude + (next.latitude - prev.latitude) * t,
                                lon: prev.longitude + (next.longitude - prev.longitude) * t,
                                alt_ft: (prev.altitude + (next.altitude - prev.altitude) * t) * 3.28084,
                                duration_s: gap,
                            });
                        }
                    }
                }
            }
        }

        let loss_rate = if day_track_time > 0.0 {
            (day_loss_time / day_track_time) * 100.0
        } else {
            0.0
        };

        // ── 베이스라인 (나머지 방위) 일별 통계 계산 ──
        let mut day_baseline_loss_points: Vec<LossPointGeo> = Vec::new();
        let (baseline_loss_rate, baseline_psr_rate) = if has_sectors {
            if let Some(bl_points) = daily_baseline_points.get(date) {
                // PSR 베이스라인
                let bl_ssr = bl_points.iter().filter(|p| {
                    let dist = calculate_haversine_distance(radar.radar_lat, radar.radar_lon, p.latitude, p.longitude);
                    dist <= PSR_RANGE_KM && is_ssr_combined(&p.radar_type)
                }).count() as u32;
                let bl_psr = bl_points.iter().filter(|p| {
                    let dist = calculate_haversine_distance(radar.radar_lat, radar.radar_lon, p.latitude, p.longitude);
                    dist <= PSR_RANGE_KM && is_psr_combined(&p.radar_type)
                }).count() as u32;
                let bl_psr_rate = if bl_ssr > 0 { bl_psr as f64 / bl_ssr as f64 } else { 0.0 };

                // Loss 베이스라인
                let mut bl_ms_groups: HashMap<&str, Vec<&LightPoint>> = HashMap::new();
                for p in bl_points {
                    bl_ms_groups.entry(&p.mode_s).or_default().push(p);
                }
                let mut bl_track_time = 0.0f64;
                let mut bl_loss_time = 0.0f64;
                for (_ms, mut pts) in bl_ms_groups {
                    if pts.len() < 2 { continue; }
                    pts.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap_or(std::cmp::Ordering::Equal));
                    bl_track_time += pts.last().expect("pts has at least 2 elements").timestamp - pts.first().expect("pts has at least 2 elements").timestamp;
                    let mut bl_gaps: Vec<f64> = pts.windows(2)
                        .map(|w| w[1].timestamp - w[0].timestamp)
                        .filter(|&g| g > 0.5 && g < 30.0)
                        .collect();
                    if bl_gaps.len() < 3 { continue; }
                    bl_gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    let bl_scan = bl_gaps[bl_gaps.len() / 2];
                    let mut bl_dists: Vec<f64> = pts.iter()
                        .map(|p| calculate_haversine_distance(radar.radar_lat, radar.radar_lon, p.latitude, p.longitude))
                        .collect();
                    bl_dists.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
                    let bl_range_idx = ((bl_dists.len() as f64 * 0.95) as usize).min(bl_dists.len() - 1);
                    let bl_max_range = bl_dists[bl_range_idx].max(50.0);
                    let bl_threshold = bl_scan * 1.4;
                    let bl_boundary = bl_max_range * 1.0;
                    for window in pts.windows(2) {
                        let prev = window[0];
                        let next = window[1];
                        let gap = next.timestamp - prev.timestamp;
                        if gap > bl_threshold && gap <= MAX_OM_LOSS_DURATION_SECS {
                            let sd = calculate_haversine_distance(radar.radar_lat, radar.radar_lon, prev.latitude, prev.longitude);
                            let ed = calculate_haversine_distance(radar.radar_lat, radar.radar_lon, next.latitude, next.longitude);
                            let missed = gap / bl_scan;
                            let dist = calculate_haversine_distance(prev.latitude, prev.longitude, next.latitude, next.longitude);
                            let implied_speed = (dist / gap) * 3600.0 / 1.852;
                            let speed_dev = if prev.speed > 10.0 { (implied_speed - prev.speed).abs() / prev.speed } else { 0.0 };
                            let speed_change = if prev.speed > 10.0 && next.speed > 10.0 {
                                let avg_spd = (prev.speed + next.speed) / 2.0;
                                (next.speed - prev.speed).abs() / avg_spd
                            } else { 0.0 };
                            let is_oor = (sd >= bl_boundary && ed >= bl_boundary)
                                || (missed >= 15.0 && (sd >= bl_boundary || ed >= bl_boundary))
                                || speed_dev > 0.5
                                || speed_change > OM_SPEED_CHANGE_RATIO;
                            if !is_oor {
                                bl_loss_time += gap;
                                // 스캔별 보간 포인트 생성
                                let total_missed = ((gap / bl_scan).round() as u32).saturating_sub(1).max(1);
                                for si in 1..=total_missed {
                                    let t = si as f64 / (total_missed as f64 + 1.0);
                                    day_baseline_loss_points.push(LossPointGeo {
                                        lat: prev.latitude + (next.latitude - prev.latitude) * t,
                                        lon: prev.longitude + (next.longitude - prev.longitude) * t,
                                        alt_ft: (prev.altitude + (next.altitude - prev.altitude) * t) * 3.28084,
                                        duration_s: gap,
                                    });
                                }
                            }
                        }
                    }
                }
                let bl_lr = if bl_track_time > 0.0 { (bl_loss_time / bl_track_time) * 100.0 } else { 0.0 };
                (bl_lr, bl_psr_rate)
            } else {
                (0.0, 0.0)
            }
        } else {
            (0.0, 0.0)
        };

        // 날짜에서 day_of_month 추출
        let dom: u8 = date[8..10].parse().unwrap_or(1);

        daily_stats.push(DailyStats {
            date: date.clone(),
            day_of_month: dom,
            week_num: week_num(dom),
            total_points: total_pts,
            ssr_combined_points: ssr_combined,
            psr_combined_points: psr_combined,
            psr_rate,
            total_track_time_secs: day_track_time,
            total_loss_time_secs: day_loss_time,
            loss_rate,
            loss_points_summary: day_loss_points,
            baseline_loss_points: day_baseline_loss_points,
            baseline_loss_rate,
            baseline_psr_rate,
            track_points_geo: day_track_geo,
        });
    }

    // 날짜순 정렬
    daily_stats.sort_by(|a, b| a.date.cmp(&b.date));

    let avg_loss_alt = if all_loss_alt_count > 0 {
        all_loss_alt_sum / all_loss_alt_count as f64
    } else {
        5000.0 // 기본값
    };

    info!(
        "[ObstacleMonthly] 레이더 '{}' 분석 완료: {} days, {} filtered points, avg_loss_alt={:.0}ft",
        radar.radar_name, daily_stats.len(), total_filtered, avg_loss_alt
    );

    Ok(RadarMonthlyResult {
        radar_name: radar.radar_name.clone(),
        daily_stats,
        avg_loss_altitude_ft: avg_loss_alt,
        total_files_parsed: total_files,
        total_points_filtered: total_filtered,
        failed_files,
    })
}
