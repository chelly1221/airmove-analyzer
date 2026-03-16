//! GIS건물통합정보 SHP 임포트 및 LOS 경로 건물 쿼리
//!
//! vworld GIS건물통합정보 SHP(EPSG:5186) 파일을 파싱하여 SQLite에 저장하고,
//! LOS 경로 상의 건물을 조회하여 높이 정보를 반환.

use std::io::{Read as IoRead, Seek};
use std::path::Path;

use encoding_rs::EUC_KR;
use rusqlite::{params, Connection};
use serde::Serialize;
use shapefile::dbase::FieldValue;

use crate::coord::epsg5186_to_wgs84;

/// 건물 높이 상한 (m) — 한국 최고층 롯데월드타워 ~555m, 여유 포함 1000m
const MAX_BUILDING_HEIGHT_M: f64 = 1000.0;

/// LOS 경로 상의 건물 정보 (프론트엔드 반환)
#[derive(Serialize, Clone, Debug)]
pub struct BuildingOnPath {
    pub distance_km: f64,
    pub height_m: f64,
    pub ground_elev_m: f64,
    pub total_height_m: f64,
    pub name: Option<String>,
    pub address: Option<String>,
    pub usage: Option<String>,
    pub lat: f64,
    pub lon: f64,
}

/// 건물 데이터 임포트 상태
#[derive(Serialize, Clone, Debug)]
pub struct BuildingImportStatus {
    pub region: String,
    pub file_date: String,
    pub imported_at: i64,
    pub record_count: i64,
}

/// 임포트 진행률 이벤트
#[derive(Clone, Serialize)]
pub struct BuildingImportProgress {
    pub region: String,
    pub total: usize,
    pub processed: usize,
    pub status: String,
}

