//! 실측 3D 건물(1m DSM) 임포트
//!
//! 항공 라이다 기반 1m DSM 에서 추출한 실측 건물 박스(`buildings_3d.bin`)를 읽어
//! ① 기존 건물통합정보(fac_buildings) 행에 실측 지붕고를 `height_measured` 로 반영하고,
//! ② GIS 대장에 없는 건물은 region='실측3D' 신규 행으로 추가하며,
//! ③ 박스의 기저부 최저 표면고(minH)로 SRTM 지반고 융합 보정을 생성한다(srtm.rs 가 로드 시 머지).
//! 선정리(clear_measured) 후 전량 재적용하므로 재실행은 멱등(idempotent).
//!
//! ## buildings_3d.bin 레이아웃
//! ```text
//! offset 0  : u32 LE = jsonLen
//! 4         : JSON 메타 (utf8, jsonLen 바이트)
//!             { count, fields, cellM, gridMax, gridBytes, namesBytes, region:[minLon,minLat,maxLon,maxLat] }
//! 4+jsonLen : f32 LE × count×6 — [minLon, minLat, maxLon, maxLat, minH, maxH] (경도 먼저, 높이 MSL m)
//! 그다음    : u32 LE × count×3 — [gridW, gridH, gridOffset]  (v1 미사용 — seek 스킵)
//! 그다음    : u8  × gridBytes  — 건물별 지붕고 래스터        (v1 미사용 — seek 스킵)
//! 그다음    : names JSON (utf8, namesBytes 바이트) — 문자열 배열 count개 (빈 문자열 다수)
//! ```

use std::collections::{HashMap, HashSet};
use std::io::{BufReader, Read, Seek, SeekFrom};

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::building::today_yyyymm;
use crate::srtm::SrtmReader;

/// 실측 임포트 전용 region 태그 (선정리·신규행 식별자)
const MEASURED_REGION: &str = "실측3D";

/// 유효 건물 최소 높이 (m) — 지반고 대비 이보다 낮으면 노이즈로 간주하고 스킵
const MIN_HEIGHT_M: f64 = 0.5;

/// bbox 매칭 판정 임계 — 교차면적 / min(실측, 후보) 면적
const MATCH_AREA_RATIO: f64 = 0.3;

/// 매칭 정합 게이트: hm 이 대장고 대비 이보다 크게 낮으면 오매칭(부분 블롭)으로 보고 매칭 기각
pub(crate) const HM_SANITY_ABS_GAP_M: f64 = 20.0;
pub(crate) const HM_SANITY_RATIO: f64 = 0.5;

/// 실측 높이 상한 — building.rs/bra.rs 의 MAX_BUILDING_HEIGHT_M(650) 과 동일값 유지
pub(crate) const MEASURED_MAX_HEIGHT_M: f64 = 650.0;

/// 실측 신규행 최소 bbox 면적 (m²) — 1m DSM 노이즈(수목/컨테이너 조각) 행 생성 방지
pub(crate) const MIN_BLOB_AREA_M2: f64 = 4.0;

/// 위도 1° 당 미터 (bbox 면적 평면 근사) — analysis/coverage.rs 와 동일 상수
const DEG_LAT_M: f64 = 111_320.0;

/// 후보 버킷 셀 크기 (deg) — 약 111m(위도) × 88m(경도)
const CELL_DEG: f64 = 0.001;

/// 커밋/진행률 배치 단위
const BATCH_SIZE: usize = 10_000;

/// 건물 수 상한 (형식 검증용)
const MAX_BUILDING_COUNT: usize = 5_000_000;

/// bbox 가 걸치는 셀 축당 최대 개수 (비정상 bbox 방어)
const MAX_CELL_SPAN: i32 = 256;

/// SRTM 1-arcsec 타일의 노드 간격 수 (노드 인덱스 0..=3600)
const SRTM_NODE_SPAN: f64 = 3600.0;

/// 지반고 표본 유효 범위 (m, MSL) — 한반도 지형 + 해수면 여유. 벗어나면 그 표본만 폐기.
const GROUND_SAMPLE_MIN_M: f64 = -10.0;
const GROUND_SAMPLE_MAX_M: f64 = 2500.0;

/// 임포트 진행률 이벤트
#[derive(Clone, Serialize)]
pub struct MeasuredImportProgress {
    pub total: usize,
    pub processed: usize,
    pub status: String,
}

/// 임포트 결과 요약
/// `total = matched + inserted + skipped` (실측 건물 단위 집계).
/// matched 는 '실측 건물' 기준이라 한 GIS 건물에 여러 실측 박스가 매칭되면
/// 실제 UPDATE 행 수보다 클 수 있다(최대값 1건만 반영).
#[derive(Serialize)]
pub struct MeasuredImportSummary {
    pub total: usize,
    pub matched: usize,
    pub inserted: usize,
    pub skipped: usize,
    /// 지반고 융합 보정이 생성된 SRTM 노드 수 (건물 집계 total 과 무관한 별도 축)
    pub corrected_cells: usize,
}

