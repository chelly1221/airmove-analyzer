//! 장애물 전파영향 사전검토 분석 모듈
//!
//! 제안 건물이 레이더 전파에 미치는 영향을 사전 분석한다.
//! - 기존 지형 대비 추가 Loss 검출
//! - 해당 지점의 기존 지형 앙각 계산 (최소 0.25° 적용)
//! - 최대 건축가능 높이 산출

use std::collections::HashMap;

use log::info;
use serde::{Deserialize, Serialize};

use crate::analysis::loss::calculate_haversine_distance;
use crate::analysis::obstacle_monthly::{AzSector, RadarFileSet, ObstacleMonthlyProgress};
use crate::models::TrackPoint;
use crate::parser;
use std::sync::Mutex;
use crate::srtm::SrtmReader;

/// 4/3 유효지구반경 (m)
const R_EFF: f64 = 6_371_000.0 * 4.0 / 3.0;

/// 최소 지형 앙각 (도) — 기준 하한
const MIN_TERRAIN_ANGLE_DEG: f64 = 0.25;

// ─── 입력 타입 ───

/// 제안 건물 정보
#[derive(Deserialize, Clone, Debug)]
pub struct ProposedBuilding {
    pub id: i64,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub height_m: f64,
    pub ground_elev_m: f64,
}

// ─── 출력 타입 ───

/// 추가 Loss 이벤트 (건물에 의해 발생하는 Loss)
#[derive(Serialize, Clone, Debug)]
pub struct AdditionalLossEvent {
    pub mode_s: String,
    pub start_time: f64,
    pub end_time: f64,
    pub duration_secs: f64,
    pub start_lat: f64,
    pub start_lon: f64,
    pub start_alt_ft: f64,
    pub end_lat: f64,
    pub end_lon: f64,
    pub end_alt_ft: f64,
    pub avg_alt_ft: f64,
    pub radar_distance_km: f64,
    pub azimuth_deg: f64,
}

/// 건물별 사전검토 결과
#[derive(Serialize, Clone, Debug)]
pub struct PreScreeningBuildingResult {
    pub building_id: i64,
    pub building_name: String,
    pub building_height_m: f64,
    pub ground_elev_m: f64,
    pub distance_km: f64,
    pub azimuth_deg: f64,
    /// 기존 지형 앙각 (°, 최소 0.25° 적용)
    pub terrain_elevation_angle_deg: f64,
    /// 건물 꼭대기 앙각 (°)
    pub building_elevation_angle_deg: f64,
    /// 최대 건축가능 높이 (m) — 기존 지형 앙각을 초과하지 않는 높이
    pub max_buildable_height_m: f64,
    /// 추가 Loss 이벤트 목록
    pub additional_loss_events: Vec<AdditionalLossEvent>,
    /// 추가 Loss 총 시간 (초)
    pub additional_loss_time_secs: f64,
    /// 영향받는 고유 항공기 수
    pub affected_aircraft_count: usize,
    /// 해당 건물 방위 섹터 내 총 항적 시간 (초)
    pub sector_total_track_time_secs: f64,
    /// 해당 건물 방위 섹터 내 기존 Loss 시간 (초)
    pub sector_existing_loss_time_secs: f64,
}

/// 레이더별 사전검토 결과
#[derive(Serialize, Clone, Debug)]
pub struct PreScreeningRadarResult {
    pub radar_name: String,
    pub building_results: Vec<PreScreeningBuildingResult>,
    pub total_files_parsed: usize,
    pub total_points_in_sectors: u32,
    pub analysis_period: String,
    pub failed_files: Vec<String>,
}

/// 전체 사전검토 결과
#[derive(Serialize, Clone, Debug)]
pub struct PreScreeningResult {
    pub radar_results: Vec<PreScreeningRadarResult>,
}

// ─── 핵심 로직 ───

/// 4/3 유효지구 모델 앙각 계산 (도)
fn elevation_angle_deg(d: f64, h_obs: f64, h_radar: f64) -> f64 {
    if d < 1.0 || !d.is_finite() || !h_obs.is_finite() || !h_radar.is_finite() {
        return 0.0;
    }
    let dh = h_obs - h_radar;
    let curv_drop = d * d / (2.0 * R_EFF);
    ((dh - curv_drop) / d).atan().to_degrees()
}

