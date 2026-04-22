//! 360° LoS 파노라마 계산
//!
//! 레이더 안테나 위치에서 전방위(0°~360°)로 ray를 쏘아
//! 지형(SRTM) + 건물통합정보 + 수동건물 중 가장 높은 앙각의 장애물을 찾는다.

use rayon::prelude::*;
use rusqlite::{params, Connection};
use serde::Serialize;

use crate::srtm::{self, SrtmReader};

/// 실제 지구반경 (m)
const R_EARTH: f64 = 6_371_000.0;

/// 건물 높이 상한 (m) — 한국 최고층 롯데월드타워 ~555m, 여유 포함 650m
const MAX_BUILDING_HEIGHT_M: f64 = 650.0;

/// 파노라마 포인트 (방위별 최대 앙각 장애물)
#[derive(Serialize, Clone, Debug)]
pub struct PanoramaPoint {
    /// 방위 (°, 정북=0, 시계방향)
    pub azimuth_deg: f64,
    /// 앙각 (°, 실제 지구 기하학적)
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
    /// 건물 폴리곤 [[lat, lon], ...] (건물 장애물만, 지형은 None)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polygon: Option<Vec<[f64; 2]>>,
}

/// 건물 장애물 (빈 양자화 없이 정확한 방위 범위)
#[derive(Serialize, Clone, Debug)]
pub struct BuildingObstacle {
    /// 방위 시작각 (°)
    pub azimuth_start_deg: f64,
    /// 방위 끝각 (°)
    pub azimuth_end_deg: f64,
    /// 최대 앙각 (°)
    pub elevation_angle_deg: f64,
    /// 최대 앙각 지점까지의 거리 (km)
    pub distance_km: f64,
    /// 건물 높이 (m)
    pub height_m: f64,
    /// 지면 표고 (m ASL)
    pub ground_elev_m: f64,
    /// 지반고 출처: "srtm" | "manual"
    pub ground_source: String,
    /// "gis_building" | "manual_building"
    pub obstacle_type: String,
    pub name: Option<String>,
    pub address: Option<String>,
    pub usage: Option<String>,
    /// 건물 대표 위치 (centroid)
    pub lat: f64,
    pub lon: f64,
    /// 건물 폴리곤 [[lat, lon], ...]
    #[serde(skip_serializing_if = "Option::is_none")]
    pub polygon: Option<Vec<[f64; 2]>>,
}

/// 파노라마 병합 결과 (지형 + 건물 분리)
#[derive(Serialize, Clone, Debug)]
pub struct PanoramaMergeResult {
    pub terrain: Vec<PanoramaPoint>,
    pub buildings: Vec<BuildingObstacle>,
}

/// 건물 후보 (DB 조회 결과) — point-only 폴백용
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

/// 건물 폴리곤 (3D 실루엣 계산용)
struct BuildingPolygon {
    polygon: Vec<[f64; 2]>,  // [[lat, lon], ...] WGS84 꼭짓점
    centroid_lat: f64,
    centroid_lon: f64,
    height_m: f64,
    ground_elev: f64,        // manual: DB값, GIS: 0 (SRTM 조회 필요)
    name: Option<String>,
    address: Option<String>,
    usage: Option<String>,
    is_manual: bool,
}

/// WGS84 → 레이더 중심 ENU 평면좌표 변환 (east, north) [m]
/// 건물 규모(~60km)에서 평면 근사 유효
fn wgs84_to_enu(radar_lat_rad_cos: f64, radar_lat: f64, radar_lon: f64, lat: f64, lon: f64) -> (f64, f64) {
    const R: f64 = 6_371_000.0;
    let east = (lon - radar_lon).to_radians() * R * radar_lat_rad_cos;
    let north = (lat - radar_lat).to_radians() * R;
    (east, north)
}