/// bin 파싱 결과 (grid 래스터는 v1 미사용이라 로드하지 않음)
struct MeasuredBin {
    count: usize,
    /// [min_lon, min_lat, max_lon, max_lat]
    region: [f64; 4],
    /// count×6 f32 — [minLon, minLat, maxLon, maxLat, minH, maxH]
    boxes: Vec<f32>,
    /// 건물명 (없으면 빈 문자열, 길이가 count 와 다를 수 있어 get() 으로 접근)
    names: Vec<String>,
}

/// 매칭 후보 (기존 fac_buildings 행)
struct Candidate {
    id: i64,
    min_lat: f64,
    min_lon: f64,
    max_lat: f64,
    max_lon: f64,
    centroid_lat: f64,
    centroid_lon: f64,
    /// 대장고 (fac_buildings.height) — 매칭 정합 게이트(hm_match_sane) 비교 기준
    height: f64,
}

/// 좌표를 버킷 셀 인덱스로 변환
#[inline]
fn cell_of(lat: f64, lon: f64) -> (i32, i32) {
    ((lat / CELL_DEG).floor() as i32, (lon / CELL_DEG).floor() as i32)
}

/// 매칭된 실측고가 대장고 대비 정합한가 — 오매칭(부분 블롭) 판별.
///
/// bbox 30% 교차 매칭은 대형 건물의 일부만 덮는 오분할 블롭도 같은 건물로 인정해 버린다.
/// 그 블롭의 낮은 지붕고가 `height_measured` 로 들어가면 조회부의 COALESCE 가 대장고를
/// 무검증 하향시켜(예: 117m → 32.7m) 건물이 BRA/LoS 에서 통째로 사라진다.
/// `register_h ≤ 0`(대장고 없음)이면 비교 불가로 통과.
pub(crate) fn hm_match_sane(register_h: f64, hm: f64) -> bool {
    !(register_h > 0.0
        && (register_h - hm) > HM_SANITY_ABS_GAP_M
        && hm < register_h * HM_SANITY_RATIO)
}

/// bbox 의 평면 근사 면적 (m²) — 위도 코사인 반영
#[inline]
fn bbox_area_m2(min_lat: f64, min_lon: f64, max_lat: f64, max_lon: f64) -> f64 {
    let cos_lat = ((min_lat + max_lat) / 2.0).to_radians().cos().abs();
    let h_m = (max_lat - min_lat) * DEG_LAT_M;
    let w_m = (max_lon - min_lon) * DEG_LAT_M * cos_lat;
    h_m * w_m
}

/// 한반도 주변 좌표 도메인 검증 (lat 25~50, lon 115~145)
#[inline]
fn in_domain(lat: f64, lon: f64) -> bool {
    lat.is_finite() && lon.is_finite() && (25.0..=50.0).contains(&lat) && (115.0..=145.0).contains(&lon)
}

