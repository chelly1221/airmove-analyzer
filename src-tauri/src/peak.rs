//! 산봉우리 지명 데이터 (연속수치지형도 N3P SHP) 임포트 및 조회
//!
//! 국토지리정보원 연속수치지형도의 산봉우리(N3P) SHP 파일을 파싱하여
//! SQLite에 저장하고, 좌표 기반 인근 산 이름을 로컬 쿼리로 제공.
//! Overpass API 의존성을 제거하고 오프라인 동작을 보장.

use std::path::Path;

use rusqlite::{params, Connection};
use serde::Serialize;
use shapefile::Shape;

use crate::building::{extract_zip_entry, get_field_as_f64, parse_dbf_euckr_field};
use crate::coord::epsg5179_to_wgs84;
use crate::geo::haversine_km;

/// 인근 산봉우리 (프론트엔드 반환)
#[derive(Serialize, Clone, Debug)]
pub struct NearbyPeak {
    pub name: String,
    pub height_m: Option<f64>,
    pub latitude: f64,
    pub longitude: f64,
    pub distance_km: f64,
}

/// 임포트 상태
#[derive(Serialize, Clone, Debug)]
pub struct PeakImportStatus {
    pub file_name: String,
    pub imported_at: i64,
    pub record_count: i64,
}

/// 임포트 진행률 이벤트
#[derive(Clone, Serialize)]
pub struct PeakImportProgress {
    pub total: usize,
    pub processed: usize,
    pub status: String,
}

/// SHP ZIP 파일에서 산봉우리 데이터를 임포트
pub fn import_from_zip(
    conn: &Connection,
    zip_path: &str,
    progress_fn: &dyn Fn(PeakImportProgress),
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

    // 파일명 추출 (임포트 로그용)
    let zip_filename = Path::new(zip_path)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("unknown.zip")
        .to_string();

    // 임시 디렉토리에 추출
    let temp_dir = std::env::temp_dir().join("airmove_peak");
    let _ = std::fs::create_dir_all(&temp_dir);

    let shp_path = temp_dir.join("peaks.shp");
    let dbf_path = temp_dir.join("peaks.dbf");

    extract_zip_entry(&mut archive, &shp_entry_name, &shp_path)?;
    extract_zip_entry(&mut archive, &dbf_entry_name, &dbf_path)?;

    progress_fn(PeakImportProgress {
        total: 0,
        processed: 0,
        status: "SHP 파일 로딩 중...".to_string(),
    });

    // DBF 원본 바이트에서 EUC-KR 산명 인덱스 구축
    let euckr_names = parse_dbf_euckr_field(&dbf_path, &["MTNM"]);

    // shapefile 크레이트로 레코드 읽기
    let reader = shapefile::ShapeReader::from_path(&shp_path)
        .map_err(|e| format!("SHP 읽기 실패: {}", e))?;
    let mut dbf_reader = shapefile::dbase::Reader::from_path(&dbf_path)
        .map_err(|e| format!("DBF 읽기 실패: {}", e))?;

    let shapes: Vec<Shape> = reader
        .read()
        .map_err(|e| format!("SHP 레코드 읽기 실패: {}", e))?;
    let records: Vec<shapefile::dbase::Record> = dbf_reader
        .read()
        .map_err(|e| format!("DBF 레코드 읽기 실패: {}", e))?;

    let total = shapes.len().min(records.len());

    progress_fn(PeakImportProgress {
        total,
        processed: 0,
        status: format!("{}건 변환 및 저장 중...", total),
    });

    // 기존 데이터 삭제
    conn.execute("DELETE FROM peak_names", [])
        .map_err(|e| format!("기존 데이터 삭제 실패: {}", e))?;
    conn.execute("DELETE FROM peak_import_log", [])
        .map_err(|e| format!("임포트 로그 삭제 실패: {}", e))?;

    conn.execute_batch("BEGIN")
        .map_err(|e| format!("트랜잭션 시작 실패: {}", e))?;

    let mut inserted = 0usize;

    for i in 0..total {
        // Point 좌표 추출 (EPSG:5179)
        let (x, y) = match &shapes[i] {
            Shape::Point(pt) => (pt.x, pt.y),
            Shape::PointZ(pt) => (pt.x, pt.y),
            _ => continue,
        };

        // EPSG:5179 → WGS84
        let (lat, lon) = epsg5179_to_wgs84(x, y);

        // 한국 영역 검증 (넓은 범위)
        if lat < 33.0 || lat > 43.0 || lon < 124.0 || lon > 132.0 {
            continue;
        }

        // 산명: EUC-KR 원본 우선 → shapefile 크레이트 fallback
        let name = euckr_names
            .as_ref()
            .and_then(|v| v.get(i).cloned().flatten())
            .or_else(|| {
                crate::building::get_field_as_string(&records[i], &["MTNM"])
            });

        let name = match name {
            Some(n) if !n.is_empty() => n,
            _ => continue, // 이름 없는 포인트는 스킵
        };

        // 높이
        let height = get_field_as_f64(&records[i], &["HEIG"]);

        // 법정동코드
        let bjcd = crate::building::get_field_as_string(&records[i], &["BJCD"]);

        conn.execute(
            "INSERT INTO peak_names (name, height_m, latitude, longitude, bjcd) VALUES (?1, ?2, ?3, ?4, ?5)",
            params![name, height, lat, lon, bjcd],
        ).map_err(|e| format!("INSERT 실패: {}", e))?;

        inserted += 1;

        // 진행률 보고 (1000건마다)
        if inserted % 1000 == 0 {
            progress_fn(PeakImportProgress {
                total,
                processed: i + 1,
                status: format!("{}건 저장 완료...", inserted),
            });
        }
    }

    conn.execute_batch("COMMIT")
        .map_err(|e| format!("커밋 실패: {}", e))?;

    // 임포트 로그 저장
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    conn.execute(
        "INSERT INTO peak_import_log (file_name, imported_at, record_count) VALUES (?1, ?2, ?3)",
        params![zip_filename, now, inserted as i64],
    ).map_err(|e| format!("임포트 로그 저장 실패: {}", e))?;

    // 임시 파일 정리
    let _ = std::fs::remove_dir_all(&temp_dir);

    progress_fn(PeakImportProgress {
        total,
        processed: total,
        status: format!("완료: {}건 임포트", inserted),
    });

    Ok(inserted)
}

