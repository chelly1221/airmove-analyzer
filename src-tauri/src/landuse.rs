//! 토지이용계획정보 SHP 임포트 및 뷰포트 조회
//!
//! vworld 토지이용계획정보 SHP(EPSG:5186)를 파싱하여 SQLite에 저장하고,
//! 맵 뷰포트 내 용도지역 폴리곤을 조회하여 오버레이 렌더링에 제공.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::building::{extract_zip_entry, get_field_as_string, parse_dbf_euckr_field};
use crate::coord::epsg5186_to_wgs84;

/// 토지이용계획 존 (프론트엔드 반환)
#[derive(Serialize, Clone, Debug)]
pub struct LandUseZone {
    pub zone_type_code: String,
    pub zone_type_name: String,
    pub polygon_json: String,
    pub centroid_lat: f64,
    pub centroid_lon: f64,
    pub area_sqm: Option<f64>,
}

/// 임포트 상태
#[derive(Serialize, Clone, Debug)]
pub struct LandUseImportStatus {
    pub region: String,
    pub file_date: String,
    pub imported_at: i64,
    pub record_count: i64,
}

/// 임포트 진행률
#[derive(Clone, Serialize)]
pub struct LandUseImportProgress {
    pub region: String,
    pub total: usize,
    pub processed: usize,
    pub status: String,
}

/// ZIP에서 토지이용계획 데이터를 임포트 (SHP 또는 CSV)
pub fn import_from_zip(
    conn: &Connection,
    zip_path: &str,
    region: &str,
    progress_fn: &dyn Fn(LandUseImportProgress),
) -> Result<usize, String> {
    let temp_dir = std::env::temp_dir().join(format!("airmove_landuse_{}", region));
    let _ = std::fs::create_dir_all(&temp_dir);

    // SHP 또는 CSV 찾기
    match find_shp_dbf_in_zip(zip_path, &temp_dir) {
        Ok(DataFiles::Shp(shp_path, dbf_path)) => {
            return import_from_shp(conn, region, &shp_path, &dbf_path, &temp_dir, progress_fn);
        }
        Ok(DataFiles::Csv(csv_path)) => {
            return import_from_csv(conn, region, &csv_path, &temp_dir, progress_fn);
        }
        Err(e) => return Err(e),
    }
}

