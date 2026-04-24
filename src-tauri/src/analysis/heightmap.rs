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
    build_heightmap_with_progress(
        srtm, conn,
        radar_lat, radar_lon, radar_altitude, antenna_height, range_nm, pixel_size_m,
        exclude_manual_ids, skip_buildings, None,
    )
}

/// 내부 단계별 진행 콜백을 받는 버전 — 진단/UI 용
pub fn build_heightmap_with_progress(
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
    progress_cb: Option<&(dyn Fn(String) + Send + Sync)>,
) -> HeightmapResult {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let emit = |msg: String| {
        log::info!("{}", &msg);
        if let Some(cb) = progress_cb { cb(msg); }
    };
    emit(format!("[Heightmap] 시작: lat={:.4}, lon={:.4}, range_nm={:.1}, pix={:.0}m, skip_bldg={}",
        radar_lat, radar_lon, range_nm, pixel_size_m, skip_buildings));
    let t_total = std::time::Instant::now();

    let radar_height = radar_altitude + antenna_height;
    let max_range_km = range_nm * 1.852;
    let max_range_m = max_range_km * 1000.0;
    let half_extent_m = max_range_m;

    // 그리드 크기 — dim^2 * 17바이트(data+bldg+bytes+b64) 메모리 사용,
    // dim 10000 → ~1.7GB peak. 안전 한도 10000으로 제한, 초과 시 pixel_size 자동 조정
    const MAX_DIM: usize = 10_000;
    let raw_dim = (2.0 * half_extent_m / pixel_size_m).ceil() as usize;
    let (dim, pixel_size_m) = if raw_dim > MAX_DIM {
        let adjusted = (2.0 * half_extent_m / MAX_DIM as f64).ceil();
        log::info!(
            "[Heightmap] dim {} 초과 → {}×{} (pixel {:.1}m→{:.1}m)",
            raw_dim, MAX_DIM, MAX_DIM, pixel_size_m, adjusted
        );
        (MAX_DIM, adjusted)
    } else {
        (raw_dim, pixel_size_m)
    };
    let width = dim;
    let height = dim;
    let half_dim = dim as f64 / 2.0;

    // SRTM 타일 프리로드
    let range_deg = (max_range_km / 111.0).ceil() as i32 + 1;
    let t_preload = std::time::Instant::now();
    emit(format!("[Heightmap] preload_tiles 시작 (범위 {}°x{}°, dim={}×{})",
        2 * range_deg + 1, 2 * range_deg + 1, width, height));
    srtm.preload_tiles(
        radar_lat.floor() as i32 - range_deg,
        radar_lat.floor() as i32 + range_deg,
        radar_lon.floor() as i32 - range_deg,
        radar_lon.floor() as i32 + range_deg,
    );
    emit(format!("[Heightmap] preload_tiles 완료 ({}ms)", t_preload.elapsed().as_millis()));
    let tiles = srtm.tiles_ref();

    // 건물 쿼리 — skip_buildings 시 완전히 생략 (이전 버그: 쿼리만 했다가 결과를 버렸음)
    let range_deg_f = max_range_km / 111.0;
    let t_bldg = std::time::Instant::now();
    let buildings = if skip_buildings {
        emit("[Heightmap] 건물 쿼리 skip".into());
        Vec::new()
    } else if let Some(exclude_ids) = exclude_manual_ids {
        emit(format!("[Heightmap] query_buildings_for_coverage_excluding 시작 (exclude={}개)", exclude_ids.len()));
        let r = super::coverage::query_buildings_for_coverage_excluding(
            conn, radar_lat, radar_lon, range_deg_f, exclude_ids,
        );
        emit(format!("[Heightmap] 건물 쿼리 완료 ({}ms, {}개)", t_bldg.elapsed().as_millis(), r.len()));
        r
    } else {
        emit("[Heightmap] query_buildings_for_coverage 시작".into());
        let r = super::coverage::query_buildings_for_coverage(
            conn, radar_lat, radar_lon, range_deg_f,
        );
        emit(format!("[Heightmap] 건물 쿼리 완료 ({}ms, {}개)", t_bldg.elapsed().as_millis(), r.len()));
        r
    };

    // 1. rayon 병렬 SRTM 샘플링 → 기본 지형 그리드
    emit(format!("[Heightmap] rayon SRTM 샘플링 시작 ({} px)", width * height));
    let t_sample = std::time::Instant::now();
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
    emit(format!("[Heightmap] rayon SRTM 샘플링 완료 ({}ms)", t_sample.elapsed().as_millis()));

    // 2. 건물 래스터화 (max semantics) — skip_buildings 시 생략
    let mut data = data;
    if skip_buildings {
        // f32 LE → base64 (건물 없는 순수 지형)
        emit("[Heightmap] base64 인코딩 시작".into());
        let t_enc = std::time::Instant::now();
        let bytes: Vec<u8> = data.iter().flat_map(|v| v.to_le_bytes()).collect();
        let data_b64 = STANDARD.encode(&bytes);
        emit(format!("[Heightmap] base64 인코딩 완료 ({}ms, {:.1}MB). 전체 {}ms",
            t_enc.elapsed().as_millis(),
            data_b64.len() as f64 / 1024.0 / 1024.0,
            t_total.elapsed().as_millis()));
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
    // SRTM 지형 + 건물 최대 높이 합산 후 bldg_heights 즉시 해제 (메모리 절약)
    for i in 0..data.len() {
        if bldg_heights[i] > 0.0 {
            data[i] += bldg_heights[i];
        }
    }
    drop(bldg_heights);

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
