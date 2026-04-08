//! 2D heightmap 빌더 — SRTM 지형 + 건물 높이를 단일 ENU 그리드로 합성
//!
//! GPU 커버리지/파노라마에서 공유하는 heightmap을 1회 IPC로 전송.
//! 기존 presample_elevations_batch(방사선 36K개 × 2400 샘플)을 대체.

use rayon::prelude::*;
use serde::Serialize;

use crate::srtm::{self, SrtmReader};

/// Heightmap 빌드 결과 — JS에서 GPU 텍스처로 업로드
#[derive(Serialize)]
pub struct HeightmapResult {
    /// f32 LE base64 (width × height, row-major, SW corner = (0,0))
    pub data_b64: String,
    pub width: u32,
    pub height: u32,
    /// 픽셀당 미터
    pub pixel_size_m: f32,
    /// 레이더 위치 (heightmap 중심)
    pub center_lat: f64,
    pub center_lon: f64,
    /// 레이더 안테나 높이 ASL (m)
    pub radar_height_m: f64,
    /// 최대 범위 (km)
    pub max_range_km: f64,
}

/// 2D heightmap 빌드 (SRTM + 건물)
///
/// ENU 좌표계: 레이더를 원점으로, East/North 방향 정사각 그리드.
/// 각 픽셀 = max(SRTM 지형고도, 지형고도 + 건물높이).
pub fn build_heightmap(
    srtm: &mut SrtmReader,
    conn: &rusqlite::Connection,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
    pixel_size_m: f64,
    exclude_manual_ids: Option<&[i64]>,
    skip_buildings: bool,
) -> HeightmapResult {
    use base64::{Engine as _, engine::general_purpose::STANDARD};

    let radar_height = radar_altitude + antenna_height;
    let max_range_km = range_nm * 1.852;
    let max_range_m = max_range_km * 1000.0;
    let half_extent_m = max_range_m;

    // 그리드 크기
    let dim = (2.0 * half_extent_m / pixel_size_m).ceil() as usize;
    let width = dim;
    let height = dim;
    let half_dim = dim as f64 / 2.0;

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
        super::coverage::query_buildings_for_coverage_excluding(
            conn, radar_lat, radar_lon, range_deg_f, exclude_ids,
        )
    } else {
        super::coverage::query_buildings_for_coverage(
            conn, radar_lat, radar_lon, range_deg_f,
        )
    };

    // 1. rayon 병렬 SRTM 샘플링 → 기본 지형 그리드
    let cos_radar_lat = radar_lat.to_radians().cos();
    let data: Vec<f32> = (0..height)
        .into_par_iter()
        .flat_map_iter(move |row| {
            (0..width).map(move |col| {
                let east_m = (col as f64 - half_dim) * pixel_size_m;
                let north_m = (row as f64 - half_dim) * pixel_size_m;
                let lat = radar_lat + north_m / 111_000.0;
                let lon = radar_lon + east_m / (111_000.0 * cos_radar_lat);
                srtm::elevation_from_tiles(tiles, lat, lon) as f32
            })
        })
        .collect();

    // 2. 건물 래스터화 (max semantics) — skip_buildings 시 생략
    let mut data = data;
    if skip_buildings {
        // f32 LE → base64 (건물 없는 순수 지형)
        let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
        let data_b64 = STANDARD.encode(&bytes);
        return HeightmapResult {
            data_b64,
            width: width as u32,
            height: height as u32,
            pixel_size_m: pixel_size_m as f32,
            center_lat: radar_lat,
            center_lon: radar_lon,
            radar_height_m: radar_height,
            max_range_km,
        };
    }
    // 건물 높이 그리드 — 픽셀별 최대 건물 높이(AGL)만 기록
    // data(SRTM 지형)에 직접 더하면 같은 픽셀에 여러 꼭짓점이 겹칠 때 높이가 누적되므로,
    // 별도 그리드에서 max를 구한 뒤 한 번만 합산
    let mut bldg_heights = vec![0.0f32; width * height];
    let cos_lat = radar_lat.to_radians().cos();
    for &(blat, blon, bheight) in &buildings {
        let east_m = (blon - radar_lon) * 111_000.0 * cos_lat;
        let north_m = (blat - radar_lat) * 111_000.0;
        let col_f = east_m / pixel_size_m + half_dim;
        let row_f = north_m / pixel_size_m + half_dim;

        let col = col_f.round() as isize;
        let row = row_f.round() as isize;
        if col < 0 || col >= width as isize || row < 0 || row >= height as isize {
            continue;
        }
        let idx = row as usize * width + col as usize;
        if bheight as f32 > bldg_heights[idx] {
            bldg_heights[idx] = bheight as f32;
        }
    }
    // SRTM 지형 + 건물 최대 높이 합산
    for i in 0..data.len() {
        if bldg_heights[i] > 0.0 {
            data[i] += bldg_heights[i];
        }
    }

    // f32 LE → base64
    let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
    let data_b64 = STANDARD.encode(&bytes);

    HeightmapResult {
        data_b64,
        width: width as u32,
        height: height as u32,
        pixel_size_m: pixel_size_m as f32,
        center_lat: radar_lat,
        center_lon: radar_lon,
        radar_height_m: radar_height,
        max_range_km,
    }
}