/// SHP 기반 임포트
fn import_from_shp(
    conn: &Connection,
    region: &str,
    shp_path: &std::path::Path,
    dbf_path: &std::path::Path,
    temp_dir: &std::path::Path,
    progress_fn: &dyn Fn(LandUseImportProgress),
) -> Result<usize, String> {

    progress_fn(LandUseImportProgress {
        region: region.to_string(),
        total: 0,
        processed: 0,
        status: "SHP 파일 로딩 중...".to_string(),
    });

    // DBF에서 용도지역 코드/명칭 추출 (EUC-KR)
    // 토지이용계획정보 필드명 후보: JIMK(지목코드), UQ_CDE/UQA_CDE(용도코드), UQ_NM/UQA_NM(용도명)
    // 다양한 필드명 시도
    let euckr_zone_names = parse_dbf_euckr_field(&dbf_path, &[
        "UQ_NM", "UQA_NM", "UNAME", "PRPS_NM", "JIGA_NM", "용도지역",
    ]);
    let euckr_zone_codes = parse_dbf_euckr_field(&dbf_path, &[
        "UQ_CDE", "UQA_CDE", "UCODE", "PRPS_CDE", "JIGA_CDE", "용도코드",
    ]);

    // shapefile 리더
    let mut reader = shapefile::Reader::from_path(&shp_path)
        .map_err(|e| format!("SHP 파일 읽기 실패: {}", e))?;

    // 기존 region 데이터 삭제
    conn.execute("DELETE FROM landuse_zones WHERE region = ?1", params![region])
        .map_err(|e| format!("기존 데이터 삭제 실패: {}", e))?;
    conn.execute("DELETE FROM landuse_import_log WHERE region = ?1", params![region])
        .map_err(|e| format!("임포트 로그 삭제 실패: {}", e))?;

    let mut count = 0usize;
    let mut inserted = 0usize;
    let batch_size = 10_000;

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(
        "INSERT INTO landuse_zones (region, zone_type_code, zone_type_name, centroid_lat, centroid_lon, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon, area_sqm, polygon_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
    ).map_err(|e| format!("INSERT 준비 실패: {}", e))?;

    let loop_result: Result<(), String> = (|| {
        for result in reader.iter_shapes_and_records() {
            let (shape, record) = result.map_err(|e| format!("레코드 읽기 실패: {}", e))?;

            count += 1;

            // 용도지역명: EUC-KR 우선, shapefile 크레이트 polback
            let zone_name = euckr_zone_names.as_ref()
                .and_then(|names| names.get(count - 1).cloned().flatten())
                .or_else(|| get_field_as_string(&record, &[
                    "UQ_NM", "UQA_NM", "UNAME", "PRPS_NM", "JIGA_NM",
                ]))
                .unwrap_or_default();

            // 용도지역코드
            let zone_code = euckr_zone_codes.as_ref()
                .and_then(|codes| codes.get(count - 1).cloned().flatten())
                .or_else(|| get_field_as_string(&record, &[
                    "UQ_CDE", "UQA_CDE", "UCODE", "PRPS_CDE", "JIGA_CDE",
                ]))
                .unwrap_or_default();

            // 면적
            let area_sqm = get_field_as_f64_landuse(&record, &["AREA", "A_AREA", "SHAPE_AREA"]);

            // 폴리곤 추출 + bbox/centroid
            let (bbox, polygon_json) = match &shape {
                shapefile::Shape::Polygon(poly) => {
                    let b = compute_poly_bbox(poly.rings());
                    let pj = extract_polygon_wgs84_landuse(poly.rings().first().map(|r| r.points()));
                    (b, pj)
                }
                shapefile::Shape::PolygonZ(poly) => {
                    let b = compute_poly_bbox(poly.rings());
                    let pj = extract_polygon_wgs84_landuse(poly.rings().first().map(|r| r.points()));
                    (b, pj)
                }
                _ => continue,
            };

            let (cx, cy, min_x, min_y, max_x, max_y) = match bbox {
                Some(v) => v,
                None => continue,
            };

            let polygon_json = match polygon_json {
                Some(pj) => pj,
                None => continue,
            };

            // EPSG:5186 → WGS84
            let (clat, clon) = epsg5186_to_wgs84(cx, cy);
            let (min_lat, min_lon) = epsg5186_to_wgs84(min_x, min_y);
            let (max_lat, max_lon) = epsg5186_to_wgs84(max_x, max_y);

            // 한국 영역 검증
            if clat < 33.0 || clat > 43.0 || clon < 124.0 || clon > 132.0 {
                continue;
            }

            stmt.execute(params![
                region, zone_code, zone_name, clat, clon,
                min_lat, min_lon, max_lat, max_lon, area_sqm, polygon_json,
            ]).map_err(|e| format!("INSERT 실패: {}", e))?;

            inserted += 1;

            if count % batch_size == 0 {
                conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
                progress_fn(LandUseImportProgress {
                    region: region.to_string(),
                    total: 0,
                    processed: count,
                    status: format!("처리 중... {}건 ({}건 유효)", count, inserted),
                });
            }
        }
        Ok(())
    })();

    if let Err(e) = loop_result {
        let _ = conn.execute_batch("ROLLBACK");
        return Err(e);
    }
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

    save_import_log(conn, region, count, inserted, temp_dir, progress_fn)?;
    Ok(inserted)
}