/// 타임스탬프 → 날짜 문자열 (UTC)
fn timestamp_to_date(ts: f64) -> String {
    let secs = ts as i64;
    let days = if secs >= 0 { secs / 86400 } else { (secs - 86399) / 86400 };
    let z = days + 719468;
    let era = (if z >= 0 { z } else { z - 146096 }) / 146097;
    let doe = (z - era * 146097) as u32;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    format!("{:04}-{:02}-{:02}", y, m, d)
}

/// 경량 포인트 (메모리 최적화)
#[derive(Clone)]
struct LightPoint {
    timestamp: f64,
    mode_s: String,
    latitude: f64,
    longitude: f64,
    altitude: f64,   // meters
    speed: f64,
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
        }
    }
}

/// 항공기의 특정 위치에서 건물에 의한 LoS 차단 여부 판정
///
/// 레이더 → 항공기 직선 경로 상에서 건물 위치를 통과할 때
/// 건물 꼭대기가 LoS 선보다 높으면 차단 (4/3 유효지구 모델)
fn is_blocked_by_building(
    radar_lat: f64, radar_lon: f64, radar_height: f64,
    ac_lat: f64, ac_lon: f64, ac_alt: f64,   // 항공기 (해발고 m)
    bldg_lat: f64, bldg_lon: f64, bldg_top: f64,  // 건물 꼭대기 해발고 m
) -> bool {
    let d_total = crate::geo::haversine_m(radar_lat, radar_lon, ac_lat, ac_lon);
    if d_total < 100.0 { return false; }
    let d_bldg = crate::geo::haversine_m(radar_lat, radar_lon, bldg_lat, bldg_lon);
    if d_bldg > d_total || d_bldg < 100.0 { return false; }

    let t = d_bldg / d_total;  // 건물이 LoS 선 상의 비율 위치

    // 4/3 유효지구 모델: LoS 선 높이 at building distance
    // curvature drop at building location
    let curv_drop_bldg = d_bldg * d_bldg / (2.0 * R_EFF);
    let curv_drop_total = d_total * d_total / (2.0 * R_EFF);

    // 직선 보간 높이 (4/3 유효지구 프레임)
    let los_height_at_bldg = radar_height * (1.0 - t) + (ac_alt + curv_drop_total) * t - curv_drop_bldg;

    // 건물 꼭대기가 LOS보다 높으면 차단
    bldg_top > los_height_at_bldg
}

/// 기존 지형에 의한 LoS 차단 여부 (건물 제외, SRTM 지형만)
/// 레이더 → 항공기 경로 상 지형 스캔
fn is_blocked_by_terrain(
    radar_lat: f64, radar_lon: f64, radar_height: f64,
    ac_lat: f64, ac_lon: f64, ac_alt: f64,
    srtm: &Mutex<SrtmReader>,
    num_samples: usize,
) -> bool {
    let d_total = crate::geo::haversine_m(radar_lat, radar_lon, ac_lat, ac_lon);
    if d_total < 200.0 { return false; }
    let curv_drop_total = d_total * d_total / (2.0 * R_EFF);

    for i in 1..num_samples {
        let t = i as f64 / num_samples as f64;
        let lat = radar_lat + (ac_lat - radar_lat) * t;
        let lon = radar_lon + (ac_lon - radar_lon) * t;
        let d = d_total * t;

        let terrain_elev = srtm.lock().ok()
            .and_then(|mut s| s.get_elevation(lat, lon))
            .unwrap_or(0.0);
        let curv_drop = d * d / (2.0 * R_EFF);
        let los_height = radar_height * (1.0 - t) + (ac_alt + curv_drop_total) * t - curv_drop;

        if terrain_elev > los_height {
            return true;
        }
    }
    false
}

