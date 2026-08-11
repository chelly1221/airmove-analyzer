//! SRTM HGT 타일 읽기 (1-arcsecond, 30m 해상도)
//! 파일 포맷: 3601×3601 big-endian i16 (meters), 북→남, 서→동
//! 저장소: SQLite DB (srtm_tiles BLOB) + 파일 폴백
//!
//! ## SRTM-실측 지반고 융합
//! 30m SRTM 은 도심에서 건물고가 섞인 DSM 편향을 갖는다. 실측 3D 건물(1m DSM) 임포트가
//! 건물 기저부 최저 표면고(minH)를 HGT 노드별 중앙값으로 모아 `srtm_ground_corrections`
//! 테이블에 **절대 MSL** 로 적재하고(measured_building.rs), 여기 `load_tile` 이 타일을 읽을 때마다
//! 인메모리 배열에만 머지한다.
//! - 원본 `srtm_tiles` BLOB 은 절대 변경하지 않는다 (파일→DB 마이그레이션 저장도 raw bytes 그대로).
//! - 절대 MSL 이라 SRTM 재다운로드로 리더가 통째로 교체돼도 다음 로드에서 자동 재적용된다.
//! - 보정 노드는 정확한 delta, 이웃 2셀은 거리 가중 테이퍼(페더링) — 30m 격자 경계 계단 방지.
//! - |delta| > 30m 는 이상치로 폐기, void(-32768) 노드는 실측 지반고를 직접 기록.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

const SRTM1_SAMPLES: usize = 3601;
const TILE_BYTES: usize = SRTM1_SAMPLES * SRTM1_SAMPLES * 2;

/// HGT void(결측/해양) 센티널
const VOID_VALUE: i16 = -32768;

/// 지반고 보정 델타 상한 (m) — 초과분은 매칭 오류/대형 구조물 기저부로 보고 폐기
const CORRECTION_DELTA_CLAMP_M: f64 = 30.0;

/// 페더링 반경 (셀) — 보정 노드 주변 체비쇼프 거리 d=1..2 에 가중 테이퍼 적용
const FEATHER_RADIUS: usize = 2;

/// SRTM HGT 타일 읽기 + 메모리 캐시
/// DB 우선 로드, 파일 폴백 (파일에서 로드 시 DB에 자동 저장)
pub struct SrtmReader {
    data_dir: PathBuf,
    db_path: PathBuf,
    tiles: HashMap<String, Option<Vec<i16>>>,
}

