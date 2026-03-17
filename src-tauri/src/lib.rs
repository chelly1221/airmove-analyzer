pub mod analysis;
pub mod building;
pub mod coord;
pub mod db;
pub mod declination;
pub mod models;
pub mod parser;
pub mod srtm;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use log::info;

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
    app_data_dir: Mutex<PathBuf>,
    db: Mutex<db::Db>,
    oauth_token: Mutex<Option<OAuthToken>>,
    srtm: Mutex<srtm::SrtmReader>,
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

/// 앱 데이터 디렉토리 경로 확보
fn get_app_data_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?;

    // Ensure directory exists
    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }

    Ok(app_data_dir)
}

// ---------- Tauri Commands ----------

/// Parse an ASS binary file and return structured track data.
#[tauri::command]
async fn parse_ass_file(path: String, radar_lat: f64, radar_lon: f64, mode_s_filter: Vec<String>, app_handle: tauri::AppHandle) -> Result<ParsedFile, String> {
    info!("Command: parse_ass_file({}, radar={},{}, filter={:?})", path, radar_lat, radar_lon, mode_s_filter);
    // 편각 조회 (파일 날짜 + 레이더 좌표)
    let mag_dec = resolve_declination(&app_handle, &path, radar_lat, radar_lon).await;
    tauri::async_runtime::spawn_blocking(move || {
        parser::ass::parse_ass_file(&path, radar_lat, radar_lon, &mode_s_filter, mag_dec, |_| {}).map_err(|e| e.to_string())
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
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::get_aircraft_list(&conn).map_err(|e| format!("DB error: {}", e))
}

/// Save (add or update) an aircraft to the persistent store.
#[tauri::command]
fn save_aircraft(aircraft: Aircraft, state: tauri::State<'_, AppState>) -> Result<(), String> {
    info!("Command: save_aircraft(id={}, name={})", aircraft.id, aircraft.name);
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::save_aircraft(&conn, &aircraft).map_err(|e| format!("DB error: {}", e))
}

/// Delete an aircraft by its ID.
#[tauri::command]
fn delete_aircraft(id: String, state: tauri::State<'_, AppState>) -> Result<(), String> {
    info!("Command: delete_aircraft(id={})", id);
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    let changed = db::delete_aircraft(&conn, &id).map_err(|e| format!("DB error: {}", e))?;
    if changed == 0 {
        return Err(format!("Aircraft with id '{}' not found", id));
    }
    Ok(())
}

/// Parse an ASS file and immediately analyze it (결과를 DB에 자동 저장).
#[tauri::command]
async fn parse_and_analyze(
    app_handle: tauri::AppHandle,
    file_path: String,
    radar_lat: f64,
    radar_lon: f64,
    mode_s_filter: Vec<String>,
) -> Result<AnalysisResult, String> {
    info!("Command: parse_and_analyze({}, radar={},{}, filter={:?})", file_path, radar_lat, radar_lon, mode_s_filter);
    let mag_dec = resolve_declination(&app_handle, &file_path, radar_lat, radar_lon).await;
    let handle = app_handle.clone();
    let fp = file_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = parser::ass::parse_ass_file(&fp, radar_lat, radar_lon, &mode_s_filter, mag_dec, |_| {})
            .map_err(|e| e.to_string())?;
        let analysis = analysis::loss::analyze_tracks(parsed, analysis::loss::DEFAULT_THRESHOLD_SECS);

        // DB에 자동 저장
        let state = handle.state::<AppState>();
        if let Ok(conn) = state.db.lock() {
            let name = fp.split(['/', '\\']).last().unwrap_or(&fp).to_string();
            if let Err(e) = db::save_parsed_file_data(&conn, &fp, &name, &analysis) {
                log::warn!("Failed to save parsed data to DB: {}", e);
            }
        }

        Ok(analysis)
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))?
}

/// 배치 파싱 결과 이벤트 페이로드 (파일 하나 완료 시 emit, track_points는 청크로 별도 전송)
#[derive(Clone, serde::Serialize)]
struct BatchResultEvent {
    file_path: String,
    success: bool,
    /// 파일 메타정보 (track_points 제외 — 청크 스트리밍으로 별도 전송)
    file_info: Option<BatchFileInfo>,
    error: Option<String>,
}

/// 배치 결과에 포함할 파일 메타정보 (track_points 제외하여 메모리 절약)
#[derive(Clone, serde::Serialize)]
struct BatchFileInfo {
    filename: String,
    total_records: usize,
    parse_errors: Vec<String>,
    start_time: Option<f64>,
    end_time: Option<f64>,
    radar_lat: f64,
    radar_lon: f64,
    parse_stats: Option<models::ParseStatistics>,
    track_point_count: usize,
}

/// 배치 완료 이벤트 페이로드
#[derive(Clone, serde::Serialize)]
struct BatchDoneEvent {
    total: usize,
    succeeded: usize,
    failed: usize,
}

