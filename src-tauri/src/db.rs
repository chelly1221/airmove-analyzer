use std::path::Path;

use rusqlite::{params, Connection, Result as SqlResult};

use crate::models::{AdsbPoint, AdsbTrack, Aircraft, FlightRecord};

/// DB 연결 타입 (lib.rs에서 사용)
pub type Db = Connection;

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

        CREATE TABLE IF NOT EXISTS adsb_tracks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            icao24 TEXT NOT NULL,
            callsign TEXT,
            start_time REAL NOT NULL,
            end_time REAL NOT NULL,
            UNIQUE(icao24, start_time)
        );

        CREATE TABLE IF NOT EXISTS adsb_points (
            track_id INTEGER NOT NULL REFERENCES adsb_tracks(id) ON DELETE CASCADE,
            time REAL NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            altitude REAL NOT NULL,
            heading REAL NOT NULL,
            on_ground INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_adsb_points_track ON adsb_points(track_id);

        CREATE TABLE IF NOT EXISTS flight_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            icao24 TEXT NOT NULL,
            first_seen REAL NOT NULL,
            last_seen REAL NOT NULL,
            est_departure_airport TEXT,
            est_arrival_airport TEXT,
            callsign TEXT,
            UNIQUE(icao24, first_seen)
        );

        CREATE INDEX IF NOT EXISTS idx_flight_history_icao24 ON flight_history(icao24);
        CREATE INDEX IF NOT EXISTS idx_flight_history_time ON flight_history(first_seen);

        CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS opensky_query_log (
            icao24 TEXT NOT NULL,
            window_start INTEGER NOT NULL,
            window_end INTEGER NOT NULL,
            queried_at INTEGER NOT NULL,
            UNIQUE(icao24, window_start, window_end)
        );

        CREATE INDEX IF NOT EXISTS idx_query_log_icao ON opensky_query_log(icao24, window_start);

        -- 파싱 데이터 영속화
        CREATE TABLE IF NOT EXISTS parsed_files (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            path TEXT NOT NULL UNIQUE,
            name TEXT NOT NULL,
            total_records INTEGER NOT NULL DEFAULT 0,
            start_time REAL,
            end_time REAL,
            radar_lat REAL NOT NULL,
            radar_lon REAL NOT NULL,
            parse_errors TEXT NOT NULL DEFAULT '[]',
            stats_json TEXT,
            created_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS track_points (
            file_id INTEGER NOT NULL REFERENCES parsed_files(id) ON DELETE CASCADE,
            timestamp REAL NOT NULL,
            mode_s TEXT NOT NULL,
            latitude REAL NOT NULL,
            longitude REAL NOT NULL,
            altitude REAL NOT NULL,
            speed REAL NOT NULL,
            heading REAL NOT NULL,
            radar_type TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_track_points_file ON track_points(file_id);

        CREATE TABLE IF NOT EXISTS garble_points (
            file_id INTEGER NOT NULL REFERENCES parsed_files(id) ON DELETE CASCADE,
            timestamp REAL NOT NULL,
            mode_s TEXT NOT NULL,
            track_number INTEGER NOT NULL,
            rho_nm REAL NOT NULL,
            theta_deg REAL NOT NULL,
            ghost_lat REAL NOT NULL,
            ghost_lon REAL NOT NULL,
            ghost_altitude REAL NOT NULL,
            real_lat REAL NOT NULL,
            real_lon REAL NOT NULL,
            real_altitude REAL NOT NULL,
            real_rho_nm REAL NOT NULL,
            real_theta_deg REAL NOT NULL,
            garble_type TEXT NOT NULL,
            bearing_diff_deg REAL NOT NULL,
            range_diff_nm REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_garble_points_file ON garble_points(file_id);
        CREATE INDEX IF NOT EXISTS idx_garble_points_modes ON garble_points(mode_s);

        -- 고도 프로파일 캐시 (open-meteo API 결과)
        CREATE TABLE IF NOT EXISTS elevation_cache (
            lat_key TEXT NOT NULL,
            lon_key TEXT NOT NULL,
            elevation REAL NOT NULL,
            PRIMARY KEY (lat_key, lon_key)
        );

        -- GIS 건물통합정보 (vworld SHP 임포트)
        CREATE TABLE IF NOT EXISTS buildings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            region TEXT NOT NULL,
            centroid_lat REAL NOT NULL,
            centroid_lon REAL NOT NULL,
            bbox_min_lat REAL NOT NULL,
            bbox_min_lon REAL NOT NULL,
            bbox_max_lat REAL NOT NULL,
            bbox_max_lon REAL NOT NULL,
            height REAL NOT NULL,
            ground_floors INTEGER,
            building_name TEXT,
            address TEXT,
            usage TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_buildings_lat ON buildings(centroid_lat);
        CREATE INDEX IF NOT EXISTS idx_buildings_lon ON buildings(centroid_lon);
        CREATE INDEX IF NOT EXISTS idx_buildings_region ON buildings(region);
        CREATE INDEX IF NOT EXISTS idx_buildings_region_lat_lon ON buildings(region, centroid_lat, centroid_lon);

        CREATE TABLE IF NOT EXISTS building_import_log (
            region TEXT PRIMARY KEY,
            file_date TEXT NOT NULL,
            imported_at INTEGER NOT NULL,
            record_count INTEGER NOT NULL
        );

        -- 기상 데이터 캐시 (일 단위, 레이더 좌표 기준)
        CREATE TABLE IF NOT EXISTS weather_cache (
            date TEXT NOT NULL,
            radar_lat TEXT NOT NULL,
            radar_lon TEXT NOT NULL,
            hourly_json TEXT NOT NULL,
            fetched_at INTEGER NOT NULL,
            PRIMARY KEY (date, radar_lat, radar_lon)
        );

        -- 구름 그리드 캐시 (일 단위)
        CREATE TABLE IF NOT EXISTS cloud_grid_cache (
            date TEXT NOT NULL,
            radar_lat TEXT NOT NULL,
            radar_lon TEXT NOT NULL,
            grid_spacing_km REAL NOT NULL,
            frames_json TEXT NOT NULL,
            fetched_at INTEGER NOT NULL,
            PRIMARY KEY (date, radar_lat, radar_lon)
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

        -- LOS 분석 결과 영속화
        CREATE TABLE IF NOT EXISTS los_results (
            id TEXT PRIMARY KEY,
            radar_site_name TEXT NOT NULL,
            radar_lat REAL NOT NULL,
            radar_lon REAL NOT NULL,
            radar_height REAL NOT NULL,
            target_lat REAL NOT NULL,
            target_lon REAL NOT NULL,
            bearing REAL NOT NULL,
            total_distance REAL NOT NULL,
            elevation_profile_json TEXT NOT NULL,
            los_blocked INTEGER NOT NULL,
            max_blocking_json TEXT,
            map_screenshot TEXT,
            chart_screenshot TEXT,
            created_at INTEGER NOT NULL
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

        -- 저장된 보고서 (PDF 포함)
        CREATE TABLE IF NOT EXISTS saved_reports (
            id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            template TEXT NOT NULL,
            radar_name TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            report_config_json TEXT NOT NULL,
            pdf_base64 TEXT,
            metadata_json TEXT
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

        -- 수동 건물 그룹
        CREATE TABLE IF NOT EXISTS building_groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            color TEXT NOT NULL DEFAULT '#6b7280',
            memo TEXT NOT NULL DEFAULT ''
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

    // 기존 DB 마이그레이션: buildings 테이블에 컬럼 추가
    let _ = conn.execute("ALTER TABLE buildings ADD COLUMN address TEXT", []);
    let _ = conn.execute("ALTER TABLE buildings ADD COLUMN usage TEXT", []);

    // 수동 건물에 도형 컬럼 추가
    let _ = conn.execute("ALTER TABLE manual_buildings ADD COLUMN geometry_type TEXT NOT NULL DEFAULT 'point'", []);
    let _ = conn.execute("ALTER TABLE manual_buildings ADD COLUMN geometry_json TEXT", []);

    // 수동 건물에 그룹 컬럼 추가
    let _ = conn.execute("ALTER TABLE manual_buildings ADD COLUMN group_id INTEGER REFERENCES building_groups(id) ON DELETE SET NULL", []);

    // 건물 그룹에 토지이용계획도 컬럼 추가
    let _ = conn.execute("ALTER TABLE building_groups ADD COLUMN plan_image BLOB", []);
    let _ = conn.execute("ALTER TABLE building_groups ADD COLUMN plan_bounds_json TEXT", []);
    let _ = conn.execute("ALTER TABLE building_groups ADD COLUMN plan_opacity REAL NOT NULL DEFAULT 0.5", []);

    // LOS 결과에 스크린샷 컬럼 추가
    let _ = conn.execute("ALTER TABLE los_results ADD COLUMN map_screenshot TEXT", []);
    let _ = conn.execute("ALTER TABLE los_results ADD COLUMN chart_screenshot TEXT", []);

    Ok(conn)
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

/// ADS-B 트랙 1건 저장 (중복 시 무시)
pub fn save_adsb_track(conn: &Connection, track: &AdsbTrack) -> SqlResult<bool> {
    let changed = conn.execute(
        "INSERT OR IGNORE INTO adsb_tracks (icao24, callsign, start_time, end_time)
         VALUES (?1, ?2, ?3, ?4)",
        params![
            track.icao24,
            track.callsign,
            track.start_time,
            track.end_time
        ],
    )?;

    if changed == 0 {
        return Ok(false);
    }

    let track_id = conn.last_insert_rowid();

    // 트랜잭션으로 포인트 일괄 삽입
    conn.execute_batch("BEGIN")?;
    {
        let mut stmt = conn.prepare(
            "INSERT INTO adsb_points (track_id, time, latitude, longitude, altitude, heading, on_ground)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for pt in &track.path {
            stmt.execute(params![
                track_id,
                pt.time,
                pt.latitude,
                pt.longitude,
                pt.altitude,
                pt.heading,
                pt.on_ground as i32,
            ])?;
        }
    }
    conn.execute_batch("COMMIT")?;

    Ok(true)
}

/// ADS-B 트랙 조회 (ICAO24 목록 + 시간 범위)
pub fn load_adsb_tracks(
    conn: &Connection,
    icao24_list: &[String],
    start: f64,
    end: f64,
) -> SqlResult<Vec<AdsbTrack>> {
    let mut tracks = Vec::new();

    for icao in icao24_list {
        let mut stmt = conn.prepare(
            "SELECT id, icao24, callsign, start_time, end_time FROM adsb_tracks
             WHERE LOWER(icao24) = LOWER(?1) AND end_time >= ?2 AND start_time <= ?3
             ORDER BY start_time",
        )?;

        let rows: Vec<(i64, String, Option<String>, f64, f64)> = stmt
            .query_map(params![icao, start, end], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        for (id, icao24, callsign, start_time, end_time) in rows {
            let mut pt_stmt = conn.prepare(
                "SELECT time, latitude, longitude, altitude, heading, on_ground
                 FROM adsb_points WHERE track_id = ?1 ORDER BY time",
            )?;

            let points: Vec<AdsbPoint> = pt_stmt
                .query_map(params![id], |row| {
                    Ok(AdsbPoint {
                        time: row.get(0)?,
                        latitude: row.get(1)?,
                        longitude: row.get(2)?,
                        altitude: row.get(3)?,
                        heading: row.get(4)?,
                        on_ground: row.get::<_, i32>(5)? != 0,
                    })
                })?
                .collect::<SqlResult<Vec<_>>>()?;

            tracks.push(AdsbTrack {
                icao24,
                callsign,
                start_time,
                end_time,
                path: points,
            });
        }
    }

    Ok(tracks)
}

/// 운항이력 1건 저장 (중복 시 무시)
pub fn save_flight_record(conn: &Connection, record: &FlightRecord) -> SqlResult<()> {
    conn.execute(
        "INSERT OR IGNORE INTO flight_history (icao24, first_seen, last_seen, est_departure_airport, est_arrival_airport, callsign)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            record.icao24,
            record.first_seen,
            record.last_seen,
            record.est_departure_airport,
            record.est_arrival_airport,
            record.callsign,
        ],
    )?;
    Ok(())
}

/// 운항이력 조회 (ICAO24 목록 + 시간 범위)
pub fn load_flight_history(
    conn: &Connection,
    icao24_list: &[String],
    start: f64,
    end: f64,
) -> SqlResult<Vec<FlightRecord>> {
    let mut records = Vec::new();

    for icao in icao24_list {
        let mut stmt = conn.prepare(
            "SELECT icao24, first_seen, last_seen, est_departure_airport, est_arrival_airport, callsign
             FROM flight_history
             WHERE LOWER(icao24) = LOWER(?1) AND last_seen >= ?2 AND first_seen <= ?3
             ORDER BY first_seen",
        )?;

        let rows = stmt
            .query_map(params![icao, start, end], |row| {
                Ok(FlightRecord {
                    icao24: row.get(0)?,
                    first_seen: row.get(1)?,
                    last_seen: row.get(2)?,
                    est_departure_airport: row.get(3)?,
                    est_arrival_airport: row.get(4)?,
                    callsign: row.get(5)?,
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        records.extend(rows);
    }

    Ok(records)
}

/// 특정 시간 구간이 이미 조회된 적이 있는지 확인 (결과 유무와 무관)
pub fn is_window_queried(conn: &Connection, icao24: &str, start: i64, end: i64) -> SqlResult<bool> {
    let count: i64 = conn.query_row(
        "SELECT COUNT(*) FROM opensky_query_log
         WHERE LOWER(icao24) = LOWER(?1) AND window_start = ?2 AND window_end = ?3",
        params![icao24, start, end],
        |row| row.get(0),
    )?;
    Ok(count > 0)
}

/// 조회 완료된 구간 기록 (결과 유무와 무관)
pub fn mark_window_queried(conn: &Connection, icao24: &str, start: i64, end: i64) -> SqlResult<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR IGNORE INTO opensky_query_log (icao24, window_start, window_end, queried_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![icao24, start, end, now],
    )?;
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

// ========== 파싱 데이터 영속화 ==========

use crate::models::{AnalysisResult, ParseStatistics, RadarDetectionType, TrackPoint};

fn radar_type_to_str(rt: &RadarDetectionType) -> &'static str {
    match rt {
        RadarDetectionType::ModeAC => "mode_ac",
        RadarDetectionType::ModeACPsr => "mode_ac_psr",
        RadarDetectionType::ModeSAllCall => "mode_s_allcall",
        RadarDetectionType::ModeSRollCall => "mode_s_rollcall",
        RadarDetectionType::ModeSAllCallPsr => "mode_s_allcall_psr",
        RadarDetectionType::ModeSRollCallPsr => "mode_s_rollcall_psr",
    }
}

fn str_to_radar_type(s: &str) -> RadarDetectionType {
    match s {
        "mode_ac" => RadarDetectionType::ModeAC,
        "mode_ac_psr" => RadarDetectionType::ModeACPsr,
        "mode_s_allcall" => RadarDetectionType::ModeSAllCall,
        "mode_s_rollcall" => RadarDetectionType::ModeSRollCall,
        "mode_s_allcall_psr" => RadarDetectionType::ModeSAllCallPsr,
        "mode_s_rollcall_psr" => RadarDetectionType::ModeSRollCallPsr,
        other => {
            log::warn!("[DB] 알 수 없는 radar_type '{}', ModeSRollCall로 대체", other);
            RadarDetectionType::ModeSRollCall
        }
    }
}

/// 파싱된 파일 데이터를 DB에 저장 (기존 데이터 교체)
pub fn save_parsed_file_data(
    conn: &Connection,
    file_path: &str,
    file_name: &str,
    analysis: &AnalysisResult,
) -> SqlResult<()> {
    // 기존 데이터 삭제 (cascade로 track_points도 삭제)
    conn.execute("DELETE FROM parsed_files WHERE path = ?1", params![file_path])?;

    let errors_json = serde_json::to_string(&analysis.file_info.parse_errors)
        .unwrap_or_else(|_| "[]".to_string());
    let stats_json = analysis.file_info.parse_stats.as_ref()
        .and_then(|s| serde_json::to_string(s).ok());
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    conn.execute(
        "INSERT INTO parsed_files (path, name, total_records, start_time, end_time, radar_lat, radar_lon, parse_errors, stats_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
        params![
            file_path,
            file_name,
            analysis.file_info.total_records as i64,
            analysis.file_info.start_time,
            analysis.file_info.end_time,
            analysis.file_info.radar_lat,
            analysis.file_info.radar_lon,
            errors_json,
            stats_json,
            now,
        ],
    )?;

    let file_id = conn.last_insert_rowid();

    // 트랜잭션으로 track_points 일괄 삽입
    conn.execute_batch("BEGIN")?;
    {
        let mut stmt = conn.prepare(
            "INSERT INTO track_points (file_id, timestamp, mode_s, latitude, longitude, altitude, speed, heading, radar_type)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )?;
        for pt in &analysis.file_info.track_points {
            stmt.execute(params![
                file_id,
                pt.timestamp,
                pt.mode_s,
                pt.latitude,
                pt.longitude,
                pt.altitude,
                pt.speed,
                pt.heading,
                radar_type_to_str(&pt.radar_type),
            ])?;
        }
    }
    conn.execute_batch("COMMIT")?;

    Ok(())
}

/// 저장된 파일 정보 (프론트엔드 반환용)
#[derive(serde::Serialize, Clone, Debug)]
pub struct SavedFileInfo {
    pub path: String,
    pub name: String,
    pub filename: String,
    pub total_records: usize,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub radar_lat: f64,
    pub radar_lon: f64,
    pub parse_errors: Vec<String>,
    pub parse_stats: Option<ParseStatistics>,
    pub track_points: Vec<TrackPoint>,
}

/// 파일 메타데이터 (포인트 제외, 스트리밍 복원용)
#[derive(serde::Serialize, Clone, Debug)]
pub struct SavedFileMeta {
    pub file_id: i64,
    pub path: String,
    pub name: String,
    pub filename: String,
    pub total_records: usize,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
    pub radar_lat: f64,
    pub radar_lon: f64,
    pub parse_errors: Vec<String>,
    pub parse_stats: Option<ParseStatistics>,
    pub point_count: usize,
}

/// 저장된 전체 데이터 (프론트엔드 반환용)
#[derive(serde::Serialize, Clone, Debug)]
pub struct SavedParsedData {
    pub files: Vec<SavedFileInfo>,
}

/// 파일 메타데이터만 반환 (포인트 개수 포함, 포인트 자체는 제외)
#[derive(serde::Serialize, Clone, Debug)]
pub struct SavedParsedMeta {
    pub files: Vec<SavedFileMeta>,
    pub total_points: usize,
}

/// DB에서 모든 파싱 데이터 로드
pub fn load_all_parsed_data(conn: &Connection) -> SqlResult<SavedParsedData> {
    // 파일 정보 로드
    let mut file_stmt = conn.prepare(
        "SELECT id, path, name, total_records, start_time, end_time, radar_lat, radar_lon, parse_errors, stats_json
         FROM parsed_files ORDER BY created_at",
    )?;

    let file_rows: Vec<(i64, String, String, i64, Option<f64>, Option<f64>, f64, f64, String, Option<String>)> = file_stmt
        .query_map([], |row| {
            Ok((
                row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?,
                row.get(4)?, row.get(5)?, row.get(6)?, row.get(7)?,
                row.get(8)?, row.get(9)?,
            ))
        })?
        .collect::<SqlResult<Vec<_>>>()?;

    let mut files = Vec::new();

    for (file_id, path, name, total_records, start_time, end_time, radar_lat, radar_lon, errors_json, stats_json) in &file_rows {
        let parse_errors: Vec<String> = serde_json::from_str(errors_json).unwrap_or_default();
        let parse_stats: Option<ParseStatistics> = stats_json.as_ref()
            .and_then(|s| serde_json::from_str(s).ok());

        // 해당 파일의 track_points 로드
        let mut pt_stmt = conn.prepare(
            "SELECT timestamp, mode_s, latitude, longitude, altitude, speed, heading, radar_type
             FROM track_points WHERE file_id = ?1 ORDER BY timestamp",
        )?;

        let points: Vec<TrackPoint> = pt_stmt
            .query_map(params![file_id], |row| {
                let radar_type_str: String = row.get(7)?;
                Ok(TrackPoint {
                    timestamp: row.get(0)?,
                    mode_s: row.get(1)?,
                    latitude: row.get(2)?,
                    longitude: row.get(3)?,
                    altitude: row.get(4)?,
                    speed: row.get(5)?,
                    heading: row.get(6)?,
                    radar_type: str_to_radar_type(&radar_type_str),
                    raw_data: Vec::new(),
                })
            })?
            .collect::<SqlResult<Vec<_>>>()?;

        files.push(SavedFileInfo {
            path: path.clone(),
            name: name.clone(),
            filename: name.clone(),
            total_records: *total_records as usize,
            start_time: *start_time,
            end_time: *end_time,
            radar_lat: *radar_lat,
            radar_lon: *radar_lon,
            parse_errors,
            parse_stats,
            track_points: points,
        });
    }

    Ok(SavedParsedData {
        files,
    })
}

/// 파일 메타데이터만 로드 (포인트 제외, 스트리밍 복원용)
pub fn load_parsed_file_metas(conn: &Connection) -> SqlResult<SavedParsedMeta> {
    let mut stmt = conn.prepare(
        "SELECT f.id, f.path, f.name, f.total_records, f.start_time, f.end_time,
                f.radar_lat, f.radar_lon, f.parse_errors, f.stats_json,
                (SELECT COUNT(*) FROM track_points WHERE file_id = f.id) as pt_count
         FROM parsed_files f ORDER BY f.created_at",
    )?;

    let mut files = Vec::new();
    let mut total_points = 0usize;

    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, Option<f64>>(4)?,
            row.get::<_, Option<f64>>(5)?,
            row.get::<_, f64>(6)?,
            row.get::<_, f64>(7)?,
            row.get::<_, String>(8)?,
            row.get::<_, Option<String>>(9)?,
            row.get::<_, i64>(10)?,
        ))
    })?;

    for row in rows {
        let (file_id, path, name, total_records, start_time, end_time,
             radar_lat, radar_lon, errors_json, stats_json, pt_count) = row?;
        let parse_errors: Vec<String> = serde_json::from_str(&errors_json).unwrap_or_default();
        let parse_stats: Option<ParseStatistics> = stats_json.as_ref()
            .and_then(|s| serde_json::from_str(s).ok());
        let pc = pt_count as usize;
        total_points += pc;
        files.push(SavedFileMeta {
            file_id,
            path,
            name: name.clone(),
            filename: name,
            total_records: total_records as usize,
            start_time,
            end_time,
            radar_lat,
            radar_lon,
            parse_errors,
            parse_stats,
            point_count: pc,
        });
    }

    Ok(SavedParsedMeta { files, total_points })
}

/// 특정 파일의 track_points를 청크 단위로 콜백 호출
pub fn load_track_points_chunked<F>(
    conn: &Connection,
    file_id: i64,
    chunk_size: usize,
    mut on_chunk: F,
) -> SqlResult<usize>
where
    F: FnMut(Vec<TrackPoint>),
{
    let mut stmt = conn.prepare(
        "SELECT timestamp, mode_s, latitude, longitude, altitude, speed, heading, radar_type
         FROM track_points WHERE file_id = ?1 ORDER BY timestamp",
    )?;

    let mut rows = stmt.query(params![file_id])?;
    let mut buffer = Vec::with_capacity(chunk_size);
    let mut total = 0usize;

    while let Some(row) = rows.next()? {
        let radar_type_str: String = row.get(7)?;
        buffer.push(TrackPoint {
            timestamp: row.get(0)?,
            mode_s: row.get(1)?,
            latitude: row.get(2)?,
            longitude: row.get(3)?,
            altitude: row.get(4)?,
            speed: row.get(5)?,
            heading: row.get(6)?,
            radar_type: str_to_radar_type(&radar_type_str),
            raw_data: Vec::new(),
        });
        total += 1;

        if buffer.len() >= chunk_size {
            on_chunk(std::mem::replace(&mut buffer, Vec::with_capacity(chunk_size)));
        }
    }

    if !buffer.is_empty() {
        on_chunk(buffer);
    }

    Ok(total)
}

/// 모든 파싱 데이터 삭제
pub fn clear_all_parsed_data(conn: &Connection) -> SqlResult<()> {
    conn.execute("DELETE FROM track_points", [])?;
    conn.execute("DELETE FROM parsed_files", [])?;
    Ok(())
}

/// 특정 파싱 파일 삭제 (CASCADE로 track_points/garble_points도 삭제)
pub fn delete_parsed_file(conn: &Connection, file_path: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM parsed_files WHERE path = ?1", params![file_path])?;
    Ok(())
}

/// 여러 파싱 파일 삭제 (경로 목록)
pub fn delete_parsed_files(conn: &Connection, file_paths: &[String]) -> SqlResult<()> {
    let mut stmt = conn.prepare("DELETE FROM parsed_files WHERE path = ?1")?;
    for path in file_paths {
        stmt.execute(params![path])?;
    }
    Ok(())
}

// ========== 고도 프로파일 캐시 ==========

/// 캐시에서 고도 조회 (lat/lon을 소수점 4자리 문자열 키로 사용)
pub fn get_cached_elevations(
    conn: &Connection,
    lats: &[f64],
    lons: &[f64],
) -> SqlResult<Vec<Option<f64>>> {
    let mut results = vec![None; lats.len()];
    let mut stmt = conn.prepare(
        "SELECT elevation FROM elevation_cache WHERE lat_key = ?1 AND lon_key = ?2",
    )?;
    for (i, (lat, lon)) in lats.iter().zip(lons.iter()).enumerate() {
        let lat_key = format!("{:.2}", lat);
        let lon_key = format!("{:.2}", lon);
        if let Ok(elev) = stmt.query_row(params![lat_key, lon_key], |row| row.get::<_, f64>(0)) {
            results[i] = Some(elev);
        }
    }
    Ok(results)
}

/// 고도 데이터를 캐시에 저장
pub fn save_elevations_to_cache(
    conn: &Connection,
    lats: &[f64],
    lons: &[f64],
    elevations: &[f64],
) -> SqlResult<()> {
    conn.execute_batch("BEGIN")?;
    {
        let mut stmt = conn.prepare(
            "INSERT OR REPLACE INTO elevation_cache (lat_key, lon_key, elevation) VALUES (?1, ?2, ?3)",
        )?;
        for i in 0..lats.len() {
            let lat_key = format!("{:.2}", lats[i]);
            let lon_key = format!("{:.2}", lons[i]);
            stmt.execute(params![lat_key, lon_key, elevations[i]])?;
        }
    }
    conn.execute_batch("COMMIT")?;
    Ok(())
}

/// 기존 adsb_cache.json → DB 마이그레이션
pub fn migrate_json_cache(conn: &Connection, cache_path: &Path) -> SqlResult<()> {
    let content = std::fs::read_to_string(cache_path).map_err(|e| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::Other,
            e,
        )))
    })?;

    let tracks: Vec<AdsbTrack> = serde_json::from_str(&content).map_err(|e| {
        rusqlite::Error::ToSqlConversionFailure(Box::new(std::io::Error::new(
            std::io::ErrorKind::Other,
            e,
        )))
    })?;

    for track in &tracks {
        save_adsb_track(conn, track)?;
    }

    // 마이그레이션 완료 후 삭제
    let _ = std::fs::remove_file(cache_path);
    Ok(())
}

// ========== 기상 데이터 캐시 ==========

/// 일 단위 기상 데이터 저장 (중복 시 덮어쓰기)
pub fn save_weather_day(
    conn: &Connection,
    date: &str,
    radar_lat: f64,
    radar_lon: f64,
    hourly_json: &str,
) -> SqlResult<()> {
    let lat_key = format!("{:.2}", radar_lat);
    let lon_key = format!("{:.2}", radar_lon);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO weather_cache (date, radar_lat, radar_lon, hourly_json, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![date, lat_key, lon_key, hourly_json, now],
    )?;
    Ok(())
}

/// 일 단위 구름 그리드 저장
pub fn save_cloud_grid_day(
    conn: &Connection,
    date: &str,
    radar_lat: f64,
    radar_lon: f64,
    grid_spacing_km: f64,
    frames_json: &str,
) -> SqlResult<()> {
    let lat_key = format!("{:.2}", radar_lat);
    let lon_key = format!("{:.2}", radar_lon);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO cloud_grid_cache (date, radar_lat, radar_lon, grid_spacing_km, frames_json, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![date, lat_key, lon_key, grid_spacing_km, frames_json, now],
    )?;
    Ok(())
}

/// 캐시된 기상 날짜 목록 조회
pub fn get_weather_cached_dates(
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
) -> SqlResult<Vec<String>> {
    let lat_key = format!("{:.2}", radar_lat);
    let lon_key = format!("{:.2}", radar_lon);
    let mut stmt = conn.prepare(
        "SELECT date FROM weather_cache WHERE radar_lat = ?1 AND radar_lon = ?2 ORDER BY date",
    )?;
    let dates = stmt
        .query_map(params![lat_key, lon_key], |row| row.get::<_, String>(0))?
        .collect::<SqlResult<Vec<_>>>()?;
    Ok(dates)
}

/// 캐시된 구름 그리드 날짜 목록 조회
pub fn get_cloud_grid_cached_dates(
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
) -> SqlResult<Vec<String>> {
    let lat_key = format!("{:.2}", radar_lat);
    let lon_key = format!("{:.2}", radar_lon);
    let mut stmt = conn.prepare(
        "SELECT date FROM cloud_grid_cache WHERE radar_lat = ?1 AND radar_lon = ?2 ORDER BY date",
    )?;
    let dates = stmt
        .query_map(params![lat_key, lon_key], |row| row.get::<_, String>(0))?
        .collect::<SqlResult<Vec<_>>>()?;
    Ok(dates)
}

/// 캐시된 기상 데이터 로드 (날짜 범위)
pub fn load_weather_cache(
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
    dates: &[String],
) -> SqlResult<Vec<(String, String)>> {
    let lat_key = format!("{:.2}", radar_lat);
    let lon_key = format!("{:.2}", radar_lon);
    let mut results = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT date, hourly_json FROM weather_cache WHERE radar_lat = ?1 AND radar_lon = ?2 AND date = ?3",
    )?;
    for date in dates {
        if let Ok(row) = stmt.query_row(params![lat_key, lon_key, date], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        }) {
            results.push(row);
        }
    }
    Ok(results)
}