impl SrtmReader {
    pub fn new(data_dir: PathBuf, db_path: PathBuf) -> Self {
        Self {
            data_dir,
            db_path,
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

    /// raw bytes → i16 배열 변환
    fn parse_hgt_bytes(bytes: &[u8]) -> Option<Vec<i16>> {
        if bytes.len() != TILE_BYTES {
            return None;
        }
        let mut data = Vec::with_capacity(SRTM1_SAMPLES * SRTM1_SAMPLES);
        for chunk in bytes.chunks_exact(2) {
            data.push(i16::from_be_bytes([chunk[0], chunk[1]]));
        }
        Some(data)
    }

    /// DB에서 타일 로드
    fn load_tile_from_db(&self, name: &str) -> Option<Vec<i16>> {
        let conn = rusqlite::Connection::open(&self.db_path).ok()?;
        let bytes: Vec<u8> = match crate::db::load_srtm_tile(&conn, name) {
            Ok(Some(b)) => b,
            _ => return None,
        };
        let data = Self::parse_hgt_bytes(&bytes)?;
        log::info!("[SRTM] Loaded tile from DB: {}", name);
        Some(data)
    }

    /// 파일에서 타일 로드 → 성공 시 DB에도 저장
    fn load_tile_from_file(&self, name: &str) -> Option<Vec<i16>> {
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
        // DB에 자동 저장 (파일→DB 마이그레이션)
        if let Ok(conn) = rusqlite::Connection::open(&self.db_path) {
            if let Err(e) = crate::db::save_srtm_tile(&conn, name, &bytes) {
                log::warn!("[SRTM] Failed to save tile {} to DB: {}", name, e);
            } else {
                log::info!("[SRTM] Migrated tile to DB: {}", name);
            }
        }
        let data = Self::parse_hgt_bytes(&bytes)?;
        log::info!("[SRTM] Loaded tile from file: {}", name);
        Some(data)
    }

    /// 타일 로드 (DB 우선 → 파일 폴백) + 실측 지반고 융합 머지
    /// 머지는 이 인메모리 배열에만 적용된다 — 원본 BLOB/파일은 불변.
    fn load_tile(&self, name: &str) -> Option<Vec<i16>> {
        let mut data = self
            .load_tile_from_db(name)
            .or_else(|| self.load_tile_from_file(name))?;
        self.apply_ground_corrections(name, &mut data);
        Some(data)
    }

    /// 실측 지반고 보정 적용 — DB 사이드카(`srtm_ground_corrections`)를 로드해 인메모리 머지.
    /// 보정이 없는 타일(대부분)은 즉시 반환하므로 비용이 없다. 실패는 비치명(원본 유지).
    fn apply_ground_corrections(&self, name: &str, data: &mut Vec<i16>) {
        let conn = match rusqlite::Connection::open(&self.db_path) {
            Ok(c) => c,
            Err(e) => {
                log::warn!("[SRTM] 지반고 보정 DB 열기 실패 ({}): {}", name, e);
                return;
            }
        };
        let corr = match crate::db::load_srtm_ground_corrections_for_tile(&conn, name) {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[SRTM] 지반고 보정 로드 실패 ({}): {}", name, e);
                return;
            }
        };
        if corr.is_empty() {
            return;
        }
        let applied = merge_ground_corrections(data, &corr);
        log::info!(
            "[SRTM] 지반고 융합 적용: {} — 보정노드 {} / 반영 {}셀",
            name,
            corr.len(),
            applied
        );
    }

    /// 인메모리 타일 캐시 비우기 — 지반고 보정 갱신/삭제 후 다음 조회가 다시 머지하도록 강제한다.
    /// (상쇄 불변식: 실측 임포트는 보정 확정 → clear_cache → SRTM 프리로드 순서를 지켜야 한다)
    pub fn clear_cache(&mut self) {
        self.tiles.clear();
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

        // 부동소수점 경계 케이스: 음수 인덱스 방어 (usize 캐스트 전 검사)
        if row_f < 0.0 || col_f < 0.0 || row_f >= (SRTM1_SAMPLES - 1) as f64 || col_f >= (SRTM1_SAMPLES - 1) as f64 {
            return Some(0.0);
        }
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

    /// 데이터 디렉토리 경로
    pub fn data_dir(&self) -> &Path {
        &self.data_dir
    }

    /// DB 경로
    pub fn db_path(&self) -> &Path {
        &self.db_path
    }

    /// Pre-load all SRTM tiles in the given coordinate range into memory cache
    pub fn preload_tiles(&mut self, min_lat: i32, max_lat: i32, min_lon: i32, max_lon: i32) {
        self.preload_tiles_with_progress(min_lat, max_lat, min_lon, max_lon, |_, _, _| {});
    }

    /// preload_tiles 의 진행 콜백 변형 — 타일 1개 처리마다 `on_tile(done, total, name)` 호출.
    /// 이미 캐시된 타일(로드 스킵)도 done 카운트에 포함해 진행률이 단조 증가하도록 한다.
    /// (기존 `preload_tiles` 시그니처는 다른 호출자들이 있어 그대로 두고 이 함수에 위임)
    pub fn preload_tiles_with_progress<F: FnMut(usize, usize, &str)>(
        &mut self,
        min_lat: i32,
        max_lat: i32,
        min_lon: i32,
        max_lon: i32,
        mut on_tile: F,
    ) {
        let lat_cnt = (max_lat - min_lat + 1).max(0) as usize;
        let lon_cnt = (max_lon - min_lon + 1).max(0) as usize;
        let total = lat_cnt * lon_cnt;
        let mut done: usize = 0;
        for lat in min_lat..=max_lat {
            for lon in min_lon..=max_lon {
                let name = Self::tile_name(lat, lon);
                if !self.tiles.contains_key(&name) {
                    let tile = self.load_tile(&name);
                    self.tiles.insert(name.clone(), tile);
                }
                done += 1;
                on_tile(done, total, &name);
            }
        }
    }

    /// Read-only access to loaded tiles (for parallel processing)
    pub fn tiles_ref(&self) -> &HashMap<String, Option<Vec<i16>>> {
        &self.tiles
    }
}

/// f64 표고 → i16 반올림 + 범위 클램프
#[inline]
fn clamp_i16(v: f64) -> i16 {
    v.round().clamp(i16::MIN as f64, i16::MAX as f64) as i16
}

/// 지반고 보정 머지 (순수 함수 — DB 비의존, 단위 테스트 대상)
///
/// `corr` = `(row, col, ground_msl)` 목록. 반환값은 실제로 값이 바뀐 셀 수(로그용).
///
/// 1. 보정 노드 자신: `delta = ground_msl − raw`. `|delta| > CORRECTION_DELTA_CLAMP_M` 이면 이상치로 폐기.
///    raw 가 void 면 delta 계산 없이 `ground_msl` 을 직접 기록(페더 기여 없음).
/// 2. 페더링: 체비쇼프 거리 d=1..FEATHER_RADIUS 이웃에 `w = 1 − d/3` 가중으로 delta 누적,
///    최종 이웃 delta = `acc / wsum.max(1)` (단일 영향원일 때 테이퍼가 살아 있도록 1 미만은 정규화하지 않음).
///    보정 노드 자신과 void 이웃에는 페더를 적용하지 않는다.
fn merge_ground_corrections(data: &mut [i16], corr: &[(u32, u32, f64)]) -> usize {
    let n = SRTM1_SAMPLES * SRTM1_SAMPLES;
    if data.len() != n || corr.is_empty() {
        return 0;
    }

    // 페더 누적 버퍼 (타일 전체 크기, 트랜지언트 — 머지 후 drop)
    let mut acc = vec![0.0f32; n];
    let mut wsum = vec![0.0f32; n];
    // 보정 노드 표식 — 이웃 페더가 정확한 값을 덮지 못하게 한다(이상치로 폐기된 노드 포함)
    let mut is_node = vec![false; n];
    // (인덱스, 확정 표고) — 페더 적용 뒤에 마지막으로 기록
    let mut exact: Vec<(usize, f64)> = Vec::with_capacity(corr.len());

    let fr = FEATHER_RADIUS as isize;
    for &(row, col, ground_msl) in corr {
        let (r, c) = (row as usize, col as usize);
        if r >= SRTM1_SAMPLES || c >= SRTM1_SAMPLES || !ground_msl.is_finite() {
            continue;
        }
        let i = r * SRTM1_SAMPLES + c;
        is_node[i] = true;
        let raw = data[i];

        // void 노드 — 원본이 결측이므로 델타 개념이 없다. 실측 지반고를 직접 기록하고 페더는 생략.
        if raw == VOID_VALUE {
            exact.push((i, ground_msl));
            continue;
        }

        let delta = ground_msl - raw as f64;
        if delta.abs() > CORRECTION_DELTA_CLAMP_M {
            continue; // 이상치 — 보정 폐기(원본 유지)
        }
        exact.push((i, raw as f64 + delta));

        // 이웃 페더 누적 (경계 계단 방지)
        for dr in -fr..=fr {
            for dc in -fr..=fr {
                let d = dr.abs().max(dc.abs());
                if d == 0 {
                    continue;
                }
                let (nr, nc) = (r as isize + dr, c as isize + dc);
                if nr < 0 || nc < 0 || nr >= SRTM1_SAMPLES as isize || nc >= SRTM1_SAMPLES as isize {
                    continue;
                }
                let ni = nr as usize * SRTM1_SAMPLES + nc as usize;
                let w = 1.0 - d as f32 / 3.0;
                acc[ni] += w * delta as f32;
                wsum[ni] += w;
            }
        }
    }

    let mut applied = 0usize;

    // ① 이웃 페더 적용 (보정 노드 자신·void 제외)
    for i in 0..n {
        if is_node[i] || wsum[i] <= 0.0 || data[i] == VOID_VALUE {
            continue;
        }
        let delta = acc[i] as f64 / wsum[i].max(1.0) as f64;
        let v = clamp_i16(data[i] as f64 + delta);
        if v != data[i] {
            data[i] = v;
            applied += 1;
        }
    }

    // ② 보정 노드 자신 — 정확한 값(페더보다 우선)
    for &(i, v) in &exact {
        let v = clamp_i16(v);
        if v != data[i] {
            data[i] = v;
            applied += 1;
        }
    }

    applied
}

/// Thread-safe elevation lookup from pre-loaded tiles (no mutation needed)
/// Used by rayon parallel iterators in coverage/panorama computation
pub fn elevation_from_tiles(tiles: &HashMap<String, Option<Vec<i16>>>, lat: f64, lon: f64) -> f64 {
    let tile_lat = lat.floor() as i32;
    let tile_lon = lon.floor() as i32;
    let name = SrtmReader::tile_name(tile_lat, tile_lon);

    let data = match tiles.get(&name) {
        Some(Some(d)) => d,
        _ => return 0.0,
    };

    let row_f = (tile_lat as f64 + 1.0 - lat) * (SRTM1_SAMPLES - 1) as f64;
    let col_f = (lon - tile_lon as f64) * (SRTM1_SAMPLES - 1) as f64;

    // 부동소수점 경계 케이스: 음수 인덱스 방어 (usize 캐스트 전 검사)
    if row_f < 0.0 || col_f < 0.0 || row_f >= (SRTM1_SAMPLES - 1) as f64 || col_f >= (SRTM1_SAMPLES - 1) as f64 {
        return 0.0;
    }
    let row = row_f.floor() as usize;
    let col = col_f.floor() as usize;

    if row >= SRTM1_SAMPLES - 1 || col >= SRTM1_SAMPLES - 1 {
        return 0.0;
    }

    let row_frac = row_f - row as f64;
    let col_frac = col_f - col as f64;

    let idx = |r: usize, c: usize| r * SRTM1_SAMPLES + c;
    let v00 = data[idx(row, col)] as f64;
    let v01 = data[idx(row, col + 1)] as f64;
    let v10 = data[idx(row + 1, col)] as f64;
    let v11 = data[idx(row + 1, col + 1)] as f64;

    if v00 == -32768.0 || v01 == -32768.0 || v10 == -32768.0 || v11 == -32768.0 {
        return 0.0;
    }

    let v0 = v00 + (v01 - v00) * col_frac;
    let v1 = v10 + (v11 - v10) * col_frac;
    (v0 + (v1 - v0) * row_frac).max(0.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 노드 (row, col) → 평면 인덱스
    fn idx(r: usize, c: usize) -> usize {
        r * SRTM1_SAMPLES + c
    }

    /// 균일값 타일 생성
    fn flat_tile(v: i16) -> Vec<i16> {
        vec![v; SRTM1_SAMPLES * SRTM1_SAMPLES]
    }

    /// 보정 노드 = 정확한 delta, 이웃 = 거리 가중 테이퍼(d=1: 2/3, d=2: 1/3), d=3 이상은 불변
    #[test]
    fn test_feathering_taper() {
        let mut data = flat_tile(100);
        merge_ground_corrections(&mut data, &[(1800, 1800, 110.0)]);

        assert_eq!(data[idx(1800, 1800)], 110); // 보정 노드 자신
        assert_eq!(data[idx(1800, 1801)], 107); // d=1 → 100 + 10*(2/3) = 106.67
        assert_eq!(data[idx(1799, 1799)], 107); // 체비쇼프 d=1 (대각)
        assert_eq!(data[idx(1800, 1802)], 103); // d=2 → 100 + 10*(1/3) = 103.33
        assert_eq!(data[idx(1798, 1798)], 103); // 체비쇼프 d=2 (대각)
        assert_eq!(data[idx(1800, 1803)], 100); // d=3 → 페더 범위 밖
    }

    /// 여러 보정원이 겹치는 이웃은 가중 평균으로 정규화 (delta 합산으로 부풀지 않음)
    #[test]
    fn test_feathering_multi_source_normalized() {
        let mut data = flat_tile(100);
        merge_ground_corrections(&mut data, &[(1800, 1800, 110.0), (1800, 1802, 110.0)]);

        // 양쪽에서 d=1 → wsum = 4/3 > 1 → delta = (2/3*10 + 2/3*10) / (4/3) = 10
        assert_eq!(data[idx(1800, 1801)], 110);
    }

    /// |delta| > 30m 는 이상치 — 노드·이웃 모두 원본 유지
    #[test]
    fn test_delta_clamp_rejects_outlier() {
        let mut data = flat_tile(100);
        let applied = merge_ground_corrections(&mut data, &[(1800, 1800, 200.0)]);

        assert_eq!(applied, 0);
        assert_eq!(data[idx(1800, 1800)], 100);
        assert_eq!(data[idx(1800, 1801)], 100);
    }

    /// void 노드는 실측 지반고를 직접 기록하고, 이웃에 페더를 흘리지 않는다
    #[test]
    fn test_void_node_direct_write_no_feather() {
        let mut data = flat_tile(100);
        data[idx(1800, 1800)] = VOID_VALUE;
        merge_ground_corrections(&mut data, &[(1800, 1800, 55.0)]);

        assert_eq!(data[idx(1800, 1800)], 55);
        assert_eq!(data[idx(1800, 1801)], 100); // 페더 기여 없음
    }

    /// void 이웃에는 페더를 적용하지 않는다 (결측 센티널 보존)
    #[test]
    fn test_void_neighbor_not_feathered() {
        let mut data = flat_tile(100);
        data[idx(1800, 1801)] = VOID_VALUE;
        merge_ground_corrections(&mut data, &[(1800, 1800, 110.0)]);

        assert_eq!(data[idx(1800, 1800)], 110);
        assert_eq!(data[idx(1800, 1801)], VOID_VALUE);
        assert_eq!(data[idx(1800, 1799)], 107);
    }

    /// void 노드 직접 기록도 i16 범위로 클램프
    #[test]
    fn test_void_write_clamped_to_i16() {
        let mut data = flat_tile(100);
        data[idx(10, 10)] = VOID_VALUE;
        merge_ground_corrections(&mut data, &[(10, 10, 40_000.0)]);

        assert_eq!(data[idx(10, 10)], i16::MAX);
    }

    /// 타일 경계 노드(0 / 3600)도 인덱스 이탈 없이 처리 + 범위 밖 노드는 무시
    #[test]
    fn test_edge_nodes_and_out_of_range() {
        let mut data = flat_tile(100);
        merge_ground_corrections(
            &mut data,
            &[(0, 0, 110.0), (3600, 3600, 110.0), (9999, 0, 110.0)],
        );

        assert_eq!(data[idx(0, 0)], 110);
        assert_eq!(data[idx(0, 1)], 107);
        assert_eq!(data[idx(3600, 3600)], 110);
        assert_eq!(data[idx(3599, 3599)], 107);
    }
}