/// 여러 ASS 파일을 병렬로 파싱+분석.
/// rayon 병렬 파싱 + 채널 기반 즉시 스트리밍 (파일 완료 즉시 메모리 해제)
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

    // 배치 전체에 대해 편각 1회 조회 (첫 번째 파일 날짜 기준, 배치 내 날짜 차이는 무시 가능)
    let mag_dec = if let Some(first) = file_paths.first() {
        resolve_declination(&app_handle, first, radar_lat, radar_lon).await
    } else {
        -8.5
    };

    let handle = app_handle.clone();
    let total = file_paths.len();

    tauri::async_runtime::spawn_blocking(move || {
        let (tx, rx) = std::sync::mpsc::channel::<(String, Result<AnalysisResult, String>)>();

        // 병렬 파싱 스레드: 완료 즉시 채널로 전송 (메모리 일괄 보유 방지)
        let filter = mode_s_filter;
        let filter_ref = &filter;
        rayon::scope(|s| {
            let tx = &tx;
            for path in &file_paths {
                let path = path.clone();
                s.spawn(move |_| {
                    let r = parser::ass::parse_ass_file(&path, radar_lat, radar_lon, filter_ref, mag_dec, |_| {})
                        .map_err(|e| e.to_string())
                        .map(|parsed| {
                            analysis::loss::analyze_tracks(parsed, analysis::loss::DEFAULT_THRESHOLD_SECS)
                        });
                    let _ = tx.send((path, r));
                });
            }
        });
        // rayon scope 완료 후 sender drop → rx 종료
        drop(tx);

        // 수신 스레드: 결과 도착 즉시 DB 저장 + 스트리밍 + 메모리 해제
        let mut succeeded = 0usize;
        let mut failed = 0usize;

        for (path, result) in rx {
            let event = match result {
                Ok(mut analysis) => {
                    succeeded += 1;
                    // DB에 자동 저장 (메모리 해제 전)
                    let state = handle.state::<AppState>();
                    if let Ok(conn) = state.db.lock() {
                        let name = path.split(['/', '\\']).last().unwrap_or(&path).to_string();
                        if let Err(e) = db::save_parsed_file_data(&conn, &path, &name, &analysis) {
                            log::warn!("Failed to save parsed data to DB: {}", e);
                            analysis.file_info.parse_errors.push(
                                format!("DB 저장 실패: {}", e)
                            );
                        }
                    } else {
                        analysis.file_info.parse_errors.push(
                            "DB 잠금 획득 실패: 파싱 데이터가 저장되지 않았습니다".to_string()
                        );
                    }
                    // 메타정보만 추출 (clone 없이, track_points 제외)
                    let file_info = BatchFileInfo {
                        filename: analysis.file_info.filename.clone(),
                        total_records: analysis.file_info.total_records,
                        parse_errors: analysis.file_info.parse_errors.clone(),
                        start_time: analysis.file_info.start_time,
                        end_time: analysis.file_info.end_time,
                        radar_lat: analysis.file_info.radar_lat,
                        radar_lon: analysis.file_info.radar_lon,
                        parse_stats: analysis.file_info.parse_stats.clone(),
                        track_point_count: analysis.file_info.track_points.len(),
                    };
                    // track_points를 청크로 스트리밍 후 메모리 해제
                    emit_and_drain_track_points(&handle, &path, &mut analysis.file_info.track_points);

                    // analysis는 여기서 drop → 메모리 즉시 해제
                    BatchResultEvent {
                        file_path: path,
                        success: true,
                        file_info: Some(file_info),
                        error: None,
                    }
                }
                Err(e) => {
                    failed += 1;
                    BatchResultEvent {
                        file_path: path,
                        success: false,
                        file_info: None,
                        error: Some(e),
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

/// base64 데이터를 파일로 저장 (PDF 등)
#[tauri::command]
fn write_file_base64(path: String, data: String) -> Result<(), String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    let bytes = STANDARD.decode(&data).map_err(|e| format!("Base64 decode error: {}", e))?;
    fs::write(&path, &bytes).map_err(|e| format!("Failed to write file: {}", e))?;
    Ok(())
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
                    // X-Rate-Limit-Retry-After-Seconds 헤더 활용
                    let retry_after = resp.headers()
                        .get("X-Rate-Limit-Retry-After-Seconds")
                        .or_else(|| resp.headers().get("x-rate-limit-retry-after-seconds"))
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok());
                    retries += 1;
                    let wait = retry_after.unwrap_or(10 * retries as u64);
                    info!("Rate limited, retry {}/3 after {}s (header: {:?})", retries, wait, retry_after);
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

    let window = 86400i64; // 1일 (OpenSky는 calendar day 기준 파티션 → 2일 윈도우 시 3파티션 에러)
    let total_windows = ((end - begin) as f64 / window as f64).ceil() as usize;
    // 최신→과거 순서로 조회 (최근 데이터 우선)
    let mut cursor = end;
    let mut window_idx = 0usize;
    let mut rate_limited = false;

    info!("Flight history sync: icao24={}, {} windows (1-day each), newest→oldest", icao24, total_windows);

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
                    // 남은 크레딧 로깅
                    let remaining_credits = resp.headers()
                        .get("X-Rate-Limit-Remaining")
                        .or_else(|| resp.headers().get("x-rate-limit-remaining"))
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<i64>().ok());
                    if let Some(rem) = remaining_credits {
                        info!("OpenSky credits remaining: {}", rem);
                    }
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
                Ok(resp) if resp.status().as_u16() == 429 => {
                    // X-Rate-Limit-Retry-After-Seconds 헤더에서 대기 시간 읽기
                    let retry_after_secs = resp.headers()
                        .get("X-Rate-Limit-Retry-After-Seconds")
                        .or_else(|| resp.headers().get("x-rate-limit-retry-after-seconds"))
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<u64>().ok());

                    let remaining = resp.headers()
                        .get("X-Rate-Limit-Remaining")
                        .or_else(|| resp.headers().get("x-rate-limit-remaining"))
                        .and_then(|v| v.to_str().ok())
                        .and_then(|s| s.parse::<i64>().ok());

                    info!("Flight history 429 for {}: retry_after={}s, remaining={:?}",
                        icao24,
                        retry_after_secs.unwrap_or(0),
                        remaining,
                    );

                    if retries < 3 {
                        retries += 1;
                        let wait = retry_after_secs.unwrap_or(10 * retries as u64);
                        info!("Flight history rate limited, retry {}/3 after {}s", retries, wait);
                        tokio::time::sleep(std::time::Duration::from_secs(wait)).await;
                        continue;
                    }

                    // 일일 한도 초과 — 이 항공기 중단, retry_after 정보 포함
                    info!("Daily rate limit reached for {}, stopping (retry_after={}s)",
                        icao24, retry_after_secs.unwrap_or(0));
                    rate_limited = true;
                    // rate_limit_retry_after를 에러 메시지에 포함하여 프론트엔드가 활용
                    if let Some(secs) = retry_after_secs {
                        let _ = app_handle.emit("flight-history-progress", serde_json::json!({
                            "current": window_idx,
                            "total": total_windows,
                            "icao24": &icao24,
                            "retry_after_secs": secs,
                        }));
                    }
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
                    // 4xx 에러는 재시도해도 의미 없으므로 조회 완료 처리
                    if status.as_u16() >= 400 && status.as_u16() < 500 {
                        let state = app_handle.state::<AppState>();
                        if let Ok(conn) = state.db.lock() {
                            let _ = db::mark_window_queried(&conn, &icao24, w_start, w_end);
                        };
                    }
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
        return Err("rate_limit_reached".to_string());
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

/// 설정값 로드 (프론트엔드용)
#[tauri::command]
fn load_setting(
    key: String,
    state: tauri::State<'_, AppState>,
) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::get_setting(&conn, &key).map_err(|e| format!("DB error: {}", e))
}

/// 설정값 저장 (프론트엔드용)
#[tauri::command]
fn save_setting(
    key: String,
    value: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::set_setting(&conn, &key, &value).map_err(|e| format!("DB error: {}", e))
}

/// DB에서 저장된 파싱 데이터 로드 (앱 시작 시 호출) — 레거시 (소량 데이터 호환)
#[tauri::command]
fn load_saved_data(
    state: tauri::State<'_, AppState>,
) -> Result<db::SavedParsedData, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::load_all_parsed_data(&conn).map_err(|e| format!("DB load error: {}", e))
}

/// 파일 메타데이터만 로드 (포인트 제외, 스트리밍 복원 1단계)
#[tauri::command]
fn load_saved_file_metas(
    state: tauri::State<'_, AppState>,
) -> Result<db::SavedParsedMeta, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::load_parsed_file_metas(&conn).map_err(|e| format!("DB load error: {}", e))
}

/// 특정 파일의 track_points를 로드 (파일 단위 분할 복원)
#[tauri::command]
async fn load_file_track_points(
    state: tauri::State<'_, AppState>,
    file_id: i64,
) -> Result<Vec<TrackPoint>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    let mut points = Vec::new();
    db::load_track_points_chunked(&conn, file_id, 50000, |chunk| {
        points.extend(chunk);
    }).map_err(|e| format!("DB load error: {}", e))?;
    Ok(points)
}