/// CSV 기반 임포트 (vworld 토지이용계획정보 CSV — WKT 지오메트리 포함)
fn import_from_csv(
    conn: &Connection,
    region: &str,
    csv_path: &std::path::Path,
    temp_dir: &std::path::Path,
    progress_fn: &dyn Fn(LandUseImportProgress),
) -> Result<usize, String> {
    use log::info;

    progress_fn(LandUseImportProgress {
        region: region.to_string(),
        total: 0,
        processed: 0,
        status: "CSV 파일 분석 중...".to_string(),
    });

    // EUC-KR 인코딩 가능성 — 전체 바이트를 읽어서 디코딩
    let raw_bytes = std::fs::read(csv_path)
        .map_err(|e| format!("CSV 읽기 실패: {}", e))?;

    let text = if let Ok(s) = std::str::from_utf8(&raw_bytes) {
        s.to_string()
    } else {
        let (decoded, _, _) = encoding_rs::EUC_KR.decode(&raw_bytes);
        decoded.into_owned()
    };

    let mut lines = text.lines();

    // 헤더 파싱
    let header_line = lines.next().ok_or("CSV가 비어있습니다")?;

    // 구분자 감지 (| 또는 ,)
    let delimiter = if header_line.contains('|') { '|' } else { ',' };
    let headers: Vec<&str> = header_line.split(delimiter).map(|s| s.trim().trim_matches('"')).collect();

    info!("landuse CSV 헤더 ({} 컬럼): {:?}", headers.len(), headers);

    // 컬럼 인덱스 찾기
    let find_col = |candidates: &[&str]| -> Option<usize> {
        for &c in candidates {
            if let Some(idx) = headers.iter().position(|h| h.eq_ignore_ascii_case(c)) {
                return Some(idx);
            }
        }
        None
    };

    // WKT 지오메트리 컬럼
    let geom_col = find_col(&["GEOM", "the_geom", "geometry", "WKT", "geom_wkt", "SHAPE"]);
    // 용도지역명
    let name_col = find_col(&["PRPS_AREA_NM", "UQ_NM", "UQA_NM", "UNAME", "PRPS_NM", "용도지역명"]);
    // 용도지역코드
    let code_col = find_col(&["PRPS_AREA_CD", "UQ_CDE", "UQA_CDE", "UCODE", "PRPS_CDE", "용도지역코드", "PRPS_AREA_DSTRC_CD"]);
    // 면적
    let area_col = find_col(&["AREA", "A_AREA", "SHAPE_AREA", "면적"]);

    info!(
        "landuse CSV 컬럼 매핑: geom={:?} name={:?} code={:?} area={:?}",
        geom_col.map(|i| headers[i]),
        name_col.map(|i| headers[i]),
        code_col.map(|i| headers[i]),
        area_col.map(|i| headers[i]),
    );

    let geom_col = geom_col.ok_or_else(|| {
        format!(
            "CSV에 지오메트리 컬럼을 찾을 수 없습니다.\n헤더: {:?}",
            headers
        )
    })?;

    // 기존 데이터 삭제
    conn.execute("DELETE FROM landuse_zones WHERE region = ?1", params![region])
        .map_err(|e| format!("기존 데이터 삭제 실패: {}", e))?;
    conn.execute("DELETE FROM landuse_import_log WHERE region = ?1", params![region])
        .map_err(|e| format!("임포트 로그 삭제 실패: {}", e))?;

    let mut count = 0usize;
    let mut inserted = 0usize;
    let batch_size = 5_000;

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(
        "INSERT INTO landuse_zones (region, zone_type_code, zone_type_name, centroid_lat, centroid_lon, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon, area_sqm, polygon_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)"
    ).map_err(|e| format!("INSERT 준비 실패: {}", e))?;

    // CSV 행을 delimiter로 분할하되, WKT 안의 쉼표는 무시해야 함
    // WKT는 보통 큰따옴표로 감싸져 있음
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }

        count += 1;

        let fields = parse_csv_line(line, delimiter);

        if fields.len() <= geom_col {
            continue;
        }

        let wkt = fields[geom_col].trim().trim_matches('"');
        if wkt.is_empty() {
            continue;
        }

        let zone_name = name_col
            .and_then(|i| fields.get(i))
            .map(|s| s.trim().trim_matches('"').to_string())
            .unwrap_or_default();

        let zone_code = code_col
            .and_then(|i| fields.get(i))
            .map(|s| s.trim().trim_matches('"').to_string())
            .unwrap_or_default();

        let area_sqm: Option<f64> = area_col
            .and_then(|i| fields.get(i))
            .and_then(|s| s.trim().trim_matches('"').parse().ok());

        // WKT → polygon coordinates
        let polygons = parse_wkt_polygons(wkt);
        if polygons.is_empty() {
            continue;
        }

        for coords in &polygons {
            if coords.len() < 3 {
                continue;
            }

            // bbox + centroid
            let mut min_lat = f64::MAX;
            let mut min_lon = f64::MAX;
            let mut max_lat = f64::MIN;
            let mut max_lon = f64::MIN;
            let mut sum_lat = 0.0;
            let mut sum_lon = 0.0;

            for &[lat, lon] in coords {
                min_lat = min_lat.min(lat);
                min_lon = min_lon.min(lon);
                max_lat = max_lat.max(lat);
                max_lon = max_lon.max(lon);
                sum_lat += lat;
                sum_lon += lon;
            }

            let n = coords.len() as f64;
            let clat = sum_lat / n;
            let clon = sum_lon / n;

            // 한국 영역 검증
            if clat < 33.0 || clat > 43.0 || clon < 124.0 || clon > 132.0 {
                continue;
            }

            // RDP 간소화
            let simplified = if coords.len() > 100 {
                rdp_simplify(coords, 0.00002)
            } else if coords.len() > 50 {
                rdp_simplify(coords, 0.00001)
            } else {
                coords.clone()
            };

            if simplified.len() < 3 {
                continue;
            }

            let polygon_json = match serde_json::to_string(&simplified) {
                Ok(j) => j,
                Err(_) => continue,
            };

            stmt.execute(params![
                region, zone_code, zone_name, clat, clon,
                min_lat, min_lon, max_lat, max_lon, area_sqm, polygon_json,
            ]).map_err(|e| format!("INSERT 실패: {}", e))?;

            inserted += 1;
        }

        if count % batch_size == 0 {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
            progress_fn(LandUseImportProgress {
                region: region.to_string(),
                total: 0,
                processed: count,
                status: format!("처리 중... {}건 ({}건 유효)", count, inserted),
            });
        }
    }

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

    save_import_log(conn, region, count, inserted, temp_dir, progress_fn)?;
    Ok(inserted)
}