/// SHP ZIP 파일에서 건물 데이터를 임포트
pub fn import_from_zip(
    conn: &Connection,
    zip_path: &str,
    region: &str,
    progress_fn: &dyn Fn(BuildingImportProgress),
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
    let temp_dir = std::env::temp_dir().join(format!("airmove_bld_{}", region));
    let _ = std::fs::create_dir_all(&temp_dir);

    let shp_path = temp_dir.join("buildings.shp");
    let dbf_path = temp_dir.join("buildings.dbf");

    extract_zip_entry(&mut archive, &shp_entry_name, &shp_path)?;
    extract_zip_entry(&mut archive, &dbf_entry_name, &dbf_path)?;

    progress_fn(BuildingImportProgress {
        region: region.to_string(),
        total: 0,
        processed: 0,
        status: "SHP 파일 로딩 중...".to_string(),
    });

    // DBF 원본 바이트에서 EUC-KR 건물명/주소 인덱스 구축
    // 건물명: A24(건축물명칭) 우선, A25(시군구건축물명칭) 차선
    let euckr_bldg_names = parse_dbf_euckr_field(&dbf_path, &["BLD_NM", "BULD_NM", "BDTLNM", "A24"]);
    let euckr_bldg_names2 = parse_dbf_euckr_field(&dbf_path, &["A25"]);
    // 주소: A4(대지위치) 우선
    let euckr_addrs = parse_dbf_euckr_field(&dbf_path, &["PLATPLC", "NEWPLATPLC", "A4", "DONG_NM", "NAM"]);
    // 용도: A9(주용도코드명, 예: "단독주택", "아파트")
    let euckr_usage = parse_dbf_euckr_field(&dbf_path, &["A9"]);

    // shapefile 크레이트로 .shp + .dbf 동시 읽기
    let mut reader = shapefile::Reader::from_path(&shp_path)
        .map_err(|e| format!("SHP 파일 읽기 실패: {}", e))?;

    // 기존 region 데이터 삭제
    conn.execute("DELETE FROM buildings WHERE region = ?1", params![region])
        .map_err(|e| format!("기존 데이터 삭제 실패: {}", e))?;
    conn.execute("DELETE FROM building_import_log WHERE region = ?1", params![region])
        .map_err(|e| format!("임포트 로그 삭제 실패: {}", e))?;

    let mut count = 0usize;
    let mut inserted = 0usize;
    let batch_size = 10_000;

    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare(
        "INSERT INTO buildings (region, centroid_lat, centroid_lon, bbox_min_lat, bbox_min_lon, bbox_max_lat, bbox_max_lon, height, ground_floors, building_name, address, usage)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)"
    ).map_err(|e| format!("INSERT 준비 실패: {}", e))?;

    for result in reader.iter_shapes_and_records() {
        let (shape, record) = result.map_err(|e| format!("레코드 읽기 실패: {}", e))?;

        count += 1;

        // 높이 추출 (A16=높이(m), 0이면 skip)
        let height = get_field_as_f64(&record, &["A16", "HEIGHT", "HEIGHT_M", "BDTYP_HG", "BULD_HG"])
            .filter(|h| *h > 0.0);

        let height = match height {
            Some(h) if h > 0.0 && h <= MAX_BUILDING_HEIGHT_M => h,
            _ => {
                if count % batch_size == 0 {
                    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
                    conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
                    progress_fn(BuildingImportProgress {
                        region: region.to_string(),
                        total: 0,
                        processed: count,
                        status: format!("처리 중... {}건 ({}건 유효)", count, inserted),
                    });
                }
                continue;
            }
        };

        // 지상층수 (A26)
        let ground_floors = get_field_as_f64(&record, &["A26", "GRND_FLR", "GRND_FLCNT", "GRD_FLR_CO"])
            .map(|f| f as i32);

        // 건물명: A24 우선 → A25 fallback (실제 건축물명칭만)
        let building_name = euckr_bldg_names.as_ref()
            .and_then(|names| names.get(count - 1).cloned().flatten())
            .or_else(|| {
                euckr_bldg_names2.as_ref()
                    .and_then(|names| names.get(count - 1).cloned().flatten())
            })
            .or_else(|| get_field_as_string(&record, &["BLD_NM", "BULD_NM", "BDTLNM"]));

        // 주소: A4(대지위치) 우선
        let address = euckr_addrs.as_ref()
            .and_then(|addrs| addrs.get(count - 1).cloned().flatten())
            .or_else(|| get_field_as_string(&record, &["PLATPLC", "NEWPLATPLC", "A4", "DONG_NM", "NAM"]));

        // 용도: A9(주용도코드명, 예: "단독주택", "아파트")
        let usage = euckr_usage.as_ref()
            .and_then(|u| u.get(count - 1).cloned().flatten())
            .or_else(|| get_field_as_string(&record, &["A9"]));

        // bbox + centroid 계산 (EPSG:5186 좌표)
        let bbox = match &shape {
            shapefile::Shape::Polygon(poly) => {
                compute_polygon_bbox_centroid(poly)
            }
            shapefile::Shape::PolygonZ(poly) => {
                compute_polygon_z_bbox_centroid(poly)
            }
            _ => continue,
        };

        let (cx, cy, min_x, min_y, max_x, max_y) = match bbox {
            Some(v) => v,
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
            region, clat, clon, min_lat, min_lon, max_lat, max_lon,
            height, ground_floors, building_name, address, usage,
        ]).map_err(|e| format!("INSERT 실패: {}", e))?;

        inserted += 1;

        if count % batch_size == 0 {
            conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;
            conn.execute_batch("BEGIN").map_err(|e| e.to_string())?;
            progress_fn(BuildingImportProgress {
                region: region.to_string(),
                total: 0,
                processed: count,
                status: format!("처리 중... {}건 ({}건 유효)", count, inserted),
            });
        }
    }

    conn.execute_batch("COMMIT").map_err(|e| e.to_string())?;

    // 임포트 로그 기록
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let file_date = today_yyyymm();

    conn.execute(
        "INSERT OR REPLACE INTO building_import_log (region, file_date, imported_at, record_count)
         VALUES (?1, ?2, ?3, ?4)",
        params![region, file_date, now, inserted as i64],
    ).map_err(|e| format!("임포트 로그 저장 실패: {}", e))?;

    // 임시 파일 정리
    let _ = std::fs::remove_dir_all(&temp_dir);

    progress_fn(BuildingImportProgress {
        region: region.to_string(),
        total: count,
        processed: count,
        status: format!("완료: {}건 중 {}건 임포트", count, inserted),
    });

    Ok(inserted)
}