/// 저장된 파싱 데이터 전체 삭제
#[tauri::command]
fn clear_saved_data(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::clear_all_parsed_data(&conn).map_err(|e| format!("DB clear error: {}", e))
}

/// 특정 파싱 파일 삭제 (건별)
#[tauri::command]
fn delete_parsed_file(
    file_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::delete_parsed_file(&conn, &file_path).map_err(|e| format!("DB delete error: {}", e))
}

/// 여러 파싱 파일 삭제 (경로 목록)
#[tauri::command]
fn delete_parsed_files(
    file_paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::delete_parsed_files(&conn, &file_paths).map_err(|e| format!("DB delete error: {}", e))
}

// ========== 기상 데이터 캐시 ==========

/// 일 단위 기상 데이터 저장
#[tauri::command]
fn save_weather_day(
    date: String,
    radar_lat: f64,
    radar_lon: f64,
    hourly_json: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::save_weather_day(&conn, &date, radar_lat, radar_lon, &hourly_json)
        .map_err(|e| format!("DB error: {}", e))
}

/// 일 단위 구름 그리드 저장
#[tauri::command]
fn save_cloud_grid_day(
    date: String,
    radar_lat: f64,
    radar_lon: f64,
    grid_spacing_km: f64,
    frames_json: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::save_cloud_grid_day(&conn, &date, radar_lat, radar_lon, grid_spacing_km, &frames_json)
        .map_err(|e| format!("DB error: {}", e))
}

/// 캐시된 기상/구름 날짜 목록 조회
#[tauri::command]
fn get_weather_cached_dates(
    radar_lat: f64,
    radar_lon: f64,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<String>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::get_weather_cached_dates(&conn, radar_lat, radar_lon)
        .map_err(|e| format!("DB error: {}", e))
}

/// 캐시된 기상 데이터 로드 (날짜 목록)
#[tauri::command]
fn load_weather_cache(
    radar_lat: f64,
    radar_lon: f64,
    dates: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::load_weather_cache(&conn, radar_lat, radar_lon, &dates)
        .map_err(|e| format!("DB error: {}", e))
}

/// 캐시된 구름 그리드 로드 (날짜 목록)
#[tauri::command]
fn load_cloud_grid_cache(
    radar_lat: f64,
    radar_lon: f64,
    dates: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<(String, String, f64)>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::load_cloud_grid_cache(&conn, radar_lat, radar_lon, &dates)
        .map_err(|e| format!("DB error: {}", e))
}

/// DB 파일 경로 반환 (내보내기/가져오기 용)
fn get_db_path(state: &AppState) -> Result<PathBuf, String> {
    let app_data_dir = state.app_data_dir.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(app_data_dir.join("adsb.db"))
}

