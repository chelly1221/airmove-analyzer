//! 레이더 커버리지 맵 계산 (rayon 병렬 + SRTM 직접 접근)
//!
//! Phase 1: 지형 프로파일 사전 계산 (rayon으로 3600 ray 병렬 처리)
//! Phase 2: 고도별 커버리지 레이어 계산 (이진 탐색)

use std::sync::Mutex;

use rayon::prelude::*;
use serde::Serialize;

use crate::srtm::{self, SrtmReader};

const R_EARTH_M: f64 = 6_371_000.0;
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

        // Binary search: LOS block point
        let mut los_block_idx = n;
        let mut lo: usize = 1;
        let mut hi: usize = n - 1;
        while lo <= hi {
            let mid = (lo + hi) / 2;
            let dist = ((mid + 1) as f64 / n as f64) * max_range_km;
            let adj_alt = alt_m - curv_drop(dist);
            let target_angle = (adj_alt as f32 - radar_h as f32) / dist as f32;
            if profile.max_angles[ray_offset + mid - 1] > target_angle {
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
fn query_buildings_for_coverage(
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

    // GIS buildings
    if let Ok(mut stmt) = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height FROM buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height >= 3.0 AND height <= 1000.0"
    ) {
        if let Ok(rows) = stmt.query_map(
            rusqlite::params![min_lat, max_lat, min_lon, max_lon],
            |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?)),
        ) {
            for r in rows.flatten() {
                result.push(r);
            }
        }
    }

    // Manual buildings
    if let Ok(mut stmt) = conn.prepare(
        "SELECT latitude, longitude, height FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4"
    ) {
        if let Ok(rows) = stmt.query_map(
            rusqlite::params![min_lat, max_lat, min_lon, max_lon],
            |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?)),
        ) {
            for r in rows.flatten() {
                result.push(r);
            }
        }
    }

    result
}

/// Query buildings excluding specific manual building IDs
fn query_buildings_for_coverage_excluding(
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

    // GIS buildings (동일 — GIS 건물은 제외 대상 아님)
    if let Ok(mut stmt) = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height FROM buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height >= 3.0 AND height <= 1000.0"
    ) {
        if let Ok(rows) = stmt.query_map(
            rusqlite::params![min_lat, max_lat, min_lon, max_lon],
            |row| Ok((row.get::<_, f64>(0)?, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?)),
        ) {
            for r in rows.flatten() {
                result.push(r);
            }
        }
    }

    // Manual buildings — 제외 ID 필터링
    if let Ok(mut stmt) = conn.prepare(
        "SELECT id, latitude, longitude, height FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4"
    ) {
        if let Ok(rows) = stmt.query_map(
            rusqlite::params![min_lat, max_lat, min_lon, max_lon],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?, row.get::<_, f64>(2)?, row.get::<_, f64>(3)?)),
        ) {
            for r in rows.flatten() {
                let (id, lat, lon, height) = r;
                if !exclude_manual_ids.contains(&id) {
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