/// LOS 경로(레이더→타겟) 상의 건물 조회
pub fn query_buildings_along_path(
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
    target_lat: f64,
    target_lon: f64,
    corridor_width_m: f64,
) -> Result<Vec<BuildingOnPath>, String> {
    let buffer_deg = corridor_width_m / 111_000.0;

    let min_lat = radar_lat.min(target_lat) - buffer_deg;
    let max_lat = radar_lat.max(target_lat) + buffer_deg;
    let min_lon = radar_lon.min(target_lon) - buffer_deg;
    let max_lon = radar_lon.max(target_lon) + buffer_deg;

    let mut stmt = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height, ground_floors, building_name, address, usage
         FROM buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height > 0
           AND height <= ?5"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map(
        params![min_lat, max_lat, min_lon, max_lon, MAX_BUILDING_HEIGHT_M],
        |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, Option<i32>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
            ))
        },
    ).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    let total_dist = haversine_km(radar_lat, radar_lon, target_lat, target_lon);
    if total_dist < 0.001 {
        return Ok(Vec::new());
    }

    let dx = target_lon - radar_lon;
    let dy = target_lat - radar_lat;
    let path_len_sq = dx * dx + dy * dy;

    let mut buildings = Vec::new();

    for row in rows {
        let (blat, blon, height, _floors, name, address, usage) = row.map_err(|e| format!("행 읽기 실패: {}", e))?;

        let bx = blon - radar_lon;
        let by = blat - radar_lat;
        let t = (bx * dx + by * dy) / path_len_sq;

        if t < -0.01 || t > 1.01 {
            continue;
        }

        let proj_lon = radar_lon + t * dx;
        let proj_lat = radar_lat + t * dy;

        let perp_dist_m = haversine_km(blat, blon, proj_lat, proj_lon) * 1000.0;
        if perp_dist_m > corridor_width_m {
            continue;
        }

        let distance_km = t.clamp(0.0, 1.0) * total_dist;

        buildings.push(BuildingOnPath {
            distance_km,
            height_m: height,
            ground_elev_m: 0.0,
            total_height_m: height,
            name,
            address,
            usage,
            lat: blat,
            lon: blon,
        });
    }

    // 수동 등록 건물도 경로 분석에 포함
    let geo_buffer = 0.01; // ~1.1km 버퍼 — 대형 도형 커버
    let mut stmt2 = conn.prepare(
        "SELECT latitude, longitude, height, ground_elev, name, memo, geometry_type, geometry_json
         FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4"
    ).map_err(|e| format!("수동 건물 쿼리 준비 실패: {}", e))?;

    let manual_rows = stmt2.query_map(
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
    ).map_err(|e| format!("수동 건물 쿼리 실행 실패: {}", e))?;

    for row in manual_rows {
        let (mlat, mlon, height, ground_elev, name, memo, geo_type, geo_json) = row.map_err(|e| format!("수동 건물 행 읽기 실패: {}", e))?;

        // geometry 확장하여 샘플 포인트 생성
        let sample_pts = expand_manual_building_geometry(mlat, mlon, geo_type.as_deref(), geo_json.as_deref());

        for (slat, slon) in &sample_pts {
            let bx = slon - radar_lon;
            let by = slat - radar_lat;
            let t = (bx * dx + by * dy) / path_len_sq;
            if t < -0.01 || t > 1.01 {
                continue;
            }
            let proj_lon = radar_lon + t * dx;
            let proj_lat = radar_lat + t * dy;
            let perp_dist_m = haversine_km(*slat, *slon, proj_lat, proj_lon) * 1000.0;
            if perp_dist_m > corridor_width_m {
                continue;
            }
            let distance_km = t.clamp(0.0, 1.0) * total_dist;
            buildings.push(BuildingOnPath {
                distance_km,
                height_m: height,
                ground_elev_m: ground_elev,
                total_height_m: height + ground_elev,
                name: name.clone(),
                address: memo.clone(), // 수동 건물은 memo를 address로
                usage: None,
                lat: *slat,
                lon: *slon,
            });
            break; // 같은 건물의 다른 샘플 포인트는 중복 방지
        }
    }

    buildings.sort_by(|a, b| a.distance_km.partial_cmp(&b.distance_km).unwrap_or(std::cmp::Ordering::Equal));

    Ok(buildings)
}

/// 임포트 현황 조회
pub fn get_import_status(conn: &Connection) -> Result<Vec<BuildingImportStatus>, String> {
    let mut stmt = conn.prepare(
        "SELECT region, file_date, imported_at, record_count FROM building_import_log ORDER BY region"
    ).map_err(|e| format!("쿼리 실패: {}", e))?;

    let rows = stmt.query_map([], |row| {
        Ok(BuildingImportStatus {
            region: row.get(0)?,
            file_date: row.get(1)?,
            imported_at: row.get(2)?,
            record_count: row.get(3)?,
        })
    }).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("결과 수집 실패: {}", e))
}

