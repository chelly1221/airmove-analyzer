pub mod analysis;
pub mod db;
pub mod models;
pub mod parser;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use log::info;
use rayon::prelude::*;
use tauri::{Emitter, Manager};

use models::{AdsbTrack, Aircraft, AnalysisResult, FlightRecord, ParsedFile, TrackPoint};

/// TrackPoint 청크 스트리밍 이벤트 페이로드
#[derive(Clone, serde::Serialize)]
struct TrackPointsChunk {
    file_path: String,
    points: Vec<TrackPoint>,
}

/// TrackPoints를 청크 단위로 이벤트 emit한 뒤, 원본에서 제거
const CHUNK_SIZE: usize = 5000;

fn emit_and_drain_track_points(
    handle: &tauri::AppHandle,
    file_path: &str,
    points: &mut Vec<TrackPoint>,
) {
    for chunk in points.chunks(CHUNK_SIZE) {
        let _ = handle.emit("parse-points-chunk", TrackPointsChunk {
            file_path: file_path.to_string(),
            points: chunk.to_vec(),
        });
    }
    // 메모리 해제 — 이미 프론트엔드로 전송됨
    points.clear();
    points.shrink_to_fit();
}

/// OAuth2 토큰 캐시
struct OAuthToken {
    access_token: String,
    expires_at: std::time::Instant,
}

/// Application state for managing aircraft data.
struct AppState {
    aircraft_path: Mutex<PathBuf>,
    db: Mutex<db::Db>,
    oauth_token: Mutex<Option<OAuthToken>>,
}

/// OAuth2 토큰 응답
#[derive(serde::Deserialize)]
struct OAuthTokenResponse {
    access_token: String,
    expires_in: u64,
}

/// OpenSky OAuth2 토큰 발급/갱신
async fn get_opensky_token(
    client: &reqwest::Client,
    client_id: &str,
    client_secret: &str,
) -> Result<(String, u64), String> {
    let resp = client
        .post("https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token")
        .form(&[
            ("grant_type", "client_credentials"),
            ("client_id", client_id),
            ("client_secret", client_secret),
        ])
        .send()
        .await
        .map_err(|e| format!("OAuth2 token request failed: {}", e))?;

    if !resp.status().is_success() {
        return Err(format!("OAuth2 token error: HTTP {}", resp.status()));
    }

    let token_resp: OAuthTokenResponse = resp
        .json()
        .await
        .map_err(|e| format!("OAuth2 token parse error: {}", e))?;

    Ok((token_resp.access_token, token_resp.expires_in))
}

/// 캐싱된 토큰 반환 (만료 시 자동 갱신, 여유 60초)
async fn ensure_opensky_token(
    app_handle: &tauri::AppHandle,
    client: &reqwest::Client,
) -> Result<Option<String>, String> {
    let (client_id, client_secret) = {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
        let id = db::get_setting(&conn, "opensky_client_id")
            .unwrap_or(None)
            .unwrap_or_default();
        let secret = db::get_setting(&conn, "opensky_client_secret")
            .unwrap_or(None)
            .unwrap_or_default();
        (id, secret)
    };

    if client_id.is_empty() || client_secret.is_empty() {
        return Ok(None);
    }

    // 캐시된 토큰 확인
    {
        let state = app_handle.state::<AppState>();
        let cache = state.oauth_token.lock().map_err(|e| format!("Token lock: {}", e))?;
        if let Some(ref token) = *cache {
            if token.expires_at > std::time::Instant::now() + std::time::Duration::from_secs(60) {
                return Ok(Some(token.access_token.clone()));
            }
        }
    }

    // 새 토큰 발급
    info!("Requesting new OpenSky OAuth2 token...");
    let (access_token, expires_in) = get_opensky_token(client, &client_id, &client_secret).await?;

    // 캐시 저장
    {
        let state = app_handle.state::<AppState>();
        let mut cache = state.oauth_token.lock().map_err(|e| format!("Token lock: {}", e))?;
        *cache = Some(OAuthToken {
            access_token: access_token.clone(),
            expires_at: std::time::Instant::now() + std::time::Duration::from_secs(expires_in),
        });
    }

    info!("OAuth2 token acquired (expires in {}s)", expires_in);
    Ok(Some(access_token))
}