/// DB 내보내기 (현재 DB를 지정 경로로 복사)
#[tauri::command]
fn export_database(
    dest_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let db_path = get_db_path(&state)?;
    // WAL 체크포인트 → 단일 파일로 정리
    {
        let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
            .map_err(|e| format!("WAL checkpoint error: {}", e))?;
    }
    fs::copy(&db_path, &dest_path)
        .map_err(|e| format!("파일 복사 실패: {}", e))?;
    info!("Database exported to: {}", dest_path);
    Ok(())
}

/// DB 가져오기 (지정 경로의 DB로 교체, 연결 재수립)
#[tauri::command]
fn import_database(
    src_path: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let db_path = get_db_path(&state)?;
    let src = std::path::Path::new(&src_path);

    // 유효한 SQLite 파일인지 확인 (매직 바이트)
    let header = fs::read(src)
        .map_err(|e| format!("파일 읽기 실패: {}", e))?;
    if header.len() < 16 || &header[0..16] != b"SQLite format 3\0" {
        return Err("유효한 SQLite 데이터베이스 파일이 아닙니다.".to_string());
    }

    // 기존 연결 닫고 파일 교체 후 재연결
    let mut conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    // WAL/SHM 파일 정리
    drop(std::mem::replace(&mut *conn, rusqlite::Connection::open_in_memory().map_err(|e| format!("임시 DB 오류: {}", e))?));

    // DB 파일 교체
    fs::copy(src, &db_path)
        .map_err(|e| format!("파일 복사 실패: {}", e))?;
    // WAL/SHM 잔여 파일 제거
    let _ = fs::remove_file(db_path.with_extension("db-wal"));
    let _ = fs::remove_file(db_path.with_extension("db-shm"));

    // 새 연결 수립
    let new_conn = db::init_db(&db_path)
        .map_err(|e| format!("DB 재연결 실패: {}", e))?;
    *conn = new_conn;

    info!("Database imported from: {}", src_path);
    Ok(())
}

/// 360° LoS 파노라마 계산 (지형 + GIS건물 + 수동건물)
#[tauri::command]
fn calculate_los_panorama(
    state: tauri::State<'_, AppState>,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    max_range_km: Option<f64>,
    azimuth_step_deg: Option<f64>,
    range_step_m: Option<f64>,
) -> Result<Vec<analysis::panorama::PanoramaPoint>, String> {
    let max_range = max_range_km.unwrap_or(100.0);
    let az_step = azimuth_step_deg.unwrap_or(0.5);
    let r_step = range_step_m.unwrap_or(200.0);

    // DB 먼저 잠금 해제하고 건물 조회, 그 다음 SRTM
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;

    Ok(analysis::panorama::calculate_panorama(
        &mut srtm, &conn,
        radar_lat, radar_lon, radar_height_m,
        max_range, az_step, r_step,
    ))
}

/// 파노라마 캐시 저장
#[tauri::command]
fn save_panorama_cache(
    state: tauri::State<'_, AppState>,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    data_json: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::save_panorama_cache(&conn, radar_lat, radar_lon, radar_height_m, &data_json)
        .map_err(|e| format!("DB error: {}", e))
}

/// 파노라마 캐시 로드
#[tauri::command]
fn load_panorama_cache(
    state: tauri::State<'_, AppState>,
    radar_lat: f64,
    radar_lon: f64,
) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::load_panorama_cache(&conn, radar_lat, radar_lon)
        .map_err(|e| format!("DB error: {}", e))
}

/// 파노라마 캐시 삭제
#[tauri::command]
fn clear_panorama_cache(
    state: tauri::State<'_, AppState>,
    radar_lat: f64,
    radar_lon: f64,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::clear_panorama_cache(&conn, radar_lat, radar_lon)
        .map_err(|e| format!("DB error: {}", e))
}

/// SRTM HGT 기반 고도 조회 (30m 해상도, 로컬 파일)
#[tauri::command]
fn fetch_elevation(
    app_handle: tauri::AppHandle,
    latitudes: Vec<f64>,
    longitudes: Vec<f64>,
) -> Result<Vec<f64>, String> {
    if latitudes.len() != longitudes.len() {
        return Err("latitudes/longitudes 길이가 다릅니다".to_string());
    }
    if latitudes.is_empty() {
        return Ok(vec![]);
    }

    let state = app_handle.state::<AppState>();
    let mut reader = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
    Ok(reader.get_elevations(&latitudes, &longitudes))
}

