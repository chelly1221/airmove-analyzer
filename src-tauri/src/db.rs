use std::path::Path;

use rusqlite::{params, Connection, Result as SqlResult};

use crate::models::Aircraft;

/// DB 연결 풀 타입 (lib.rs에서 사용)
pub type DbPool = r2d2::Pool<r2d2_sqlite::SqliteConnectionManager>;
pub type PooledConn = r2d2::PooledConnection<r2d2_sqlite::SqliteConnectionManager>;

/// DB 초기화 (테이블 생성)
pub fn init_db(path: &Path) -> SqlResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;
        PRAGMA synchronous=NORMAL;
        PRAGMA cache_size=-32000;
        PRAGMA busy_timeout=5000;
        PRAGMA temp_store=MEMORY;

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        -- 고도 프로파일 캐시 (open-meteo API 결과)
        CREATE TABLE IF NOT EXISTS elevation_cache (
            lat_key TEXT NOT NULL,
            lon_key TEXT NOT NULL,
            elevation REAL NOT NULL,
            PRIMARY KEY (lat_key, lon_key)
        );

        -- LoS 파노라마 캐시 (레이더별, JSON)
        CREATE TABLE IF NOT EXISTS panorama_cache (
            radar_lat TEXT NOT NULL,
            radar_lon TEXT NOT NULL,
            radar_height_m REAL NOT NULL,
            data_json TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (radar_lat, radar_lon)
        );

        -- 수동 등록 건물
        CREATE TABLE IF NOT EXISTS manual_buildings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            height REAL NOT NULL,
            ground_elev REAL NOT NULL DEFAULT 0,
            memo TEXT NOT NULL DEFAULT ''
        );

        -- 수동 비행 병합 이력
        CREATE TABLE IF NOT EXISTS manual_merge_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source_flight_ids_json TEXT NOT NULL,
            mode_s TEXT NOT NULL,
            created_at INTEGER NOT NULL
        );

        -- 커버리지 맵 캐시 (settings에서 분리)
        CREATE TABLE IF NOT EXISTS coverage_cache (
            radar_name TEXT PRIMARY KEY,
            radar_lat REAL NOT NULL,
            radar_lon REAL NOT NULL,
            radar_height REAL NOT NULL,
            max_elev_deg REAL NOT NULL,
            layers_json TEXT NOT NULL,
            computed_at INTEGER NOT NULL
        );

        -- Garble 요약 통계 캐시
        CREATE TABLE IF NOT EXISTS garble_summary_cache (
            mode_s TEXT PRIMARY KEY,
            aircraft_name TEXT,
            total_count INTEGER NOT NULL,
            sidelobe_count INTEGER NOT NULL,
            multipath_count INTEGER NOT NULL,
            time_range_start REAL NOT NULL,
            time_range_end REAL NOT NULL,
            computed_at INTEGER NOT NULL
        );

        -- 기상-Garble 상관분석 캐시
        CREATE TABLE IF NOT EXISTS weather_garble_correlation (
            cache_key TEXT PRIMARY KEY,
            result_json TEXT NOT NULL,
            computed_at INTEGER NOT NULL
        );

        -- 비행검사기 (aircraft.json → DB 이식)
        CREATE TABLE IF NOT EXISTS aircraft (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            registration TEXT NOT NULL DEFAULT '',
            model TEXT NOT NULL DEFAULT '',
            mode_s_code TEXT NOT NULL,
            organization TEXT NOT NULL DEFAULT '',
            memo TEXT NOT NULL DEFAULT '',
            active INTEGER NOT NULL DEFAULT 1
        );

        -- SRTM HGT 타일 (BLOB, 3601×3601 big-endian i16 ≈ 25MB/타일)
        CREATE TABLE IF NOT EXISTS srtm_tiles (
            name TEXT PRIMARY KEY,
            data BLOB NOT NULL,
            downloaded_at INTEGER NOT NULL
        );

        -- SRTM 지반고 융합 보정 (실측 1m DSM 건물 기저부 → HGT 노드별 절대 MSL)
        -- row/col = HGT 노드 인덱스 0..=3600 (row 0 = 북단, col 0 = 서단).
        -- srtm_tiles BLOB 은 원본 그대로 두고, 로드 시점(srtm.rs::load_tile)에만 머지한다.
        -- 델타가 아닌 절대 MSL 을 저장하므로 SRTM 재다운로드 후에도 재계산 없이 자동 재적용된다.
        CREATE TABLE IF NOT EXISTS srtm_ground_corrections (
            tile_name TEXT NOT NULL,
            row INTEGER NOT NULL,
            col INTEGER NOT NULL,
            ground_msl REAL NOT NULL,
            n_samples INTEGER NOT NULL,
            PRIMARY KEY (tile_name, row, col)
        );

        -- 수동 건물 그룹
        CREATE TABLE IF NOT EXISTS building_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#6b7280',
            memo TEXT NOT NULL DEFAULT ''
        );

        -- 산봉우리 지명 (연속수치지형도 N3P SHP 임포트)
        CREATE TABLE IF NOT EXISTS peak_names (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            height_m REAL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            bjcd TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_peak_names_lat ON peak_names(latitude);
        CREATE INDEX IF NOT EXISTS idx_peak_names_lon ON peak_names(longitude);

        CREATE TABLE IF NOT EXISTS peak_import_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_name TEXT NOT NULL,
            imported_at INTEGER NOT NULL,
            record_count INTEGER NOT NULL
        );

        -- 토지이용계획정보 (vworld dsId=14, SHP 임포트)
        CREATE TABLE IF NOT EXISTS landuse_zones (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            region TEXT NOT NULL,
            zone_type_code TEXT NOT NULL DEFAULT '',
            zone_type_name TEXT NOT NULL DEFAULT '',
            centroid_lat REAL NOT NULL,
            centroid_lon REAL NOT NULL,
            bbox_min_lat REAL NOT NULL,
            bbox_min_lon REAL NOT NULL,
            bbox_max_lat REAL NOT NULL,
            bbox_max_lon REAL NOT NULL,
            area_sqm REAL,
            polygon_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_landuse_bbox ON landuse_zones(bbox_min_lat, bbox_max_lat, bbox_min_lon, bbox_max_lon);
        CREATE INDEX IF NOT EXISTS idx_landuse_region ON landuse_zones(region);

        CREATE TABLE IF NOT EXISTS landuse_import_log (
            region TEXT PRIMARY KEY,
            file_date TEXT NOT NULL,
            imported_at INTEGER NOT NULL,
            record_count INTEGER NOT NULL
        );

        -- 토지이용계획도 타일 캐시 (vworld dtkmap 렌더링 타일)
        CREATE TABLE IF NOT EXISTS landuse_tiles (
            z INTEGER NOT NULL,
            x INTEGER NOT NULL,
            y INTEGER NOT NULL,
            data BLOB NOT NULL,
            PRIMARY KEY (z, x, y)
        );

        -- 건물통합정보 (F_FAC_BUILDING SHP 임포트)
        CREATE TABLE IF NOT EXISTS fac_buildings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            region TEXT NOT NULL,
            centroid_lat REAL NOT NULL,
            centroid_lon REAL NOT NULL,
            bbox_min_lat REAL NOT NULL,
            bbox_min_lon REAL NOT NULL,
            bbox_max_lat REAL NOT NULL,
            bbox_max_lon REAL NOT NULL,
            height REAL NOT NULL,
            building_name TEXT,
            dong_name TEXT,
            usability TEXT,
            pnu TEXT,
            bd_mgt_sn TEXT,
            polygon_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_fac_buildings_bbox ON fac_buildings(bbox_min_lat, bbox_max_lat, bbox_min_lon, bbox_max_lon);
        CREATE INDEX IF NOT EXISTS idx_fac_buildings_centroid ON fac_buildings(centroid_lat, centroid_lon);
        CREATE INDEX IF NOT EXISTS idx_fac_buildings_region ON fac_buildings(region);

        CREATE TABLE IF NOT EXISTS fac_building_import_log (
            region TEXT PRIMARY KEY,
            file_date TEXT NOT NULL,
            imported_at INTEGER NOT NULL,
            record_count INTEGER NOT NULL
        );

        -- 자기편각 캐시 (NOAA API 결과 + WMM fallback)
        CREATE TABLE IF NOT EXISTS declination_cache (
            lat_key TEXT NOT NULL,
            lon_key TEXT NOT NULL,
            date_key TEXT NOT NULL,
            declination_deg REAL NOT NULL,
            source TEXT NOT NULL,
            fetched_at INTEGER NOT NULL,
            PRIMARY KEY (lat_key, lon_key, date_key)
        );
        ",
    )?;

    // 구 juso 테이블 삭제 (vworld 실시간 검색으로 대체)
    let _ = conn.execute("DROP TABLE IF EXISTS juso_fts", []);
    let _ = conn.execute("DROP TABLE IF EXISTS juso_addresses", []);
    let _ = conn.execute("DROP TABLE IF EXISTS juso_import_log", []);

    // 구 GIS buildings/building_import_log/weather_cache/cloud_grid_cache 테이블 삭제 (fac_buildings로 대체)
    let _ = conn.execute("DROP TABLE IF EXISTS buildings", []);
    let _ = conn.execute("DROP TABLE IF EXISTS building_import_log", []);
    let _ = conn.execute("DROP TABLE IF EXISTS weather_cache", []);
    let _ = conn.execute("DROP TABLE IF EXISTS cloud_grid_cache", []);

    // 수동 건물에 도형 컬럼 추가
    let _ = conn.execute("ALTER TABLE manual_buildings ADD COLUMN geometry_type TEXT NOT NULL DEFAULT 'polygon'", []);
    let _ = conn.execute("ALTER TABLE manual_buildings ADD COLUMN geometry_json TEXT", []);

    // 레거시 geometry_type 마이그레이션: point/circle/rectangle/line → polygon
    let _ = conn.execute(
        "UPDATE manual_buildings SET geometry_type = 'polygon' WHERE geometry_type IN ('point','circle','rectangle','line')",
        [],
    );
    // multi 내부 서브 도형 JSON도 일괄 변환
    let _ = conn.execute(
        "UPDATE manual_buildings SET geometry_json = REPLACE(REPLACE(REPLACE(REPLACE(geometry_json, '\"type\":\"line\"', '\"type\":\"polygon\"'), '\"type\":\"circle\"', '\"type\":\"polygon\"'), '\"type\":\"rectangle\"', '\"type\":\"polygon\"'), '\"type\":\"point\"', '\"type\":\"polygon\"') WHERE geometry_type = 'multi' AND geometry_json IS NOT NULL",
        [],
    );

    // 수동 건물에 그룹 컬럼 추가
    let _ = conn.execute("ALTER TABLE manual_buildings ADD COLUMN group_id INTEGER REFERENCES building_groups(id) ON DELETE SET NULL", []);

    // 지면 표고 입력 모드: 'auto'(SRTM 자동) | 'manual'(수동 입력) | ''(레거시 미기록)
    let _ = conn.execute("ALTER TABLE manual_buildings ADD COLUMN elev_mode TEXT NOT NULL DEFAULT ''", []);

    // 건물 그룹에 토지이용계획도 컬럼 추가
    let _ = conn.execute("ALTER TABLE building_groups ADD COLUMN plan_image BLOB", []);
    let _ = conn.execute("ALTER TABLE building_groups ADD COLUMN plan_bounds_json TEXT", []);
    let _ = conn.execute("ALTER TABLE building_groups ADD COLUMN plan_opacity REAL NOT NULL DEFAULT 0.5", []);
    let _ = conn.execute("ALTER TABLE building_groups ADD COLUMN plan_rotation REAL NOT NULL DEFAULT 0", []);

    // 건물 그룹에 영역 바운드 컬럼 추가
    let _ = conn.execute("ALTER TABLE building_groups ADD COLUMN area_bounds_json TEXT", []);

    // 건물 그룹 활성화 플래그 (비활성 그룹의 수동 건물은 LoS/커버리지/3D 렌더링에서 제외)
    let _ = conn.execute("ALTER TABLE building_groups ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1", []);

    // fac_buildings 지반고 컬럼 (SRTM centroid 표고 캐시)
    // NULL = 아직 백필되지 않음, 0 이상 = SRTM 값 계산 완료
    let _ = conn.execute("ALTER TABLE fac_buildings ADD COLUMN ground_elev REAL", []);

    // fac_buildings 실측 지붕고 컬럼 (1m DSM 임포트, NULL = 실측값 없음 → 기존 height 사용)
    let _ = conn.execute("ALTER TABLE fac_buildings ADD COLUMN height_measured REAL", []);

    // fac_buildings 우선순위 중복 억제 컬럼 — NULL=활성, 'manual:<id>'=수동등록 건물에 덮임,
    // 'measured:<fac_id>'=실측3D 행에 덮임. 상위 원인 삭제 시 재계산으로 복원(가역).
    // 값 확정은 자료 등록/임포트 시점(suppression.rs::recompute_area) — 조회 시점 런타임 판정 아님.
    let _ = conn.execute("ALTER TABLE fac_buildings ADD COLUMN suppressed_by TEXT", []);

    // 실측 커버리지 extent(MIN/MAX) 전용 파트셜 커버링 인덱스 — height_measured 컬럼 추가 뒤에 생성해야 한다
    // (CREATE TABLE 배치 시점엔 컬럼이 없어 실패). WHERE 절 텍스트가 measured_building::coverage_bbox 의
    // 쿼리와 동일해야 플래너가 파트셜 인덱스를 선택한다. 있으면 extent 쿼리가 실측 엔트리(≈152k)
    // 인덱스 스캔만으로 끝나고, 없으면 fac_buildings 2.1M 행 풀스캔(~30s).
    // EXPLAIN QUERY PLAN 으로 `SCAN ... USING INDEX idx_fac_buildings_measured_bbox` 확인.
    let _ = conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_fac_buildings_measured_bbox ON fac_buildings(bbox_min_lat, bbox_max_lat, bbox_min_lon, bbox_max_lon) WHERE height_measured IS NOT NULL OR region='실측3D'",
        [],
    );

    // 과거 실측 임포트가 usability(용도)에 '실측(1m DSM)' 표기를 저장했던 것을 NULL 환원 (idempotent)
    // — 용도 컬럼은 실제 용도만, 실측 여부는 height_measured 기준(팝업 '실측자료' 별도 항목 표시)
    let _ = conn.execute(
        "UPDATE fac_buildings SET usability = NULL WHERE usability = '실측(1m DSM)'",
        [],
    );

    // 파노라마 캐시 알고리즘 버전 컬럼 (기존 행은 0 → 로드 시 버전 불일치로 자연 미스)
    let _ = conn.execute("ALTER TABLE panorama_cache ADD COLUMN version INTEGER NOT NULL DEFAULT 0", []);

    // 보고서 저장 기능 폐지 — 기존 DB에 남은 미사용 테이블 제거 (idempotent)
    let _ = conn.execute("DROP TABLE IF EXISTS saved_reports", []);

    // 레이더 자체 건물 제외 도입(building::radar_own_building_ids) 이전에 계산된 파노라마 캐시는
    // 안테나 발밑 구조물을 초대형 근거리 장애물로 담고 있다. 캐시 키(좌표·높이·version)로는
    // 걸러지지 않으므로 설정 플래그 기반 1회성 전건 삭제로 무효화한다(파노라마는 온디맨드 재계산이라 저렴).
    // coverage_cache 는 사용자가 명시적으로 재생성하는 자료라 건드리지 않는다.
    let ver = get_setting(&conn, "panorama_cache_ver").unwrap_or(None);
    if ver.as_deref() != Some("2") {
        let _ = conn.execute("DELETE FROM panorama_cache", []);
        let _ = set_setting(&conn, "panorama_cache_ver", "2");
    }

    Ok(conn)
}