/// buildings_3d.bin 파싱 — 헤더/크기/좌표 도메인 검증 포함
fn parse_bin(bin_path: &str) -> Result<MeasuredBin, String> {
    let file = std::fs::File::open(bin_path)
        .map_err(|e| format!("실측 건물 파일 열기 실패: {}", e))?;
    let file_len = file
        .metadata()
        .map_err(|e| format!("실측 건물 파일 정보 읽기 실패: {}", e))?
        .len();
    let mut reader = BufReader::new(file);

    // ── 헤더: jsonLen + JSON 메타 ──
    let mut len_buf = [0u8; 4];
    reader
        .read_exact(&mut len_buf)
        .map_err(|_| "buildings_3d.bin 형식이 아닙니다 (헤더 없음)".to_string())?;
    let json_len = u32::from_le_bytes(len_buf) as usize;
    if json_len == 0 || json_len > 1_048_576 || (4 + json_len) as u64 > file_len {
        return Err("buildings_3d.bin 형식이 아닙니다 (메타 길이 이상)".to_string());
    }

    let mut json_buf = vec![0u8; json_len];
    reader
        .read_exact(&mut json_buf)
        .map_err(|_| "buildings_3d.bin 형식이 아닙니다 (메타 읽기 실패)".to_string())?;
    let meta: serde_json::Value = serde_json::from_slice(&json_buf)
        .map_err(|_| "buildings_3d.bin 형식이 아닙니다 (메타 JSON 파싱 실패)".to_string())?;

    let count = meta
        .get("count")
        .and_then(|v| v.as_u64())
        .ok_or_else(|| "buildings_3d.bin 형식이 아닙니다 (count 없음)".to_string())?
        as usize;
    if count == 0 || count > MAX_BUILDING_COUNT {
        return Err(format!(
            "buildings_3d.bin 형식이 아닙니다 (건물 수 이상: {})",
            count
        ));
    }

    let region_arr = meta
        .get("region")
        .and_then(|v| v.as_array())
        .ok_or_else(|| "buildings_3d.bin 형식이 아닙니다 (region 없음)".to_string())?;
    if region_arr.len() != 4 {
        return Err("buildings_3d.bin 형식이 아닙니다 (region 길이 이상)".to_string());
    }
    let mut region = [0.0f64; 4];
    for (i, v) in region_arr.iter().enumerate() {
        region[i] = v
            .as_f64()
            .ok_or_else(|| "buildings_3d.bin 형식이 아닙니다 (region 값 이상)".to_string())?;
    }
    // region = [min_lon, min_lat, max_lon, max_lat]
    if !in_domain(region[1], region[0])
        || !in_domain(region[3], region[2])
        || region[0] >= region[2]
        || region[1] >= region[3]
    {
        return Err("buildings_3d.bin 형식이 아닙니다 (좌표 범위가 동아시아 밖)".to_string());
    }

    let grid_bytes = meta.get("gridBytes").and_then(|v| v.as_u64()).unwrap_or(0);
    let names_bytes = meta.get("namesBytes").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

    // 전체 크기 검증 (헤더 + boxes + gridMeta + grid + names)
    let boxes_bytes = (count as u64) * 6 * 4;
    let gridmeta_bytes = (count as u64) * 3 * 4;
    let expected = 4 + json_len as u64 + boxes_bytes + gridmeta_bytes + grid_bytes + names_bytes as u64;
    if file_len < expected {
        return Err(format!(
            "buildings_3d.bin 형식이 아닙니다 (파일 크기 부족: {}바이트, 최소 {}바이트 필요)",
            file_len, expected
        ));
    }

    // ── boxes: f32 LE × count×6 ──
    let mut raw = vec![0u8; boxes_bytes as usize];
    reader
        .read_exact(&mut raw)
        .map_err(|e| format!("실측 건물 박스 읽기 실패: {}", e))?;
    let mut boxes: Vec<f32> = Vec::with_capacity(count * 6);
    for chunk in raw.chunks_exact(4) {
        boxes.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }
    drop(raw);

    // ── gridMeta + grid: v1 미사용 → seek 스킵 ──
    reader
        .seek(SeekFrom::Current((gridmeta_bytes + grid_bytes) as i64))
        .map_err(|e| format!("실측 건물 래스터 스킵 실패: {}", e))?;

    // ── names JSON (실패해도 치명적이지 않음 — 이름 없이 진행) ──
    let mut names: Vec<String> = Vec::new();
    if names_bytes > 0 {
        let mut nbuf = vec![0u8; names_bytes];
        if reader.read_exact(&mut nbuf).is_ok() {
            match serde_json::from_slice::<Vec<String>>(&nbuf) {
                Ok(v) => names = v,
                Err(e) => log::warn!("[실측3D] 건물명 JSON 파싱 실패(이름 없이 진행): {}", e),
            }
        } else {
            log::warn!("[실측3D] 건물명 블록 읽기 실패 — 이름 없이 진행");
        }
    }

    Ok(MeasuredBin {
        count,
        region,
        boxes,
        names,
    })
}

/// 매칭 후보(기존 fac_buildings) 로드 — 실측 region bbox 내, 실측 신규행 제외.
/// region 경계에 걸친 건물은 GIS centroid 가 bbox 밖일 수 있으므로 마진(~1km)을 더해
/// 경계 중복 신규행(동일 건물이 매칭 실패로 '실측3D' 행으로 이중 등록)을 방지한다.
fn load_candidates(conn: &Connection, region: &[f64; 4]) -> Result<Vec<Candidate>, String> {
    const MARGIN_DEG: f64 = 0.01;
    let mut stmt = conn
        .prepare(
            "SELECT id, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon, centroid_lat, centroid_lon, height
             FROM fac_buildings
             WHERE centroid_lat BETWEEN ?1 AND ?2
               AND centroid_lon BETWEEN ?3 AND ?4
               AND region <> ?5",
        )
        .map_err(|e| format!("후보 쿼리 준비 실패: {}", e))?;

    let rows = stmt
        .query_map(
            params![
                region[1] - MARGIN_DEG,
                region[3] + MARGIN_DEG,
                region[0] - MARGIN_DEG,
                region[2] + MARGIN_DEG,
                MEASURED_REGION
            ],
            |row| {
                Ok(Candidate {
                    id: row.get(0)?,
                    min_lat: row.get(1)?,
                    min_lon: row.get(2)?,
                    max_lat: row.get(3)?,
                    max_lon: row.get(4)?,
                    centroid_lat: row.get(5)?,
                    centroid_lon: row.get(6)?,
                    height: row.get(7)?,
                })
            },
        )
        .map_err(|e| format!("후보 쿼리 실행 실패: {}", e))?;

    let mut cands = Vec::new();
    for r in rows {
        cands.push(r.map_err(|e| format!("후보 행 읽기 실패: {}", e))?);
    }
    Ok(cands)
}

/// bbox 사각형 폴리곤 JSON — 저장 포맷은 fac_building.rs 와 동일한 [[lat,lon],...] 폐곡 링
fn bbox_polygon_json(min_lat: f64, min_lon: f64, max_lat: f64, max_lon: f64) -> String {
    let ring: Vec<[f64; 2]> = vec![
        [min_lat, min_lon],
        [min_lat, max_lon],
        [max_lat, max_lon],
        [max_lat, min_lon],
        [min_lat, min_lon],
    ];
    serde_json::to_string(&ring).unwrap_or_else(|_| "[]".to_string())
}