/// 한국 SRTM 타일 다운로드 (AWS Terrain Tiles, 인증 불필요)
/// lat 33~38, lon 124~131 → 최대 42타일 (~250MB)
#[tauri::command]
async fn download_srtm_korea(
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    use flate2::read::GzDecoder;
    use std::io::Read;

    let (srtm_dir, db_path) = {
        let state = app_handle.state::<AppState>();
        let reader = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        (reader.data_dir().to_path_buf(), reader.db_path().to_path_buf())
    };

    // DB 연결 (타일 존재 확인용)
    let db_conn = rusqlite::Connection::open(&db_path)
        .map_err(|e| format!("DB open: {}", e))?;

    // 한국 영역 타일 목록 (DB + 파일 모두 확인)
    let mut tiles: Vec<(i32, i32, String)> = Vec::new();
    for lat in 33..=38 {
        for lon in 124..=131 {
            let name = srtm::SrtmReader::tile_name(lat, lon);
            let in_db = db::has_srtm_tile(&db_conn, &name);
            let in_file = srtm_dir.join(format!("{}.hgt", &name)).exists();
            if !in_db && !in_file {
                tiles.push((lat, lon, name));
            }
        }
    }
    drop(db_conn);

    if tiles.is_empty() {
        return Ok("모든 SRTM 타일이 이미 다운로드되어 있습니다.".to_string());
    }

    let total = tiles.len();
    info!("SRTM download: {} tiles to fetch", total);

    let _ = app_handle.emit("srtm-download-progress", serde_json::json!({
        "total": total,
        "downloaded": 0,
        "status": "started",
    }));

    let client = reqwest::Client::builder()
        .user_agent("AirMoveAnalyzer/0.1")
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client error: {}", e))?;

    let mut downloaded = 0usize;
    let mut skipped = 0usize;

    for (lat, _lon, name) in &tiles {
        let ns = if *lat >= 0 { "N" } else { "S" };
        let url = format!(
            "https://s3.amazonaws.com/elevation-tiles-prod/skadi/{}{:02}/{}.hgt.gz",
            ns, lat.abs(), name
        );

        let _ = app_handle.emit("srtm-download-progress", serde_json::json!({
            "total": total,
            "downloaded": downloaded,
            "current_tile": name,
            "status": "downloading",
        }));

        match client.get(&url).send().await {
            Ok(resp) if resp.status().is_success() => {
                let gz_bytes = resp.bytes().await
                    .map_err(|e| format!("Download error for {}: {}", name, e))?;

                // gzip 해제
                let mut decoder = GzDecoder::new(&gz_bytes[..]);
                let mut hgt_bytes = Vec::new();
                decoder.read_to_end(&mut hgt_bytes)
                    .map_err(|e| format!("Decompress error for {}: {}", name, e))?;

                // DB에 저장
                {
                    let db_conn = rusqlite::Connection::open(&db_path)
                        .map_err(|e| format!("DB open: {}", e))?;
                    db::save_srtm_tile(&db_conn, name, &hgt_bytes)
                        .map_err(|e| format!("DB save error for {}: {}", name, e))?;
                }

                // 파일에도 저장 (폴백 호환)
                let dest = srtm_dir.join(format!("{}.hgt", name));
                let _ = std::fs::write(&dest, &hgt_bytes);

                downloaded += 1;
                info!("[SRTM] Downloaded: {} ({:.1}MB)", name, gz_bytes.len() as f64 / 1_048_576.0);
            }
            Ok(resp) if resp.status().as_u16() == 404 => {
                // 해양 타일 (데이터 없음) — 정상
                skipped += 1;
                info!("[SRTM] Skipped (ocean): {}", name);
            }
            Ok(resp) => {
                log::warn!("[SRTM] HTTP {} for {}", resp.status(), name);
                skipped += 1;
            }
            Err(e) => {
                log::warn!("[SRTM] Download failed for {}: {}", name, e);
                skipped += 1;
            }
        }

        let _ = app_handle.emit("srtm-download-progress", serde_json::json!({
            "total": total,
            "downloaded": downloaded,
            "skipped": skipped,
            "status": "downloading",
        }));
    }

    // 캐시 초기화 (새 타일 반영)
    {
        let state = app_handle.state::<AppState>();
        let mut reader = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        *reader = srtm::SrtmReader::new(srtm_dir, db_path);
    }

    let msg = format!(
        "완료: {}개 타일 다운로드, {}개 스킵 (해양)",
        downloaded, skipped
    );
    let _ = app_handle.emit("srtm-download-progress", serde_json::json!({
        "total": total,
        "downloaded": downloaded,
        "skipped": skipped,
        "status": "done",
    }));
    Ok(msg)
}

// ---------- 건물 데이터 (GIS건물통합정보) ----------

#[tauri::command]
async fn import_building_data(
    app_handle: tauri::AppHandle,
    zip_path: String,
    region: String,
) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    let handle = app_handle.clone();
    let region_clone = region.clone();

    let count = building::import_from_zip(&conn, &zip_path, &region, &|progress| {
        let _ = handle.emit("building-import-progress", progress);
    })?;

    Ok(format!("{} 건물 {}건 임포트 완료", region_clone, count))
}

#[tauri::command]
fn query_buildings_along_path(
    state: tauri::State<'_, AppState>,
    radar_lat: f64,
    radar_lon: f64,
    target_lat: f64,
    target_lon: f64,
    corridor_width_m: Option<f64>,
) -> Result<Vec<building::BuildingOnPath>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let width = corridor_width_m.unwrap_or(100.0);
    building::query_buildings_along_path(&conn, radar_lat, radar_lon, target_lat, target_lon, width)
}

#[tauri::command]
fn get_building_import_status(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<building::BuildingImportStatus>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::get_import_status(&conn)
}

#[tauri::command]
fn clear_building_data(
    state: tauri::State<'_, AppState>,
    region: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::clear_building_data(&conn, region.as_deref())
}

// ---------- 영역 내 건물 조회 (커버리지 맵용) ----------

#[tauri::command]
fn query_buildings_in_bbox(
    state: tauri::State<'_, AppState>,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: Option<f64>,
) -> Result<Vec<building::BuildingInArea>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::query_buildings_in_bbox(&conn, min_lat, max_lat, min_lon, max_lon, min_height_m.unwrap_or(3.0))
}

// ---------- 영역 내 건물 조회 (맵 오버레이용) ----------

#[tauri::command]
fn query_buildings_for_overlay(
    state: tauri::State<'_, AppState>,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: Option<f64>,
) -> Result<Vec<building::BuildingForOverlay>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::query_buildings_for_overlay(&conn, min_lat, max_lat, min_lon, max_lon, min_height_m.unwrap_or(3.0))
}

// ---------- 건물 그룹 ----------

#[tauri::command]
fn list_building_groups(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<building::BuildingGroup>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::list_building_groups(&conn)
}

