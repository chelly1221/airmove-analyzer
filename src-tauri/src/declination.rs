//! 자기편각(Magnetic Declination) 관리 모듈
//!
//! 1차: NOAA API (온라인) → DB 캐시
//! 2차: WMM 크레이트 (오프라인 fallback)
//! API 복원 시 WMM fallback 데이터를 NOAA 데이터로 자동 치환

use log::{info, warn};
use rusqlite::{params, Connection};

/// 기본 fallback 편각 (한국, 2025년 기준)
const DEFAULT_DECLINATION: f64 = -8.5;

/// 위경도를 0.1° 그리드 키로 양자화
fn grid_key(lat: f64, lon: f64) -> (String, String) {
    (format!("{:.1}", lat), format!("{:.1}", lon))
}

/// DB에서 캐시된 편각 조회 (NOAA 우선)
pub fn get_cached(conn: &Connection, lat: f64, lon: f64, date: &str) -> Option<(f64, String)> {
    let (lat_key, lon_key) = grid_key(lat, lon);
    conn.query_row(
        "SELECT declination_deg, source FROM declination_cache
         WHERE lat_key = ?1 AND lon_key = ?2 AND date_key = ?3
         ORDER BY CASE source WHEN 'noaa' THEN 0 ELSE 1 END
         LIMIT 1",
        params![lat_key, lon_key, date],
        |row| Ok((row.get::<_, f64>(0)?, row.get::<_, String>(1)?)),
    )
    .ok()
}

/// 편각을 DB에 캐시 저장 (UPSERT)
pub fn save_cache(
    conn: &Connection,
    lat: f64,
    lon: f64,
    date: &str,
    dec: f64,
    source: &str,
) -> rusqlite::Result<()> {
    let (lat_key, lon_key) = grid_key(lat, lon);
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    conn.execute(
        "INSERT OR REPLACE INTO declination_cache
         (lat_key, lon_key, date_key, declination_deg, source, fetched_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![lat_key, lon_key, date, dec, source, now],
    )?;
    Ok(())
}

/// NOAA API에서 자기편각 조회
pub async fn fetch_noaa(lat: f64, lon: f64, year: i32, month: u32, day: u32) -> Result<f64, String> {
    let url = format!(
        "https://www.ngdc.noaa.gov/geomag-web/calculators/calculateDeclination\
         ?lat1={}&lon1={}&startYear={}&startMonth={}&startDay={}&resultFormat=json",
        lat, lon, year, month, day
    );
    info!("NOAA declination request: {}", url);

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("NOAA request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("NOAA HTTP {}", resp.status()));
    }

    let body: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("NOAA JSON parse error: {}", e))?;

    // NOAA 응답 구조: { "result": [ { "declination": -8.47, ... } ] }
    body["result"]
        .as_array()
        .and_then(|arr| arr.first())
        .and_then(|r| r["declination"].as_f64())
        .ok_or_else(|| format!("NOAA response missing declination: {}", body))
}

/// WMM 크레이트로 오프라인 편각 계산
pub fn compute_wmm(lat: f64, lon: f64, year: i32, month: u32, day: u32) -> Result<f64, String> {
    let tm = time::Month::try_from(month as u8).map_err(|_| "invalid month".to_string())?;
    let date = time::Date::from_calendar_date(year, tm, day as u8)
        .map_err(|e| format!("Date error: {}", e))?;
    let dec = wmm::declination(date, lat as f32, lon as f32)
        .map_err(|e| format!("WMM error: {:?}", e))?;
    Ok(dec as f64)
}

/// 날짜 문자열 "YYYY-MM-DD" 파싱
pub fn parse_date(date: &str) -> Result<(i32, u32, u32), String> {
    let parts: Vec<&str> = date.split('-').collect();
    if parts.len() != 3 {
        return Err(format!("Invalid date format: {}", date));
    }
    let year: i32 = parts[0].parse().map_err(|_| "Invalid year".to_string())?;
    let month: u32 = parts[1].parse().map_err(|_| "Invalid month".to_string())?;
    let day: u32 = parts[2].parse().map_err(|_| "Invalid day".to_string())?;
    Ok((year, month, day))
}

/// 동기 버전: spawn_blocking 안에서 사용 (캐시 + WMM만, API 호출 없음)
pub fn get_declination_sync(conn: &Connection, lat: f64, lon: f64, date: &str) -> f64 {
    if let Some((dec, _)) = get_cached(conn, lat, lon, date) {
        return dec;
    }
    let (year, month, day) = match parse_date(date) {
        Ok(v) => v,
        Err(_) => return DEFAULT_DECLINATION,
    };
    match compute_wmm(lat, lon, year, month, day) {
        Ok(dec) => {
            let _ = save_cache(conn, lat, lon, date, dec, "wmm");
            dec
        }
        Err(_) => DEFAULT_DECLINATION,
    }
}

/// DB에서 WMM 소스 엔트리 목록 조회 (sync)
pub fn list_wmm_entries(conn: &Connection) -> Vec<(String, String, String)> {
    let Ok(mut stmt) = conn.prepare(
        "SELECT lat_key, lon_key, date_key FROM declination_cache WHERE source = 'wmm'"
    ) else {
        return Vec::new();
    };
    stmt.query_map([], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
        ))
    })
    .map(|rows| rows.filter_map(|r| r.ok()).collect())
    .unwrap_or_default()
}