/// 원점(레이더)에서 방위각 방향 ray와 선분(e1,n1)-(e2,n2)의 교차 거리 반환
/// az_rad: 방위각 (라디안, 정북=0, 시계방향)
/// 반환: 교차점까지의 직선 거리 (m), 교차하지 않으면 None
fn ray_segment_intersection(
    ray_dx: f64, ray_dy: f64,  // (sin(az), cos(az)) — ENU에서 east, north 방향
    e1: f64, n1: f64,
    e2: f64, n2: f64,
) -> Option<f64> {
    // Ray: P = t * (ray_dx, ray_dy), t >= 0
    // Segment: Q = (e1,n1) + s * (se, sn), s ∈ [0, 1]
    let se = e2 - e1;
    let sn = n2 - n1;

    let denom = ray_dx * sn - ray_dy * se;
    if denom.abs() < 1e-12 {
        return None; // 평행
    }

    let s = (ray_dx * n1 - ray_dy * e1) / denom;
    if s < 0.0 || s > 1.0 {
        return None; // 선분 밖
    }

    // t = 교차점까지 ray 파라미터 (거리)
    let t = if ray_dx.abs() > ray_dy.abs() {
        (e1 + s * se) / ray_dx
    } else {
        (n1 + s * sn) / ray_dy
    };

    if t > 0.0 { Some(t) } else { None }
}

/// 실제 지구 기하학적 앙각 계산
/// d: 지표 거리 (m), h_obs: 장애물 해발고 (m), h_radar: 레이더 안테나 해발고 (m)
fn elevation_angle_deg(d: f64, h_obs: f64, h_radar: f64) -> f64 {
    if d < 1.0 || !d.is_finite() || !h_obs.is_finite() || !h_radar.is_finite() {
        return 0.0;
    }
    let dh = h_obs - h_radar;
    let curv_drop = d * d / (2.0 * R_EARTH);
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

/// DB에서 건물 폴리곤 조회 (3D 실루엣 계산용)
/// 폴리곤이 있는 건물은 BuildingPolygon으로, 없는 건물은 BuildingCandidate(폴백)로 반환
fn query_building_polygons(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: f64,
    exclude_manual_ids: &[i64],
) -> (Vec<BuildingPolygon>, Vec<BuildingCandidate>) {
    let mut polygons = Vec::new();
    let mut point_buildings = Vec::new();

    // 건물통합정보 (fac_buildings) — 폴리곤 단위로 반환
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
                let (clat, clon, height_m, name, address, usage, polygon_json) = row;

                let poly_pts: Option<Vec<[f64; 2]>> = polygon_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok());

                if let Some(pts) = poly_pts {
                    if pts.len() >= 3 {
                        polygons.push(BuildingPolygon {
                            polygon: pts,
                            centroid_lat: clat,
                            centroid_lon: clon,
                            height_m,
                            ground_elev: 0.0,
                            name,
                            address,
                            usage,
                            is_manual: false,
                        });
                    }
                }
                // 폴리곤 없는 GIS 건물은 제외
            }
        }
    }

    // 수동 등록 건물
    let geo_buffer = 0.01;
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

                // geometry_json → 폴리곤 추출 시도
                let sample_pts = expand_manual_geometry(lat, lon, geo_type.as_deref(), geo_json.as_deref());
                if sample_pts.len() >= 3 {
                    let poly: Vec<[f64; 2]> = sample_pts.iter().map(|&(la, lo)| [la, lo]).collect();
                    polygons.push(BuildingPolygon {
                        polygon: poly,
                        centroid_lat: lat,
                        centroid_lon: lon,
                        height_m,
                        ground_elev,
                        name,
                        address: None,
                        usage: memo,
                        is_manual: true,
                    });
                } else {
                    // point-only 수동 건물 → 폴백
                    point_buildings.push(BuildingCandidate {
                        lat, lon, height_m, ground_elev,
                        name, address: None, usage: memo,
                        is_manual: true,
                    });
                }
            }
        }
    }

    (polygons, point_buildings)
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
) -> PanoramaMergeResult {
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
                polygon: None,
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

    let all_buildings = collect_building_obstacles(srtm, conn, radar_lat, radar_lon, radar_height_m, max_range_m, exclude_manual_ids);
    let buildings = filter_visible_buildings(all_buildings, &terrain_results);

    PanoramaMergeResult {
        terrain: terrain_results,
        buildings,
    }
}

