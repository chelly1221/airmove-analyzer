//! 360° LoS 파노라마 계산
//!
//! 레이더 안테나 위치에서 전방위(0°~360°)로 ray를 쏘아
//! 지형(SRTM) + 건물통합정보 + 수동건물 중 가장 높은 앙각의 장애물을 찾는다.

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::srtm::{self, SrtmReader};

/// 4/3 유효지구반경 (m)
const R_EFF: f64 = 6_371_000.0 * 4.0 / 3.0;

/// 건물 높이 상한 (m) — 한국 최고층 롯데월드타워 ~555m, 여유 포함 650m
const MAX_BUILDING_HEIGHT_M: f64 = 650.0;

/// 파노라마 포인트 (방위별 최대 앙각 장애물)
#[derive(Serialize, Clone, Debug)]
pub struct PanoramaPoint {
    /// 방위 (°, 정북=0, 시계방향)
    pub azimuth_deg: f64,
    /// 앙각 (°, 4/3 유효지구 모델)
    pub elevation_angle_deg: f64,
    /// 장애물까지 지표 거리 (km)
    pub distance_km: f64,
    /// 장애물 높이 (m, 건물=건물높이, 지형=지형고)
    pub obstacle_height_m: f64,
    /// 지면 표고 (m ASL)
    pub ground_elev_m: f64,
    /// 장애물 유형: "terrain" | "gis_building" | "manual_building"
    pub obstacle_type: String,
    /// 장애물 이름 (산 이름, 건물명 등)
    pub name: Option<String>,
    /// 주소 (건물)
    pub address: Option<String>,
    /// 용도 (건물)
    pub usage: Option<String>,
    /// 장애물 위치 WGS84
    pub lat: f64,
    pub lon: f64,
}

/// 건물 후보 (DB 조회 결과)
struct BuildingCandidate {
    lat: f64,
    lon: f64,
    height_m: f64,
    ground_elev: f64,  // manual building만 유효, GIS는 0
    name: Option<String>,
    address: Option<String>,
    usage: Option<String>,
    is_manual: bool,
}

/// 4/3 유효지구 모델 앙각 계산
/// d: 지표 거리 (m), h_obs: 장애물 해발고 (m), h_radar: 레이더 안테나 해발고 (m)
fn elevation_angle_deg(d: f64, h_obs: f64, h_radar: f64) -> f64 {
    if d < 1.0 || !d.is_finite() || !h_obs.is_finite() || !h_radar.is_finite() {
        return 0.0;
    }
    let dh = h_obs - h_radar;
    let curv_drop = d * d / (2.0 * R_EFF);
    ((dh - curv_drop) / d).atan().to_degrees()
}

/// 레이더→방위/거리 지점의 WGS84 좌표 계산 (공개: presample에서도 사용)
/// geo::destination_point_m으로의 호환 래퍼
pub fn destination_point_pub(lat: f64, lon: f64, bearing_deg: f64, distance_m: f64) -> (f64, f64) {
    crate::geo::destination_point_m(lat, lon, bearing_deg, distance_m)
}

/// GPU 파노라마 지형 결과 (프론트엔드에서 전달)
#[derive(serde::Deserialize, Clone, Debug)]
pub struct TerrainResult {
    pub azimuth_deg: f64,
    pub elevation_angle_deg: f64,
    pub distance_km: f64,
    pub obstacle_height_m: f64,
    pub ground_elev_m: f64,
    pub lat: f64,
    pub lon: f64,
}