/// 임포트 로그 저장 + 임시 파일 정리
fn save_import_log(
    conn: &Connection,
    region: &str,
    count: usize,
    inserted: usize,
    temp_dir: &std::path::Path,
    progress_fn: &dyn Fn(LandUseImportProgress),
) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let file_date = {
        let t = time::OffsetDateTime::now_utc();
        format!("{}{:02}", t.year(), t.month() as u8)
    };

    conn.execute(
        "INSERT OR REPLACE INTO landuse_import_log (region, file_date, imported_at, record_count)
         VALUES (?1, ?2, ?3, ?4)",
        params![region, file_date, now, inserted as i64],
    ).map_err(|e| format!("임포트 로그 저장 실패: {}", e))?;

    let _ = std::fs::remove_dir_all(temp_dir);

    progress_fn(LandUseImportProgress {
        region: region.to_string(),
        total: count,
        processed: count,
        status: format!("완료: {}건 중 {}건 임포트", count, inserted),
    });

    Ok(())
}

/// 뷰포트(bbox) 내 토지이용계획 존 조회
pub fn query_in_bbox(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    max_count: usize,
) -> Result<Vec<LandUseZone>, String> {
    let mut stmt = conn.prepare(
        "SELECT zone_type_code, zone_type_name, polygon_json, centroid_lat, centroid_lon, area_sqm
         FROM landuse_zones
         WHERE bbox_max_lat >= ?1 AND bbox_min_lat <= ?2
           AND bbox_max_lon >= ?3 AND bbox_min_lon <= ?4
         LIMIT ?5"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map(
        params![min_lat, max_lat, min_lon, max_lon, max_count as i64],
        |row| {
            Ok(LandUseZone {
                zone_type_code: row.get(0)?,
                zone_type_name: row.get(1)?,
                polygon_json: row.get(2)?,
                centroid_lat: row.get(3)?,
                centroid_lon: row.get(4)?,
                area_sqm: row.get(5)?,
            })
        },
    ).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("결과 수집 실패: {}", e))
}

/// 임포트 현황 조회
pub fn get_import_status(conn: &Connection) -> Result<Vec<LandUseImportStatus>, String> {
    let mut stmt = conn.prepare(
        "SELECT region, file_date, imported_at, record_count FROM landuse_import_log ORDER BY region"
    ).map_err(|e| format!("쿼리 실패: {}", e))?;

    let rows = stmt.query_map([], |row| {
        Ok(LandUseImportStatus {
            region: row.get(0)?,
            file_date: row.get(1)?,
            imported_at: row.get(2)?,
            record_count: row.get(3)?,
        })
    }).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("결과 수집 실패: {}", e))
}

/// 토지이용계획 데이터 삭제
pub fn clear_data(conn: &Connection, region: Option<&str>) -> Result<(), String> {
    match region {
        Some(r) => {
            conn.execute("DELETE FROM landuse_zones WHERE region = ?1", params![r])
                .map_err(|e| format!("삭제 실패: {}", e))?;
            conn.execute("DELETE FROM landuse_import_log WHERE region = ?1", params![r])
                .map_err(|e| format!("로그 삭제 실패: {}", e))?;
        }
        None => {
            conn.execute("DELETE FROM landuse_zones", [])
                .map_err(|e| format!("전체 삭제 실패: {}", e))?;
            conn.execute("DELETE FROM landuse_import_log", [])
                .map_err(|e| format!("전체 로그 삭제 실패: {}", e))?;
        }
    }
    Ok(())
}

// ─── 내부 유틸 ──────────────────────────────────────────────────