/// 건물 데이터 삭제
pub fn clear_building_data(conn: &Connection, region: Option<&str>) -> Result<(), String> {
    match region {
        Some(r) => {
            conn.execute("DELETE FROM buildings WHERE region = ?1", params![r])
                .map_err(|e| format!("삭제 실패: {}", e))?;
            conn.execute("DELETE FROM building_import_log WHERE region = ?1", params![r])
                .map_err(|e| format!("로그 삭제 실패: {}", e))?;
        }
        None => {
            conn.execute("DELETE FROM buildings", [])
                .map_err(|e| format!("전체 삭제 실패: {}", e))?;
            conn.execute("DELETE FROM building_import_log", [])
                .map_err(|e| format!("전체 로그 삭제 실패: {}", e))?;
        }
    }
    Ok(())
}

// ─── 영역 내 건물 조회 (커버리지 맵용) ──────────────────────────

/// 영역 내 건물 정보 (좌표 + 높이만 반환, 경량)
#[derive(Serialize, Clone, Debug)]
pub struct BuildingInArea {
    pub lat: f64,
    pub lon: f64,
    pub height_m: f64,
}

/// 건물 오버레이용 상세 정보 (이름/주소/용도 포함)
#[derive(Serialize, Clone, Debug)]
pub struct BuildingForOverlay {
    pub lat: f64,
    pub lon: f64,
    pub height_m: f64,
    pub name: Option<String>,
    pub address: Option<String>,
    pub usage: Option<String>,
    /// "gis" | "manual"
    pub source: String,
}

/// 바운딩 박스 내 건물 조회 (오버레이용, 이름/주소/용도 포함)
pub fn query_buildings_for_overlay(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: f64,
) -> Result<Vec<BuildingForOverlay>, String> {
    let mut result = Vec::new();

    // 1) GIS 건물
    let mut stmt = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height, building_name, address, usage
         FROM buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height >= ?5
           AND height <= ?6"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map(
        params![min_lat, max_lat, min_lon, max_lon, min_height_m, MAX_BUILDING_HEIGHT_M],
        |row| {
            Ok(BuildingForOverlay {
                lat: row.get(0)?,
                lon: row.get(1)?,
                height_m: row.get(2)?,
                name: row.get(3)?,
                address: row.get(4)?,
                usage: row.get(5)?,
                source: "gis".to_string(),
            })
        },
    ).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    for row in rows {
        result.push(row.map_err(|e| format!("행 읽기 실패: {}", e))?);
    }

    // 2) 수동 등록 건물
    let mut stmt2 = conn.prepare(
        "SELECT name, latitude, longitude, height, ground_elev, memo
         FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4"
    ).map_err(|e| format!("수동 건물 쿼리 준비 실패: {}", e))?;

    let rows2 = stmt2.query_map(
        params![min_lat, max_lat, min_lon, max_lon],
        |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, f64>(4)?,
                row.get::<_, String>(5)?,
            ))
        },
    ).map_err(|e| format!("수동 건물 쿼리 실행 실패: {}", e))?;

    for row in rows2 {
        let (name, lat, lon, height, ground_elev, memo) = row.map_err(|e| format!("수동 건물 행 읽기 실패: {}", e))?;
        result.push(BuildingForOverlay {
            lat,
            lon,
            height_m: height + ground_elev,
            name: if name.is_empty() { None } else { Some(name) },
            address: None,
            usage: if memo.is_empty() { None } else { Some(memo) },
            source: "manual".to_string(),
        });
    }

    Ok(result)
}