/// SRTM 지반고 융합 보정 생성 — 실측 박스의 기저부 최저 표면고(minH)를 HGT 노드별로 모아
/// 중앙값을 **절대 MSL** 로 `srtm_ground_corrections` 에 적재한다. 반환값 = 보정 노드 수.
///
/// 30m SRTM 은 도심에서 건물고가 섞인 DSM 편향을 갖는데, 1m DSM 의 건물 기저부는
/// 실제 지반에 가까우므로 이를 노드별 중앙값(이상치에 강함)으로 대표시킨다.
/// 델타가 아닌 절대 MSL 을 저장해야 SRTM 재다운로드 후에도 재계산 없이 자동 재적용된다.
///
/// **호출 시점 불변식**: SRTM 프리로드·건물 높이 계산(maxH − liveSRTM) **이전**에 완료하고
/// 리더 캐시를 클리어해야, 같은 임포트 안에서 계산되는 실측 높이가 보정된 지반고를 쓴다.
/// 다운샘플링 없이 전 박스를 순회한다.
fn build_ground_corrections(
    conn: &Connection,
    bin: &MeasuredBin,
    progress_fn: &dyn Fn(MeasuredImportProgress),
) -> Result<usize, String> {
    let count = bin.count;
    progress_fn(MeasuredImportProgress {
        total: count,
        processed: 0,
        status: "지반고 융합 보정 계산 중...".to_string(),
    });

    // 노드별 minH 표본 수집 (키 = 타일명 + HGT 노드 인덱스)
    let mut samples: HashMap<(String, u32, u32), Vec<f32>> = HashMap::new();
    let mut sampled = 0usize;

    for i in 0..count {
        if i > 0 && i % BATCH_SIZE == 0 {
            progress_fn(MeasuredImportProgress {
                total: count,
                processed: i,
                status: format!("지반고 융합 보정 계산 중... {}/{} (표본 {})", i, count, sampled),
            });
        }

        let b = &bin.boxes[i * 6..i * 6 + 6];
        let (m_min_lon, m_min_lat, m_max_lon, m_max_lat, min_h, max_h) = (
            b[0] as f64,
            b[1] as f64,
            b[2] as f64,
            b[3] as f64,
            b[4] as f64,
            b[5] as f64,
        );
        let clat = (m_min_lat + m_max_lat) / 2.0;
        let clon = (m_min_lon + m_max_lon) / 2.0;

        // 표본 위생 — 불통과 시 이 표본만 버리고 임포트는 계속 진행
        if !min_h.is_finite()
            || !(GROUND_SAMPLE_MIN_M..=GROUND_SAMPLE_MAX_M).contains(&min_h)
            || !(min_h <= max_h)
            || !in_domain(clat, clon)
        {
            continue;
        }

        // 최근접 HGT 노드 배정 (row 0 = 북단, col 0 = 서단, 0..=3600)
        let tile_lat = clat.floor();
        let tile_lon = clon.floor();
        let row_f = ((tile_lat + 1.0 - clat) * SRTM_NODE_SPAN).round();
        let col_f = ((clon - tile_lon) * SRTM_NODE_SPAN).round();
        // 반올림이 타일 경계를 넘으면(음수/3601 이상) 이웃 타일 노드가 되므로 클램프 없이 스킵
        if !(0.0..=SRTM_NODE_SPAN).contains(&row_f) || !(0.0..=SRTM_NODE_SPAN).contains(&col_f) {
            continue;
        }

        let name = SrtmReader::tile_name(tile_lat as i32, tile_lon as i32);
        samples
            .entry((name, row_f as u32, col_f as u32))
            .or_default()
            .push(min_h as f32);
        sampled += 1;
    }

    // 노드별 중앙값 → 영속화 행
    let mut rows: Vec<(String, u32, u32, f64, u32)> = Vec::with_capacity(samples.len());
    for ((name, row, col), mut vals) in samples.into_iter() {
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = vals.len();
        let median = if n % 2 == 1 {
            vals[n / 2] as f64
        } else {
            (vals[n / 2 - 1] as f64 + vals[n / 2] as f64) / 2.0
        };
        rows.push((name, row, col, median, n as u32));
    }

    crate::db::replace_srtm_ground_corrections(conn, &rows)
        .map_err(|e| format!("지반고 보정 저장 실패: {}", e))?;

    log::info!(
        "[실측3D] 지반고 융합 보정 {}노드 (표본 {}동 / 전체 {}동)",
        rows.len(),
        sampled,
        count
    );
    Ok(rows.len())
}