/// 캐시된 구름 그리드 로드 (날짜 범위)
pub fn load_cloud_grid_cache(
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
    dates: &[String],
) -> SqlResult<Vec<(String, String, f64)>> {
    let lat_key = format!("{:.2}", radar_lat);
    let lon_key = format!("{:.2}", radar_lon);
    let mut results = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT date, frames_json, grid_spacing_km FROM cloud_grid_cache WHERE radar_lat = ?1 AND radar_lon = ?2 AND date = ?3",
    )?;
    for date in dates {
        if let Ok(row) = stmt.query_row(params![lat_key, lon_key, date], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, f64>(2)?))
        }) {
            results.push(row);
        }
    }
    Ok(results)
}

// ========== LoS 파노라마 캐시 ==========

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
        "INSERT OR REPLACE INTO panorama_cache (radar_lat, radar_lon, radar_height_m, data_json, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5)",
        params![lat_key, lon_key, radar_height_m, data_json, now],
    )?;
    Ok(())
}

/// 파노라마 캐시 로드
pub fn load_panorama_cache(
    conn: &Connection,
    radar_lat: f64,
    radar_lon: f64,
) -> SqlResult<Option<String>> {
    let lat_key = format!("{:.4}", radar_lat);
    let lon_key = format!("{:.4}", radar_lon);
    let mut stmt = conn.prepare(
        "SELECT data_json FROM panorama_cache WHERE radar_lat = ?1 AND radar_lon = ?2",
    )?;
    match stmt.query_row(params![lat_key, lon_key], |row| row.get::<_, String>(0)) {
        Ok(json) => Ok(Some(json)),
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

// ========== LOS 분석 결과 영속화 ==========

/// LOS 결과 저장
pub fn save_los_result(
    conn: &Connection,
    id: &str,
    radar_site_name: &str,
    radar_lat: f64,
    radar_lon: f64,
    radar_height: f64,
    target_lat: f64,
    target_lon: f64,
    bearing: f64,
    total_distance: f64,
    elevation_profile_json: &str,
    los_blocked: bool,
    max_blocking_json: Option<&str>,
    map_screenshot: Option<&str>,
    chart_screenshot: Option<&str>,
) -> SqlResult<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO los_results (id, radar_site_name, radar_lat, radar_lon, radar_height, target_lat, target_lon, bearing, total_distance, elevation_profile_json, los_blocked, max_blocking_json, map_screenshot, chart_screenshot, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
        params![id, radar_site_name, radar_lat, radar_lon, radar_height, target_lat, target_lon, bearing, total_distance, elevation_profile_json, los_blocked as i32, max_blocking_json, map_screenshot, chart_screenshot, now],
    )?;
    Ok(())
}

/// LOS 결과 전체 로드
#[allow(clippy::type_complexity)]
pub fn load_all_los_results(conn: &Connection) -> SqlResult<Vec<(String, String, f64, f64, f64, f64, f64, f64, f64, String, bool, Option<String>, Option<String>, Option<String>, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT id, radar_site_name, radar_lat, radar_lon, radar_height, target_lat, target_lon, bearing, total_distance, elevation_profile_json, los_blocked, max_blocking_json, map_screenshot, chart_screenshot, created_at
         FROM los_results ORDER BY created_at",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, f64>(2)?,
                row.get::<_, f64>(3)?,
                row.get::<_, f64>(4)?,
                row.get::<_, f64>(5)?,
                row.get::<_, f64>(6)?,
                row.get::<_, f64>(7)?,
                row.get::<_, f64>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, i32>(10)? != 0,
                row.get::<_, Option<String>>(11)?,
                row.get::<_, Option<String>>(12)?,
                row.get::<_, Option<String>>(13)?,
                row.get::<_, i64>(14)?,
            ))
        })?
        .collect::<SqlResult<Vec<_>>>()?;
    Ok(rows)
}