/// 바운딩 박스 내 건물 조회 (GIS건물통합정보 + 수동 등록 건물 통합)
pub fn query_buildings_in_bbox(
    conn: &Connection,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: f64,
) -> Result<Vec<BuildingInArea>, String> {
    let mut result = Vec::new();

    // 1) GIS 건물 데이터
    let mut stmt = conn.prepare(
        "SELECT centroid_lat, centroid_lon, height
         FROM buildings
         WHERE centroid_lat BETWEEN ?1 AND ?2
           AND centroid_lon BETWEEN ?3 AND ?4
           AND height >= ?5
           AND height <= ?6"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map(
        params![min_lat, max_lat, min_lon, max_lon, min_height_m, MAX_BUILDING_HEIGHT_M],
        |row| {
            Ok(BuildingInArea {
                lat: row.get(0)?,
                lon: row.get(1)?,
                height_m: row.get(2)?,
            })
        },
    ).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    for row in rows {
        result.push(row.map_err(|e| format!("행 읽기 실패: {}", e))?);
    }

    // 2) 수동 등록 건물 (geometry 확장 지원)
    let geo_buffer = 0.01; // ~1.1km 버퍼
    let mut stmt2 = conn.prepare(
        "SELECT latitude, longitude, height, ground_elev, geometry_type, geometry_json
         FROM manual_buildings
         WHERE latitude BETWEEN ?1 AND ?2
           AND longitude BETWEEN ?3 AND ?4
           AND (height + ground_elev) >= ?5"
    ).map_err(|e| format!("수동 건물 쿼리 준비 실패: {}", e))?;

    let rows2 = stmt2.query_map(
        params![min_lat - geo_buffer, max_lat + geo_buffer, min_lon - geo_buffer, max_lon + geo_buffer, min_height_m],
        |row| {
            Ok((
                row.get::<_, f64>(0)?,
                row.get::<_, f64>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
            ))
        },
    ).map_err(|e| format!("수동 건물 쿼리 실행 실패: {}", e))?;

    for row in rows2 {
        let (clat, clon, height, ground_elev, geo_type, geo_json) = row.map_err(|e| format!("수동 건물 행 읽기 실패: {}", e))?;
        let total_h = height + ground_elev;

        let sample_pts = expand_manual_building_geometry(clat, clon, geo_type.as_deref(), geo_json.as_deref());
        for (slat, slon) in &sample_pts {
            // 원래 bbox 범위에 들어오는 포인트만 추가
            if *slat >= min_lat && *slat <= max_lat && *slon >= min_lon && *slon <= max_lon {
                result.push(BuildingInArea {
                    lat: *slat,
                    lon: *slon,
                    height_m: total_h,
                });
            }
        }
    }

    Ok(result)
}

// ─── 수동 등록 건물 CRUD ─────────────────────────────────────────

/// 수동 등록 건물
#[derive(Serialize, Clone, Debug)]
pub struct ManualBuilding {
    pub id: i64,
    pub name: String,
    pub latitude: f64,
    pub longitude: f64,
    pub height: f64,
    pub ground_elev: f64,
    pub memo: String,
    /// 도형 유형: "point" | "rectangle" | "circle" | "line"
    pub geometry_type: String,
    /// 도형 좌표 JSON (rectangle: [[lat,lon]x4] 4꼭짓점 (레거시: [[minLat,minLon],[maxLat,maxLon]]), circle: {center:[lat,lon],semi_major_m,semi_minor_m,rotation_deg}, line: [[lat,lon],...])
    pub geometry_json: Option<String>,
}

/// 수동 건물 전체 조회
pub fn list_manual_buildings(conn: &Connection) -> Result<Vec<ManualBuilding>, String> {
    let mut stmt = conn.prepare(
        "SELECT id, name, latitude, longitude, height, ground_elev, memo, geometry_type, geometry_json FROM manual_buildings ORDER BY id"
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map([], |row| {
        Ok(ManualBuilding {
            id: row.get(0)?,
            name: row.get(1)?,
            latitude: row.get(2)?,
            longitude: row.get(3)?,
            height: row.get(4)?,
            ground_elev: row.get(5)?,
            memo: row.get(6)?,
            geometry_type: row.get::<_, Option<String>>(7)?.unwrap_or_else(|| "point".to_string()),
            geometry_json: row.get(8)?,
        })
    }).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("결과 수집 실패: {}", e))
}

/// 수동 건물 추가 (생성된 id 반환)
pub fn add_manual_building(
    conn: &Connection,
    name: &str,
    latitude: f64,
    longitude: f64,
    height: f64,
    ground_elev: f64,
    memo: &str,
    geometry_type: &str,
    geometry_json: Option<&str>,
) -> Result<i64, String> {
    conn.execute(
        "INSERT INTO manual_buildings (name, latitude, longitude, height, ground_elev, memo, geometry_type, geometry_json) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![name, latitude, longitude, height, ground_elev, memo, geometry_type, geometry_json],
    ).map_err(|e| format!("INSERT 실패: {}", e))?;
    Ok(conn.last_insert_rowid())
}

