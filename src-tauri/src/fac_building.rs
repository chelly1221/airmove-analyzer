//! 건물통합정보 (F_FAC_BUILDING) SHP 임포트 및 3D 조회
//!
//! 국토교통부 건물통합정보(F_FAC_BUILDING) SHP(EPSG:5186) 파일을 파싱하여
//! SQLite fac_buildings 테이블에 저장하고, 3D 시각화용 건물 조회를 제공.

use rusqlite::{params, Connection};
use serde::Serialize;

use crate::building::{
    compute_polygon_bbox_centroid, compute_polygon_z_bbox_centroid,
    extract_polygon_wgs84, extract_zip_entry, get_field_as_f64, get_field_as_string,
    parse_dbf_euckr_field, today_yyyymm, Building3D,
};
use crate::coord::epsg5186_to_wgs84;
use crate::srtm::SrtmReader;

/// 건물 높이 상한 (m)
const MAX_HEIGHT_M: f64 = 650.0;

/// 층당 최대 허용 높이 (m) — 용도별 차등 적용
/// 공장/창고/산업시설: 층고가 높으므로 10m까지 허용
/// 일반 건물(주거/사무/상업 등): 6m까지 허용
const MAX_HEIGHT_PER_FLOOR_INDUSTRIAL: f64 = 10.0;
const MAX_HEIGHT_PER_FLOOR_DEFAULT: f64 = 6.0;

/// 임포트 진행률 이벤트
#[derive(Clone, Serialize)]
pub struct FacBuildingImportProgress {
    pub region: String,
    pub total: usize,
    pub processed: usize,
    pub status: String,
}

/// 임포트 현황
#[derive(Serialize, Clone, Debug)]
pub struct FacBuildingImportStatus {
    pub region: String,
    pub file_date: String,
    pub imported_at: i64,
    pub record_count: i64,
}