/// LOS 결과 삭제
pub fn delete_los_result(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM los_results WHERE id = ?1", params![id])?;
    Ok(())
}

/// LOS 결과 전체 삭제
pub fn clear_all_los_results(conn: &Connection) -> SqlResult<()> {
    conn.execute("DELETE FROM los_results", [])?;
    Ok(())
}

// ========== 수동 병합 이력 ==========

/// 수동 병합 저장
pub fn save_manual_merge(conn: &Connection, source_flight_ids_json: &str, mode_s: &str) -> SqlResult<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT INTO manual_merge_history (source_flight_ids_json, mode_s, created_at) VALUES (?1, ?2, ?3)",
        params![source_flight_ids_json, mode_s, now],
    )?;
    Ok(())
}

/// 수동 병합 이력 전체 로드
pub fn load_manual_merges(conn: &Connection) -> SqlResult<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT source_flight_ids_json, mode_s FROM manual_merge_history ORDER BY created_at",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<SqlResult<Vec<_>>>()?;
    Ok(rows)
}

/// 수동 병합 이력 전체 삭제
pub fn clear_manual_merges(conn: &Connection) -> SqlResult<()> {
    conn.execute("DELETE FROM manual_merge_history", [])?;
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

/// 커버리지 캐시 삭제
pub fn clear_coverage_cache(conn: &Connection, radar_name: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM coverage_cache WHERE radar_name = ?1", params![radar_name])?;
    Ok(())
}

// ========== 저장된 보고서 ==========

/// 보고서 저장
pub fn save_report(
    conn: &Connection,
    id: &str,
    title: &str,
    template: &str,
    radar_name: &str,
    report_config_json: &str,
    pdf_base64: Option<&str>,
    metadata_json: Option<&str>,
) -> SqlResult<()> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO saved_reports (id, title, template, radar_name, created_at, report_config_json, pdf_base64, metadata_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![id, title, template, radar_name, now, report_config_json, pdf_base64, metadata_json],
    )?;
    Ok(())
}