/// 수동 건물 수정
pub fn update_manual_building(
    conn: &Connection,
    id: i64,
    name: &str,
    latitude: f64,
    longitude: f64,
    height: f64,
    ground_elev: f64,
    memo: &str,
    geometry_type: &str,
    geometry_json: Option<&str>,
) -> Result<(), String> {
    conn.execute(
        "UPDATE manual_buildings SET name=?1, latitude=?2, longitude=?3, height=?4, ground_elev=?5, memo=?6, geometry_type=?7, geometry_json=?8 WHERE id=?9",
        params![name, latitude, longitude, height, ground_elev, memo, geometry_type, geometry_json, id],
    ).map_err(|e| format!("UPDATE 실패: {}", e))?;
    Ok(())
}

/// 수동 건물 삭제
pub fn delete_manual_building(conn: &Connection, id: i64) -> Result<(), String> {
    conn.execute("DELETE FROM manual_buildings WHERE id = ?1", params![id])
        .map_err(|e| format!("DELETE 실패: {}", e))?;
    Ok(())
}

// ─── 헬퍼 함수 ─────────────────────────────────────────────────

/// DBF 파일에서 특정 문자열 필드의 원본 바이트를 EUC-KR로 디코딩하여 레코드별 Vec 반환
fn parse_dbf_euckr_field(dbf_path: &Path, field_names: &[&str]) -> Option<Vec<Option<String>>> {
    let data = std::fs::read(dbf_path).ok()?;
    if data.len() < 32 { return None; }

    let num_records = u32::from_le_bytes(data[4..8].try_into().ok()?) as usize;
    let header_size = u16::from_le_bytes(data[8..10].try_into().ok()?) as usize;
    let record_size = u16::from_le_bytes(data[10..12].try_into().ok()?) as usize;
    if record_size == 0 || header_size == 0 || header_size > data.len() {
        return None;
    }

    // 필드 디스크립터 파싱: 오프셋 32부터 32바이트씩, 0x0D 터미네이터
    // field_names 리스트 순서를 우선순위로 사용 (앞쪽이 높은 우선순위)
    let mut field_map: Vec<(String, usize, usize)> = Vec::new(); // (name, offset, len)
    let mut field_offset: usize = 1; // 1바이트 삭제 플래그
    let mut pos = 32;
    while pos + 32 <= header_size && data[pos] != 0x0D {
        let fname_bytes = &data[pos..pos + 11];
        let fname_end = fname_bytes.iter().position(|&b| b == 0).unwrap_or(11);
        let fname = std::str::from_utf8(&fname_bytes[..fname_end]).unwrap_or("");
        let flen = data[pos + 16] as usize;

        if field_names.iter().any(|&n| n.eq_ignore_ascii_case(fname)) {
            field_map.push((fname.to_string(), field_offset, flen));
        }
        field_offset += flen;
        pos += 32;
    }

    // field_names 우선순위 순서로 정렬 (리스트 앞쪽 = 높은 우선순위)
    let (t_off, t_len) = field_names.iter()
        .find_map(|&wanted| {
            field_map.iter()
                .find(|(name, _, _)| name.eq_ignore_ascii_case(wanted))
                .map(|(_, off, len)| (*off, *len))
        })?;

    let mut results = Vec::with_capacity(num_records);
    for i in 0..num_records {
        let rec_start = header_size + i * record_size;
        if rec_start + t_off + t_len > data.len() {
            results.push(None);
            continue;
        }
        let raw = &data[rec_start + t_off..rec_start + t_off + t_len];
        // EUC-KR 디코딩
        let (decoded, _, _) = EUC_KR.decode(raw);
        let trimmed = decoded.trim().to_string();
        if trimmed.is_empty() {
            results.push(None);
        } else {
            results.push(Some(trimmed));
        }
    }

    Some(results)
}

fn extract_zip_entry<R: IoRead + Seek>(
    archive: &mut zip::ZipArchive<R>,
    entry_name: &str,
    dest_path: &Path,
) -> Result<(), String> {
    let mut entry = archive.by_name(entry_name)
        .map_err(|e| format!("ZIP 항목 '{}' 열기 실패: {}", entry_name, e))?;
    let mut out = std::fs::File::create(dest_path)
        .map_err(|e| format!("파일 생성 실패: {}", e))?;
    std::io::copy(&mut entry, &mut out)
        .map_err(|e| format!("파일 추출 실패: {}", e))?;
    Ok(())
}