/// r2d2 연결 풀 초기화
pub fn init_db_pool(path: &Path) -> Result<DbPool, String> {
    // 먼저 단일 연결로 마이그레이션 수행
    init_db(path).map_err(|e| format!("DB migration: {}", e))?;

    let manager = r2d2_sqlite::SqliteConnectionManager::file(path)
        .with_init(|conn| {
            conn.execute_batch(
                "PRAGMA journal_mode=WAL;
                 PRAGMA foreign_keys=ON;
                 PRAGMA synchronous=NORMAL;
                 PRAGMA cache_size=-32000;
                 PRAGMA busy_timeout=5000;
                 PRAGMA temp_store=MEMORY;",
            )?;
            Ok(())
        });

    r2d2::Pool::builder()
        .max_size(8)
        .build(manager)
        .map_err(|e| format!("DB pool init: {}", e))
}

// ========== 비행검사기 (Aircraft) ==========

/// 비행검사기 목록 조회
pub fn get_aircraft_list(conn: &Connection) -> SqlResult<Vec<Aircraft>> {
    let mut stmt = conn.prepare(
        "SELECT id, name, registration, model, mode_s_code, organization, memo, active FROM aircraft ORDER BY name",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(Aircraft {
                id: row.get(0)?,
                name: row.get(1)?,
                registration: row.get(2)?,
                model: row.get(3)?,
                mode_s_code: row.get(4)?,
                organization: row.get(5)?,
                memo: row.get(6)?,
                active: row.get::<_, i32>(7)? != 0,
            })
        })?
        .collect::<SqlResult<Vec<_>>>()?;
    Ok(rows)
}

