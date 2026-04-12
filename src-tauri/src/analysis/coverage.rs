//! 레이더 커버리지 맵 계산 (rayon 병렬 + SRTM 직접 접근)
//!
//! Phase 1: 지형 프로파일 사전 계산 (rayon으로 3600 ray 병렬 처리)
//! Phase 2: 고도별 커버리지 레이어 계산 (이진 탐색)

use std::sync::Mutex;

use rayon::prelude::*;
use serde::Serialize;

use crate::srtm::{self, SrtmReader};

const R_EARTH_M: f64 = 6_371_000.0;
/// 4/3 유효지구 반경 — 레이더 전파 굴절 모델 (GPU 셰이더와 동일)
const R_EFF_M: f64 = 8_494_666.7;
const MAX_ELEVATION_DEG: f64 = 40.0;
const FT_TO_M: f64 = 0.3048;
const SAMPLES_PER_RAY: usize = 2400;

/// Module-level profile cache
static PROFILE_CACHE: Mutex<Option<CoverageProfile>> = Mutex::new(None);

/// 건물 제외 커버리지 프로파일 캐시 (장애물 월간 보고서용)
static PROFILE_CACHE_EXCLUDED: Mutex<Option<CoverageProfile>> = Mutex::new(None);

/// Cached terrain profile (stored in Rust, never sent to frontend)
struct CoverageProfile {
    radar_name: String,
    radar_lat: f64,
    radar_lon: f64,
    radar_height: f64,
    max_range_km: f64,
    bearing_step_deg: f64,
    /// Per-ray profile data, flattened: [ray0_sample0, ray0_sample1, ..., ray1_sample0, ...]
    adj_terrains: Vec<f32>,
    max_angles: Vec<f32>,
    num_rays: usize,
}

#[derive(Serialize, Clone)]
pub struct CoverageBearing {
    pub deg: f64,
    pub max_range_km: f64,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Serialize, Clone)]
pub struct CoverageLayer {
    pub altitude_ft: f64,
    pub altitude_m: f64,
    pub bearings: Vec<CoverageBearing>,
    pub cone_radius_km: f64,
}

#[derive(Serialize)]
pub struct ProfileMeta {
    pub radar_name: String,
    pub radar_height: f64,
    pub max_range_km: f64,
    pub max_elev_deg: f64,
    pub num_rays: usize,
    pub samples_per_ray: usize,
}

/// Display-frame curvature drop (real earth radius)
fn curv_drop(d_km: f64) -> f64 {
    let d_m = d_km * 1000.0;
    (d_m * d_m) / (2.0 * R_EARTH_M)
}

/// Compute terrain profile with rayon parallelization
pub fn compute_terrain_profile(
    srtm: &mut SrtmReader,
    conn: &rusqlite::Connection,
    radar_name: &str,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
    bearing_step_deg: f64,
) -> ProfileMeta {
    let radar_height = radar_altitude + antenna_height;
    let max_range_km = range_nm * 1.852;
    let num_rays = (360.0 / bearing_step_deg).floor() as usize;

    // 1. Pre-load SRTM tiles
    let range_deg = (max_range_km / 111.0).ceil() as i32 + 1;
    let min_lat = radar_lat.floor() as i32 - range_deg;
    let max_lat = radar_lat.floor() as i32 + range_deg;
    let min_lon = radar_lon.floor() as i32 - range_deg;
    let max_lon = radar_lon.floor() as i32 + range_deg;
    srtm.preload_tiles(min_lat, max_lat, min_lon, max_lon);
    let tiles = srtm.tiles_ref();

    // 2. Query buildings
    let range_deg_f = max_range_km / 111.0;
    let buildings: Vec<(f64, f64, f64)> = query_buildings_for_coverage(
        conn, radar_lat, radar_lon, range_deg_f,
    );

    // 3. Pre-compute building grid (bearing -> sample -> max_height)
    // Use a flat array: [ray_idx * SAMPLES_PER_RAY + sample_idx]
    let mut building_heights = vec![0.0f32; num_rays * SAMPLES_PER_RAY];
    let cos_radar_lat = (radar_lat.to_radians()).cos();
    for &(blat, blon, bheight) in &buildings {
        let d_lat = blat - radar_lat;
        let d_lon = (blon - radar_lon) * cos_radar_lat;
        let dist_deg = (d_lat * d_lat + d_lon * d_lon).sqrt();
        let dist_km = dist_deg * 111.0;
        if dist_km < 0.01 || dist_km > max_range_km { continue; }

        let mut bearing = (d_lon.atan2(d_lat)).to_degrees();
        if bearing < 0.0 { bearing += 360.0; }

        let ray_idx = (bearing / bearing_step_deg).round() as usize % num_rays;
        let sample_idx = ((dist_km / max_range_km) * SAMPLES_PER_RAY as f64).round() as i32 - 1;
        if sample_idx < 0 || sample_idx >= SAMPLES_PER_RAY as i32 { continue; }

        let global_idx = ray_idx * SAMPLES_PER_RAY + sample_idx as usize;
        if bheight as f32 > building_heights[global_idx] {
            building_heights[global_idx] = bheight as f32;
        }
    }

    // 4. Parallel ray computation with rayon
    let ray_results: Vec<(Vec<f32>, Vec<f32>)> = (0..num_rays)
        .into_par_iter()
        .map(|ray_idx| {
            let bearing = ray_idx as f64 * bearing_step_deg;
            let mut ray_adj = vec![0.0f32; SAMPLES_PER_RAY];
            let mut ray_max = vec![0.0f32; SAMPLES_PER_RAY];
            let mut running_max_angle: f64 = f64::NEG_INFINITY;

            for s in 0..SAMPLES_PER_RAY {
                let dist = ((s + 1) as f64 / SAMPLES_PER_RAY as f64) * max_range_km;
                let (lat, lon) = crate::geo::destination_point_km(radar_lat, radar_lon, bearing, dist);

                let elev = srtm::elevation_from_tiles(tiles, lat, lon);
                let bld_h = building_heights[ray_idx * SAMPLES_PER_RAY + s] as f64;
                let terrain_with_building = elev + bld_h;
                let adj = terrain_with_building - curv_drop(dist);
                ray_adj[s] = adj as f32;

                let angle = (adj - radar_height) / dist;
                if angle > running_max_angle { running_max_angle = angle; }
                ray_max[s] = running_max_angle as f32;
            }

            (ray_adj, ray_max)
        })
        .collect();

    // Copy parallel results into flat arrays
    let total_samples = num_rays * SAMPLES_PER_RAY;
    let mut adj_terrains = vec![0.0f32; total_samples];
    let mut max_angles = vec![0.0f32; total_samples];

    for (ray_idx, (ray_adj, ray_max)) in ray_results.into_iter().enumerate() {
        let offset = ray_idx * SAMPLES_PER_RAY;
        adj_terrains[offset..offset + SAMPLES_PER_RAY].copy_from_slice(&ray_adj);
        max_angles[offset..offset + SAMPLES_PER_RAY].copy_from_slice(&ray_max);
    }

    // 5. Store in cache
    let profile = CoverageProfile {
        radar_name: radar_name.to_string(),
        radar_lat, radar_lon, radar_height, max_range_km,
        bearing_step_deg,
        adj_terrains, max_angles, num_rays,
    };

    let meta = ProfileMeta {
        radar_name: radar_name.to_string(),
        radar_height,
        max_range_km,
        max_elev_deg: MAX_ELEVATION_DEG,
        num_rays,
        samples_per_ray: SAMPLES_PER_RAY,
    };

    *PROFILE_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = Some(profile);
    meta
}