/// GPU 지형 결과 + 건물 장애물 수집 → PanoramaMergeResult 반환
pub fn merge_buildings_into_panorama(
    srtm: &mut SrtmReader,
    conn: &Connection,
    terrain_results: &[TerrainResult],
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    max_range_m: f64,
    _azimuth_step_deg: f64,
    exclude_manual_ids: &[i64],
) -> PanoramaMergeResult {
    let terrain: Vec<PanoramaPoint> = terrain_results.iter().map(|t| PanoramaPoint {
        azimuth_deg: t.azimuth_deg,
        elevation_angle_deg: t.elevation_angle_deg,
        distance_km: t.distance_km,
        obstacle_height_m: t.obstacle_height_m,
        ground_elev_m: t.ground_elev_m,
        obstacle_type: "terrain".to_string(),
        name: None, address: None, usage: None,
        lat: t.lat, lon: t.lon,
        polygon: None,
    }).collect();

    let all_buildings = collect_building_obstacles(srtm, conn, radar_lat, radar_lon, radar_height_m, max_range_m, exclude_manual_ids);
    let buildings = filter_visible_buildings(all_buildings, &terrain);

    PanoramaMergeResult { terrain, buildings }
}

/// LoS에 실질적으로 영향 주는 건물만 필터:
/// 1) 건물 앙각 > 해당 방위 지형 앙각 (지형에 가려지면 제외)
/// 2) 같은 방위 범위에 더 높은 앙각의 건물이 있으면 가려짐 → 제외
fn filter_visible_buildings(all: Vec<BuildingObstacle>, terrain: &[PanoramaPoint]) -> Vec<BuildingObstacle> {
    let n = terrain.len();
    if n == 0 { return all; }

    // 1단계: 지형 가림 필터
    let above_terrain: Vec<BuildingObstacle> = all.into_iter().filter(|b| {
        let mid_az = ((b.azimuth_start_deg + b.azimuth_end_deg) / 2.0).rem_euclid(360.0);
        let idx = ((mid_az / 360.0 * n as f64).round() as usize).min(n - 1);
        b.elevation_angle_deg > terrain[idx].elevation_angle_deg
    }).collect();

    // 2단계: 건물 간 가림 필터 — 방위 겹침 + 더 높은 앙각 건물에 완전히 가려지면 제외
    // 앙각 내림차순 정렬 → 높은 건물부터 방위 트랙에 등록
    let mut sorted: Vec<(usize, &BuildingObstacle)> = above_terrain.iter().enumerate().collect();
    sorted.sort_by(|a, b| b.1.elevation_angle_deg.partial_cmp(&a.1.elevation_angle_deg).unwrap());

    // 0.01° 해상도 방위 트랙: 각 빈의 최대 앙각
    let track_bins = 36000usize;
    let mut max_angle = vec![f64::NEG_INFINITY; track_bins];

    // 지형 앙각으로 트랙 초기화
    for (i, t) in terrain.iter().enumerate() {
        let bin = ((t.azimuth_deg / 360.0 * track_bins as f64).round() as usize).min(track_bins - 1);
        if t.elevation_angle_deg > max_angle[bin] {
            max_angle[bin] = t.elevation_angle_deg;
        }
        // 이웃 빈 보정 (terrain 해상도 갭 방지)
        if i > 0 {
            let prev_bin = ((terrain[i-1].azimuth_deg / 360.0 * track_bins as f64).round() as usize).min(track_bins - 1);
            for bi in prev_bin.min(bin)..=prev_bin.max(bin) {
                if t.elevation_angle_deg > max_angle[bi] {
                    max_angle[bi] = t.elevation_angle_deg;
                }
            }
        }
    }

    let mut visible = vec![false; above_terrain.len()];

    for &(orig_idx, b) in &sorted {
        let mut start = b.azimuth_start_deg;
        let mut end = b.azimuth_end_deg;
        if start == end { start -= 0.01; end += 0.01; }
        if end < start { end += 360.0; }

        let bin_start = ((start / 360.0 * track_bins as f64).floor() as i64).rem_euclid(track_bins as i64) as usize;
        let bin_end = ((end / 360.0 * track_bins as f64).ceil() as i64).rem_euclid(track_bins as i64) as usize;
        let bin_count = if bin_end >= bin_start { bin_end - bin_start + 1 } else { track_bins - bin_start + bin_end + 1 };

        // 이 건물이 어떤 빈에서라도 현재 최대보다 높으면 보임
        let mut dominated = true;
        for di in 0..bin_count {
            let bi = (bin_start + di) % track_bins;
            if b.elevation_angle_deg > max_angle[bi] {
                dominated = false;
                break;
            }
        }

        if !dominated {
            visible[orig_idx] = true;
            // 이 건물의 방위 범위를 트랙에 등록
            for di in 0..bin_count {
                let bi = (bin_start + di) % track_bins;
                if b.elevation_angle_deg > max_angle[bi] {
                    max_angle[bi] = b.elevation_angle_deg;
                }
            }
        }
    }

    above_terrain.into_iter().enumerate()
        .filter(|(i, _)| visible[*i])
        .map(|(_, b)| b)
        .collect()
}