/// 비행검사기 저장 (추가/수정)
pub fn save_aircraft(conn: &Connection, aircraft: &Aircraft) -> SqlResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO aircraft (id, name, registration, model, mode_s_code, organization, memo, active)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            aircraft.id,
            aircraft.name,
            aircraft.registration,
            aircraft.model,
            aircraft.mode_s_code,
            aircraft.organization,
            aircraft.memo,
            aircraft.active as i32,
        ],
    )?;
    Ok(())
}

/// 비행검사기 삭제
pub fn delete_aircraft(conn: &Connection, id: &str) -> SqlResult<usize> {
    let changed = conn.execute("DELETE FROM aircraft WHERE id = ?1", params![id])?;
    Ok(changed)
}

/// aircraft.json → DB 마이그레이션
pub fn migrate_aircraft_json(conn: &Connection, json_path: &Path) -> SqlResult<()> {
    // DB에 이미 데이터가 있으면 마이그레이션 건너뛰기
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM aircraft", [], |row| row.get(0))?;
    if count > 0 {
        return Ok(());
    }

    let content = std::fs::read_to_string(json_path).map_err(|e| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::Other,
            e,
        )))
    })?;

    let aircraft_list: Vec<Aircraft> = serde_json::from_str(&content).map_err(|e| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::Other,
            e,
        )))
    })?;

    for a in &aircraft_list {
        save_aircraft(conn, a)?;
    }

    log::info!("Migrated {} aircraft from JSON to DB", aircraft_list.len());
    Ok(())
}