/// 보고서 목록 조회 (PDF 제외 — 경량)
#[derive(serde::Serialize)]
pub struct SavedReportSummary {
    pub id: String,
    pub title: String,
    pub template: String,
    pub radar_name: String,
    pub created_at: i64,
    pub has_pdf: bool,
}

pub fn list_saved_reports(conn: &Connection) -> SqlResult<Vec<SavedReportSummary>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, template, radar_name, created_at, (pdf_base64 IS NOT NULL) FROM saved_reports ORDER BY created_at DESC",
    )?;
    let rows = stmt
        .query_map([], |row| {
            Ok(SavedReportSummary {
                id: row.get(0)?,
                title: row.get(1)?,
                template: row.get(2)?,
                radar_name: row.get(3)?,
                created_at: row.get(4)?,
                has_pdf: row.get::<_, i32>(5)? != 0,
            })
        })?
        .collect::<SqlResult<Vec<_>>>()?;
    Ok(rows)
}

/// 보고서 상세 (PDF 포함)
pub fn load_report_detail(conn: &Connection, id: &str) -> SqlResult<Option<(String, String, String, String, i64, String, Option<String>, Option<String>)>> {
    let mut stmt = conn.prepare(
        "SELECT id, title, template, radar_name, created_at, report_config_json, pdf_base64, metadata_json FROM saved_reports WHERE id = ?1",
    )?;
    match stmt.query_row(params![id], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, i64>(4)?,
            row.get::<_, String>(5)?,
            row.get::<_, Option<String>>(6)?,
            row.get::<_, Option<String>>(7)?,
        ))
    }) {
        Ok(row) => Ok(Some(row)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 보고서 삭제
pub fn delete_report(conn: &Connection, id: &str) -> SqlResult<()> {
    conn.execute("DELETE FROM saved_reports WHERE id = ?1", params![id])?;
    Ok(())
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

/// 저장된 SRTM 타일 이름 목록
pub fn list_srtm_tiles(conn: &Connection) -> SqlResult<Vec<String>> {
    let mut stmt = conn.prepare("SELECT name FROM srtm_tiles ORDER BY name")?;
    let names = stmt.query_map([], |row| row.get(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(names)
}