/// Compute a single coverage layer from cached profile
pub fn compute_layer(alt_ft: f64, bearing_step: usize) -> Option<CoverageLayer> {
    let cache = PROFILE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    let profile = cache.as_ref()?;
    Some(compute_layer_inner(profile, alt_ft, bearing_step))
}

/// 내부 레이어 계산 (프로파일 참조)
fn compute_layer_inner(profile: &CoverageProfile, alt_ft: f64, bearing_step: usize) -> CoverageLayer {
    let alt_m = alt_ft * FT_TO_M;
    let max_elev_rad = MAX_ELEVATION_DEG.to_radians();
    let height_above_radar = alt_m - profile.radar_height;
    let cone_radius_km = if height_above_radar > 0.0 {
        (height_above_radar / max_elev_rad.tan()) / 1000.0
    } else {
        0.0
    };

    let radar_h = profile.radar_height;
    let max_range_km = profile.max_range_km;
    let step_deg = profile.bearing_step_deg;
    let n = SAMPLES_PER_RAY;
    let mut bearings = Vec::new();

    for r in (0..profile.num_rays).step_by(bearing_step) {
        let ray_offset = r * n;
        let bearing_deg = r as f64 * step_deg;

        // Binary search: LoS block point
        let mut los_block_idx = n;
        let mut lo: usize = 1;
        let mut hi: usize = n - 1;
        while lo <= hi {
            let mid = (lo + hi) / 2;
            let dist = ((mid + 1) as f64 / n as f64) * max_range_km;
            let adj_alt = alt_m - curv_drop(dist);
            let target_angle = (adj_alt as f32 - radar_h as f32) / dist as f32;
            if profile.max_angles[ray_offset + mid] > target_angle {
                los_block_idx = mid;
                if mid == 0 { break; }
                hi = mid - 1;
            } else {
                lo = mid + 1;
            }
        }

        // Linear search: terrain block point
        let mut terrain_block_idx = n;
        for i in 0..los_block_idx {
            let dist = ((i + 1) as f64 / n as f64) * max_range_km;
            let adj_alt = (alt_m - curv_drop(dist)) as f32;
            if profile.adj_terrains[ray_offset + i] > adj_alt {
                terrain_block_idx = i;
                break;
            }
        }

        let block_idx = los_block_idx.min(terrain_block_idx);

        let (dist_km, lat, lon) = if block_idx < n && block_idx > 0 {
            let d = (block_idx as f64 / n as f64) * max_range_km;
            let (la, lo) = crate::geo::destination_point_km(profile.radar_lat, profile.radar_lon, bearing_deg, d);
            (d, la, lo)
        } else if block_idx == 0 {
            (0.0, profile.radar_lat, profile.radar_lon)
        } else {
            let (la, lo) = crate::geo::destination_point_km(profile.radar_lat, profile.radar_lon, bearing_deg, max_range_km);
            (max_range_km, la, lo)
        };

        bearings.push(CoverageBearing {
            deg: bearing_deg,
            max_range_km: dist_km,
            lat,
            lon,
        });
    }

    CoverageLayer {
        altitude_ft: alt_ft,
        altitude_m: alt_m,
        bearings,
        cone_radius_km,
    }
}

/// Compute multiple layers in batch
pub fn compute_layers_batch(alt_fts: &[f64], bearing_step: usize) -> Vec<CoverageLayer> {
    alt_fts.iter()
        .filter_map(|&alt_ft| compute_layer(alt_ft, bearing_step))
        .collect()
}

/// Check if cache is valid for given radar params
pub fn is_cache_valid(radar_name: &str, radar_lat: f64, radar_lon: f64, radar_height: f64) -> bool {
    let cache = PROFILE_CACHE.lock().unwrap_or_else(|e| e.into_inner());
    match cache.as_ref() {
        Some(p) => {
            p.radar_name == radar_name
                && p.radar_lat == radar_lat
                && p.radar_lon == radar_lon
                && (p.radar_height - radar_height).abs() < 0.01
        }
        None => false,
    }
}