/// 실측 3D 건물(1m DSM) bin 임포트
///
/// 1) bin 파싱 → 2) 선정리(멱등) → 3) SRTM 지반고 융합 보정 생성 + 리더 캐시 클리어 →
/// 4) SRTM 프리로드(보정 반영본) → 5) 후보 그리드 버킷 →
/// 6) 실측 건물별 bbox 최대교차 매칭(UPDATE) / 미매칭 신규 INSERT → 7) import_log 기록
pub fn import_from_bin(
    conn: &Connection,
    srtm: &mut SrtmReader,
    bin_path: &str,
    progress_fn: &dyn Fn(MeasuredImportProgress),
) -> Result<MeasuredImportSummary, String> {
    progress_fn(MeasuredImportProgress {
        total: 0,
        processed: 0,
        status: "실측 건물 파일 로딩 중...".to_string(),
    });

    // ① bin 파싱 (박스 + 이름만 메모리 로드, 래스터는 스킵)
    //    — 파싱 성공을 확인한 뒤에 선정리해야 잘못된 파일 선택 시 기존 실측 데이터가 보존됨
    let bin = parse_bin(bin_path)?;

    progress_fn(MeasuredImportProgress {
        total: 0,
        processed: 0,
        status: "이전 실측 데이터 정리 중...".to_string(),
    });

    // ② 선정리 — 재실행 멱등성 확보
    clear_measured(conn)?;
    let count = bin.count;
    log::info!(
        "[실측3D] {}동 로드 (region {:?})",
        count,
        bin.region
    );

    // ③ SRTM 지반고 융합 보정 생성 (건물 높이 계산 이전에 확정해야 상쇄 불변식 유지)
    //    보정은 원본 srtm_tiles BLOB 을 건드리지 않고 사이드카 테이블에만 쌓이므로,
    //    리더 캐시를 비워 이후 프리로드가 보정 머지된 타일을 다시 읽게 한다.
    let corrected_cells = build_ground_corrections(conn, &bin, progress_fn)?;
    srtm.clear_cache();

    // ④ SRTM 타일 프리로드 — 매칭/신규 모두 live SRTM 지반고를 쓰므로 미리 캐시
    srtm.preload_tiles(
        bin.region[1].floor() as i32,
        bin.region[3].floor() as i32,
        bin.region[0].floor() as i32,
        bin.region[2].floor() as i32,
    );

    progress_fn(MeasuredImportProgress {
        total: count,
        processed: 0,
        status: "기존 건물 후보 로딩 중...".to_string(),
    });

    // ⑤ 후보 인메모리 로드 + 0.001° 셀 버킷 (bbox 가 걸치는 셀 전부 등록)
    let cands = load_candidates(conn, &bin.region)?;
    let mut buckets: HashMap<(i32, i32), Vec<usize>> = HashMap::new();
    for (idx, c) in cands.iter().enumerate() {
        if !in_domain(c.centroid_lat, c.centroid_lon) {
            continue;
        }
        let (r0, c0) = cell_of(c.min_lat.min(c.max_lat), c.min_lon.min(c.max_lon));
        let (r1, c1) = cell_of(c.max_lat.max(c.min_lat), c.max_lon.max(c.min_lon));
        if r1 - r0 > MAX_CELL_SPAN || c1 - c0 > MAX_CELL_SPAN {
            // 비정상 bbox — centroid 셀에만 등록
            let key = cell_of(c.centroid_lat, c.centroid_lon);
            buckets.entry(key).or_default().push(idx);
            continue;
        }
        for r in r0..=r1 {
            for cc in c0..=c1 {
                buckets.entry((r, cc)).or_default().push(idx);
            }
        }
    }
    log::info!("[실측3D] 매칭 후보 {}동 / 버킷 {}셀", cands.len(), buckets.len());

    // ⑥ 스캔 — 매칭(최대값 유지) / 미매칭 신규 INSERT
    let mut height_map: HashMap<i64, f64> = HashMap::new();
    let mut matched = 0usize;
    let mut inserted = 0usize;
    let mut skipped = 0usize;
    // 매칭 후보는 있었으나 정합 게이트에서 기각된 블롭 수 (요약 로그 전용 — ImportSummary 불변)
    let mut rejected = 0usize;

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let mut ins = conn
        .prepare(
            "INSERT INTO fac_buildings (region, centroid_lat, centroid_lon, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon, height, building_name, dong_name, usability, pnu, bd_mgt_sn, polygon_json, ground_elev, height_measured)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
        )
        .map_err(|e| format!("INSERT 준비 실패: {}", e))?;

    let loop_result: Result<(), String> = (|| {
        let mut seen: HashSet<usize> = HashSet::new();

        for i in 0..count {
            // 진행률 + 주기적 커밋
            if i > 0 && i % BATCH_SIZE == 0 {
                conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
                progress_fn(MeasuredImportProgress {
                    total: count,
                    processed: i,
                    status: format!(
                        "실측 건물 매칭 중... {}/{} (반영 {} · 신규 {})",
                        i, count, matched, inserted
                    ),
                });
            }

            let b = &bin.boxes[i * 6..i * 6 + 6];
            let (m_min_lon, m_min_lat, m_max_lon, m_max_lat, max_h) =
                (b[0] as f64, b[1] as f64, b[2] as f64, b[3] as f64, b[5] as f64);

            // 좌표/높이 위생 검사
            if !in_domain(m_min_lat, m_min_lon)
                || !in_domain(m_max_lat, m_max_lon)
                || m_min_lon >= m_max_lon
                || m_min_lat >= m_max_lat
                || !max_h.is_finite()
            {
                skipped += 1;
                continue;
            }

            let m_area = (m_max_lon - m_min_lon) * (m_max_lat - m_min_lat);

            // 교차면적 최대 후보 탐색
            let (r0, c0) = cell_of(m_min_lat, m_min_lon);
            let (r1, c1) = cell_of(m_max_lat, m_max_lon);
            seen.clear();
            let mut best: Option<(f64, usize)> = None; // (교차면적, 후보 idx)
            if r1 - r0 <= MAX_CELL_SPAN && c1 - c0 <= MAX_CELL_SPAN {
                for r in r0..=r1 {
                    for cc in c0..=c1 {
                        let list = match buckets.get(&(r, cc)) {
                            Some(l) => l,
                            None => continue,
                        };
                        for &ci in list {
                            if !seen.insert(ci) {
                                continue;
                            }
                            let cand = &cands[ci];
                            let ow = (m_max_lon.min(cand.max_lon) - m_min_lon.max(cand.min_lon)).max(0.0);
                            let oh = (m_max_lat.min(cand.max_lat) - m_min_lat.max(cand.min_lat)).max(0.0);
                            let inter = ow * oh;
                            if inter <= 0.0 {
                                continue;
                            }
                            let c_area =
                                (cand.max_lon - cand.min_lon).max(0.0) * (cand.max_lat - cand.min_lat).max(0.0);
                            // 교차면적이 작은 쪽 면적의 30% 이상이어야 동일 건물로 인정
                            if inter < MATCH_AREA_RATIO * m_area.min(c_area) {
                                continue;
                            }
                            if best.as_ref().map_or(true, |(ba, _)| inter > *ba) {
                                best = Some((inter, ci));
                            }
                        }
                    }
                }
            }

            // ── 매칭 정합 게이트 — 통과분만 대장 행 반영 대상(accepted) 으로 승격 ──
            // 기각된 블롭은 아래 미매칭 경로로 흘려보낸다. 낮은 부분 블롭도 실물이므로
            // 자체 '실측3D' 행으로 존재하는 것이 정답이고, 높이 조건 억제(suppression.rs)가
            // 그 행이 고층 대장 행을 죽이지 못하게 막는다.
            let mut accepted: Option<(i64, f64)> = None; // (fac 행 id, 실측 지붕고)
            if let Some((_, ci)) = best {
                let cand = &cands[ci];
                // 지반고 = centroid SRTM(live). ground_elev 캐시 컬럼은 미백필 행이 많아 사용 금지(프로젝트 불변식).
                let ground = srtm
                    .get_elevation(cand.centroid_lat, cand.centroid_lon)
                    .unwrap_or(0.0);
                let hm = max_h - ground;
                if hm.is_finite()
                    && hm >= MIN_HEIGHT_M
                    && hm <= MEASURED_MAX_HEIGHT_M
                    && hm_match_sane(cand.height, hm)
                {
                    accepted = Some((cand.id, hm));
                } else {
                    rejected += 1;
                }
            }

            match accepted {
                // ── 매칭: 기존 GIS 건물에 실측 지붕고 반영 ──
                Some((cand_id, hm)) => {
                    // 한 GIS 건물에 여러 실측 박스가 겹칠 수 있으므로 최대값 유지
                    // (게이트 통과분만 여기 도달하므로 최대값도 정합 검증을 거친 값이다)
                    let e = height_map.entry(cand_id).or_insert(hm);
                    if hm > *e {
                        *e = hm;
                    }
                    matched += 1;
                }
                // ── 미매칭(또는 매칭 기각): GIS 대장에 없는 건물 → 신규 행 ──
                None => {
                    let clat = (m_min_lat + m_max_lat) / 2.0;
                    let clon = (m_min_lon + m_max_lon) / 2.0;
                    let ground = srtm.get_elevation(clat, clon).unwrap_or(0.0);
                    let h = max_h - ground;
                    // 높이 하한·상한 컷 — 상한 초과는 DSM 잡음(전파탑 스파이크 등)으로 본다
                    if h < MIN_HEIGHT_M || h > MEASURED_MAX_HEIGHT_M {
                        skipped += 1;
                        continue;
                    }
                    // 면적 컷 — 1m DSM 의 수목/컨테이너 조각이 건물 행으로 승격되는 것 방지
                    if bbox_area_m2(m_min_lat, m_min_lon, m_max_lat, m_max_lon) < MIN_BLOB_AREA_M2 {
                        skipped += 1;
                        continue;
                    }
                    let name: Option<String> = bin
                        .names
                        .get(i)
                        .map(|s| s.trim().to_string())
                        .filter(|s| !s.is_empty());
                    let polygon_json = bbox_polygon_json(m_min_lat, m_min_lon, m_max_lat, m_max_lon);

                    ins.execute(params![
                        MEASURED_REGION,
                        clat,
                        clon,
                        m_min_lat,
                        m_min_lon,
                        m_max_lat,
                        m_max_lon,
                        h,
                        name,
                        None::<String>,
                        // usability(용도)는 NULL — 실측 표기를 용도로 오염시키지 않는다
                        // (실측 여부는 height_measured 로 판별, 팝업엔 '실측자료' 항목으로 별도 표시)
                        None::<String>,
                        None::<String>,
                        None::<String>,
                        polygon_json,
                        ground,
                        h,
                    ])
                    .map_err(|e| format!("INSERT 실패: {}", e))?;
                    inserted += 1;
                }
            }
        }
        Ok(())
    })();

    if let Err(e) = loop_result {
        drop(ins);
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e);
    }
    drop(ins);

    // ⑦ 매칭분 일괄 UPDATE (같은 트랜잭션 흐름 안에서 배치 커밋)
    progress_fn(MeasuredImportProgress {
        total: count,
        processed: count,
        status: format!("실측 지붕고 반영 중... {}동", height_map.len()),
    });

    let update_result: Result<usize, String> = (|| {
        let mut upd = conn
            .prepare("UPDATE fac_buildings SET height_measured = ?1 WHERE id = ?2")
            .map_err(|e| format!("UPDATE 준비 실패: {}", e))?;
        let mut n = 0usize;
        for (id, h) in height_map.iter() {
            upd.execute(params![h, id])
                .map_err(|e| format!("UPDATE 실패: {}", e))?;
            n += 1;
            if n % BATCH_SIZE == 0 {
                conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
                progress_fn(MeasuredImportProgress {
                    total: count,
                    processed: count,
                    status: format!("실측 지붕고 반영 중... {}/{}동", n, height_map.len()),
                });
            }
        }
        Ok(n)
    })();

    let updated = match update_result {
        Ok(n) => n,
        Err(e) => {
            let _ = conn.execute_batch("ROLLBACK");
            return Err(e);
        }
    };
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

    // ⑧ 임포트 로그
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO fac_building_import_log (region, file_date, imported_at, record_count)
         VALUES (?1, ?2, ?3, ?4)",
        params![MEASURED_REGION, today_yyyymm(), now, (matched + inserted) as i64],
    )
    .map_err(|e| format!("임포트 로그 저장 실패: {}", e))?;

    log::info!(
        "[실측3D] 완료 — 총 {} · 매칭 {}(UPDATE {}행) · 신규 {} · 스킵 {} · 매칭기각 {}(정합 게이트 → 신규행 경로)",
        count, matched, updated, inserted, skipped, rejected
    );

    // ⑨ 우선순위 중복 억제 재계산 — region 전역(+여유). 새로 들어온 실측 행이 덮는 대장 행을
    //    'measured:<fac_id>' 로, 수동 건물이 덮는 행을 'manual:<id>' 로 확정한다.
    //    실패는 비치명 — 임포트 자체는 성공으로 유지(다음 등록/백필에서 재확정).
    //    region = [min_lon, min_lat, max_lon, max_lat] (parse_bin 규약)
    {
        let m = crate::suppression::AREA_MARGIN_DEG;
        progress_fn(MeasuredImportProgress {
            total: count,
            processed: count,
            status: "중복 건물 정리 중...".to_string(),
        });
        match crate::suppression::recompute_area(
            conn,
            bin.region[1] - m,
            bin.region[3] + m,
            bin.region[0] - m,
            bin.region[2] + m,
        ) {
            Ok((s, c)) => log::info!("[실측3D] 중복억제 재계산 — 억제 {}행 · 해제 {}행", s, c),
            Err(e) => log::warn!("[실측3D] 중복억제 재계산 실패: {}", e),
        }
    }

    progress_fn(MeasuredImportProgress {
        total: count,
        processed: count,
        status: format!(
            "완료: 총 {}동 중 실측 반영 {}동 · 신규 {}동 · 제외 {}동",
            count, matched, inserted, skipped
        ),
    });

    Ok(MeasuredImportSummary {
        total: count,
        matched,
        inserted,
        skipped,
        corrected_cells,
    })
}