/// 단일 레이더의 사전검토 분석 실행
pub fn analyze_pre_screening(
    radar: &RadarFileSet,
    buildings: &[ProposedBuilding],
    exclude_mode_s: &[String],
    mag_dec_deg: f64,
    srtm: &Mutex<SrtmReader>,
    progress_fn: &dyn Fn(ObstacleMonthlyProgress),
) -> Result<PreScreeningRadarResult, String> {
    let total_files = radar.file_paths.len();
    info!(
        "[PreScreening] 레이더 '{}' 분석 시작: {} files, {} buildings",
        radar.radar_name, total_files, buildings.len()
    );

    let radar_height = radar.radar_altitude + radar.antenna_height;

    // 건물별 방위 구간 + 기본 정보 준비
    struct BuildingInfo {
        bldg: ProposedBuilding,
        azimuth_deg: f64,
        distance_m: f64,
        bldg_top_m: f64, // 해발고
        terrain_angle_deg: f64,
        building_angle_deg: f64,
        max_buildable_m: f64,
        sector: AzSector,
    }

    let mut bldg_infos: Vec<BuildingInfo> = Vec::new();
    for b in buildings {
        let dist = crate::geo::haversine_m(radar.radar_lat, radar.radar_lon, b.latitude, b.longitude);
        let az = crate::geo::bearing_deg(radar.radar_lat, radar.radar_lon, b.latitude, b.longitude);
        let bldg_top = b.ground_elev_m + b.height_m;

        // 기존 지형 앙각: SRTM 기반 레이더→건물 경로 상 최대 앙각
        let mut max_terrain_angle = 0.0f64;
        let terrain_samples = 50;
        for i in 1..=terrain_samples {
            let t = i as f64 / terrain_samples as f64;
            let lat = radar.radar_lat + (b.latitude - radar.radar_lat) * t;
            let lon = radar.radar_lon + (b.longitude - radar.radar_lon) * t;
            let d = dist * t;
            let elev = srtm.lock().ok()
                .and_then(|mut s| s.get_elevation(lat, lon))
                .unwrap_or(0.0);
            let angle = elevation_angle_deg(d, elev, radar_height);
            if angle > max_terrain_angle {
                max_terrain_angle = angle;
            }
        }

        // 최소 0.25° 적용
        let terrain_angle = max_terrain_angle.max(MIN_TERRAIN_ANGLE_DEG);

        // 건물 앙각
        let building_angle = elevation_angle_deg(dist, bldg_top, radar_height);

        // 최대 건축가능 높이: terrain_angle 기준으로 역산
        let terrain_angle_rad = terrain_angle.to_radians();
        let curv_drop = dist * dist / (2.0 * R_EFF);
        let max_top = radar_height + dist * terrain_angle_rad.tan() + curv_drop;
        let max_buildable = (max_top - b.ground_elev_m).max(0.0);

        // 방위 섹터: 건물 방위 ± 2° (건물 크기에 따라 더 넓을 수 있지만 기본값)
        let half_width = 2.0f64;
        let sector = AzSector {
            start_deg: (az - half_width + 360.0) % 360.0,
            end_deg: (az + half_width) % 360.0,
        };

        bldg_infos.push(BuildingInfo {
            bldg: b.clone(),
            azimuth_deg: az,
            distance_m: dist,
            bldg_top_m: bldg_top,
            terrain_angle_deg: terrain_angle,
            building_angle_deg: building_angle,
            max_buildable_m: max_buildable,
            sector,
        });
    }

    // 1단계: 파일 파싱 → 건물별 방위 구간 내 포인트 수집
    // 건물별 포인트 버킷 (building_index → Vec<LightPoint>)
    let mut bldg_points: Vec<Vec<LightPoint>> = vec![Vec::new(); buildings.len()];
    let mut total_in_sectors = 0u32;
    let mut failed_files: Vec<String> = Vec::new();

    for (fi, path) in radar.file_paths.iter().enumerate() {
        progress_fn(ObstacleMonthlyProgress {
            radar_name: radar.radar_name.clone(),
            stage: "parsing".to_string(),
            current: fi + 1,
            total: total_files,
            message: format!(
                "{} 파싱 중... ({}/{})",
                path.split(['/', '\\']).last().unwrap_or(path),
                fi + 1, total_files
            ),
        });

        let parsed = match parser::ass::parse_ass_file(
            path, radar.radar_lat, radar.radar_lon, &[], &[], mag_dec_deg, "and", false, false, |_| {},
        ) {
            Ok(p) => p,
            Err(e) => {
                info!("[PreScreening] 파싱 실패: {} — {}", path, e);
                failed_files.push(path.clone());
                continue;
            }
        };

        for tp in &parsed.track_points {
            if exclude_mode_s.iter().any(|ex| ex.eq_ignore_ascii_case(&tp.mode_s)) {
                continue;
            }

            let az = crate::geo::bearing_deg(radar.radar_lat, radar.radar_lon, tp.latitude, tp.longitude);
            let dist_to_radar = calculate_haversine_distance(
                radar.radar_lat, radar.radar_lon, tp.latitude, tp.longitude,
            );

            // 각 건물의 방위 구간 확인
            for (bi, info) in bldg_infos.iter().enumerate() {
                if info.sector.contains(az) {
                    // 건물보다 먼 항적만 대상 (건물 후방)
                    let bldg_dist_km = info.distance_m / 1000.0;
                    if dist_to_radar >= bldg_dist_km {
                        bldg_points[bi].push(LightPoint::from_track_point(tp));
                        total_in_sectors += 1;
                    }
                }
            }
        }
    }

    // 2단계: 건물별 추가 Loss 분석
    let mut building_results: Vec<PreScreeningBuildingResult> = Vec::new();

    for (bi, info) in bldg_infos.iter().enumerate() {
        progress_fn(ObstacleMonthlyProgress {
            radar_name: radar.radar_name.clone(),
            stage: "analyzing".to_string(),
            current: bi + 1,
            total: buildings.len(),
            message: format!(
                "{} 분석 중... ({}/{})",
                info.bldg.name, bi + 1, buildings.len()
            ),
        });

        let points = &bldg_points[bi];
        if points.is_empty() {
            building_results.push(PreScreeningBuildingResult {
                building_id: info.bldg.id,
                building_name: info.bldg.name.clone(),
                building_height_m: info.bldg.height_m,
                ground_elev_m: info.bldg.ground_elev_m,
                distance_km: info.distance_m / 1000.0,
                azimuth_deg: info.azimuth_deg,
                terrain_elevation_angle_deg: info.terrain_angle_deg,
                building_elevation_angle_deg: info.building_angle_deg,
                max_buildable_height_m: info.max_buildable_m,
                additional_loss_events: Vec::new(),
                additional_loss_time_secs: 0.0,
                affected_aircraft_count: 0,
                sector_total_track_time_secs: 0.0,
                sector_existing_loss_time_secs: 0.0,
            });
            continue;
        }

        // mode_s별 그룹핑 후 시간순 정렬
        let mut ms_groups: HashMap<&str, Vec<&LightPoint>> = HashMap::new();
        for p in points {
            ms_groups.entry(&p.mode_s).or_default().push(p);
        }

        let mut additional_losses: Vec<AdditionalLossEvent> = Vec::new();
        let mut total_track_time = 0.0f64;
        let mut existing_loss_time = 0.0f64;
        let mut additional_loss_time = 0.0f64;

        for (_ms, mut pts) in ms_groups {
            if pts.len() < 2 { continue; }
            pts.sort_by(|a, b| a.timestamp.partial_cmp(&b.timestamp).unwrap_or(std::cmp::Ordering::Equal));

            let track_time = pts.last().expect("pts has at least 2 elements").timestamp - pts.first().expect("pts has at least 2 elements").timestamp;
            total_track_time += track_time;

            // 스캔 간격 추정
            let mut gaps: Vec<f64> = pts.windows(2)
                .map(|w| w[1].timestamp - w[0].timestamp)
                .filter(|&g| g > 0.5 && g < 30.0)
                .collect();
            if gaps.len() < 3 { continue; }
            gaps.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let scan_interval = gaps[gaps.len() / 2];
            let threshold = scan_interval * 1.4;

            // 최대 범위 추정
            let mut distances: Vec<f64> = pts.iter()
                .map(|p| calculate_haversine_distance(radar.radar_lat, radar.radar_lon, p.latitude, p.longitude))
                .collect();
            distances.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let range_idx = ((distances.len() as f64 * 0.95) as usize).min(distances.len() - 1);
            let max_range = distances[range_idx].max(50.0);
            let boundary = max_range;

            // 탐지된 포인트들에 대해 건물 차단 검사
            // 건물 앙각이 지형 앙각보다 높으면, 건물 뒤 저고도 항적은 추가 Loss 가능
            for window in pts.windows(2) {
                let prev = window[0];
                let next = window[1];
                let gap = next.timestamp - prev.timestamp;

                if gap <= threshold || gap > 14400.0 { continue; }

                // out_of_range 제외
                let sd = calculate_haversine_distance(radar.radar_lat, radar.radar_lon, prev.latitude, prev.longitude);
                let ed = calculate_haversine_distance(radar.radar_lat, radar.radar_lon, next.latitude, next.longitude);
                let missed = gap / scan_interval;
                let dist = calculate_haversine_distance(prev.latitude, prev.longitude, next.latitude, next.longitude);
                let implied_speed = (dist / gap) * 3600.0 / 1.852;
                let speed_dev = if prev.speed > 10.0 { (implied_speed - prev.speed).abs() / prev.speed } else { 0.0 };
                let is_oor = (sd >= boundary && ed >= boundary)
                    || (missed >= 15.0 && (sd >= boundary || ed >= boundary))
                    || speed_dev > 0.5;

                if is_oor { continue; }

                // 이 gap은 signal_loss로 분류됨
                existing_loss_time += gap;

                // 이 Loss가 건물에 의한 것인지 확인:
                // gap 중간 보간 포인트에서 건물 차단 여부 검사
                let mid_lat = (prev.latitude + next.latitude) / 2.0;
                let mid_lon = (prev.longitude + next.longitude) / 2.0;
                let mid_alt = (prev.altitude + next.altitude) / 2.0;

                let blocked_by_building = is_blocked_by_building(
                    radar.radar_lat, radar.radar_lon, radar_height,
                    mid_lat, mid_lon, mid_alt,
                    info.bldg.latitude, info.bldg.longitude, info.bldg_top_m,
                );

                if blocked_by_building {
                    // 기존 지형만으로도 차단되는지 확인 (SRTM 20 샘플)
                    let blocked_by_terrain = is_blocked_by_terrain(
                        radar.radar_lat, radar.radar_lon, radar_height,
                        mid_lat, mid_lon, mid_alt,
                        srtm, 20,
                    );

                    if !blocked_by_terrain {
                        // 건물에 의해서만 추가로 차단됨 → 추가 Loss
                        let avg_alt_ft = ((prev.altitude + next.altitude) / 2.0) * 3.28084;
                        let mid_dist = calculate_haversine_distance(radar.radar_lat, radar.radar_lon, mid_lat, mid_lon);
                        let mid_az = crate::geo::bearing_deg(radar.radar_lat, radar.radar_lon, mid_lat, mid_lon);

                        additional_losses.push(AdditionalLossEvent {
                            mode_s: prev.mode_s.clone(),
                            start_time: prev.timestamp,
                            end_time: next.timestamp,
                            duration_secs: gap,
                            start_lat: prev.latitude,
                            start_lon: prev.longitude,
                            start_alt_ft: prev.altitude * 3.28084,
                            end_lat: next.latitude,
                            end_lon: next.longitude,
                            end_alt_ft: next.altitude * 3.28084,
                            avg_alt_ft,
                            radar_distance_km: mid_dist,
                            azimuth_deg: mid_az,
                        });
                        additional_loss_time += gap;
                    }
                }
            }
        }

        // 영향받는 고유 항공기 수
        let affected_count = {
            let mut set = std::collections::HashSet::new();
            for ev in &additional_losses {
                set.insert(ev.mode_s.as_str());
            }
            set.len()
        };

        building_results.push(PreScreeningBuildingResult {
            building_id: info.bldg.id,
            building_name: info.bldg.name.clone(),
            building_height_m: info.bldg.height_m,
            ground_elev_m: info.bldg.ground_elev_m,
            distance_km: info.distance_m / 1000.0,
            azimuth_deg: info.azimuth_deg,
            terrain_elevation_angle_deg: info.terrain_angle_deg,
            building_elevation_angle_deg: info.building_angle_deg,
            max_buildable_height_m: info.max_buildable_m,
            additional_loss_events: additional_losses,
            additional_loss_time_secs: additional_loss_time,
            affected_aircraft_count: affected_count,
            sector_total_track_time_secs: total_track_time,
            sector_existing_loss_time_secs: existing_loss_time,
        });
    }

    // 분석 기간
    let period = if !bldg_points.is_empty() {
        let all_dates: Vec<String> = bldg_points.iter()
            .flat_map(|pts| pts.iter().map(|p| timestamp_to_date(p.timestamp)))
            .collect();
        if let (Some(first), Some(last)) = (all_dates.iter().min(), all_dates.iter().max()) {
            format!("{} ~ {}", first, last)
        } else {
            String::new()
        }
    } else {
        String::new()
    };

    info!(
        "[PreScreening] 레이더 '{}' 완료: {} buildings, {} points in sectors",
        radar.radar_name, building_results.len(), total_in_sectors
    );

    Ok(PreScreeningRadarResult {
        radar_name: radar.radar_name.clone(),
        building_results,
        total_files_parsed: total_files,
        total_points_in_sectors: total_in_sectors,
        analysis_period: period,
        failed_files,
    })
}