#[tauri::command]
fn add_building_group(
    state: tauri::State<'_, AppState>,
    name: String,
    color: String,
    memo: String,
) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::add_building_group(&conn, &name, &color, &memo)
}

#[tauri::command]
fn update_building_group(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
    color: String,
    memo: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::update_building_group(&conn, id, &name, &color, &memo)
}

#[tauri::command]
fn delete_building_group(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::delete_building_group(&conn, id)
}

// ---------- 수동 등록 건물 ----------

#[tauri::command]
fn list_manual_buildings(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<building::ManualBuilding>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::list_manual_buildings(&conn)
}

#[tauri::command]
fn add_manual_building(
    state: tauri::State<'_, AppState>,
    name: String,
    latitude: f64,
    longitude: f64,
    height: f64,
    ground_elev: f64,
    memo: String,
    geometry_type: Option<String>,
    geometry_json: Option<String>,
    group_id: Option<i64>,
) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let gt = geometry_type.as_deref().unwrap_or("point");
    let gj = geometry_json.as_deref();
    building::add_manual_building(&conn, &name, latitude, longitude, height, ground_elev, &memo, gt, gj, group_id)
}

#[tauri::command]
fn update_manual_building(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
    latitude: f64,
    longitude: f64,
    height: f64,
    ground_elev: f64,
    memo: String,
    geometry_type: Option<String>,
    geometry_json: Option<String>,
    group_id: Option<i64>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let gt = geometry_type.as_deref().unwrap_or("point");
    let gj = geometry_json.as_deref();
    building::update_manual_building(&conn, id, &name, latitude, longitude, height, ground_elev, &memo, gt, gj, group_id)
}

#[tauri::command]
fn delete_manual_building(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::delete_manual_building(&conn, id)
}

// ========== LOS 분석 결과 영속화 ==========

#[tauri::command]
fn save_los_result(
    state: tauri::State<'_, AppState>,
    id: String,
    radar_site_name: String,
    radar_lat: f64,
    radar_lon: f64,
    radar_height: f64,
    target_lat: f64,
    target_lon: f64,
    bearing: f64,
    total_distance: f64,
    elevation_profile_json: String,
    los_blocked: bool,
    max_blocking_json: Option<String>,
    map_screenshot: Option<String>,
    chart_screenshot: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::save_los_result(
        &conn, &id, &radar_site_name, radar_lat, radar_lon, radar_height,
        target_lat, target_lon, bearing, total_distance,
        &elevation_profile_json, los_blocked, max_blocking_json.as_deref(),
        map_screenshot.as_deref(), chart_screenshot.as_deref(),
    ).map_err(|e| format!("DB error: {}", e))
}

#[tauri::command]
fn load_los_results(
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    let rows = db::load_all_los_results(&conn).map_err(|e| format!("DB error: {}", e))?;

    #[derive(serde::Serialize)]
    struct LOSResult {
        id: String,
        radar_site_name: String,
        radar_lat: f64,
        radar_lon: f64,
        radar_height: f64,
        target_lat: f64,
        target_lon: f64,
        bearing: f64,
        total_distance: f64,
        elevation_profile_json: String,
        los_blocked: bool,
        max_blocking_json: Option<String>,
        map_screenshot: Option<String>,
        chart_screenshot: Option<String>,
        created_at: i64,
    }

    let results: Vec<LOSResult> = rows.into_iter().map(|r| LOSResult {
        id: r.0, radar_site_name: r.1, radar_lat: r.2, radar_lon: r.3,
        radar_height: r.4, target_lat: r.5, target_lon: r.6, bearing: r.7,
        total_distance: r.8, elevation_profile_json: r.9, los_blocked: r.10,
        max_blocking_json: r.11, map_screenshot: r.12, chart_screenshot: r.13, created_at: r.14,
    }).collect();

    serde_json::to_string(&results).map_err(|e| format!("JSON error: {}", e))
}

#[tauri::command]
fn delete_los_result(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::delete_los_result(&conn, &id).map_err(|e| format!("DB error: {}", e))
}

#[tauri::command]
fn clear_los_results(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::clear_all_los_results(&conn).map_err(|e| format!("DB error: {}", e))
}

// ========== 수동 병합 이력 ==========

#[tauri::command]
fn save_manual_merge(
    state: tauri::State<'_, AppState>,
    source_flight_ids_json: String,
    mode_s: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::save_manual_merge(&conn, &source_flight_ids_json, &mode_s)
        .map_err(|e| format!("DB error: {}", e))
}

#[tauri::command]
fn load_manual_merges(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<(String, String)>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::load_manual_merges(&conn).map_err(|e| format!("DB error: {}", e))
}

#[tauri::command]
fn clear_manual_merges(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::clear_manual_merges(&conn).map_err(|e| format!("DB error: {}", e))
}

// ========== 커버리지 캐시 ==========

#[tauri::command]
fn save_coverage_cache(
    state: tauri::State<'_, AppState>,
    radar_name: String,
    radar_lat: f64,
    radar_lon: f64,
    radar_height: f64,
    max_elev_deg: f64,
    layers_json: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::save_coverage_cache(&conn, &radar_name, radar_lat, radar_lon, radar_height, max_elev_deg, &layers_json)
        .map_err(|e| format!("DB error: {}", e))
}

#[tauri::command]
fn load_coverage_cache(
    state: tauri::State<'_, AppState>,
    radar_name: String,
) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::load_coverage_cache(&conn, &radar_name).map_err(|e| format!("DB error: {}", e))
}

#[tauri::command]
fn clear_coverage_cache(
    state: tauri::State<'_, AppState>,
    radar_name: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::clear_coverage_cache(&conn, &radar_name).map_err(|e| format!("DB error: {}", e))
}