/// DB에서 건물 후보 조회 (GIS + 수동)
/// `exclude_manual_ids`가 비어있지 않으면 해당 ID의 수동 건물은 제외
fn query_building_candidates(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: f64,
    exclude_manual_ids: &[i64],
) -> Vec<BuildingCandidate> {
    let mut result = Vec::new();

    // 건물통합정보 (fac_buildings) — 폴리곤 있으면 꼭짓점별 후보 생성
    if let Ok(mut stmt) = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height, building_name, dong_name, usability, polygon_json
         FROM fac_buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height >= ?5
           AND height <= ?6"
    ) {
        if let Ok(rows) = stmt.query_map(
            params![min_lat, max_lat, min_lon, max_lon, min_height_m, MAX_BUILDING_HEIGHT_M],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                ))
            },
        ) {
            for row in rows.flatten() {
                let (_clat, _clon, height_m, name, address, usage, polygon_json) = row;

                // 폴리곤이 있으면 꼭짓점별로 확장 (실제 건물 범위 반영)
                let poly_pts: Option<Vec<[f64; 2]>> = polygon_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok());

                if let Some(pts) = poly_pts {
                    if pts.len() >= 3 {
                        for pt in &pts {
                            result.push(BuildingCandidate {
                                lat: pt[0],
                                lon: pt[1],
                                height_m,
                                ground_elev: 0.0,
                                name: name.clone(),
                                address: address.clone(),
                                usage: usage.clone(),
                                is_manual: false,
                            });
                        }
                        continue;
                    }
                }

                // 폴리곤 없는 GIS 건물은 제외
            }
        }
    }

    // 수동 등록 건물 (geometry 확장을 위해 넉넉한 버퍼 적용)
    let geo_buffer = 0.01; // ~1.1km 버퍼 — 대형 도형 커버
    let exclude_clause = if exclude_manual_ids.is_empty() {
        String::new()
    } else {
        let ids: Vec<String> = exclude_manual_ids.iter().map(|id| id.to_string()).collect();
        format!(" AND id NOT IN ({})", ids.join(","))
    };
    let manual_sql = format!(
        "SELECT latitude, longitude, height, ground_elev, name, memo, geometry_type, geometry_json
         FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4{}",
        exclude_clause
    );
    if let Ok(mut stmt) = conn.prepare(&manual_sql) {
        if let Ok(rows) = stmt.query_map(
            params![min_lat - geo_buffer, max_lat + geo_buffer, min_lon - geo_buffer, max_lon + geo_buffer],
            |row| {
                Ok((
                    row.get::<_, f64>(0)?,
                    row.get::<_, f64>(1)?,
                    row.get::<_, f64>(2)?,
                    row.get::<_, f64>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                ))
            },
        ) {
            for row in rows.flatten() {
                let (lat, lon, height_m, ground_elev, name, memo, geo_type, geo_json) = row;
                let base = BuildingCandidate {
                    lat, lon, height_m, ground_elev,
                    name: name.clone(), address: None, usage: memo.clone(),
                    is_manual: true,
                };

                // geometry_json이 있으면 다중 샘플 포인트로 확장
                let sample_pts = expand_manual_geometry(lat, lon, geo_type.as_deref(), geo_json.as_deref());
                if sample_pts.is_empty() {
                    result.push(base);
                } else {
                    for (slat, slon) in sample_pts {
                        result.push(BuildingCandidate {
                            lat: slat, lon: slon, height_m, ground_elev,
                            name: name.clone(), address: None, usage: memo.clone(),
                            is_manual: true,
                        });
                    }
                }
            }
        }
    }

    result
}