/// F_FAC_BUILDING SHP ZIP 파일에서 건물 데이터를 임포트
/// HEIGHT > 0 인 건물만 저장, 폴리곤 풋프린트를 WGS84 JSON으로 변환하여 저장
pub fn import_from_zip(
    conn: &Connection,
    srtm: &mut SrtmReader,
    zip_path: &str,
    region: &str,
    progress_fn: &dyn Fn(FacBuildingImportProgress),
) -> Result<usize, String> {
    let file = std::fs::File::open(zip_path)
        .map_err(|e| format!("ZIP 파일 열기 실패: {}", e))?;
    let mut archive = zip::ZipArchive::new(file)
        .map_err(|e| format!("ZIP 아카이브 읽기 실패: {}", e))?;

    // ZIP 내에서 .shp와 .dbf 파일 찾기
    let mut shp_name = None;
    let mut dbf_name = None;
    for i in 0..archive.len() {
        let entry = archive.by_index(i).map_err(|e| format!("ZIP 항목 읽기 실패: {}", e))?;
        let name_lower = entry.name().to_lowercase();
        if name_lower.ends_with(".shp") && !name_lower.contains("__macosx") {
            shp_name = Some(entry.name().to_string());
        }
        if name_lower.ends_with(".dbf") && !name_lower.contains("__macosx") {
            dbf_name = Some(entry.name().to_string());
        }
    }

    let shp_entry_name = shp_name.ok_or("ZIP에서 .shp 파일을 찾을 수 없습니다")?;
    let dbf_entry_name = dbf_name.ok_or("ZIP에서 .dbf 파일을 찾을 수 없습니다")?;

    // 임시 디렉토리에 추출
    let temp_dir = std::env::temp_dir().join(format!("airmove_fac_{}", region));
    let _ = std::fs::create_dir_all(&temp_dir);

    let shp_path = temp_dir.join("fac_buildings.shp");
    let dbf_path = temp_dir.join("fac_buildings.dbf");

    extract_zip_entry(&mut archive, &shp_entry_name, &shp_path)?;
    extract_zip_entry(&mut archive, &dbf_entry_name, &dbf_path)?;

    progress_fn(FacBuildingImportProgress {
        region: region.to_string(),
        total: 0,
        processed: 0,
        status: "SHP 파일 로딩 중...".to_string(),
    });

    // DBF EUC-KR 필드 파싱 (건물명, 동명칭)
    let euckr_bld_names = parse_dbf_euckr_field(&dbf_path, &["BLD_NM"]);
    let euckr_dong_names = parse_dbf_euckr_field(&dbf_path, &["DONG_NM"]);

    // shapefile 크레이트로 .shp + .dbf 동시 읽기
    let mut reader = shapefile::Reader::from_path(&shp_path)
        .map_err(|e| format!("SHP 파일 읽기 실패: {}", e))?;

    // 기존 region 데이터 삭제
    conn.execute("DELETE FROM fac_buildings WHERE region = ?1", params![region])
        .map_err(|e| format!("기존 데이터 삭제 실패: {}", e))?;
    conn.execute("DELETE FROM fac_building_import_log WHERE region = ?1", params![region])
        .map_err(|e| format!("임포트 로그 삭제 실패: {}", e))?;

    let mut count = 0usize;
    let mut inserted = 0usize;
    let batch_size = 10_000;

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(
        "INSERT INTO fac_buildings (region, centroid_lat, centroid_lon, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon, height, building_name, dong_name, usability, pnu, bd_mgt_sn, polygon_json, ground_elev)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)"
    ).map_err(|e| format!("INSERT 준비 실패: {}", e))?;

    let loop_result: Result<(), String> = (|| {
        for result in reader.iter_shapes_and_records() {
            let (shape, record) = result.map_err(|e| format!("레코드 읽기 실패: {}", e))?;

            count += 1;

            // HEIGHT 추출 — 0 이하는 스킵
            let height = get_field_as_f64(&record, &["HEIGHT"]);
            let height = match height {
                Some(h) if h > 0.0 && h <= MAX_HEIGHT_M => h,
                _ => {
                    if count % batch_size == 0 {
                        conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                        conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
                        progress_fn(FacBuildingImportProgress {
                            region: region.to_string(),
                            total: 0,
                            processed: count,
                            status: format!("처리 중... {}건 ({}건 유효)", count, inserted),
                        });
                    }
                    continue;
                }
            };

            // 용도 (층수 검증에 필요하므로 먼저 추출)
            let usability = get_field_as_string(&record, &["USABILITY"]);

            // 층수 대비 높이 검증 — GRND_FLR(지상층수) + 용도별 차등
            if let Some(floors) = get_field_as_f64(&record, &["GRND_FLR"]) {
                if floors >= 1.0 {
                    let h_per_floor = height / floors;
                    let is_industrial = usability.as_deref().map_or(false, |u| {
                        u.contains("공장") || u.contains("창고") || u.contains("산업")
                            || u.contains("발전") || u.contains("저장")
                    });
                    let max_hpf = if is_industrial {
                        MAX_HEIGHT_PER_FLOOR_INDUSTRIAL
                    } else {
                        MAX_HEIGHT_PER_FLOOR_DEFAULT
                    };
                    if h_per_floor > max_hpf {
                        continue;
                    }
                }
            }

            // 건물명 (EUC-KR 디코딩)
            let building_name = euckr_bld_names.as_ref()
                .and_then(|names| names.get(count - 1).cloned().flatten())
                .or_else(|| get_field_as_string(&record, &["BLD_NM"]));

            // 동명칭 (EUC-KR 디코딩)
            let dong_name = euckr_dong_names.as_ref()
                .and_then(|names| names.get(count - 1).cloned().flatten())
                .or_else(|| get_field_as_string(&record, &["DONG_NM"]));

            // PNU, 도로명주소건물관리번호 (ASCII) — usability는 위에서 이미 추출
            let pnu = get_field_as_string(&record, &["PNU"]);
            let bd_mgt_sn = get_field_as_string(&record, &["BD_MGT_SN"]);

            // bbox + centroid 계산 + 폴리곤 WGS84 변환
            let (bbox, polygon_json) = match &shape {
                shapefile::Shape::Polygon(poly) => {
                    let b = compute_polygon_bbox_centroid(poly);
                    let pj = extract_polygon_wgs84(poly.rings().first().map(|r| r.points()));
                    (b, pj)
                }
                shapefile::Shape::PolygonZ(poly) => {
                    let b = compute_polygon_z_bbox_centroid(poly);
                    let pj = extract_polygon_wgs84(poly.rings().first().map(|r| r.points()));
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
                None => continue, // 폴리곤 필수
            };

            // EPSG:5186 → WGS84
            let (clat, clon) = epsg5186_to_wgs84(cx, cy);
            let (min_lat, min_lon) = epsg5186_to_wgs84(min_x, min_y);
            let (max_lat, max_lon) = epsg5186_to_wgs84(max_x, max_y);

            // 한국 영역 검증
            if clat < 33.0 || clat > 43.0 || clon < 124.0 || clon > 132.0 {
                continue;
            }

            // centroid 지반고 (SRTM) — 3D 렌더링 및 LoS 단면도 base로 사용
            let ground_elev = srtm.get_elevation(clat, clon).unwrap_or(0.0);

            stmt.execute(params![
                region, clat, clon, min_lat, min_lon, max_lat, max_lon,
                height, building_name, dong_name, usability, pnu, bd_mgt_sn, polygon_json,
                ground_elev,
            ]).map_err(|e| format!("INSERT 실패: {}", e))?;

            inserted += 1;

            if count % batch_size == 0 {
                conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
                progress_fn(FacBuildingImportProgress {
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

    // 임포트 로그 기록
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let file_date = today_yyyymm();

    conn.execute(
        "INSERT OR REPLACE INTO fac_building_import_log (region, file_date, imported_at, record_count)
         VALUES (?1, ?2, ?3, ?4)",
        params![region, file_date, now, inserted as i64],
    ).map_err(|e| format!("임포트 로그 저장 실패: {}", e))?;

    // 임시 파일 정리
    let _ = std::fs::remove_dir_all(&temp_dir);

    progress_fn(FacBuildingImportProgress {
        region: region.to_string(),
        total: count,
        processed: count,
        status: format!("완료: {}건 중 {}건 임포트", count, inserted),
    });

    Ok(inserted)
}

/// 뷰포트 내 건물통합정보 3D 건물 조회 (폴리곤 포함, 높은 건물 우선)
pub fn query_fac_buildings_3d(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: f64,
    max_count: usize,
) -> Result<Vec<Building3D>, String> {
    let mut stmt = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height, building_name, usability, polygon_json, COALESCE(ground_elev, 0)
         FROM fac_buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height >= ?5
           AND height <= ?6
         ORDER BY height DESC
         LIMIT ?7"
    ).map_err(|e| format!("건물통합정보 3D 쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map(
        params![min_lat, max_lat, min_lon, max_lon, min_height_m, MAX_HEIGHT_M, max_count as i64],
        |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, f64>(6)?,
            ))
        },
    ).map_err(|e| format!("건물통합정보 3D 쿼리 실행 실패: {}", e))?;

    let mut result = Vec::new();
    for row in rows {
        let (lat, lon, height, name, usage, poly_json, ground_elev) =
            row.map_err(|e| format!("건물통합정보 3D 행 읽기 실패: {}", e))?;

        let polygon: Vec<[f64; 2]> = match serde_json::from_str(&poly_json) {
            Ok(p) => p,
            Err(_) => continue,
        };

        if polygon.len() < 3 {
            continue;
        }

        result.push(Building3D {
            lat,
            lon,
            height_m: height,
            ground_elev_m: ground_elev,
            polygon,
            name,
            usage,
            source: "fac".to_string(),
            group_color: None,
        });
    }

    Ok(result)
}

/// 기존 fac_buildings 중 ground_elev가 NULL인 행에 SRTM 표고 일괄 채우기
/// 앱 시작 시 1회만 수행 (settings 플래그로 중복 실행 방지)
pub fn backfill_ground_elev(
    conn: &Connection,
    srtm: &mut SrtmReader,
) -> Result<usize, String> {
    // NULL 상태 행의 좌표 수집
    let mut stmt = conn
        .prepare("SELECT id, centroid_lat, centroid_lon FROM fac_buildings WHERE ground_elev IS NULL")
        .map_err(|e| format!("백필 SELECT 준비 실패: {}", e))?;
    let rows: Vec<(i64, f64, f64)> = stmt
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
        .map_err(|e| format!("백필 쿼리 실패: {}", e))?
        .filter_map(|r| r.ok())
        .collect();

    if rows.is_empty() {
        return Ok(0);
    }
    log::info!("[fac_building] ground_elev 백필 시작: {} 행", rows.len());

    // SRTM 타일 미리 로드 (한국 전역)
    srtm.preload_tiles(33, 43, 124, 132);

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
    let updated = {
        let mut upd = conn
            .prepare("UPDATE fac_buildings SET ground_elev = ?1 WHERE id = ?2")
            .map_err(|e| format!("백필 UPDATE 준비 실패: {}", e))?;
        let mut n = 0usize;
        for (id, lat, lon) in &rows {
            let g = srtm.get_elevation(*lat, *lon).unwrap_or(0.0);
            if upd.execute(params![g, id]).is_ok() {
                n += 1;
            }
        }
        n
    };
    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

    log::info!("[fac_building] ground_elev 백필 완료: {} 행", updated);
    Ok(updated)
}

/// 임포트 현황 조회
pub fn get_import_status(conn: &Connection) -> Result<Vec<FacBuildingImportStatus>, String> {
    let mut stmt = conn.prepare(
        "SELECT region, file_date, imported_at, record_count FROM fac_building_import_log ORDER BY region"
    ).map_err(|e| format!("쿼리 실패: {}", e))?;

    let rows = stmt.query_map([], |row| {
        Ok(FacBuildingImportStatus {
            region: row.get(0)?,
            file_date: row.get(1)?,
            imported_at: row.get(2)?,
            record_count: row.get(3)?,
        })
    }).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("결과 수집 실패: {}", e))
}

/// 건물통합정보 데이터 삭제
pub fn clear_data(conn: &Connection, region: Option<&str>) -> Result<(), String> {
    match region {
        Some(r) => {
            conn.execute("DELETE FROM fac_buildings WHERE region = ?1", params![r])
                .map_err(|e| format!("삭제 실패: {}", e))?;
            conn.execute("DELETE FROM fac_building_import_log WHERE region = ?1", params![r])
                .map_err(|e| format!("로그 삭제 실패: {}", e))?;
        }
        None => {
            conn.execute("DELETE FROM fac_buildings", [])
                .map_err(|e| format!("전체 삭제 실패: {}", e))?;
            conn.execute("DELETE FROM fac_building_import_log", [])
                .map_err(|e| format!("전체 로그 삭제 실패: {}", e))?;
        }
    }
    Ok(())
}