/// 좌표 인근 산봉우리 조회 (Overpass API 대체)
pub fn query_nearby_peaks(
    conn: &Connection,
    lat: f64,
    lon: f64,
    radius_km: f64,
) -> Result<Vec<NearbyPeak>, String> {
    // 위도 1° ≈ 111km, 경도는 cos(lat) 보정
    let delta_lat = radius_km / 111.0;
    let delta_lon = radius_km / (111.0 * (lat * std::f64::consts::PI / 180.0).cos());

    let min_lat = lat - delta_lat;
    let max_lat = lat + delta_lat;
    let min_lon = lon - delta_lon;
    let max_lon = lon + delta_lon;

    let mut stmt = conn.prepare(
        "SELECT name, height_m, latitude, longitude FROM peak_names
         WHERE latitude BETWEEN ?1 AND ?2 AND longitude BETWEEN ?3 AND ?4",
    ).map_err(|e| format!("쿼리 준비 실패: {}", e))?;

    let rows = stmt.query_map(params![min_lat, max_lat, min_lon, max_lon], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<f64>>(1)?,
            row.get::<_, f64>(2)?,
            row.get::<_, f64>(3)?,
        ))
    }).map_err(|e| format!("쿼리 실행 실패: {}", e))?;

    let mut peaks: Vec<NearbyPeak> = Vec::new();
    for row in rows {
        let (name, height_m, p_lat, p_lon) = row.map_err(|e| format!("행 읽기 실패: {}", e))?;
        let dist = haversine_km(lat, lon, p_lat, p_lon);
        if dist <= radius_km {
            peaks.push(NearbyPeak {
                name,
                height_m,
                latitude: p_lat,
                longitude: p_lon,
                distance_km: dist,
            });
        }
    }

    // 거리순 정렬
    peaks.sort_by(|a, b| a.distance_km.partial_cmp(&b.distance_km).unwrap_or(std::cmp::Ordering::Equal));
    Ok(peaks)
}

/// 임포트 상태 조회
pub fn get_import_status(conn: &Connection) -> Result<Option<PeakImportStatus>, String> {
    let mut stmt = conn.prepare(
        "SELECT file_name, imported_at, record_count FROM peak_import_log ORDER BY imported_at DESC LIMIT 1",
    ).map_err(|e| format!("쿼리 실패: {}", e))?;

    match stmt.query_row([], |row| {
        Ok(PeakImportStatus {
            file_name: row.get(0)?,
            imported_at: row.get(1)?,
            record_count: row.get(2)?,
        })
    }) {
        Ok(status) => Ok(Some(status)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("상태 조회 실패: {}", e)),
    }
}

/// 산봉우리 데이터 전체 삭제
pub fn clear_data(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM peak_names", [])
        .map_err(|e| format!("삭제 실패: {}", e))?;
    conn.execute("DELETE FROM peak_import_log", [])
        .map_err(|e| format!("로그 삭제 실패: {}", e))?;
    Ok(())
}