/// Phase 2: 건물 장애물 수집 — ray-polygon 교차 기반 (빈 양자화 없음)
fn collect_building_obstacles(
    srtm: &mut SrtmReader,
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    max_range_m: f64,
    exclude_manual_ids: &[i64],
) -> Vec<BuildingObstacle> {
    let cos_lat = radar_lat.to_radians().cos().max(0.5);
    let mut results: Vec<BuildingObstacle> = Vec::new();

    let tiers: [(f64, f64, f64); 3] = [
        (0.0, 10_000.0, 10.0),
        (10_000.0, 30_000.0, 30.0),
        (30_000.0, max_range_m, 60.0),
    ];

    for &(min_d, max_d, min_h) in &tiers {
        let outer_deg = max_d / 111_000.0;
        let outer_deg_lon = max_d / (111_000.0 * cos_lat);

        let bb_min_lat = radar_lat - outer_deg;
        let bb_max_lat = radar_lat + outer_deg;
        let bb_min_lon = radar_lon - outer_deg_lon;
        let bb_max_lon = radar_lon + outer_deg_lon;

        let (poly_buildings, point_buildings) = query_building_polygons(
            conn, bb_min_lat, bb_max_lat, bb_min_lon, bb_max_lon, min_h, exclude_manual_ids,
        );

        // ── 폴리곤 건물: 정확한 방위 범위 + 최대 앙각 ──
        for bld in &poly_buildings {
            let centroid_dist = crate::geo::haversine_m(radar_lat, radar_lon, bld.centroid_lat, bld.centroid_lon);
            if centroid_dist < min_d.max(1.0) - 500.0 || centroid_dist > max_d + 500.0 {
                continue;
            }

            let ground = if bld.is_manual {
                bld.ground_elev
            } else {
                srtm.get_elevation(bld.centroid_lat, bld.centroid_lon).unwrap_or(0.0)
            };
            let total_h = ground + bld.height_m;

            // 꼭짓점 → ENU + 방위각
            let n = bld.polygon.len();
            let mut enu: Vec<(f64, f64)> = Vec::with_capacity(n);
            let mut vertex_az_deg: Vec<f64> = Vec::with_capacity(n);

            for pt in &bld.polygon {
                let (e, nn) = wgs84_to_enu(cos_lat, radar_lat, radar_lon, pt[0], pt[1]);
                let az = e.atan2(nn).to_degrees().rem_euclid(360.0);
                enu.push((e, nn));
                vertex_az_deg.push(az);
            }

            let (az_start, az_span) = azimuth_span(&vertex_az_deg);
            if az_span > 180.0 { continue; }

            // 꼭짓점별 거리로 최소 거리(nearest edge) 근사 → 앙각 계산
            let mut best_angle = f64::NEG_INFINITY;
            let mut best_dist = f64::INFINITY;

            // 방위 중앙에서 레이 쏘아 정확한 nearest edge 거리 구함
            let mid_az_deg = (az_start + az_span / 2.0) % 360.0;
            let mid_az_rad = mid_az_deg.to_radians();
            let ray_dx = mid_az_rad.sin();
            let ray_dy = mid_az_rad.cos();
            let mut nearest_mid = f64::INFINITY;
            for i in 0..n {
                let j = (i + 1) % n;
                if let Some(d) = ray_segment_intersection(ray_dx, ray_dy, enu[i].0, enu[i].1, enu[j].0, enu[j].1) {
                    if d < nearest_mid { nearest_mid = d; }
                }
            }
            if nearest_mid < f64::INFINITY && nearest_mid >= 1.0 && nearest_mid >= min_d && nearest_mid <= max_d {
                let angle = elevation_angle_deg(nearest_mid, total_h, radar_height_m);
                if angle > best_angle { best_angle = angle; best_dist = nearest_mid; }
            }

            // 양 끝 방위에서도 레이 쏴서 체크
            for edge_az in [az_start, (az_start + az_span) % 360.0] {
                let az_rad = edge_az.to_radians();
                let rdx = az_rad.sin();
                let rdy = az_rad.cos();
                let mut nd = f64::INFINITY;
                for i in 0..n {
                    let j = (i + 1) % n;
                    if let Some(d) = ray_segment_intersection(rdx, rdy, enu[i].0, enu[i].1, enu[j].0, enu[j].1) {
                        if d < nd { nd = d; }
                    }
                }
                if nd < f64::INFINITY && nd >= 1.0 && nd >= min_d && nd <= max_d {
                    let angle = elevation_angle_deg(nd, total_h, radar_height_m);
                    if angle > best_angle { best_angle = angle; best_dist = nd; }
                }
            }

            if best_angle <= f64::NEG_INFINITY { continue; }

            let obs_type = if bld.is_manual { "manual_building" } else { "gis_building" };
            let az_end = (az_start + az_span) % 360.0;

            let ground_src = if bld.is_manual { "manual" } else { "srtm" };
            results.push(BuildingObstacle {
                azimuth_start_deg: az_start,
                azimuth_end_deg: az_end,
                elevation_angle_deg: best_angle,
                distance_km: best_dist / 1000.0,
                height_m: bld.height_m,
                ground_elev_m: ground,
                ground_source: ground_src.to_string(),
                obstacle_type: obs_type.to_string(),
                name: bld.name.clone(),
                address: bld.address.clone(),
                usage: bld.usage.clone(),
                lat: bld.centroid_lat,
                lon: bld.centroid_lon,
                polygon: Some(bld.polygon.clone()),
            });
        }

        // ── point-only 건물 (폴리곤 없는 수동 건물) ──
        for bld in &point_buildings {
            let dist_m = crate::geo::haversine_m(radar_lat, radar_lon, bld.lat, bld.lon);
            if dist_m < min_d || dist_m > max_d { continue; }

            let ground = if bld.is_manual { bld.ground_elev } else {
                srtm.get_elevation(bld.lat, bld.lon).unwrap_or(0.0)
            };
            let total_h = ground + bld.height_m;
            let angle = elevation_angle_deg(dist_m, total_h, radar_height_m);
            let az = crate::geo::bearing_deg(radar_lat, radar_lon, bld.lat, bld.lon);
            let obs_type = if bld.is_manual { "manual_building" } else { "gis_building" };

            let ground_src = if bld.is_manual { "manual" } else { "srtm" };
            results.push(BuildingObstacle {
                azimuth_start_deg: az,
                azimuth_end_deg: az,
                elevation_angle_deg: angle,
                distance_km: dist_m / 1000.0,
                height_m: bld.height_m,
                ground_elev_m: ground,
                ground_source: ground_src.to_string(),
                obstacle_type: obs_type.to_string(),
                name: bld.name.clone(),
                address: bld.address.clone(),
                usage: bld.usage.clone(),
                lat: bld.lat,
                lon: bld.lon,
                polygon: None,
            });
        }
    }

    results
}