/// Invalidate the cached profile
pub fn invalidate_cache() {
    *PROFILE_CACHE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// Query buildings for coverage computation (returns (lat, lon, height) tuples)
/// GIS 건물은 폴리곤 꼭짓점별로 확장, 수동 건물은 geometry별 샘플 포인트 확장
pub(crate) fn query_buildings_for_coverage(
    conn: &rusqlite::Connection,
    radar_lat: f64,
    radar_lon: f64,
    range_deg: f64,
) -> Vec<(f64, f64, f64)> {
    let mut result = Vec::new();

    let min_lat = radar_lat - range_deg;
    let max_lat = radar_lat + range_deg;
    let min_lon = radar_lon - range_deg;
    let max_lon = radar_lon + range_deg;

    // 건물통합정보 (fac_buildings) — 폴리곤 꼭짓점별 확장
    if let Ok(mut stmt) = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height, polygon_json FROM fac_buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height >= 3.0 AND height <= 1000.0"
    ) {
        if let Ok(rows) = stmt.query_map(
            rusqlite::params![min_lat, max_lat, min_lon, max_lon],
            |row| Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, Option<String>>(3)?,
            )),
        ) {
            for r in rows.flatten() {
                let (_clat, _clon, height, polygon_json) = r;
                let poly_pts: Option<Vec<[f64; 2]>> = polygon_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok());
                if let Some(pts) = poly_pts {
                    if pts.len() >= 3 {
                        for pt in &pts {
                            result.push((pt[0], pt[1], height));
                        }
                    }
                }
                // 폴리곤 없는 GIS 건물은 제외
            }
        }
    }

    // Manual buildings — geometry 확장
    if let Ok(mut stmt) = conn.prepare(
        "SELECT latitude, longitude, height, geometry_type, geometry_json FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4"
    ) {
        if let Ok(rows) = stmt.query_map(
            rusqlite::params![min_lat, max_lat, min_lon, max_lon],
            |row| Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            )),
        ) {
            for r in rows.flatten() {
                let (lat, lon, height, geo_type, geo_json) = r;
                let sample_pts = crate::building::expand_manual_building_geometry(
                    lat, lon, geo_type.as_deref(), geo_json.as_deref(),
                );
                if sample_pts.len() > 1 {
                    for (slat, slon) in sample_pts {
                        result.push((slat, slon, height));
                    }
                } else {
                    result.push((lat, lon, height));
                }
            }
        }
    }

    result
}

/// Query buildings excluding specific manual building IDs
/// GIS 건물은 폴리곤 꼭짓점별 확장, 수동 건물은 geometry별 샘플 포인트 확장
pub(crate) fn query_buildings_for_coverage_excluding(
    conn: &rusqlite::Connection,
    radar_lat: f64,
    radar_lon: f64,
    range_deg: f64,
    exclude_manual_ids: &[i64],
) -> Vec<(f64, f64, f64)> {
    let mut result = Vec::new();

    let min_lat = radar_lat - range_deg;
    let max_lat = radar_lat + range_deg;
    let min_lon = radar_lon - range_deg;
    let max_lon = radar_lon + range_deg;

    // 건물통합정보 (fac_buildings) — 폴리곤 꼭짓점별 확장
    if let Ok(mut stmt) = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height, polygon_json FROM fac_buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height >= 3.0 AND height <= 1000.0"
    ) {
        if let Ok(rows) = stmt.query_map(
            rusqlite::params![min_lat, max_lat, min_lon, max_lon],
            |row| Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, Option<String>>(3)?,
            )),
        ) {
            for r in rows.flatten() {
                let (_clat, _clon, height, polygon_json) = r;
                let poly_pts: Option<Vec<[f64; 2]>> = polygon_json
                    .as_deref()
                    .and_then(|s| serde_json::from_str(s).ok());
                if let Some(pts) = poly_pts {
                    if pts.len() >= 3 {
                        for pt in &pts {
                            result.push((pt[0], pt[1], height));
                        }
                    }
                }
                // 폴리곤 없는 GIS 건물은 제외
            }
        }
    }

    // Manual buildings — 제외 ID 필터링 + geometry 확장
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, latitude, longitude, height, geometry_type, geometry_json FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4"
    ) {
        if let Ok(rows) = stmt.query_map(
            rusqlite::params![min_lat, max_lat, min_lon, max_lon],
            |row| Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            )),
        ) {
            for r in rows.flatten() {
                let (id, lat, lon, height, geo_type, geo_json) = r;
                if exclude_manual_ids.contains(&id) {
                    continue;
                }
                let sample_pts = crate::building::expand_manual_building_geometry(
                    lat, lon, geo_type.as_deref(), geo_json.as_deref(),
                );
                if sample_pts.len() > 1 {
                    for (slat, slon) in sample_pts {
                        result.push((slat, slon, height));
                    }
                } else {
                    result.push((lat, lon, height));
                }
            }
        }
    }

    result
}