/// ZIP에서 찾은 데이터 파일 유형
enum DataFiles {
    Shp(std::path::PathBuf, std::path::PathBuf), // (shp_path, dbf_path)
    Csv(std::path::PathBuf),
}

/// ZIP에서 SHP/DBF 또는 CSV 파일 찾기 — 직접 포함 또는 중첩 ZIP 내부
/// 토지이용계획정보 ZIP은 여러 구조가 가능:
///   1. ZIP > *.shp + *.dbf (직접)
///   2. ZIP > inner.zip > *.shp + *.dbf (중첩)
///   3. ZIP > subdir/ > *.shp + *.dbf (서브디렉토리)
///   4. ZIP > *.csv (SHP 없이 CSV만 — 미지원, 에러)
fn find_shp_dbf_in_zip(
    zip_path: &str,
    temp_dir: &std::path::Path,
) -> Result<DataFiles, String> {
    use log::info;

    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("ZIP 파일 열기 실패: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("ZIP 아카이브 읽기 실패: {}", e))?;

    // ZIP 내용물 로그
    let mut entries = Vec::new();
    let mut shp_name = None;
    let mut dbf_name = None;
    let mut csv_name = None;
    let mut inner_zips = Vec::new();

    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("ZIP 항목 읽기 실패: {}", e))?;
        let name = entry.name().to_string();
        let name_lower = name.to_lowercase();
        entries.push(name.clone());

        if name_lower.contains("__macosx") || entry.is_dir() {
            continue;
        }

        if name_lower.ends_with(".shp") {
            shp_name = Some(name.clone());
        }
        if name_lower.ends_with(".dbf") {
            dbf_name = Some(name.clone());
        }
        if name_lower.ends_with(".csv") {
            csv_name = Some(name.clone());
        }
        if name_lower.ends_with(".zip") {
            inner_zips.push(name.clone());
        }
    }

    info!(
        "landuse ZIP 내용물 ({} 항목): {:?}",
        entries.len(),
        if entries.len() > 20 { &entries[..20] } else { &entries }
    );

    // 1) 직접 SHP/DBF 발견
    if let (Some(shp), Some(dbf)) = (&shp_name, &dbf_name) {
        let shp_path = temp_dir.join("landuse.shp");
        let dbf_path = temp_dir.join("landuse.dbf");
        extract_zip_entry(&mut archive, shp, &shp_path)?;
        extract_zip_entry(&mut archive, dbf, &dbf_path)?;
        return Ok(DataFiles::Shp(shp_path, dbf_path));
    }

    // 1.5) CSV 발견 (SHP 없이 CSV만 있는 경우)
    if let Some(csv) = &csv_name {
        info!("landuse: SHP 미발견, CSV '{}' 사용", csv);
        let csv_path = temp_dir.join("landuse.csv");
        extract_zip_entry(&mut archive, csv, &csv_path)?;
        return Ok(DataFiles::Csv(csv_path));
    }

    // 2) 중첩 ZIP 시도
    if !inner_zips.is_empty() {
        info!("landuse: SHP 미발견, 중첩 ZIP {} 개 시도", inner_zips.len());

        for inner_zip_name in &inner_zips {
            let inner_zip_path = temp_dir.join("inner.zip");
            extract_zip_entry(&mut archive, inner_zip_name, &inner_zip_path)?;

            // 중첩 ZIP 열기
            let inner_file = std::fs::File::open(&inner_zip_path)
                .map_err(|e| format!("중첩 ZIP 열기 실패: {}", e))?;
            let mut inner_archive = match zip::ZipArchive::new(inner_file) {
                Ok(a) => a,
                Err(_) => continue,
            };

            let mut inner_shp = None;
            let mut inner_dbf = None;
            let mut inner_entries = Vec::new();

            for i in 0..inner_archive.len() {
                if let Ok(entry) = inner_archive.by_index(i) {
                    let n = entry.name().to_string();
                    let nl = n.to_lowercase();
                    inner_entries.push(n.clone());
                    if nl.ends_with(".shp") && !nl.contains("__macosx") {
                        inner_shp = Some(n.clone());
                    }
                    if nl.ends_with(".dbf") && !nl.contains("__macosx") {
                        inner_dbf = Some(n.clone());
                    }
                }
            }

            info!(
                "landuse 중첩 ZIP '{}' 내용물 ({} 항목): {:?}",
                inner_zip_name,
                inner_entries.len(),
                if inner_entries.len() > 20 { &inner_entries[..20] } else { &inner_entries }
            );

            if let (Some(shp), Some(dbf)) = (&inner_shp, &inner_dbf) {
                let shp_path = temp_dir.join("landuse.shp");
                let dbf_path = temp_dir.join("landuse.dbf");
                extract_zip_entry(&mut inner_archive, shp, &shp_path)?;
                extract_zip_entry(&mut inner_archive, dbf, &dbf_path)?;
                let _ = std::fs::remove_file(&inner_zip_path);
                return Ok(DataFiles::Shp(shp_path, dbf_path));
            }

            // 이중 중첩 (ZIP > ZIP > ZIP > SHP) 도 시도
            let mut inner_inner_zips = Vec::new();
            for entry_name in &inner_entries {
                if entry_name.to_lowercase().ends_with(".zip") {
                    inner_inner_zips.push(entry_name.clone());
                }
            }

            for iiz_name in &inner_inner_zips {
                let iiz_path = temp_dir.join("inner2.zip");
                if extract_zip_entry(&mut inner_archive, iiz_name, &iiz_path).is_err() {
                    continue;
                }

                let iiz_file = match std::fs::File::open(&iiz_path) {
                    Ok(f) => f,
                    Err(_) => continue,
                };
                let mut iiz_archive = match zip::ZipArchive::new(iiz_file) {
                    Ok(a) => a,
                    Err(_) => continue,
                };

                let mut ii_shp = None;
                let mut ii_dbf = None;
                let mut ii_entries = Vec::new();

                for i in 0..iiz_archive.len() {
                    if let Ok(entry) = iiz_archive.by_index(i) {
                        let n = entry.name().to_string();
                        let nl = n.to_lowercase();
                        ii_entries.push(n.clone());
                        if nl.ends_with(".shp") && !nl.contains("__macosx") {
                            ii_shp = Some(n.clone());
                        }
                        if nl.ends_with(".dbf") && !nl.contains("__macosx") {
                            ii_dbf = Some(n.clone());
                        }
                    }
                }

                info!(
                    "landuse 이중 중첩 ZIP '{}' 내용물 ({} 항목): {:?}",
                    iiz_name,
                    ii_entries.len(),
                    if ii_entries.len() > 20 { &ii_entries[..20] } else { &ii_entries }
                );

                if let (Some(shp), Some(dbf)) = (&ii_shp, &ii_dbf) {
                    let shp_path = temp_dir.join("landuse.shp");
                    let dbf_path = temp_dir.join("landuse.dbf");
                    extract_zip_entry(&mut iiz_archive, shp, &shp_path)?;
                    extract_zip_entry(&mut iiz_archive, dbf, &dbf_path)?;
                    let _ = std::fs::remove_file(&iiz_path);
                    let _ = std::fs::remove_file(&inner_zip_path);
                    return Ok(DataFiles::Shp(shp_path, dbf_path));
                }
                let _ = std::fs::remove_file(&iiz_path);
            }

            let _ = std::fs::remove_file(&inner_zip_path);
        }
    }

    // SHP를 전혀 찾지 못한 경우 — 상세 에러
    let file_types: Vec<&str> = entries
        .iter()
        .filter_map(|e| e.rsplit('.').next())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    Err(format!(
        "ZIP에서 .shp 파일을 찾을 수 없습니다.\nZIP 내 파일 유형: {:?}\n전체 항목 (앞 30개): {:?}",
        file_types,
        if entries.len() > 30 { &entries[..30] } else { &entries }
    ))
}

