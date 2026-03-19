//! 360° LoS 파노라마 계산
//!
//! 레이더 안테나 위치에서 전방위(0°~360°)로 ray를 쏘아
//! 지형(SRTM) + GIS건물 + 수동건물 중 가장 높은 앙각의 장애물을 찾는다.

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
    if d < 1.0 || !d.is_finite() {
        return 0.0;
    }
    let dh = h_obs - h_radar;
    let curv_drop = d * d / (2.0 * R_EFF);
    ((dh - curv_drop) / d).atan().to_degrees()
}

/// Haversine 거리 (m)
fn haversine_m(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6_371_000.0;
    let dlat = (lat2 - lat1).to_radians();
    let dlon = (lon2 - lon1).to_radians();
    let a = (dlat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (dlon / 2.0).sin().powi(2);
    r * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

/// 레이더→방위/거리 지점의 WGS84 좌표 계산 (공개: presample에서도 사용)
pub fn destination_point_pub(lat: f64, lon: f64, bearing_deg: f64, distance_m: f64) -> (f64, f64) {
    destination_point(lat, lon, bearing_deg, distance_m)
}

/// 레이더→방위/거리 지점의 WGS84 좌표 계산
fn destination_point(lat: f64, lon: f64, bearing_deg: f64, distance_m: f64) -> (f64, f64) {
    let r = 6_371_000.0;
    let lat1 = lat.to_radians();
    let lon1 = lon.to_radians();
    let brg = bearing_deg.to_radians();
    let d_r = distance_m / r;

    let lat2 = (lat1.sin() * d_r.cos() + lat1.cos() * d_r.sin() * brg.cos()).asin();
    let lon2 = lon1 + (brg.sin() * d_r.sin() * lat1.cos())
        .atan2(d_r.cos() - lat1.sin() * lat2.sin());

    (lat2.to_degrees(), lon2.to_degrees())
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

/// 레이더에서 대상까지의 방위 (°, 정북=0, 시계방향)
fn bearing_deg(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let lat1 = lat1.to_radians();
    let lat2 = lat2.to_radians();
    let dlon = (lon2 - lon1).to_radians();

    let y = dlon.sin() * lat2.cos();
    let x = lat1.cos() * lat2.sin() - lat1.sin() * lat2.cos() * dlon.cos();
    let brg = y.atan2(x).to_degrees();
    (brg + 360.0) % 360.0
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

    // GIS 건물
    if let Ok(mut stmt) = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height, building_name, address, usage
         FROM buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height >= ?5
           AND height <= ?6"
    ) {
        if let Ok(rows) = stmt.query_map(
            params![min_lat, max_lat, min_lon, max_lon, min_height_m, MAX_BUILDING_HEIGHT_M],
            |row| {
                Ok(BuildingCandidate {
                    lat: row.get(0)?,
                    lon: row.get(1)?,
                    height_m: row.get(2)?,
                    ground_elev: 0.0,
                    name: row.get(3)?,
                    address: row.get(4)?,
                    usage: row.get(5)?,
                    is_manual: false,
                })
            },
        ) {
            for row in rows.flatten() {
                result.push(row);
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
                let (lat, lon) = destination_point(radar_lat, radar_lon, az, d);
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
            let dist_m = haversine_m(radar_lat, radar_lon, bld.lat, bld.lon);
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

            let az = bearing_deg(radar_lat, radar_lon, bld.lat, bld.lon);
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

            if dist_m < 5000.0 && bld.height_m > 20.0 {
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
        Some(t) if t != "point" => t,
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
        "rectangle" => {
            if let Some(arr) = val.as_array() {
                if arr.len() == 4 {
                    // 4꼭짓점 형식
                    let corners: Vec<(f64, f64)> = arr.iter().filter_map(|p| {
                        let lat = p.get(0).and_then(|v| v.as_f64())?;
                        let lon = p.get(1).and_then(|v| v.as_f64())?;
                        Some((lat, lon))
                    }).collect();
                    if corners.len() == 4 {
                        let mid_lat = corners.iter().map(|c| c.0).sum::<f64>() / 4.0;
                        let mid_lon = corners.iter().map(|c| c.1).sum::<f64>() / 4.0;
                        let mut pts = corners.clone();
                        for i in 0..4 {
                            let j = (i + 1) % 4;
                            pts.push(((corners[i].0 + corners[j].0) / 2.0, (corners[i].1 + corners[j].1) / 2.0));
                        }
                        pts.push((mid_lat, mid_lon));
                        return pts;
                    }
                } else if arr.len() == 2 {
                    // 레거시: [[minLat, minLon], [maxLat, maxLon]]
                    let min_lat = arr[0].get(0).and_then(|v| v.as_f64()).unwrap_or(center_lat);
                    let min_lon = arr[0].get(1).and_then(|v| v.as_f64()).unwrap_or(center_lon);
                    let max_lat = arr[1].get(0).and_then(|v| v.as_f64()).unwrap_or(center_lat);
                    let max_lon = arr[1].get(1).and_then(|v| v.as_f64()).unwrap_or(center_lon);
                    let mid_lat = (min_lat + max_lat) / 2.0;
                    let mid_lon = (min_lon + max_lon) / 2.0;
                    return vec![
                        (min_lat, min_lon), (min_lat, max_lon),
                        (max_lat, min_lon), (max_lat, max_lon),
                        (mid_lat, min_lon), (mid_lat, max_lon),
                        (min_lat, mid_lon), (max_lat, mid_lon),
                        (mid_lat, mid_lon),
                    ];
                }
            }
        }
        "circle" => {
            // {center: [lat, lon], semi_major_m, semi_minor_m, rotation_deg}
            let clat = val.get("center").and_then(|c| c.get(0)).and_then(|v| v.as_f64()).unwrap_or(center_lat);
            let clon = val.get("center").and_then(|c| c.get(1)).and_then(|v| v.as_f64()).unwrap_or(center_lon);
            let semi_major = val.get("semi_major_m").and_then(|v| v.as_f64())
                .or_else(|| val.get("radius_m").and_then(|v| v.as_f64()))
                .unwrap_or(0.0);
            let semi_minor = val.get("semi_minor_m").and_then(|v| v.as_f64()).unwrap_or(semi_major);
            let rot_deg = val.get("rotation_deg").and_then(|v| v.as_f64()).unwrap_or(0.0);

            if semi_major < 1.0 {
                return vec![];
            }

            let rot_rad = rot_deg.to_radians();
            let cos_lat = clat.to_radians().cos().max(0.01);
            let num_samples = 12;
            let mut pts = Vec::with_capacity(num_samples + 1);
            pts.push((clat, clon)); // 중심

            for i in 0..num_samples {
                let angle = (i as f64 / num_samples as f64) * 2.0 * std::f64::consts::PI;
                let lx = semi_major * angle.cos();
                let ly = semi_minor * angle.sin();
                // 회전 적용 (북=위도+ 기준 시계방향)
                let rx = lx * rot_rad.sin() + ly * rot_rad.cos(); // east (m)
                let ry = lx * rot_rad.cos() - ly * rot_rad.sin(); // north (m)
                let dlat = ry / 111_320.0;
                let dlon = rx / (111_320.0 * cos_lat);
                pts.push((clat + dlat, clon + dlon));
            }
            return pts;
        }
        "line" => {
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
        _ => {}
    }

    vec![]
}