/// 건물 제외 커버리지 프로파일 계산 (장애물 월간 보고서용)
/// 기존 compute_terrain_profile과 동일하지만 PROFILE_CACHE_EXCLUDED에 저장
pub fn compute_terrain_profile_excluding(
    srtm: &mut SrtmReader,
    conn: &rusqlite::Connection,
    radar_name: &str,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
    exclude_manual_ids: &[i64],
    bearing_step_deg: f64,
) -> ProfileMeta {
    let radar_height = radar_altitude + antenna_height;
    let max_range_km = range_nm * 1.852;
    let num_rays = (360.0 / bearing_step_deg).floor() as usize;

    // SRTM 타일 로드 (이미 로드되어 있으면 빠름)
    let range_deg = (max_range_km / 111.0).ceil() as i32 + 1;
    srtm.preload_tiles(
        radar_lat.floor() as i32 - range_deg,
        radar_lat.floor() as i32 + range_deg,
        radar_lon.floor() as i32 - range_deg,
        radar_lon.floor() as i32 + range_deg,
    );
    let tiles = srtm.tiles_ref();

    // 건물 쿼리 (제외 적용)
    let range_deg_f = max_range_km / 111.0;
    let buildings = query_buildings_for_coverage_excluding(
        conn, radar_lat, radar_lon, range_deg_f, exclude_manual_ids,
    );

    // 건물 높이 그리드
    let mut building_heights = vec![0.0f32; num_rays * SAMPLES_PER_RAY];
    let cos_radar_lat = (radar_lat.to_radians()).cos();
    for &(blat, blon, bheight) in &buildings {
        let d_lat = blat - radar_lat;
        let d_lon = (blon - radar_lon) * cos_radar_lat;
        let dist_deg = (d_lat * d_lat + d_lon * d_lon).sqrt();
        let dist_km = dist_deg * 111.0;
        if dist_km < 0.01 || dist_km > max_range_km { continue; }

        let mut bearing = (d_lon.atan2(d_lat)).to_degrees();
        if bearing < 0.0 { bearing += 360.0; }

        let ray_idx = (bearing / bearing_step_deg).round() as usize % num_rays;
        let sample_idx = ((dist_km / max_range_km) * SAMPLES_PER_RAY as f64).round() as i32 - 1;
        if sample_idx < 0 || sample_idx >= SAMPLES_PER_RAY as i32 { continue; }

        let global_idx = ray_idx * SAMPLES_PER_RAY + sample_idx as usize;
        if bheight as f32 > building_heights[global_idx] {
            building_heights[global_idx] = bheight as f32;
        }
    }

    // 병렬 ray 계산
    let ray_results: Vec<(Vec<f32>, Vec<f32>)> = (0..num_rays)
        .into_par_iter()
        .map(|ray_idx| {
            let bearing = ray_idx as f64 * bearing_step_deg;
            let mut ray_adj = vec![0.0f32; SAMPLES_PER_RAY];
            let mut ray_max = vec![0.0f32; SAMPLES_PER_RAY];
            let mut running_max_angle: f64 = f64::NEG_INFINITY;

            for s in 0..SAMPLES_PER_RAY {
                let dist = ((s + 1) as f64 / SAMPLES_PER_RAY as f64) * max_range_km;
                let (lat, lon) = crate::geo::destination_point_km(radar_lat, radar_lon, bearing, dist);

                let elev = srtm::elevation_from_tiles(tiles, lat, lon);
                let bld_h = building_heights[ray_idx * SAMPLES_PER_RAY + s] as f64;
                let terrain_with_building = elev + bld_h;
                let adj = terrain_with_building - curv_drop(dist);
                ray_adj[s] = adj as f32;

                let angle = (adj - radar_height) / dist;
                if angle > running_max_angle { running_max_angle = angle; }
                ray_max[s] = running_max_angle as f32;
            }

            (ray_adj, ray_max)
        })
        .collect();

    let total_samples = num_rays * SAMPLES_PER_RAY;
    let mut adj_terrains = vec![0.0f32; total_samples];
    let mut max_angles = vec![0.0f32; total_samples];

    for (ray_idx, (ray_adj, ray_max)) in ray_results.into_iter().enumerate() {
        let offset = ray_idx * SAMPLES_PER_RAY;
        adj_terrains[offset..offset + SAMPLES_PER_RAY].copy_from_slice(&ray_adj);
        max_angles[offset..offset + SAMPLES_PER_RAY].copy_from_slice(&ray_max);
    }

    let profile = CoverageProfile {
        radar_name: radar_name.to_string(),
        radar_lat, radar_lon, radar_height, max_range_km,
        bearing_step_deg,
        adj_terrains, max_angles, num_rays,
    };

    let meta = ProfileMeta {
        radar_name: radar_name.to_string(),
        radar_height,
        max_range_km,
        max_elev_deg: MAX_ELEVATION_DEG,
        num_rays,
        samples_per_ray: SAMPLES_PER_RAY,
    };

    *PROFILE_CACHE_EXCLUDED.lock().unwrap_or_else(|e| e.into_inner()) = Some(profile);
    meta
}

/// 건물 제외 캐시에서 커버리지 레이어 계산
pub fn compute_layers_batch_excluded(alt_fts: &[f64], bearing_step: usize) -> Vec<CoverageLayer> {
    alt_fts.iter()
        .filter_map(|&alt_ft| compute_layer_from_cache(&PROFILE_CACHE_EXCLUDED, alt_ft, bearing_step))
        .collect()
}

/// 지정된 캐시에서 단일 레이어 계산 (공통 로직)
fn compute_layer_from_cache(
    cache_lock: &Mutex<Option<CoverageProfile>>,
    alt_ft: f64,
    bearing_step: usize,
) -> Option<CoverageLayer> {
    let cache = cache_lock.lock().unwrap_or_else(|e| e.into_inner());
    let profile = cache.as_ref()?;
    Some(compute_layer_inner(profile, alt_ft, bearing_step))
}

// ─── GPU용 프리샘플 (SRTM 지형 + 건물 높이 → base64) ───