/// 360° LoS 파노라마 계산
pub fn calculate_panorama(
    srtm: &mut SrtmReader,
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    max_range_km: f64,
    azimuth_step_deg: f64,
    range_step_m: f64,
    exclude_manual_ids: &[i64],
) -> Vec<PanoramaPoint> {
    let max_range_m = max_range_km * 1000.0;
    let num_azimuths = (360.0 / azimuth_step_deg).round() as usize;

    // Pre-load SRTM tiles for the radar range
    let range_deg = (max_range_m / 111_000.0).ceil() as i32 + 1;
    let min_lat_tile = radar_lat.floor() as i32 - range_deg;
    let max_lat_tile = radar_lat.floor() as i32 + range_deg;
    let min_lon_tile = radar_lon.floor() as i32 - range_deg;
    let max_lon_tile = radar_lon.floor() as i32 + range_deg;
    srtm.preload_tiles(min_lat_tile, max_lat_tile, min_lon_tile, max_lon_tile);
    let tiles = srtm.tiles_ref();

    // Phase 1: 지형 스캔 (SRTM) — rayon 병렬 처리
    let terrain_results: Vec<PanoramaPoint> = (0..num_azimuths)
        .into_par_iter()
        .map(|idx| {
            let az = idx as f64 * azimuth_step_deg;
            let mut best = PanoramaPoint {
                azimuth_deg: az,
                elevation_angle_deg: -90.0,
                distance_km: 0.0,
                obstacle_height_m: 0.0,
                ground_elev_m: 0.0,
                obstacle_type: "terrain".to_string(),
                name: None, address: None, usage: None,
                lat: radar_lat, lon: radar_lon,
            };

            let mut d = range_step_m;
            while d <= max_range_m {
                let (lat, lon) = crate::geo::destination_point_m(radar_lat, radar_lon, az, d);
                let elev = srtm::elevation_from_tiles(tiles, lat, lon);
                let angle = elevation_angle_deg(d, elev, radar_height_m);
                if angle > best.elevation_angle_deg {
                    best.elevation_angle_deg = angle;
                    best.distance_km = d / 1000.0;
                    best.obstacle_height_m = elev;
                    best.ground_elev_m = elev;
                    best.lat = lat;
                    best.lon = lon;
                }
                d += range_step_m;
            }

            if best.elevation_angle_deg < -89.0 {
                best.elevation_angle_deg = 0.0;
            }
            best
        })
        .collect();

    let mut panorama = terrain_results;

    // Phase 2: 건물 조회 + 병합
    apply_buildings(&mut panorama, srtm, conn, radar_lat, radar_lon, radar_height_m, max_range_m, azimuth_step_deg, exclude_manual_ids);

    panorama
}

/// GPU 지형 결과에 건물 데이터를 병합하여 최종 PanoramaPoint 배열 반환
pub fn merge_buildings_into_panorama(
    srtm: &mut SrtmReader,
    conn: &Connection,
    terrain_results: &[TerrainResult],
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    max_range_m: f64,
    azimuth_step_deg: f64,
) -> Vec<PanoramaPoint> {
    // TerrainResult → PanoramaPoint 변환
    let mut panorama: Vec<PanoramaPoint> = terrain_results.iter().map(|t| PanoramaPoint {
        azimuth_deg: t.azimuth_deg,
        elevation_angle_deg: t.elevation_angle_deg,
        distance_km: t.distance_km,
        obstacle_height_m: t.obstacle_height_m,
        ground_elev_m: t.ground_elev_m,
        obstacle_type: "terrain".to_string(),
        name: None, address: None, usage: None,
        lat: t.lat, lon: t.lon,
    }).collect();

    apply_buildings(&mut panorama, srtm, conn, radar_lat, radar_lon, radar_height_m, max_range_m, azimuth_step_deg, &[]);

    panorama
}