/// Polygon bbox + centroid (EPSG:5186 좌표)
fn compute_polygon_bbox_centroid(
    poly: &shapefile::Polygon,
) -> Option<(f64, f64, f64, f64, f64, f64)> {
    let rings = poly.rings();
    if rings.is_empty() {
        return None;
    }
    let points = rings[0].points();
    if points.is_empty() {
        return None;
    }

    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;

    for pt in points {
        min_x = min_x.min(pt.x);
        min_y = min_y.min(pt.y);
        max_x = max_x.max(pt.x);
        max_y = max_y.max(pt.y);
        sum_x += pt.x;
        sum_y += pt.y;
    }

    let n = points.len() as f64;
    Some((sum_x / n, sum_y / n, min_x, min_y, max_x, max_y))
}

/// PolygonZ bbox + centroid
fn compute_polygon_z_bbox_centroid(
    poly: &shapefile::PolygonZ,
) -> Option<(f64, f64, f64, f64, f64, f64)> {
    let rings = poly.rings();
    if rings.is_empty() {
        return None;
    }
    let points = rings[0].points();
    if points.is_empty() {
        return None;
    }

    let mut min_x = f64::MAX;
    let mut min_y = f64::MAX;
    let mut max_x = f64::MIN;
    let mut max_y = f64::MIN;
    let mut sum_x = 0.0;
    let mut sum_y = 0.0;

    for pt in points {
        min_x = min_x.min(pt.x);
        min_y = min_y.min(pt.y);
        max_x = max_x.max(pt.x);
        max_y = max_y.max(pt.y);
        sum_x += pt.x;
        sum_y += pt.y;
    }

    let n = points.len() as f64;
    Some((sum_x / n, sum_y / n, min_x, min_y, max_x, max_y))
}