/// Get the path to the aircraft data JSON file.
fn get_aircraft_file_path(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?;

    // Ensure directory exists
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }

    Ok(app_data_dir.join("aircraft.json"))
}

/// Load aircraft list from the JSON data file.
fn load_aircraft_from_file(path: &PathBuf) -> Vec<Aircraft> {
    if !path.exists() {
        return Vec::new();
    }

    match fs::read_to_string(path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_else(|e| {
            log::warn!("Failed to parse aircraft file: {}. Starting fresh.", e);
            Vec::new()
        }),
        Err(e) => {
            log::warn!("Failed to read aircraft file: {}. Starting fresh.", e);
            Vec::new()
        }
    }
}

/// Save aircraft list to the JSON data file.
fn save_aircraft_to_file(path: &PathBuf, aircraft: &[Aircraft]) -> Result<(), String> {
    let json = serde_json::to_string_pretty(aircraft)
        .map_err(|e| format!("Failed to serialize aircraft data: {}", e))?;

    fs::write(path, json).map_err(|e| format!("Failed to write aircraft file: {}", e))
}

// ---------- Tauri Commands ----------

/// Parse an ASS binary file and return structured track data.
#[tauri::command]
async fn parse_ass_file(path: String, radar_lat: f64, radar_lon: f64, mode_s_filter: Vec<String>) -> Result<ParsedFile, String> {
    info!("Command: parse_ass_file({}, radar={},{}, filter={:?})", path, radar_lat, radar_lon, mode_s_filter);
    tauri::async_runtime::spawn_blocking(move || {
        parser::ass::parse_ass_file(&path, radar_lat, radar_lon, &mode_s_filter, |_| {}).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// Analyze parsed track data: detect loss segments and compute statistics.
#[tauri::command]
fn analyze_tracks(parsed: ParsedFile, threshold: f64) -> Result<AnalysisResult, String> {
    info!(
        "Command: analyze_tracks({}, threshold={}s)",
        parsed.filename, threshold
    );

    if threshold <= 0.0 {
        return Err("Threshold must be a positive number".to_string());
    }

    Ok(analysis::loss::analyze_tracks(parsed, threshold))
}

/// Get the list of registered aircraft.
#[tauri::command]
fn get_aircraft_list(state: tauri::State<'_, AppState>) -> Result<Vec<Aircraft>, String> {
    let path = state
        .aircraft_path
        .lock()
        .map_err(|e| format!("Failed to acquire lock: {}", e))?;
    Ok(load_aircraft_from_file(&path))
}

/// Save (add or update) an aircraft to the persistent store.
#[tauri::command]
fn save_aircraft(aircraft: Aircraft, state: tauri::State<'_, AppState>) -> Result<(), String> {
    info!("Command: save_aircraft(id={}, name={})", aircraft.id, aircraft.name);

    let path = state
        .aircraft_path
        .lock()
        .map_err(|e| format!("Failed to acquire lock: {}", e))?;
    let mut list = load_aircraft_from_file(&path);

    // Check if aircraft already exists (update) or is new (insert)
    if let Some(existing) = list.iter_mut().find(|a| a.id == aircraft.id) {
        *existing = aircraft;
    } else {
        list.push(aircraft);
    }

    save_aircraft_to_file(&path, &list)
}

/// Delete an aircraft by its ID.
#[tauri::command]
fn delete_aircraft(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    info!("Command: delete_aircraft(id={})", id);

    let path = state
        .aircraft_path
        .lock()
        .map_err(|e| format!("Failed to acquire lock: {}", e))?;
    let mut list = load_aircraft_from_file(&path);

    let original_len = list.len();
    list.retain(|a| a.id != id);

    if list.len() == original_len {
        return Err(format!("Aircraft with id '{}' not found", id));
    }

    save_aircraft_to_file(&path, &list)
}

/// Parse an ASS file and immediately analyze it.
#[tauri::command]
async fn parse_and_analyze(
    file_path: String,
    radar_lat: f64,
    radar_lon: f64,
    mode_s_filter: Vec<String>,
) -> Result<AnalysisResult, String> {
    info!("Command: parse_and_analyze({}, radar={},{}, filter={:?})", file_path, radar_lat, radar_lon, mode_s_filter);
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = parser::ass::parse_ass_file(&file_path, radar_lat, radar_lon, &mode_s_filter, |_| {})
            .map_err(|e| e.to_string())?;
        Ok(analysis::loss::analyze_tracks(parsed, analysis::loss::DEFAULT_THRESHOLD_SECS))
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 배치 파싱 결과 이벤트 페이로드 (파일 하나 완료 시 emit, track_points는 이미 청크로 전송됨)
#[derive(Clone, serde::Serialize)]
struct BatchResultEvent {
    file_path: String,
    success: bool,
    result: Option<AnalysisResult>,
    error: Option<String>,
}

/// 배치 완료 이벤트 페이로드
#[derive(Clone, serde::Serialize)]
struct BatchDoneEvent {
    total: usize,
    succeeded: usize,
    failed: usize,
}

/// 여러 ASS 파일을 병렬로 파싱+분석.
/// 1단계: rayon으로 모든 파일을 병렬 파싱 (CPU-bound, emit 없음)
/// 2단계: 완료된 결과를 순차적으로 청크 스트리밍 (IPC 락 경합 없음)
#[tauri::command]
async fn parse_and_analyze_batch(
    app_handle: tauri::AppHandle,
    file_paths: Vec<String>,
    radar_lat: f64,
    radar_lon: f64,
    mode_s_filter: Vec<String>,
) -> Result<(), String> {
    info!(
        "Command: parse_and_analyze_batch({} files, radar={},{}, filter={:?})",
        file_paths.len(),
        radar_lat,
        radar_lon,
        mode_s_filter
    );

    let handle = app_handle.clone();
    let total = file_paths.len();

    tauri::async_runtime::spawn_blocking(move || {
        // 1단계: 병렬 파싱 (emit 없음 → 락 경합 없음, 순수 CPU 활용)
        let filter = &mode_s_filter;
        let mut results: Vec<(String, Result<AnalysisResult, String>)> = file_paths
            .par_iter()
            .map(|path| {
                let r = parser::ass::parse_ass_file(path, radar_lat, radar_lon, filter, |_| {})
                    .map_err(|e| e.to_string())
                    .map(|parsed| {
                        analysis::loss::analyze_tracks(parsed, analysis::loss::DEFAULT_THRESHOLD_SECS)
                    });
                (path.clone(), r)
            })
            .collect();

        // 2단계: 순차적으로 결과 스트리밍 (IPC 병목 최소화)
        let mut succeeded = 0usize;
        let mut failed = 0usize;

        for (path, result) in results.iter_mut() {
            let event = match result {
                Ok(ref mut analysis) => {
                    succeeded += 1;
                    // track_points를 청크로 스트리밍 후 메모리 해제
                    emit_and_drain_track_points(&handle, path, &mut analysis.file_info.track_points);
                    BatchResultEvent {
                        file_path: path.clone(),
                        success: true,
                        result: Some(analysis.clone()),
                        error: None,
                    }
                }
                Err(ref e) => {
                    failed += 1;
                    BatchResultEvent {
                        file_path: path.clone(),
                        success: false,
                        result: None,
                        error: Some(e.clone()),
                    }
                }
            };
            let _ = handle.emit("batch-parse-result", event);
        }

        let _ = handle.emit("batch-parse-done", BatchDoneEvent {
            total,
            succeeded,
            failed,
        });
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))
}

/// Filter track points by Mode-S code (case-insensitive match).
#[tauri::command]
fn filter_tracks_by_mode_s(parsed: ParsedFile, mode_s: String) -> Vec<TrackPoint> {
    info!(
        "Command: filter_tracks_by_mode_s({}, mode_s={})",
        parsed.filename, mode_s
    );

    let mode_s_upper = mode_s.to_uppercase();
    parsed
        .track_points
        .into_iter()
        .filter(|p| p.mode_s.to_uppercase() == mode_s_upper)
        .collect()
}

/// 파일을 읽어 base64로 반환 (한글 폰트 등)
#[tauri::command]
fn read_file_base64(path: String) -> Result<String, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let bytes = std::fs::read(&path).map_err(|e| format!("Failed to read file: {}", e))?;
    Ok(STANDARD.encode(&bytes))
}

/// OpenSky Network API로 ADS-B 항적 조회
#[derive(serde::Deserialize)]
struct AdsbQuery {
    icao24: String,
    time: i64,
}

#[tauri::command]
async fn fetch_adsb_tracks(
    app_handle: tauri::AppHandle,
    queries: Vec<AdsbQuery>,
) -> Result<Vec<AdsbTrack>, String> {
    let client = reqwest::Client::builder()
        .user_agent("AirMoveAnalyzer/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // OAuth2 토큰 발급 (인증정보 필수 — 익명 접근 차단됨)
    let token = ensure_opensky_token(&app_handle, &client).await?;
    if token.is_none() {
        return Err("OpenSky 인증정보가 설정되지 않았습니다. 설정에서 Client ID/Secret을 입력하세요.".to_string());
    }
    let has_auth = true;

    let mut tracks = Vec::new();
    let total = queries.len();

    for (i, query) in queries.iter().enumerate() {
        let icao_lower = query.icao24.to_lowercase();
        let url = format!(
            "https://opensky-network.org/api/tracks/all?icao24={}&time={}",
            icao_lower, query.time
        );
        info!("Fetching ADS-B track ({}/{}): {}", i + 1, total, url);

        // 진행 상황 이벤트
        let _ = app_handle.emit("adsb-progress", serde_json::json!({
            "current": i + 1,
            "total": total,
            "icao24": &query.icao24,
        }));

        let mut retries = 0u32;
        loop {
            let mut req = client.get(&url);
            if let Some(ref t) = token {
                req = req.bearer_auth(t);
            }
            match req.send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(json) = resp.json::<serde_json::Value>().await {
                        if let Some(path_arr) = json.get("path").and_then(|p| p.as_array()) {
                            let points: Vec<models::AdsbPoint> = path_arr
                                .iter()
                                .filter_map(|entry| {
                                    let arr = entry.as_array()?;
                                    Some(models::AdsbPoint {
                                        time: arr.get(0)?.as_f64()?,
                                        latitude: arr.get(1)?.as_f64()?,
                                        longitude: arr.get(2)?.as_f64()?,
                                        altitude: arr.get(3)?.as_f64().unwrap_or(0.0),
                                        heading: arr.get(4)?.as_f64().unwrap_or(0.0),
                                        on_ground: arr.get(5)?.as_bool().unwrap_or(false),
                                    })
                                })
                                .collect();

                            if !points.is_empty() {
                                let track = AdsbTrack {
                                    icao24: query.icao24.clone(),
                                    callsign: json
                                        .get("callsign")
                                        .and_then(|c| c.as_str())
                                        .map(|s| s.trim().to_string()),
                                    start_time: json
                                        .get("startTime")
                                        .and_then(|t| t.as_f64())
                                        .unwrap_or(0.0),
                                    end_time: json
                                        .get("endTime")
                                        .and_then(|t| t.as_f64())
                                        .unwrap_or(0.0),
                                    path: points,
                                };
                                // DB 저장 (건별 즉시 영속화)
                                let state = app_handle.state::<AppState>();
                                if let Ok(conn) = state.db.lock() {
                                    let _ = db::save_adsb_track(&conn, &track);
                                }
                                drop(state);
                                tracks.push(track);
                            }
                        }
                    }
                    break;
                }
                Ok(resp) if resp.status().as_u16() == 429 && retries < 3 => {
                    // 429 Too Many Requests → 백오프 후 재시도
                    retries += 1;
                    let wait = 10 * retries as u64;
                    info!("Rate limited, retry {}/3 after {}s", retries, wait);
                    tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                    continue;
                }
                Ok(resp) => {
                    info!("ADS-B API returned {}: {}", resp.status(), query.icao24);
                    break;
                }
                Err(e) => {
                    log::warn!("Failed to fetch ADS-B for {}: {}", query.icao24, e);
                    break;
                }
            }
        }

        // OpenSky rate limit 준수 (인증시 1초, 익명 10초)
        if i + 1 < total {
            let delay = if has_auth { 1 } else { 10 };
            tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        }
    }

    Ok(tracks)
}

/// ADS-B 트랙 DB 조회 (ICAO24 목록 + 시간 범위)
#[tauri::command]
fn load_adsb_tracks_for_range(
    icao24_list: Vec<String>,
    start: f64,
    end: f64,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<AdsbTrack>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::load_adsb_tracks(&conn, &icao24_list, start, end)
        .map_err(|e| format!("DB load error: {}", e))
}

/// OpenSky /flights/aircraft API 응답
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpenSkyFlight {
    icao24: String,
    first_seen: f64,
    last_seen: f64,
    est_departure_airport: Option<String>,
    est_arrival_airport: Option<String>,
    callsign: Option<String>,
}

/// 운항이력 조회 (OpenSky API + DB 저장)
#[tauri::command]
async fn fetch_flight_history(
    app_handle: tauri::AppHandle,
    icao24: String,
    begin: i64,
    end: i64,
) -> Result<Vec<FlightRecord>, String> {
    let client = reqwest::Client::builder()
        .user_agent("AirMoveAnalyzer/0.1")
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    // OAuth2 토큰 발급 (인증정보 필수 — 익명 접근 차단됨)
    let token = ensure_opensky_token(&app_handle, &client).await?;
    if token.is_none() {
        return Err("OpenSky 인증정보가 설정되지 않았습니다. 설정에서 Client ID/Secret을 입력하세요.".to_string());
    }
    let has_auth = true;

    let window = 172800i64; // 2일 (API 최대 허용)
    let total_windows = ((end - begin) as f64 / window as f64).ceil() as usize;
    // 최신→과거 순서로 조회 (최근 데이터 우선)
    let mut cursor = end;
    let mut window_idx = 0usize;
    let mut rate_limited = false;

    info!("Flight history sync: icao24={}, {} windows (30-day each), newest→oldest", icao24, total_windows);

    while cursor > begin {
        let w_start = std::cmp::max(cursor - window, begin);
        let w_end = cursor;
        window_idx += 1;

        // 이미 조회한 구간이면 스킵 (결과 유무와 무관)
        let already_queried = {
            let state = app_handle.state::<AppState>();
            let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
            db::is_window_queried(&conn, &icao24, w_start, w_end)
                .unwrap_or(false)
        };

        if already_queried {
            cursor = w_start;
            continue;
        }

        // 진행 상황 이벤트
        let _ = app_handle.emit(
            "flight-history-progress",
            serde_json::json!({
                "current": window_idx,
                "total": total_windows,
                "icao24": &icao24,
            }),
        );

        let url = format!(
            "https://opensky-network.org/api/flights/aircraft?icao24={}&begin={}&end={}",
            icao24.to_lowercase(),
            w_start,
            w_end
        );

        let mut retries = 0u32;
        loop {
            let mut req = client.get(&url);
            if let Some(ref t) = token {
                req = req.bearer_auth(t);
            }
            match req.send().await {
                Ok(resp) if resp.status().is_success() => {
                    if let Ok(flights) = resp.json::<Vec<OpenSkyFlight>>().await {
                        let state = app_handle.state::<AppState>();
                        let conn =
                            state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
                        let mut new_records = Vec::new();
                        for f in &flights {
                            let record = FlightRecord {
                                icao24: f.icao24.clone(),
                                first_seen: f.first_seen,
                                last_seen: f.last_seen,
                                est_departure_airport: f.est_departure_airport.clone(),
                                est_arrival_airport: f.est_arrival_airport.clone(),
                                callsign: f
                                    .callsign
                                    .as_ref()
                                    .map(|s| s.trim().to_string()),
                            };
                            let _ = db::save_flight_record(&conn, &record);
                            new_records.push(record);
                        }
                        // 조회 완료 기록 (결과 0건이어도 기록)
                        let _ = db::mark_window_queried(&conn, &icao24, w_start, w_end);
                        // 프론트엔드에 증분 전송
                        if !new_records.is_empty() {
                            info!("Flight history: {} found {} records (window {}/{})",
                                icao24, new_records.len(), window_idx, total_windows);
                            let _ = app_handle.emit("flight-history-records", &new_records);
                        }
                    }
                    break;
                }
                Ok(resp) if resp.status().as_u16() == 404 => {
                    // 해당 구간 데이터 없음 — 조회 완료로 기록
                    info!("Flight history: {} no data for window {}/{}", icao24, window_idx, total_windows);
                    let state = app_handle.state::<AppState>();
                    if let Ok(conn) = state.db.lock() {
                        let _ = db::mark_window_queried(&conn, &icao24, w_start, w_end);
                    }
                    break;
                }
                Ok(resp) if resp.status().as_u16() == 403 => {
                    let body = resp.text().await.unwrap_or_default();
                    log::warn!("Flight history 403 Forbidden for {}: {}", icao24, body);
                    return Err(format!("OpenSky 접근 거부: {}. 인증정보를 확인하세요.", body.trim()));
                }
                Ok(resp) if resp.status().as_u16() == 429 && retries < 3 => {
                    retries += 1;
                    let wait = 10 * retries as u64;
                    info!("Flight history rate limited, retry {}/3 after {}s", retries, wait);
                    tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                    continue;
                }
                Ok(resp) if resp.status().as_u16() == 429 => {
                    // 일일 한도 초과 — 이 항공기 중단
                    info!("Daily rate limit reached for {}, stopping", icao24);
                    rate_limited = true;
                    break;
                }
                Ok(resp) => {
                    let status = resp.status();
                    let body = resp.text().await.unwrap_or_default();
                    log::warn!(
                        "Flight history API returned {} for {}: {}",
                        status,
                        icao24,
                        body
                    );
                    break;
                }
                Err(e) => {
                    log::warn!("Flight history fetch failed for {}: {}", icao24, e);
                    break;
                }
            }
        }

        if rate_limited {
            break;
        }

        cursor = w_start;
        // Rate limit 회피 (인증시 0.5초, 익명 1초)
        let delay_ms = if has_auth { 500 } else { 1000 };
        tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    }

    // Rate limit 시 에러 반환 (프론트엔드가 재시도 스케줄링)
    if rate_limited {
        return Err("rate limit reached".to_string());
    }

    // DB에서 전체 결과 로드
    let state = app_handle.state::<AppState>();
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::load_flight_history(&conn, &[icao24], begin as f64, end as f64)
        .map_err(|e| format!("DB load error: {}", e))
}

/// 운항이력 DB 조회
#[tauri::command]
fn load_flight_history(
    icao24_list: Vec<String>,
    start: f64,
    end: f64,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<FlightRecord>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::load_flight_history(&conn, &icao24_list, start, end)
        .map_err(|e| format!("DB load error: {}", e))
}

/// OpenSky 인증정보 저장
#[tauri::command]
fn save_opensky_credentials(
    client_id: String,
    client_secret: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::set_setting(&conn, "opensky_client_id", &client_id)
        .map_err(|e| format!("DB error: {}", e))?;
    db::set_setting(&conn, "opensky_client_secret", &client_secret)
        .map_err(|e| format!("DB error: {}", e))?;
    Ok(())
}

/// OpenSky 인증정보 로드
#[tauri::command]
fn load_opensky_credentials(
    state: tauri::State<'_, AppState>,
) -> Result<(String, String), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    let id = db::get_setting(&conn, "opensky_client_id")
        .map_err(|e| format!("DB error: {}", e))?
        .unwrap_or_default();
    let secret = db::get_setting(&conn, "opensky_client_secret")
        .map_err(|e| format!("DB error: {}", e))?
        .unwrap_or_default();
    Ok((id, secret))
}

// ---------- App Entry Point ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            let aircraft_path = get_aircraft_file_path(app.handle())
                .map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
            info!("Aircraft data path: {:?}", aircraft_path);

            // SQLite DB 초기화
            let db_path = aircraft_path.with_file_name("adsb.db");
            let db_conn = db::init_db(&db_path).map_err(|e| {
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("DB init error: {}", e),
                ))
            })?;
            info!("Database path: {:?}", db_path);

            // 기존 JSON 캐시 → DB 마이그레이션
            let cache_path = aircraft_path.with_file_name("adsb_cache.json");
            if cache_path.exists() {
                info!("Migrating adsb_cache.json to SQLite...");
                if let Err(e) = db::migrate_json_cache(&db_conn, &cache_path) {
                    log::warn!("Migration failed: {}", e);
                }
            }

            app.manage(AppState {
                aircraft_path: Mutex::new(aircraft_path),
                db: Mutex::new(db_conn),
                oauth_token: Mutex::new(None),
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            parse_ass_file,
            analyze_tracks,
            parse_and_analyze,
            parse_and_analyze_batch,
            get_aircraft_list,
            save_aircraft,
            delete_aircraft,
            filter_tracks_by_mode_s,
            read_file_base64,
            fetch_adsb_tracks,
            load_adsb_tracks_for_range,
            fetch_flight_history,
            load_flight_history,
            save_opensky_credentials,
            load_opensky_credentials,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