/// Phase 2: 건물 조회 + 기존 파노라마에 병합 (공통 로직)
fn apply_buildings(
    panorama: &mut Vec<PanoramaPoint>,
    srtm: &mut SrtmReader,
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    max_range_m: f64,
    azimuth_step_deg: f64,
    exclude_manual_ids: &[i64],
) {
    let num_azimuths = panorama.len();
    let cos_lat = radar_lat.to_radians().cos().max(0.5);

    let tiers: [(f64, f64, f64); 3] = [
        (0.0, 10_000.0, 10.0),
        (10_000.0, 30_000.0, 30.0),
        (30_000.0, max_range_m, 60.0),
    ];

    for &(min_d, max_d, min_h) in &tiers {
        let outer_deg = max_d / 111_000.0;
        let outer_deg_lon = max_d / (111_000.0 * cos_lat);

        let min_lat = radar_lat - outer_deg;
        let max_lat = radar_lat + outer_deg;
        let min_lon = radar_lon - outer_deg_lon;
        let max_lon = radar_lon + outer_deg_lon;

        let buildings = query_building_candidates(conn, min_lat, max_lat, min_lon, max_lon, min_h, exclude_manual_ids);

        for bld in &buildings {
            let dist_m = crate::geo::haversine_m(radar_lat, radar_lon, bld.lat, bld.lon);
            if dist_m < min_d || dist_m > max_d {
                continue;
            }

            let ground = if bld.is_manual {
                bld.ground_elev
            } else {
                srtm.get_elevation(bld.lat, bld.lon).unwrap_or(0.0)
            };

            let total_h = ground + bld.height_m;
            let angle = elevation_angle_deg(dist_m, total_h, radar_height_m);

            let az = crate::geo::bearing_deg(radar_lat, radar_lon, bld.lat, bld.lon);
            let bin = ((az / azimuth_step_deg).round() as usize) % num_azimuths;

            if angle > panorama[bin].elevation_angle_deg {
                let obs_type = if bld.is_manual { "manual_building" } else { "gis_building" };
                panorama[bin] = PanoramaPoint {
                    azimuth_deg: bin as f64 * azimuth_step_deg,
                    elevation_angle_deg: angle,
                    distance_km: dist_m / 1000.0,
                    obstacle_height_m: bld.height_m,
                    ground_elev_m: ground,
                    obstacle_type: obs_type.to_string(),
                    name: bld.name.clone(),
                    address: bld.address.clone(),
                    usage: bld.usage.clone(),
                    lat: bld.lat,
                    lon: bld.lon,
                };
            }

            if dist_m > 1.0 && dist_m < 5000.0 && bld.height_m > 20.0 {
                let angular_width = (30.0 / dist_m).atan().to_degrees();
                let spread_bins = (angular_width / azimuth_step_deg).ceil() as usize;
                for offset in 1..=spread_bins {
                    for &dir in &[-1i32, 1] {
                        let adj_bin = ((bin as i32 + dir * offset as i32).rem_euclid(num_azimuths as i32)) as usize;
                        if angle > panorama[adj_bin].elevation_angle_deg {
                            let obs_type = if bld.is_manual { "manual_building" } else { "gis_building" };
                            panorama[adj_bin] = PanoramaPoint {
                                azimuth_deg: adj_bin as f64 * azimuth_step_deg,
                                elevation_angle_deg: angle,
                                distance_km: dist_m / 1000.0,
                                obstacle_height_m: bld.height_m,
                                ground_elev_m: ground,
                                obstacle_type: obs_type.to_string(),
                                name: bld.name.clone(),
                                address: bld.address.clone(),
                                usage: bld.usage.clone(),
                                lat: bld.lat,
                                lon: bld.lon,
                            };
                        }
                    }
                }
            }
        }
    }
}

/// 수동 건물 geometry_json을 파싱하여 샘플 포인트 (lat, lon) 목록으로 확장.
/// 반환값이 비어 있으면 중심점만 사용.
fn expand_manual_geometry(
    center_lat: f64,
    center_lon: f64,
    geo_type: Option<&str>,
    geo_json: Option<&str>,
) -> Vec<(f64, f64)> {
    let geo_type = match geo_type {
        Some(t) if t == "polygon" || t == "multi" => t,
        _ => return vec![],
    };
    let json_str = match geo_json {
        Some(s) if !s.is_empty() => s,
        _ => return vec![],
    };

    let val: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return vec![],
    };

    match geo_type {
        "polygon" => {
            // [[lat, lon], [lat, lon], ...]
            if let Some(arr) = val.as_array() {
                let pts: Vec<(f64, f64)> = arr.iter().filter_map(|p| {
                    let lat = p.get(0).and_then(|v| v.as_f64())?;
                    let lon = p.get(1).and_then(|v| v.as_f64())?;
                    Some((lat, lon))
                }).collect();
                if !pts.is_empty() {
                    return pts;
                }
            }
        }
        "multi" => {
            // 복합 도형: [{type, json}, ...] 배열을 재귀 확장
            if let Some(arr) = val.as_array() {
                let mut all_pts = Vec::new();
                for item in arr {
                    let sub_type = item.get("type").and_then(|v| v.as_str());
                    let sub_json = item.get("json").and_then(|v| v.as_str());
                    let pts = expand_manual_geometry(center_lat, center_lon, sub_type, sub_json);
                    all_pts.extend(pts);
                }
                if !all_pts.is_empty() {
                    return all_pts;
                }
            }
        }
        _ => {}
    }

    vec![]
}
