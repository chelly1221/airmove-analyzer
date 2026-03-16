//! SRTM HGT 타일 읽기 (1-arcsecond, 30m 해상도)
//! 파일 포맷: 3601×3601 big-endian i16 (meters), 북→남, 서→동

use std::collections::HashMap;
use std::path::{Path, PathBuf};

const SRTM1_SAMPLES: usize = 3601;
const TILE_BYTES: usize = SRTM1_SAMPLES * SRTM1_SAMPLES * 2;

/// SRTM HGT 타일 읽기 + 메모리 캐시
pub struct SrtmReader {
    data_dir: PathBuf,
    tiles: HashMap<String, Option<Vec<i16>>>,
}

impl SrtmReader {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            tiles: HashMap::new(),
        }
    }

    /// 타일 이름 생성 (e.g., "N37E126")
    pub fn tile_name(lat: i32, lon: i32) -> String {
        let ns = if lat >= 0 { 'N' } else { 'S' };
        let ew = if lon >= 0 { 'E' } else { 'W' };
        format!("{}{:02}{}{:03}", ns, lat.abs(), ew, lon.abs())
    }

    /// 타일 파일 경로
    pub fn tile_path(&self, name: &str) -> PathBuf {
        self.data_dir.join(format!("{}.hgt", name))
    }

    /// 타일 로드 (3601×3601 big-endian i16)
    fn load_tile(&self, name: &str) -> Option<Vec<i16>> {
        let path = self.tile_path(name);
        let bytes = std::fs::read(&path).ok()?;
        if bytes.len() != TILE_BYTES {
            log::warn!(
                "[SRTM] Invalid tile size for {}: {} (expected {})",
                name,
                bytes.len(),
                TILE_BYTES
            );
            return None;
        }
        let mut data = Vec::with_capacity(SRTM1_SAMPLES * SRTM1_SAMPLES);
        for chunk in bytes.chunks_exact(2) {
            data.push(i16::from_be_bytes([chunk[0], chunk[1]]));
        }
        log::info!("[SRTM] Loaded tile: {}", name);
        Some(data)
    }

    /// 좌표에서 고도 조회 (바이리니어 보간, 30m 해상도)
    pub fn get_elevation(&mut self, lat: f64, lon: f64) -> Option<f64> {
        let tile_lat = lat.floor() as i32;
        let tile_lon = lon.floor() as i32;
        let name = Self::tile_name(tile_lat, tile_lon);

        // 캐시 확인/로드
        if !self.tiles.contains_key(&name) {
            let tile = self.load_tile(&name);
            self.tiles.insert(name.clone(), tile);
        }
        let data = self.tiles.get(&name)?.as_ref()?;

        // 픽셀 좌표 (북→남이므로 row는 반전)
        let row_f = (tile_lat as f64 + 1.0 - lat) * (SRTM1_SAMPLES - 1) as f64;
        let col_f = (lon - tile_lon as f64) * (SRTM1_SAMPLES - 1) as f64;
        let row = row_f.floor() as usize;
        let col = col_f.floor() as usize;

        if row >= SRTM1_SAMPLES - 1 || col >= SRTM1_SAMPLES - 1 {
            return Some(0.0);
        }

        let row_frac = row_f - row as f64;
        let col_frac = col_f - col as f64;

        let idx = |r: usize, c: usize| r * SRTM1_SAMPLES + c;
        let v00 = data[idx(row, col)] as f64;
        let v01 = data[idx(row, col + 1)] as f64;
        let v10 = data[idx(row + 1, col)] as f64;
        let v11 = data[idx(row + 1, col + 1)] as f64;

        // void (-32768) → 0m (해양/결측)
        if v00 == -32768.0 || v01 == -32768.0 || v10 == -32768.0 || v11 == -32768.0 {
            return Some(0.0);
        }

        // 바이리니어 보간
        let v0 = v00 + (v01 - v00) * col_frac;
        let v1 = v10 + (v11 - v10) * col_frac;
        Some((v0 + (v1 - v0) * row_frac).max(0.0))
    }

    /// 배치 고도 조회
    pub fn get_elevations(&mut self, lats: &[f64], lons: &[f64]) -> Vec<f64> {
        lats.iter()
            .zip(lons.iter())
            .map(|(&lat, &lon)| self.get_elevation(lat, lon).unwrap_or(0.0))
            .collect()
    }

    /// 특정 타일 존재 여부
    pub fn has_tile(&self, lat: i32, lon: i32) -> bool {
        let name = Self::tile_name(lat, lon);
        self.tile_path(&name).exists()
    }

    /// 데이터 디렉토리 경로
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }
}