/// GPU 커버리지 프리샘플 결과
#[derive(Serialize)]
pub struct PreSampledCoverage {
    /// 지형 고도 + 건물 높이 합산 f32 LE base64 (num_rays × num_samples)
    pub elev_b64: String,
    pub num_rays: u32,
    pub num_samples: u32,
    pub radar_height_m: f64,
    pub max_range_km: f64,
    pub bearing_step_deg: f64,
}

/// GPU용 배치 프리샘플: SRTM + 건물 높이를 f32 배열로 반환 (base64)
/// batch_start..batch_start+batch_count 범위의 ray만 처리
pub fn presample_elevations_batch(
    srtm: &mut SrtmReader,
    conn: &rusqlite::Connection,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
    bearing_step_deg: f64,
    exclude_manual_ids: Option<&[i64]>,
    batch_start: usize,
    batch_count: usize,
) -> PreSampledCoverage {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let radar_height = radar_altitude + antenna_height;
    let max_range_km = range_nm * 1.852;
    let total_rays = (360.0 / bearing_step_deg).floor() as usize;
    let actual_count = batch_count.min(total_rays.saturating_sub(batch_start));

    // SRTM 타일 프리로드
    let range_deg = (max_range_km / 111.0).ceil() as i32 + 1;
    srtm.preload_tiles(
        radar_lat.floor() as i32 - range_deg,
        radar_lat.floor() as i32 + range_deg,
        radar_lon.floor() as i32 - range_deg,
        radar_lon.floor() as i32 + range_deg,
    );
    let tiles = srtm.tiles_ref();

    // 건물 쿼리
    let range_deg_f = max_range_km / 111.0;
    let buildings = if let Some(exclude_ids) = exclude_manual_ids {
        query_buildings_for_coverage_excluding(conn, radar_lat, radar_lon, range_deg_f, exclude_ids)
    } else {
        query_buildings_for_coverage(conn, radar_lat, radar_lon, range_deg_f)
    };

    // 건물 높이 그리드 (배치 범위만)
    let mut building_heights = vec![0.0f32; actual_count * SAMPLES_PER_RAY];
    let cos_radar_lat = radar_lat.to_radians().cos();
    for &(blat, blon, bheight) in &buildings {
        let d_lat = blat - radar_lat;
        let d_lon = (blon - radar_lon) * cos_radar_lat;
        let dist_deg = (d_lat * d_lat + d_lon * d_lon).sqrt();
        let dist_km = dist_deg * 111.0;
        if dist_km < 0.01 || dist_km > max_range_km { continue; }

        let mut bearing = d_lon.atan2(d_lat).to_degrees();
        if bearing < 0.0 { bearing += 360.0; }

        let global_ray = (bearing / bearing_step_deg).round() as usize % total_rays;
        if global_ray < batch_start || global_ray >= batch_start + actual_count { continue; }
        let local_ray = global_ray - batch_start;

        let sample_idx = ((dist_km / max_range_km) * SAMPLES_PER_RAY as f64).round() as i32 - 1;
        if sample_idx < 0 || sample_idx >= SAMPLES_PER_RAY as i32 { continue; }

        let idx = local_ray * SAMPLES_PER_RAY + sample_idx as usize;
        if bheight as f32 > building_heights[idx] {
            building_heights[idx] = bheight as f32;
        }
    }

    // rayon 병렬: 지형 고도 + 건물 높이 합산
    let bh_ref = &building_heights;
    let elevations: Vec<f32> = (0..actual_count)
        .into_par_iter()
        .flat_map_iter(|local_idx| {
            let ray_idx = batch_start + local_idx;
            let bearing = ray_idx as f64 * bearing_step_deg;
            (0..SAMPLES_PER_RAY).map(move |s| {
                let dist = ((s + 1) as f64 / SAMPLES_PER_RAY as f64) * max_range_km;
                let (lat, lon) = crate::geo::destination_point_km(radar_lat, radar_lon, bearing, dist);
                let elev = srtm::elevation_from_tiles(tiles, lat, lon);
                let bld_h = bh_ref[local_idx * SAMPLES_PER_RAY + s] as f64;
                (elev + bld_h) as f32
            })
        })
        .collect();

    // f32 LE → base64
    let bytes: Vec<u8> = elevations.into_iter().flat_map(|v| v.to_le_bytes()).collect();
    let elev_b64 = STANDARD.encode(&bytes);
    drop(bytes);

    PreSampledCoverage {
        elev_b64,
        num_rays: actual_count as u32,
        num_samples: SAMPLES_PER_RAY as u32,
        radar_height_m: radar_height,
        max_range_km,
        bearing_step_deg,
    }
}


// ═══════════════════════════════════════════════════
// Per-pixel 커버리지 비트맵 렌더링 (무한해상도, GPU 대체)
// ═══════════════════════════════════════════════════

/// Per-pixel 렌더링용 레이더별 캐시 (SRTM+건물, 뷰포트 독립)
static PIXEL_STATE: Mutex<Option<PixelCoverageState>> = Mutex::new(None);

struct PixelCoverageState {
    radar_key: String,
    radar_lat: f64,
    radar_lon: f64,
    radar_height: f64,
    max_range_km: f64,
    cos_radar_lat: f64,
    inv_deg_lat: f64,
    inv_deg_lon: f64,
    /// 건물 높이 sparse map: bearing_slot → [(sample_idx, height)]
    building_map: Vec<Vec<(usize, f32)>>,
    bearing_quant_deg: f64,
    num_bearing_slots: usize,
}

/// 비트맵 렌더링 결과
#[derive(Serialize)]
pub struct CoverageBitmapResult {
    /// RGBA 비트맵 base64
    pub bitmap_b64: String,
    pub width: u32,
    pub height: u32,
    /// 맵 오버레이 bounds [west, south, east, north]
    pub bounds: [f64; 4],
    /// 화면에 실제 렌더링된 고도 목록 (ft, 오름차순)
    pub used_alt_fts: Vec<f64>,
}