/// 실측(1m DSM) 데이터가 덮는 커버리지 bbox — 반환 순서 `[min_lat, max_lat, min_lon, max_lon]`.
///
/// 실측 메시(3D Tiles)가 표출되는 영역을 대장 건물 bbox 의 합집합 extent 로 근사한다.
/// TrackMap 은 이 영역 안의 fill-extrusion 박스를 실측 보유 여부와 무관하게 전부 숨긴다
/// (커버리지 내에서는 메시가 유일한 진실 — 미매칭 대장 건물이 메시 위에 겹쳐 렌더되는 것 방지).
///
/// 실측 데이터가 전무하면 집계 4값이 모두 NULL 이므로 `Ok(None)`.
pub fn coverage_bbox(conn: &Connection) -> Result<Option<[f64; 4]>, String> {
    // WHERE 절 텍스트는 db.rs 의 파트셜 인덱스(idx_fac_buildings_measured_bbox) predicate 와
    // 반드시 동일하게 유지할 것 — 다르면 플래너가 파트셜 인덱스를 못 쓰고 2.1M 행 풀스캔으로 떨어진다.
    let row: (Option<f64>, Option<f64>, Option<f64>, Option<f64>) = conn
        .query_row(
            "SELECT MIN(bbox_min_lat), MAX(bbox_max_lat), MIN(bbox_min_lon), MAX(bbox_max_lon)
             FROM fac_buildings WHERE height_measured IS NOT NULL OR region='실측3D'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .map_err(|e| format!("실측 커버리지 조회 실패: {}", e))?;

    match row {
        (Some(min_lat), Some(max_lat), Some(min_lon), Some(max_lon)) => {
            Ok(Some([min_lat, max_lat, min_lon, max_lon]))
        }
        // 하나라도 NULL = 실측 데이터 전무
        _ => Ok(None),
    }
}

/// 실측 데이터 초기화 — 실측 지붕고 컬럼 해제 + 실측 신규행/로그/지반고 보정 삭제
/// (SRTM 리더 인메모리 캐시 무효화는 호출자 몫 — lib.rs 커맨드에서 `clear_cache()` 호출)
pub fn clear_measured(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE fac_buildings SET height_measured = NULL WHERE height_measured IS NOT NULL",
        [],
    )
    .map_err(|e| format!("실측 지붕고 초기화 실패: {}", e))?;
    conn.execute(
        "DELETE FROM fac_buildings WHERE region = ?1",
        params![MEASURED_REGION],
    )
    .map_err(|e| format!("실측 건물 삭제 실패: {}", e))?;
    conn.execute(
        "DELETE FROM fac_building_import_log WHERE region = ?1",
        params![MEASURED_REGION],
    )
    .map_err(|e| format!("실측 임포트 로그 삭제 실패: {}", e))?;

    // SRTM 지반고 융합 보정도 함께 제거 — 원본 srtm_tiles BLOB 은 애초에 불변이므로
    // 사이드카만 비우면 다음 타일 로드부터 순수 SRTM 으로 복귀한다.
    crate::db::clear_srtm_ground_corrections(conn)
        .map_err(|e| format!("지반고 보정 초기화 실패: {}", e))?;

    // 실측 원인 중복 억제 해제 — 원인이 사라졌으니 덮여 있던 대장 행을 되살린다(가역).
    // 수동 원인('manual:%')은 원인이 남아 있으므로 유지. 실패는 비치명.
    match crate::suppression::clear_measured_suppression(conn) {
        Ok(n) if n > 0 => log::info!("[실측3D] 중복억제 해제 {}행", n),
        Ok(_) => {}
        Err(e) => log::warn!("[실측3D] 중복억제 해제 실패: {}", e),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 부분 블롭 오매칭 — 대장 117m 에 32.7m 지붕고가 붙으면 기각
    /// (절대 격차 20m 초과 AND 대장고의 50% 미만 두 조건 동시 충족)
    #[test]
    fn test_hm_match_sane_rejects_partial_blob() {
        assert!(!hm_match_sane(117.0, 32.7));
        assert!(!hm_match_sane(66.0, 8.0));
    }

    /// 정상 매칭 — 실측이 대장보다 높거나, 낮아도 격차/비율 중 하나만 걸리면 통과
    #[test]
    fn test_hm_match_sane_accepts_normal() {
        assert!(hm_match_sane(117.0, 121.5)); // 실측이 더 높음 (일반적: 옥탑/설비)
        assert!(hm_match_sane(66.0, 60.0)); // 격차 6m — 절대 격차 미달
        assert!(hm_match_sane(30.0, 18.0)); // 격차 12m — 절대 격차 미달
        assert!(hm_match_sane(100.0, 60.0)); // 비율 60% — 비율 조건 미달
    }

    /// 경계값 — 두 조건 모두 '초과/미만' 이므로 경계에서는 통과
    #[test]
    fn test_hm_match_sane_boundary() {
        assert!(hm_match_sane(100.0, 80.0)); // 격차 정확히 20m (초과 아님)
        assert!(hm_match_sane(100.0, 50.0)); // 정확히 50% (미만 아님)
        assert!(!hm_match_sane(100.0, 49.9)); // 격차 50.1m + 49.9% → 기각
    }

    /// 대장고가 없는 행(0 이하)은 비교 불가 — 항상 통과
    #[test]
    fn test_hm_match_sane_no_register_height() {
        assert!(hm_match_sane(0.0, 3.0));
        assert!(hm_match_sane(-1.0, 3.0));
    }

    /// bbox 면적 — 1m² 블롭은 노이즈 컷(4m²) 미달, 3m×3m 은 통과
    #[test]
    fn test_bbox_area_m2_noise_cut() {
        // 위도 37.5° 부근 1m ≈ 8.98e-6°(lat) / 1.13e-5°(lon)
        let lat: f64 = 37.5;
        let d_lat_1m = 1.0 / DEG_LAT_M;
        let d_lon_1m = 1.0 / (DEG_LAT_M * lat.to_radians().cos());
        let a1 = bbox_area_m2(lat, 127.0, lat + d_lat_1m, 127.0 + d_lon_1m);
        assert!(a1 < MIN_BLOB_AREA_M2, "1m² 블롭 = {}", a1);
        let a9 = bbox_area_m2(lat, 127.0, lat + 3.0 * d_lat_1m, 127.0 + 3.0 * d_lon_1m);
        assert!(a9 > MIN_BLOB_AREA_M2, "9m² 블롭 = {}", a9);
    }
}
