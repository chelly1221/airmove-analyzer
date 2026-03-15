use std::path::Path;

use rusqlite::{params, Connection, Result as SqlResult};

use crate::models::{AdsbPoint, AdsbTrack, FlightRecord};

/// DB 연결 타입 (lib.rs에서 사용)
pub type Db = Connection;

/// DB 초기화 (테이블 생성)
pub fn init_db(path: &Path) -> SqlResult<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(
        "
        PRAGMA journal_mode=WAL;
        PRAGMA foreign_keys=ON;

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
        ",
    )?;
    Ok(conn)
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