/// 폴리곤 ring에서 bbox + centroid 계산 (EPSG:5186 좌표)
fn compute_poly_bbox<R>(rings: &[R]) -> Option<(f64, f64, f64, f64, f64, f64)>
where
    R: AsPoints,
{
    let points = rings.first()?.as_points();
    if points.is_empty() {
        return None;
    }

    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;

    for &(x, y) in &points {
        min_x = min_x.min(x);
        min_y = min_y.min(y);
        max_x = max_x.max(x);
        max_y = max_y.max(y);
        sum_x += x;
        sum_y += y;
    }

    let n = points.len() as f64;
    Some((sum_x / n, sum_y / n, min_x, min_y, max_x, max_y))
}

/// 다양한 ring 타입을 통합하기 위한 트레이트
trait AsPoints {
    fn as_points(&self) -> Vec<(f64, f64)>;
}

impl AsPoints for shapefile::record::polygon::PolygonRing<shapefile::Point> {
    fn as_points(&self) -> Vec<(f64, f64)> {
        self.points().iter().map(|p| (p.x, p.y)).collect()
    }
}

impl AsPoints for shapefile::record::polygon::PolygonRing<shapefile::PointZ> {
    fn as_points(&self) -> Vec<(f64, f64)> {
        self.points().iter().map(|p| (p.x, p.y)).collect()
    }
}