/// DBF 레코드에서 숫자 필드 추출 (여러 필드명 시도)
fn get_field_as_f64(
    record: &shapefile::dbase::Record,
    field_names: &[&str],
) -> Option<f64> {
    for name in field_names {
        if let Some(value) = record.get(name) {
            match value {
                FieldValue::Numeric(Some(v)) => return Some(*v),
                FieldValue::Float(Some(v)) => return Some(*v as f64),
                FieldValue::Double(v) => return Some(*v),
                FieldValue::Integer(v) => return Some(*v as f64),
                FieldValue::Character(Some(s)) => {
                    if let Ok(v) = s.trim().parse::<f64>() {
                        return Some(v);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// DBF 레코드에서 문자열 필드 추출
fn get_field_as_string(
    record: &shapefile::dbase::Record,
    field_names: &[&str],
) -> Option<String> {
    for name in field_names {
        if let Some(value) = record.get(name) {
            if let FieldValue::Character(Some(s)) = value {
                let trimmed = s.trim().to_string();
                if !trimmed.is_empty() {
                    return Some(trimmed);
                }
            }
        }
    }
    None
}

/// Haversine 거리 (km)
fn haversine_km(lat1: f64, lon1: f64, lat2: f64, lon2: f64) -> f64 {
    let r = 6371.0;
    let d_lat = (lat2 - lat1).to_radians();
    let d_lon = (lon2 - lon1).to_radians();
    let a = (d_lat / 2.0).sin().powi(2)
        + lat1.to_radians().cos() * lat2.to_radians().cos() * (d_lon / 2.0).sin().powi(2);
    r * 2.0 * a.sqrt().atan2((1.0 - a).sqrt())
}

/// 수동 건물 geometry_json을 파싱하여 (lat, lon) 샘플 포인트 목록으로 확장.
/// geometry가 없으면 중심점만 반환.
fn expand_manual_building_geometry(
    center_lat: f64,
    center_lon: f64,
    geo_type: Option<&str>,
    geo_json: Option<&str>,
) -> Vec<(f64, f64)> {
    let geo_type = match geo_type {
        Some(t) if t != "point" => t,
        _ => return vec![(center_lat, center_lon)],
    };
    let json_str = match geo_json {
        Some(s) if !s.is_empty() => s,
        _ => return vec![(center_lat, center_lon)],
    };
    let val: serde_json::Value = match serde_json::from_str(json_str) {
        Ok(v) => v,
        Err(_) => return vec![(center_lat, center_lon)],
    };

    match geo_type {
        "rectangle" => {
            if let Some(arr) = val.as_array() {
                if arr.len() == 4 {
                    // 4꼭짓점 형식: [[lat1,lon1],[lat2,lon2],[lat3,lon3],[lat4,lon4]]
                    let corners: Vec<(f64, f64)> = arr.iter().filter_map(|p| {
                        let lat = p.get(0).and_then(|v| v.as_f64())?;
                        let lon = p.get(1).and_then(|v| v.as_f64())?;
                        Some((lat, lon))
                    }).collect();
                    if corners.len() == 4 {
                        let mid_lat = corners.iter().map(|c| c.0).sum::<f64>() / 4.0;
                        let mid_lon = corners.iter().map(|c| c.1).sum::<f64>() / 4.0;
                        let mut pts = corners.clone();
                        // 변 중점 4개
                        for i in 0..4 {
                            let j = (i + 1) % 4;
                            pts.push(((corners[i].0 + corners[j].0) / 2.0, (corners[i].1 + corners[j].1) / 2.0));
                        }
                        pts.push((mid_lat, mid_lon));
                        return pts;
                    }
                } else if arr.len() == 2 {
                    // 레거시: [[minLat, minLon], [maxLat, maxLon]]
                    let min_lat = arr[0].get(0).and_then(|v| v.as_f64()).unwrap_or(center_lat);
                    let min_lon = arr[0].get(1).and_then(|v| v.as_f64()).unwrap_or(center_lon);
                    let max_lat = arr[1].get(0).and_then(|v| v.as_f64()).unwrap_or(center_lat);
                    let max_lon = arr[1].get(1).and_then(|v| v.as_f64()).unwrap_or(center_lon);
                    let mid_lat = (min_lat + max_lat) / 2.0;
                    let mid_lon = (min_lon + max_lon) / 2.0;
                    return vec![
                        (min_lat, min_lon), (min_lat, max_lon),
                        (max_lat, min_lon), (max_lat, max_lon),
                        (mid_lat, min_lon), (mid_lat, max_lon),
                        (min_lat, mid_lon), (max_lat, mid_lon),
                        (mid_lat, mid_lon),
                    ];
                }
            }
        }
        "circle" => {
            let clat = val.get("center").and_then(|c| c.get(0)).and_then(|v| v.as_f64()).unwrap_or(center_lat);
            let clon = val.get("center").and_then(|c| c.get(1)).and_then(|v| v.as_f64()).unwrap_or(center_lon);
            let semi_major = val.get("semi_major_m").and_then(|v| v.as_f64())
                .or_else(|| val.get("radius_m").and_then(|v| v.as_f64()))
                .unwrap_or(0.0);
            let semi_minor = val.get("semi_minor_m").and_then(|v| v.as_f64()).unwrap_or(semi_major);
            let rot_deg = val.get("rotation_deg").and_then(|v| v.as_f64()).unwrap_or(0.0);

            if semi_major < 1.0 {
                return vec![(center_lat, center_lon)];
            }

            let rot_rad = rot_deg.to_radians();
            let cos_lat = clat.to_radians().cos().max(0.01);
            let num_samples = 12;
            let mut pts = Vec::with_capacity(num_samples + 1);
            pts.push((clat, clon));

            for i in 0..num_samples {
                let angle = (i as f64 / num_samples as f64) * 2.0 * std::f64::consts::PI;
                let lx = semi_major * angle.cos();
                let ly = semi_minor * angle.sin();
                let rx = lx * rot_rad.sin() + ly * rot_rad.cos();
                let ry = lx * rot_rad.cos() - ly * rot_rad.sin();
                let dlat = ry / 111_320.0;
                let dlon = rx / (111_320.0 * cos_lat);
                pts.push((clat + dlat, clon + dlon));
            }
            return pts;
        }
        "line" => {
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
        _ => {}
    }

    vec![(center_lat, center_lon)]
}

/// 오늘 날짜 문자열 (YYYY-MM)
fn today_yyyymm() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days = now / 86400;
    let years = 1970 + days / 365;
    let month = (days % 365) / 30 + 1;
    format!("{}-{:02}", years, month.min(12))
}