/// HSL→RGB 변환 (Worker altToColor와 동일)
fn alt_to_color(alt_ft: f64) -> [u8; 3] {
    let t = ((alt_ft - 100.0) / (30000.0 - 100.0)).clamp(0.0, 1.0);
    let hue = t * 240.0;
    let s: f64 = 0.85;
    let l: f64 = 0.5;
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let x = c * (1.0 - ((hue / 60.0) % 2.0 - 1.0).abs());
    let m = l - c / 2.0;
    let (r1, g1, b1) = if hue < 60.0 { (c, x, 0.0) }
        else if hue < 120.0 { (x, c, 0.0) }
        else if hue < 180.0 { (0.0, c, x) }
        else if hue < 240.0 { (0.0, x, c) }
        else { (0.0, 0.0, c) };
    [((r1 + m) * 255.0).round() as u8,
     ((g1 + m) * 255.0).round() as u8,
     ((b1 + m) * 255.0).round() as u8]
}

/// Per-pixel 캐시 초기화 (SRTM 프리로드 + 건물 building_map 구축)
pub fn init_pixel_coverage(
    srtm: &mut SrtmReader,
    conn: &rusqlite::Connection,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
) {
    let radar_height = radar_altitude + antenna_height;
    let max_range_km = range_nm * 1.852;
    let bearing_quant_deg: f64 = 0.001;
    let num_bearing_slots = (360.0 / bearing_quant_deg).floor() as usize;
    let cos_radar_lat = radar_lat.to_radians().cos();
    let inv_deg_lat = 1.0 / 111_320.0;
    let inv_deg_lon = if cos_radar_lat > 0.0 { 1.0 / (111_320.0 * cos_radar_lat) } else { 0.0 };

    // SRTM 타일 프리로드
    let range_deg = (max_range_km / 111.0).ceil() as i32 + 1;
    srtm.preload_tiles(
        radar_lat.floor() as i32 - range_deg,
        radar_lat.floor() as i32 + range_deg,
        radar_lon.floor() as i32 - range_deg,
        radar_lon.floor() as i32 + range_deg,
    );

    // 건물 쿼리 + sparse building map
    let range_deg_f = max_range_km / 111.0;
    let buildings = query_buildings_for_coverage(conn, radar_lat, radar_lon, range_deg_f);
    let mut building_map: Vec<Vec<(usize, f32)>> = vec![Vec::new(); num_bearing_slots];
    for &(blat, blon, bheight) in &buildings {
        let d_lat = blat - radar_lat;
        let d_lon = (blon - radar_lon) * cos_radar_lat;
        let dist_deg = (d_lat * d_lat + d_lon * d_lon).sqrt();
        let dist_km = dist_deg * 111.0;
        if dist_km < 0.01 || dist_km > max_range_km { continue; }
        let mut bearing = d_lon.atan2(d_lat).to_degrees();
        if bearing < 0.0 { bearing += 360.0; }
        let slot = (bearing / bearing_quant_deg).round() as usize % num_bearing_slots;
        let si = ((dist_km / max_range_km) * SAMPLES_PER_RAY as f64).round() as i32 - 1;
        if si < 0 || si >= SAMPLES_PER_RAY as i32 { continue; }
        building_map[slot].push((si as usize, bheight as f32));
    }

    let key = format!("{radar_lat}_{radar_lon}_{radar_height}");
    *PIXEL_STATE.lock().unwrap_or_else(|e| e.into_inner()) = Some(PixelCoverageState {
        radar_key: key,
        radar_lat, radar_lon, radar_height, max_range_km,
        cos_radar_lat, inv_deg_lat, inv_deg_lon,
        building_map, bearing_quant_deg, num_bearing_slots,
    });
}

/// Per-pixel 캐시 유효성 확인
pub fn is_pixel_cache_valid(radar_lat: f64, radar_lon: f64, radar_height: f64) -> bool {
    let cache = PIXEL_STATE.lock().unwrap_or_else(|e| e.into_inner());
    match cache.as_ref() {
        Some(s) => s.radar_key == format!("{radar_lat}_{radar_lon}_{radar_height}"),
        None => false,
    }
}

/// Per-pixel 캐시 무효화
pub fn invalidate_pixel_cache() {
    *PIXEL_STATE.lock().unwrap_or_else(|e| e.into_inner()) = None;
}