/// SHP 폴리곤 꼭짓점을 WGS84로 변환하여 JSON 직렬화 (토지이용계획은 간소화 좀 더 적극적)
fn extract_polygon_wgs84_landuse<P: shapefile::record::traits::HasXY>(points: Option<&[P]>) -> Option<String> {
    let pts = points?;
    if pts.len() < 3 {
        return None;
    }

    let mut coords: Vec<[f64; 2]> = Vec::with_capacity(pts.len());
    for pt in pts {
        let (lat, lon) = epsg5186_to_wgs84(pt.x(), pt.y());
        coords.push([lat, lon]);
    }

    // RDP 간소화: 토지이용 폴리곤은 크므로 좀 더 적극적으로 축소
    if coords.len() > 100 {
        coords = rdp_simplify(&coords, 0.00002); // ~2m
        if coords.len() < 3 {
            return None;
        }
    } else if coords.len() > 50 {
        coords = rdp_simplify(&coords, 0.00001); // ~1m
        if coords.len() < 3 {
            return None;
        }
    }

    serde_json::to_string(&coords).ok()
}

/// Ramer-Douglas-Peucker 폴리곤 간소화
fn rdp_simplify(points: &[[f64; 2]], epsilon: f64) -> Vec<[f64; 2]> {
    if points.len() < 3 {
        return points.to_vec();
    }

    let first = points[0];
    let last = points[points.len() - 1];
    let mut max_dist = 0.0;
    let mut max_idx = 0;

    for (i, pt) in points.iter().enumerate().skip(1).take(points.len() - 2) {
        let d = perp_dist(pt, &first, &last);
        if d > max_dist {
            max_dist = d;
            max_idx = i;
        }
    }

    if max_dist > epsilon {
        let mut left = rdp_simplify(&points[..=max_idx], epsilon);
        let right = rdp_simplify(&points[max_idx..], epsilon);
        left.pop();
        left.extend_from_slice(&right);
        left
    } else {
        vec![first, last]
    }
}

fn perp_dist(pt: &[f64; 2], a: &[f64; 2], b: &[f64; 2]) -> f64 {
    let dx = b[0] - a[0];
    let dy = b[1] - a[1];
    let len_sq = dx * dx + dy * dy;
    if len_sq < 1e-20 {
        let ex = pt[0] - a[0];
        let ey = pt[1] - a[1];
        return (ex * ex + ey * ey).sqrt();
    }
    ((pt[0] - a[0]) * dy - (pt[1] - a[1]) * dx).abs() / len_sq.sqrt()
}

/// 레코드에서 f64 필드값 추출 (면적 등)
fn get_field_as_f64_landuse(
    record: &shapefile::dbase::Record,
    field_names: &[&str],
) -> Option<f64> {
    use shapefile::dbase::FieldValue;
    for &name in field_names {
        if let Some(val) = record.get(name) {
            match val {
                FieldValue::Numeric(Some(v)) => return Some(*v),
                FieldValue::Float(Some(v)) => return Some(*v as f64),
                FieldValue::Double(v) => return Some(*v),
                _ => {}
            }
        }
    }
    None
}

// ─── CSV / WKT 파서 ─────────────────────────────────────────────

/// CSV 행을 delimiter로 분할 (큰따옴표 내 delimiter 무시)
fn parse_csv_line(line: &str, delimiter: char) -> Vec<String> {
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;

    for ch in line.chars() {
        if ch == '"' {
            in_quotes = !in_quotes;
            current.push(ch);
        } else if ch == delimiter && !in_quotes {
            fields.push(current.clone());
            current.clear();
        } else {
            current.push(ch);
        }
    }
    fields.push(current);
    fields
}

/// WKT 문자열에서 폴리곤 좌표 추출
/// 지원 포맷: POLYGON((lon lat, lon lat, ...)), MULTIPOLYGON(((lon lat, ...)))
/// 반환: Vec<Vec<[lat, lon]>> (다중 폴리곤 가능)
fn parse_wkt_polygons(wkt: &str) -> Vec<Vec<[f64; 2]>> {
    let upper = wkt.trim().to_uppercase();
    let mut polygons = Vec::new();

    if upper.starts_with("MULTIPOLYGON") {
        // MULTIPOLYGON(((x y, x y), (hole)), ((x y, x y)))
        // 각 ((...)) 를 개별 폴리곤으로 처리 — outer ring만 사용
        let inner = strip_prefix_parens(wkt, "MULTIPOLYGON");
        for poly_wkt in split_multi_polygon(&inner) {
            if let Some(ring) = parse_polygon_rings(&poly_wkt).into_iter().next() {
                if ring.len() >= 3 {
                    polygons.push(ring);
                }
            }
        }
    } else if upper.starts_with("POLYGON") {
        let inner = strip_prefix_parens(wkt, "POLYGON");
        if let Some(ring) = parse_polygon_rings(&inner).into_iter().next() {
            if ring.len() >= 3 {
                polygons.push(ring);
            }
        }
    }

    polygons
}