/// 방위각 목록에서 실제 건물이 차지하는 (시작각, 각도폭) 계산
/// 0/360° 경계를 올바르게 처리: 최대 갭의 반대편이 건물 구간
fn azimuth_span(azimuths: &[f64]) -> (f64, f64) {
    if azimuths.is_empty() {
        return (0.0, 0.0);
    }
    if azimuths.len() == 1 {
        return (azimuths[0], 0.0);
    }

    let mut sorted: Vec<f64> = azimuths.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());

    // 인접 방위각 간 갭 중 최대값 탐색 (마지막→처음 wrap 포함)
    let mut max_gap = 0.0_f64;
    let mut max_gap_end = 0usize;
    let n = sorted.len();

    for i in 0..n {
        let gap = if i + 1 < n {
            sorted[i + 1] - sorted[i]
        } else {
            (sorted[0] + 360.0) - sorted[n - 1]
        };
        if gap > max_gap {
            max_gap = gap;
            max_gap_end = (i + 1) % n;
        }
    }

    // 건물 시작 = 최대 갭 끝, 건물 끝 = 최대 갭 시작
    let az_start = sorted[max_gap_end];
    let az_end = if max_gap_end == 0 {
        sorted[n - 1]
    } else {
        sorted[max_gap_end - 1]
    };

    let span = if az_end >= az_start {
        az_end - az_start
    } else {
        (az_end + 360.0) - az_start
    };

    (az_start, span)
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