/// 특정 좌표의 최저 탐지고도(ft) 조회
/// 캐시된 PIXEL_STATE + SRTM을 사용하여 해당 지점의 ray profile을 계산하고,
/// 100ft~30000ft 범위에서 이진 탐색으로 최저 탐지 가능 고도를 반환.
pub fn query_min_detection_alt(
    srtm: &mut SrtmReader,
    lat: f64,
    lon: f64,
) -> Option<f64> {
    let ps_guard = PIXEL_STATE.lock().unwrap_or_else(|e| e.into_inner());
    let ps = ps_guard.as_ref()?;
    let tiles = srtm.tiles_ref();

    // 레이더로부터의 거리/방위 계산
    let d_north_km = (lat - ps.radar_lat) * 111.32;
    let d_east_km = (lon - ps.radar_lon) * 111.32 * ps.cos_radar_lat;
    let dist_sq = d_north_km * d_north_km + d_east_km * d_east_km;
    if dist_sq > ps.max_range_km * ps.max_range_km || dist_sq < 0.0001 {
        return None;
    }
    let dist_km = dist_sq.sqrt();
    let mut bearing = d_east_km.atan2(d_north_km).to_degrees();
    if bearing < 0.0 { bearing += 360.0; }
    let slot = (bearing / ps.bearing_quant_deg).round() as usize % ps.num_bearing_slots;
    let si = ((dist_km / ps.max_range_km) * SAMPLES_PER_RAY as f64) as usize;
    let si = si.min(SAMPLES_PER_RAY - 1);

    // 해당 방위의 ray profile 계산
    let bearing_rad = (slot as f64 * ps.bearing_quant_deg).to_radians();
    let sin_b = bearing_rad.sin();
    let cos_b = bearing_rad.cos();

    let mut ray_bld = vec![0.0f32; SAMPLES_PER_RAY];
    for &(s_idx, bh) in &ps.building_map[slot] {
        if bh > ray_bld[s_idx] { ray_bld[s_idx] = bh; }
    }

    let mut max_angles = vec![0.0f32; SAMPLES_PER_RAY];
    let mut running_max: f64 = f64::NEG_INFINITY;
    for s in 0..SAMPLES_PER_RAY {
        let dist_m = ((s + 1) as f64 / SAMPLES_PER_RAY as f64) * ps.max_range_km * 1000.0;
        let east_m = dist_m * sin_b;
        let north_m = dist_m * cos_b;
        let s_lat = ps.radar_lat + north_m * ps.inv_deg_lat;
        let s_lon = ps.radar_lon + east_m * ps.inv_deg_lon;
        let elev = srtm::elevation_from_tiles(tiles, s_lat, s_lon);
        let raw_terrain = elev + ray_bld[s] as f64;
        let curv = dist_m * dist_m / (2.0 * R_EFF_M);
        let adj = raw_terrain - curv;
        let angle = (adj - ps.radar_height) / dist_m;
        if angle > running_max { running_max = angle; }
        max_angles[s] = running_max as f32;
    }

    // 이진 탐색: 최저 탐지고도 (100ft ~ 30000ft, 50ft 단위)
    let dist_m = dist_km * 1000.0;
    let curv = dist_m * dist_m / (2.0 * R_EFF_M);
    let max_angle_at_point = max_angles[si];
    let max_elev_rad = MAX_ELEVATION_DEG.to_radians();

    let mut lo_ft: f64 = 100.0;
    let mut hi_ft: f64 = 30000.0;

    // 30000ft에서도 탐지 불가 → None
    {
        let alt_m = hi_ft * FT_TO_M;
        let adj_alt = alt_m - curv;
        let target = ((adj_alt - ps.radar_height) / dist_m) as f32;
        if max_angle_at_point > target {
            return None; // 최대 고도에서도 차단
        }
    }

    // 100ft에서 탐지 가능 → 100ft
    {
        let alt_m = lo_ft * FT_TO_M;
        let adj_alt = alt_m - curv;
        let target = ((adj_alt - ps.radar_height) / dist_m) as f32;
        if max_angle_at_point <= target {
            // Cone of Silence 체크
            let height_above = alt_m - ps.radar_height;
            let cone_r_km = if height_above > 0.0 { (height_above / max_elev_rad.tan()) / 1000.0 } else { 0.0 };
            if dist_km >= cone_r_km {
                return Some(lo_ft);
            }
        }
    }

    // 이진 탐색
    while hi_ft - lo_ft > 50.0 {
        let mid_ft = ((lo_ft + hi_ft) / 2.0 / 50.0).round() * 50.0;
        let alt_m = mid_ft * FT_TO_M;
        let adj_alt = alt_m - curv;
        let target = ((adj_alt - ps.radar_height) / dist_m) as f32;
        let height_above = alt_m - ps.radar_height;
        let cone_r_km = if height_above > 0.0 { (height_above / max_elev_rad.tan()) / 1000.0 } else { 0.0 };
        if max_angle_at_point <= target && dist_km >= cone_r_km {
            hi_ft = mid_ft;
        } else {
            lo_ft = mid_ft;
        }
    }

    Some(hi_ft)
}