// ========== 저장된 보고서 ==========

#[tauri::command]
fn save_report(
    state: tauri::State<'_, AppState>,
    id: String,
    title: String,
    template: String,
    radar_name: String,
    report_config_json: String,
    pdf_base64: Option<String>,
    metadata_json: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::save_report(&conn, &id, &title, &template, &radar_name, &report_config_json, pdf_base64.as_deref(), metadata_json.as_deref())
        .map_err(|e| format!("DB error: {}", e))
}

#[tauri::command]
fn list_saved_reports(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<db::SavedReportSummary>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::list_saved_reports(&conn).map_err(|e| format!("DB error: {}", e))
}

#[tauri::command]
fn load_report_detail(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    let row = db::load_report_detail(&conn, &id).map_err(|e| format!("DB error: {}", e))?;
    match row {
        Some(r) => {
            #[derive(serde::Serialize)]
            struct Detail {
                id: String,
                title: String,
                template: String,
                radar_name: String,
                created_at: i64,
                report_config_json: String,
                pdf_base64: Option<String>,
                metadata_json: Option<String>,
            }
            let detail = Detail {
                id: r.0, title: r.1, template: r.2, radar_name: r.3,
                created_at: r.4, report_config_json: r.5, pdf_base64: r.6, metadata_json: r.7,
            };
            serde_json::to_string(&detail).map_err(|e| format!("JSON error: {}", e)).map(Some)
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn delete_saved_report(
    state: tauri::State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::delete_report(&conn, &id).map_err(|e| format!("DB error: {}", e))
}

// ---------- 자기편각 (Magnetic Declination) ----------

/// 파싱 전 편각 조회 헬퍼: 파일 날짜 + 레이더 좌표로 편각 결정
///
/// MutexGuard를 .await 경계 너머로 들고 가지 않도록 단계별로 분리:
/// 1. DB 캐시 조회 (sync, lock/unlock)
/// 2. NOAA API 호출 (async, lock 없음)
/// 3. DB 저장 (sync, lock/unlock)
async fn resolve_declination(app_handle: &tauri::AppHandle, file_path: &str, radar_lat: f64, radar_lon: f64) -> f64 {
    let date = parser::ass::extract_date_from_filename(file_path)
        .unwrap_or_else(|| "2025-06-01".to_string());

    // 1단계: 캐시 확인 (lock → 조회 → unlock)
    let cached = {
        let state = app_handle.state::<AppState>();
        let guard = state.db.lock().ok();
        guard.and_then(|conn| declination::get_cached(&conn, radar_lat, radar_lon, &date))
    };
    if let Some((dec, ref source)) = cached {
        if source == "noaa" {
            return dec;
        }
    }

    // 2단계: NOAA API 시도 (async, lock 없음)
    let date_parts = date.split('-').collect::<Vec<_>>();
    if date_parts.len() == 3 {
        let year: i32 = date_parts[0].parse().unwrap_or(2025);
        let month: u32 = date_parts[1].parse().unwrap_or(6);
        let day: u32 = date_parts[2].parse().unwrap_or(1);

        if let Ok(dec) = declination::fetch_noaa(radar_lat, radar_lon, year, month, day).await {
            info!("Magnetic declination (NOAA): {:.2}° for ({},{}) on {}", dec, radar_lat, radar_lon, date);
            // 3단계: 결과 저장 (lock → 저장 → unlock)
            let state = app_handle.state::<AppState>();
            let _ = state.db.lock().ok().map(|conn| {
                declination::save_cache(&conn, radar_lat, radar_lon, &date, dec, "noaa")
            });
            return dec;
        }
    }

    // 4단계: WMM fallback (동기 계산)
    if let Some((dec, _)) = cached {
        return dec; // 이미 WMM 캐시가 있으면 재사용
    }

    let state = app_handle.state::<AppState>();
    let guard = state.db.lock().ok();
    match guard {
        Some(conn) => declination::get_declination_sync(&conn, radar_lat, radar_lon, &date),
        None => -8.5,
    }
}

/// 자기편각 조회 IPC 커맨드
#[tauri::command]
async fn get_magnetic_declination(
    app_handle: tauri::AppHandle,
    lat: f64,
    lon: f64,
    date: String,
) -> Result<f64, String> {
    // 1. 캐시 확인
    let cached = {
        let state = app_handle.state::<AppState>();
        let guard = state.db.lock().ok();
        guard.and_then(|conn| declination::get_cached(&conn, lat, lon, &date))
    };
    if let Some((dec, ref source)) = cached {
        if source == "noaa" {
            return Ok(dec);
        }
    }

    // 2. NOAA API 시도
    let date_parts = date.split('-').collect::<Vec<_>>();
    if date_parts.len() == 3 {
        let year: i32 = date_parts[0].parse().unwrap_or(2025);
        let month: u32 = date_parts[1].parse().unwrap_or(6);
        let day: u32 = date_parts[2].parse().unwrap_or(1);

        if let Ok(dec) = declination::fetch_noaa(lat, lon, year, month, day).await {
            let state = app_handle.state::<AppState>();
            let _ = state.db.lock().ok().map(|conn| {
                declination::save_cache(&conn, lat, lon, &date, dec, "noaa")
            });
            return Ok(dec);
        }
    }

    // 3. WMM fallback
    if let Some((dec, _)) = cached {
        return Ok(dec);
    }
    let result = {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
        declination::get_declination_sync(&conn, lat, lon, &date)
    };
    Ok(result)
}

/// WMM fallback 데이터를 NOAA 데이터로 치환하는 IPC 커맨드
#[tauri::command]
async fn refresh_declination_cache(
    app_handle: tauri::AppHandle,
) -> Result<usize, String> {
    refresh_wmm_to_noaa(&app_handle).await
}

/// WMM→NOAA 치환 로직 (IPC + 백그라운드 공용)
/// rusqlite::Connection은 Send가 아니므로 DB 접근(sync)과 API 호출(async)을 분리
async fn refresh_wmm_to_noaa(app_handle: &tauri::AppHandle) -> Result<usize, String> {
    // 1. DB에서 WMM 엔트리 목록 조회 (sync)
    let entries = {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
        declination::list_wmm_entries(&conn)
    };

    if entries.is_empty() {
        return Ok(0);
    }

    info!("Refreshing {} WMM declination entries with NOAA data", entries.len());
    let mut refreshed = 0usize;

    for (lat_key, lon_key, date_key) in &entries {
        let lat: f64 = lat_key.parse().unwrap_or(37.5);
        let lon: f64 = lon_key.parse().unwrap_or(127.0);
        let (year, month, day) = match declination::parse_date(date_key) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // 2. NOAA API 호출 (async, DB lock 없음)
        match declination::fetch_noaa(lat, lon, year, month, day).await {
            Ok(dec) => {
                // 3. DB 저장 (sync)
                let state = app_handle.state::<AppState>();
                let saved = state.db.lock().ok().map(|conn| {
                    declination::save_cache(&conn, lat, lon, date_key, dec, "noaa").is_ok()
                }).unwrap_or(false);
                if saved { refreshed += 1; }
            }
            Err(e) => {
                log::warn!("NOAA refresh failed for ({},{}) on {}: {}", lat_key, lon_key, date_key, e);
                break; // API 실패 시 중단
            }
        }

        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
    }

    info!("Refreshed {}/{} WMM entries with NOAA data", refreshed, entries.len());
    Ok(refreshed)
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
            let app_data_dir = get_app_data_dir(app.handle())
                .map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
            info!("App data dir: {:?}", app_data_dir);

            // SQLite DB 초기화
            let db_path = app_data_dir.join("adsb.db");
            let db_conn = db::init_db(&db_path).map_err(|e| {
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("DB init error: {}", e),
                ))
            })?;
            info!("Database path: {:?}", db_path);

            // 기존 JSON 캐시 → DB 마이그레이션
            let cache_path = app_data_dir.join("adsb_cache.json");
            if cache_path.exists() {
                info!("Migrating adsb_cache.json to SQLite...");
                if let Err(e) = db::migrate_json_cache(&db_conn, &cache_path) {
                    log::warn!("Migration failed: {}", e);
                }
            }

            // 기존 aircraft.json → DB 마이그레이션
            let aircraft_json_path = app_data_dir.join("aircraft.json");
            if aircraft_json_path.exists() {
                info!("Migrating aircraft.json to SQLite...");
                if let Err(e) = db::migrate_aircraft_json(&db_conn, &aircraft_json_path) {
                    log::warn!("Aircraft migration failed: {}", e);
                }
            }

            // SRTM 데이터 디렉토리 초기화
            let srtm_dir = app_data_dir.join("srtm");
            if !srtm_dir.exists() {
                let _ = fs::create_dir_all(&srtm_dir);
            }
            info!("SRTM data dir: {:?}", srtm_dir);

            app.manage(AppState {
                app_data_dir: Mutex::new(app_data_dir.clone()),
                db: Mutex::new(db_conn),
                oauth_token: Mutex::new(None),
                srtm: Mutex::new(srtm::SrtmReader::new(srtm_dir, db_path.clone())),
            });

            // 백그라운드: WMM fallback 편각을 NOAA 데이터로 치환
            let bg_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(10)).await;
                match refresh_wmm_to_noaa(&bg_handle).await {
                    Ok(n) if n > 0 => info!("Refreshed {} WMM declination entries with NOAA data", n),
                    Ok(_) => {}
                    Err(e) => log::warn!("Declination refresh failed: {}", e),
                }
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
            write_file_base64,
            fetch_adsb_tracks,
            load_adsb_tracks_for_range,
            fetch_flight_history,
            load_flight_history,
            save_opensky_credentials,
            load_opensky_credentials,
            load_saved_data,
            load_saved_file_metas,
            load_file_track_points,
            clear_saved_data,
            delete_parsed_file,
            delete_parsed_files,
            load_setting,
            save_setting,
            export_database,
            import_database,
            calculate_los_panorama,
            save_panorama_cache,
            load_panorama_cache,
            clear_panorama_cache,
            fetch_elevation,
            download_srtm_korea,
            import_building_data,
            query_buildings_along_path,
            query_buildings_in_bbox,
            query_buildings_for_overlay,
            get_building_import_status,
            clear_building_data,
            list_building_groups,
            add_building_group,
            update_building_group,
            delete_building_group,
            list_manual_buildings,
            add_manual_building,
            update_manual_building,
            delete_manual_building,
            save_weather_day,
            save_cloud_grid_day,
            get_weather_cached_dates,
            load_weather_cache,
            load_cloud_grid_cache,
            // LOS 결과 영속화
            save_los_result,
            load_los_results,
            delete_los_result,
            clear_los_results,
            // 수동 병합 이력
            save_manual_merge,
            load_manual_merges,
            clear_manual_merges,
            // 커버리지 캐시
            save_coverage_cache,
            load_coverage_cache,
            clear_coverage_cache,
            // 보고서
            save_report,
            list_saved_reports,
            load_report_detail,
            delete_saved_report,
            // 자기편각
            get_magnetic_declination,
            refresh_declination_cache,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