/// 설정값 저장
pub fn set_setting(conn: &Connection, key: &str, value: &str) -> SqlResult<()> {
    conn.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
        params![key, value],
    )?;
    Ok(())
}

/// 설정값 조회
pub fn get_setting(conn: &Connection, key: &str) -> SqlResult<Option<String>> {
    let mut stmt = conn.prepare("SELECT value FROM settings WHERE key = ?1")?;
    let mut rows = stmt.query_map(params![key], |row| row.get::<_, String>(0))?;
    match rows.next() {
        Some(Ok(val)) => Ok(Some(val)),
        _ => Ok(None),
    }
}


// ========== LoS 파노라마 캐시 ==========

/// 파노라마 계산 알고리즘 버전 — 계산식 변경 시 증가시켜 기존 캐시를 자연 무효화
/// v1: ray_segment_intersection 선분 파라미터 s 부호 수정 (구버전 캐시는 실루엣/거리 왜곡)
pub const PANORAMA_CACHE_VERSION: i64 = 1;

/// 파노라마 데이터 저장
pub fn save_panorama_cache(
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    data_json: &str,
) -> SqlResult<()> {
    let lat_key = format!("{:.4}", radar_lat);
    let lon_key = format!("{:.4}", radar_lon);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO panorama_cache (radar_lat, radar_lon, radar_height_m, data_json, created_at, version)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![lat_key, lon_key, radar_height_m, data_json, now, PANORAMA_CACHE_VERSION],
    )?;
    Ok(())
}