/// Per-pixel 커버리지 비트맵 렌더링
///
/// 뷰포트의 각 픽셀에 대해 on-demand ray tracing:
///   1. (px,py) → (lat,lon) → (bearing, distance) from radar
///   2. 같은 bearing의 ray profile 계산 (max_angles, 2400 SRTM samples)
///   3. 해당 거리에서 선택 고도의 커버리지 여부 판정 (O(1))
///   4. 고도별 HSL 색상 적용
///
/// 해상도 = 뷰포트 픽셀 해상도 (무한, 줌 레벨에 비례)
pub fn render_coverage_bitmap(
    srtm: &mut SrtmReader,
    alt_fts: &[f64],
    show_cone: bool,
    west: f64, south: f64, east: f64, north: f64,
    width: u32, height: u32,
) -> Option<CoverageBitmapResult> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use std::collections::HashMap;

    let ps_guard = PIXEL_STATE.lock().unwrap_or_else(|e| e.into_inner());
    let ps = ps_guard.as_ref()?;
    let tiles = srtm.tiles_ref();

    let w = width as usize;
    let h = height as usize;
    let lat_step = (north - south) / h as f64;
    let lon_step = (east - west) / w as f64;
    let max_range_sq = ps.max_range_km * ps.max_range_km;

    // 고도 색상 프리컴퓨트 (낮은→높은 순, 낮은 고도 우선 탐색)
    let mut sorted_alts: Vec<f64> = alt_fts.to_vec();
    sorted_alts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let alt_colors: Vec<[u8; 3]> = sorted_alts.iter().map(|&a| alt_to_color(a)).collect();
    let alt_ms: Vec<f64> = sorted_alts.iter().map(|&a| a * FT_TO_M).collect();
    let n_alts = alt_ms.len();

    // Cone of Silence
    let max_elev_rad = MAX_ELEVATION_DEG.to_radians();
    let lowest_alt_m = alt_ms.first().copied().unwrap_or(0.0);
    let cone_radius_km = if show_cone && lowest_alt_m > ps.radar_height {
        ((lowest_alt_m - ps.radar_height) / max_elev_rad.tan()) / 1000.0
    } else { 0.0 };
    let cone_radius_sq = cone_radius_km * cone_radius_km;

    // Step 1: 각 픽셀의 (bearing_slot, sample_idx, dist_km) 계산
    let px_data: Vec<(u32, u16, f64, bool)> = (0..w * h)
        .into_par_iter()
        .map(|i| {
            let px = i % w;
            let py = i / w;
            let lat = north - (py as f64 + 0.5) * lat_step;
            let lon = west + (px as f64 + 0.5) * lon_step;
            let d_north_km = (lat - ps.radar_lat) * 111.32;
            let d_east_km = (lon - ps.radar_lon) * 111.32 * ps.cos_radar_lat;
            let dist_sq = d_north_km * d_north_km + d_east_km * d_east_km;
            if dist_sq > max_range_sq || dist_sq < 0.0001 {
                return (0u32, 0u16, 0.0, false);
            }
            let dist_km = dist_sq.sqrt();
            let mut bearing = d_east_km.atan2(d_north_km).to_degrees();
            if bearing < 0.0 { bearing += 360.0; }
            let slot = (bearing / ps.bearing_quant_deg).round() as u32 % ps.num_bearing_slots as u32;
            let si = ((dist_km / ps.max_range_km) * SAMPLES_PER_RAY as f64) as u16;
            let si = si.min(SAMPLES_PER_RAY as u16 - 1);
            (slot, si, dist_km, true)
        })
        .collect();

    // Step 2: 고유 bearing 수집
    let mut unique_set = std::collections::HashSet::new();
    for &(slot, _, _, in_range) in &px_data {
        if in_range { unique_set.insert(slot); }
    }
    let unique_bearings: Vec<u32> = unique_set.into_iter().collect();

    // Step 3: 고유 bearing별 ray profile 계산 (Rayon 병렬)
    let profiles: HashMap<u32, Vec<f32>> = unique_bearings
        .into_par_iter()
        .map(|slot| {
            let bearing_rad = (slot as f64 * ps.bearing_quant_deg).to_radians();
            let sin_b = bearing_rad.sin();
            let cos_b = bearing_rad.cos();

            let mut ray_bld = vec![0.0f32; SAMPLES_PER_RAY];
            for &(si, bh) in &ps.building_map[slot as usize] {
                if bh > ray_bld[si] { ray_bld[si] = bh; }
            }

            let mut max_angles = vec![0.0f32; SAMPLES_PER_RAY];
            let mut running_max: f64 = f64::NEG_INFINITY;
            for s in 0..SAMPLES_PER_RAY {
                let dist_m = ((s + 1) as f64 / SAMPLES_PER_RAY as f64) * ps.max_range_km * 1000.0;
                let east_m = dist_m * sin_b;
                let north_m = dist_m * cos_b;
                let lat = ps.radar_lat + north_m * ps.inv_deg_lat;
                let lon = ps.radar_lon + east_m * ps.inv_deg_lon;
                let elev = srtm::elevation_from_tiles(tiles, lat, lon);
                let raw_terrain = elev + ray_bld[s] as f64;
                let curv = dist_m * dist_m / (2.0 * R_EFF_M);
                let adj = raw_terrain - curv;
                let angle = (adj - ps.radar_height) / dist_m;
                if angle > running_max { running_max = angle; }
                max_angles[s] = running_max as f32;
            }
            (slot, max_angles)
        })
        .collect();

    // Step 4: 픽셀별 커버리지 판정 → 고도 인덱스 (Rayon 병렬)
    let rh = ps.radar_height;
    let px_alt_idx: Vec<u16> = (0..w * h)
        .into_par_iter()
        .map(|i| {
            let (slot, si, dist_km, in_range) = px_data[i];
            if !in_range { return u16::MAX; }
            if cone_radius_km > 0.5 && dist_km * dist_km < cone_radius_sq { return u16::MAX; }

            let max_angles = &profiles[&slot];
            let si = si as usize;
            let dist_m = dist_km * 1000.0;

            for a in 0..n_alts {
                let alt_m = alt_ms[a];
                let curv = dist_m * dist_m / (2.0 * R_EFF_M);
                let adj_alt = alt_m - curv;
                let target = ((adj_alt - rh) / dist_m) as f32;
                if max_angles[si] > target { continue; }
                return a as u16;
            }
            u16::MAX
        })
        .collect();

    // 사용된 고도 수집
    let mut used_mask = vec![false; n_alts];
    for &idx in &px_alt_idx {
        if (idx as usize) < n_alts { used_mask[idx as usize] = true; }
    }
    let used_alt_fts: Vec<f64> = used_mask.iter().enumerate()
        .filter(|(_, &used)| used)
        .map(|(i, _)| sorted_alts[i])
        .collect();

    // RGBA 비트맵 생성
    let mut bitmap = vec![0u8; w * h * 4];
    for (i, &idx) in px_alt_idx.iter().enumerate() {
        if (idx as usize) < n_alts {
            let c = alt_colors[idx as usize];
            let off = i * 4;
            bitmap[off] = c[0];
            bitmap[off + 1] = c[1];
            bitmap[off + 2] = c[2];
            bitmap[off + 3] = 255;
        }
    }

    let bitmap_b64 = STANDARD.encode(&bitmap);
    Some(CoverageBitmapResult {
        bitmap_b64,
        width,
        height,
        bounds: [west, south, east, north],
        used_alt_fts,
    })
}