/// "POLYGON((...))" → "((...)" — 키워드 제거 후 외부 괄호 제거
fn strip_prefix_parens(wkt: &str, keyword: &str) -> String {
    let trimmed = wkt.trim();
    // 키워드 (대소문자 무관) 제거
    let after_keyword = if let Some(pos) = trimmed.to_uppercase().find(&keyword.to_uppercase()) {
        &trimmed[pos + keyword.len()..]
    } else {
        trimmed
    };
    after_keyword.trim().to_string()
}

/// MULTIPOLYGON 내부를 개별 폴리곤으로 분할
/// "(((x y,x y)), ((x y,x y)))" → ["(x y,x y)", "(x y,x y)"]
fn split_multi_polygon(s: &str) -> Vec<String> {
    let mut polygons = Vec::new();
    let mut depth = 0;
    let mut current = String::new();

    for ch in s.chars() {
        match ch {
            '(' => {
                depth += 1;
                if depth >= 3 {
                    current.push(ch);
                }
            }
            ')' => {
                if depth >= 3 {
                    current.push(ch);
                }
                depth -= 1;
                if depth == 1 && !current.trim().is_empty() {
                    polygons.push(current.trim().to_string());
                    current.clear();
                }
            }
            ',' if depth == 1 => {
                // 폴리곤 사이 쉼표 — 무시
            }
            _ => {
                if depth >= 2 {
                    current.push(ch);
                }
            }
        }
    }
    if !current.trim().is_empty() {
        polygons.push(current.trim().to_string());
    }
    polygons
}

/// "(x y, x y, ...)" 또는 "((x y, x y), (hole))" → rings (outer ring이 첫 번째)
/// 반환: Vec<Vec<[lat, lon]>> (첫 번째 ring = outer, 나머지 = holes)
fn parse_polygon_rings(s: &str) -> Vec<Vec<[f64; 2]>> {
    let mut rings = Vec::new();
    let mut depth = 0;
    let mut current = String::new();

    for ch in s.chars() {
        match ch {
            '(' => {
                depth += 1;
                if depth > 1 {
                    current.push(ch);
                }
            }
            ')' => {
                if depth > 1 {
                    current.push(ch);
                }
                depth -= 1;
                if depth == 0 && !current.trim().is_empty() {
                    if let Some(ring) = parse_coordinate_ring(current.trim()) {
                        rings.push(ring);
                    }
                    current.clear();
                }
            }
            ',' if depth == 1 => {
                if !current.trim().is_empty() {
                    if let Some(ring) = parse_coordinate_ring(current.trim()) {
                        rings.push(ring);
                    }
                    current.clear();
                }
            }
            _ => {
                current.push(ch);
            }
        }
    }

    // 괄호 없이 직접 좌표가 있는 경우 (단순 POLYGON)
    if rings.is_empty() && !current.trim().is_empty() {
        if let Some(ring) = parse_coordinate_ring(current.trim()) {
            rings.push(ring);
        }
    }

    rings
}

/// "x y, x y, x y" → Vec<[lat, lon]>
/// WKT는 (lon lat) 순서 → [lat, lon] 으로 변환
fn parse_coordinate_ring(s: &str) -> Option<Vec<[f64; 2]>> {
    // 괄호 제거
    let s = s.trim().trim_start_matches('(').trim_end_matches(')');
    let coords: Vec<[f64; 2]> = s
        .split(',')
        .filter_map(|pair| {
            let pair = pair.trim();
            let parts: Vec<&str> = pair.split_whitespace().collect();
            if parts.len() >= 2 {
                let lon: f64 = parts[0].parse().ok()?;
                let lat: f64 = parts[1].parse().ok()?;
                Some([lat, lon]) // WKT은 lon lat 순서
            } else {
                None
            }
        })
        .collect();

    if coords.len() >= 3 {
        Some(coords)
    } else {
        None
    }
}