/// 파노라마 캐시 로드
/// 저장된 radar_height_m 과 요청 높이가 0.01m 초과 차이나면 캐시 미스(None)
/// — 사이트고/안테나고 수정 후 구 높이 기준 앙각 파노라마 재사용 방지
/// 저장 버전이 PANORAMA_CACHE_VERSION 과 다르면 캐시 미스 — 구 알고리즘 결과 폐기
pub fn load_panorama_cache(
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
) -> SqlResult<Option<String>> {
    let lat_key = format!("{:.4}", radar_lat);
    let lon_key = format!("{:.4}", radar_lon);
    let mut stmt = conn.prepare(
        "SELECT data_json, radar_height_m, version FROM panorama_cache WHERE radar_lat = ?1 AND radar_lon = ?2",
    )?;
    match stmt.query_row(params![lat_key, lon_key], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, f64>(1)?, row.get::<_, i64>(2)?))
    }) {
        Ok((json, stored_height_m, stored_version)) => {
            if stored_version != PANORAMA_CACHE_VERSION {
                // 알고리즘 버전 불일치 → 캐시 미스 (호출부에서 재계산)
                Ok(None)
            } else if (stored_height_m - radar_height_m).abs() > 0.01 {
                // 레이더 높이 불일치 → 캐시 미스 (호출부에서 재계산)
                Ok(None)
            } else {
                Ok(Some(json))
            }
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 파노라마 캐시 삭제
pub fn clear_panorama_cache(
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
) -> SqlResult<()> {
    let lat_key = format!("{:.4}", radar_lat);
    let lon_key = format!("{:.4}", radar_lon);
    conn.execute(
        "DELETE FROM panorama_cache WHERE radar_lat = ?1 AND radar_lon = ?2",
        params![lat_key, lon_key],
    )?;
    Ok(())
}

/// 파노라마 캐시 전건 삭제 — 건물 데이터(실측/GIS) 임포트·삭제 시 호출.
/// 캐시 키(레이더 좌표·높이·알고리즘 버전)에 건물 데이터 세대가 없어
/// 건물 높이가 바뀌면 모든 레이더의 캐시가 무효하다 (건물 데이터는 전역).
pub fn clear_panorama_cache_all(conn: &Connection) -> SqlResult<()> {
    conn.execute("DELETE FROM panorama_cache", [])?;
    Ok(())
}

// ========== 커버리지 캐시 ==========

/// 커버리지 캐시 저장
pub fn save_coverage_cache(
    conn: &Connection,
    radar_name: &str,
    radar_lat: f64,
    radar_lon: f64,
    radar_height: f64,
    max_elev_deg: f64,
    layers_json: &str,
) -> SqlResult<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO coverage_cache (radar_name, radar_lat, radar_lon, radar_height, max_elev_deg, layers_json, computed_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        params![radar_name, radar_lat, radar_lon, radar_height, max_elev_deg, layers_json, now],
    )?;
    Ok(())
}

/// 커버리지 캐시 로드
pub fn load_coverage_cache(conn: &Connection, radar_name: &str) -> SqlResult<Option<String>> {
    let mut stmt = conn.prepare(
        "SELECT layers_json FROM coverage_cache WHERE radar_name = ?1",
    )?;
    match stmt.query_row(params![radar_name], |row| row.get::<_, String>(0)) {
        Ok(json) => Ok(Some(json)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 커버리지 캐시 존재 확인 (JSON 로드 없이 경량 체크)
pub fn has_coverage_cache(conn: &Connection, radar_name: &str) -> SqlResult<bool> {
    let mut stmt = conn.prepare(
        "SELECT 1 FROM coverage_cache WHERE radar_name = ?1 LIMIT 1",
    )?;
    match stmt.query_row(params![radar_name], |_| Ok(())) {
        Ok(_) => Ok(true),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(false),
        Err(e) => Err(e),
    }
}

// ========== SRTM 타일 ==========

/// SRTM 타일 저장 (UPSERT)
pub fn save_srtm_tile(conn: &Connection, name: &str, data: &[u8]) -> SqlResult<()> {
    conn.execute(
        "INSERT INTO srtm_tiles (name, data, downloaded_at) VALUES (?1, ?2, strftime('%s','now'))
         ON CONFLICT(name) DO UPDATE SET data = excluded.data, downloaded_at = excluded.downloaded_at",
        params![name, data],
    )?;
    Ok(())
}

/// SRTM 타일 로드 (BLOB → Vec<u8>)
pub fn load_srtm_tile(conn: &Connection, name: &str) -> SqlResult<Option<Vec<u8>>> {
    match conn.query_row(
        "SELECT data FROM srtm_tiles WHERE name = ?1",
        params![name],
        |row| row.get::<_, Vec<u8>>(0),
    ) {
        Ok(data) => Ok(Some(data)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// SRTM 타일 존재 여부
pub fn has_srtm_tile(conn: &Connection, name: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM srtm_tiles WHERE name = ?1",
        params![name],
        |_| Ok(()),
    ).is_ok()
}

/// SRTM 타일 상태 (타일 수 + 최신 다운로드 일시)
pub fn get_srtm_status(conn: &Connection) -> SqlResult<Option<(i64, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT COUNT(*), COALESCE(MAX(downloaded_at), 0) FROM srtm_tiles"
    )?;
    let result = stmt.query_row([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
    })?;
    if result.0 == 0 { Ok(None) } else { Ok(Some(result)) }
}

// ========== SRTM 지반고 융합 보정 ==========

/// 지반고 보정 전량 교체 (기존 전건 삭제 + 배치 INSERT, 단일 트랜잭션)
/// rows = `(tile_name, row, col, ground_msl, n_samples)` — ground_msl 은 델타가 아닌 **절대 MSL**.
/// 실측 임포트가 멱등(선정리 후 전량 재적용)이므로 보정도 매번 통째로 갈아끼운다.
pub fn replace_srtm_ground_corrections(
    conn: &Connection,
    rows: &[(String, u32, u32, f64, u32)],
) -> SqlResult<()> {
    // 실패 시 Transaction drop 으로 자동 롤백 (기존 보정 보존)
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM srtm_ground_corrections", [])?;
    {
        let mut stmt = tx.prepare(
            "INSERT OR REPLACE INTO srtm_ground_corrections (tile_name, row, col, ground_msl, n_samples)
             VALUES (?1, ?2, ?3, ?4, ?5)",
        )?;
        for (tile_name, row, col, ground_msl, n_samples) in rows {
            stmt.execute(params![tile_name, *row as i64, *col as i64, ground_msl, *n_samples as i64])?;
        }
    }
    tx.commit()
}

/// 타일 1개분 지반고 보정 로드 — `(row, col, ground_msl)`
pub fn load_srtm_ground_corrections_for_tile(
    conn: &Connection,
    tile_name: &str,
) -> SqlResult<Vec<(u32, u32, f64)>> {
    let mut stmt = conn.prepare(
        "SELECT row, col, ground_msl FROM srtm_ground_corrections WHERE tile_name = ?1",
    )?;
    let rows = stmt.query_map(params![tile_name], |row| {
        Ok((
            row.get::<_, i64>(0)? as u32,
            row.get::<_, i64>(1)? as u32,
            row.get::<_, f64>(2)?,
        ))
    })?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r?);
    }
    Ok(out)
}

/// 지반고 보정 전건 삭제 (실측 데이터 초기화 시)
pub fn clear_srtm_ground_corrections(conn: &Connection) -> SqlResult<()> {
    conn.execute("DELETE FROM srtm_ground_corrections", [])?;
    Ok(())
}
