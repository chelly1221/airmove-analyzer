pub mod analysis;
pub mod building;
pub mod coord;
pub mod db;
pub mod declination;
pub mod fac_building;
pub mod geo;
pub mod landuse;
pub mod models;
pub mod parser;
pub mod peak;
pub mod srtm;
pub mod vworld;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use log::info;
use rusqlite::params;

use tauri::{Emitter, Manager};

use models::{Aircraft, AnalysisResult, ParsedFile, TrackPoint};

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

/// Application state for managing aircraft data.
struct AppState {
    app_data_dir: Mutex<PathBuf>,
    db: Mutex<db::Db>,
    srtm: Mutex<srtm::SrtmReader>,
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
async fn parse_ass_file(path: String, radar_lat: f64, radar_lon: f64, mode_s_include: Vec<String>, mode_s_exclude: Vec<String>, mode3a_include: Vec<u16>, mode3a_exclude: Vec<u16>, app_handle: tauri::AppHandle) -> Result<ParsedFile, String> {
    info!("Command: parse_ass_file({}, radar={},{}, include={:?}, exclude={:?})", path, radar_lat, radar_lon, mode_s_include, mode_s_exclude);
    // 편각 조회 (파일 날짜 + 레이더 좌표)
    let mag_dec = resolve_declination(&app_handle, &path, radar_lat, radar_lon).await;
    tauri::async_runtime::spawn_blocking(move || {
        parser::ass::parse_ass_file(&path, radar_lat, radar_lon, &mode_s_include, &mode_s_exclude, &mode3a_include, &mode3a_exclude, mag_dec, |_| {}).map_err(|e| e.to_string())
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

/// Parse an ASS file and immediately analyze it.
#[tauri::command]
async fn parse_and_analyze(
    app_handle: tauri::AppHandle,
    file_path: String,
    radar_lat: f64,
    radar_lon: f64,
    mode_s_include: Vec<String>,
    mode_s_exclude: Vec<String>,
    mode3a_include: Vec<u16>,
    mode3a_exclude: Vec<u16>,
) -> Result<AnalysisResult, String> {
    info!("Command: parse_and_analyze({}, radar={},{}, include={:?}, exclude={:?})", file_path, radar_lat, radar_lon, mode_s_include, mode_s_exclude);
    let mag_dec = resolve_declination(&app_handle, &file_path, radar_lat, radar_lon).await;
    let fp = file_path.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let parsed = parser::ass::parse_ass_file(&fp, radar_lat, radar_lon, &mode_s_include, &mode_s_exclude, &mode3a_include, &mode3a_exclude, mag_dec, |_| {})
            .map_err(|e| e.to_string())?;
        let analysis = analysis::loss::analyze_tracks(parsed, analysis::loss::DEFAULT_THRESHOLD_SECS);

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
    mode_s_include: Vec<String>,
    mode_s_exclude: Vec<String>,
    mode3a_include: Vec<u16>,
    mode3a_exclude: Vec<u16>,
) -> Result<(), String> {
    info!(
        "Command: parse_and_analyze_batch({} files, radar={},{}, include={:?}, exclude={:?})",
        file_paths.len(),
        radar_lat,
        radar_lon,
        mode_s_include,
        mode_s_exclude,
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
        let ms_incl_ref = &mode_s_include;
        let ms_excl_ref = &mode_s_exclude;
        let m3a_incl_ref = &mode3a_include;
        let m3a_excl_ref = &mode3a_exclude;
        rayon::scope(|s| {
            let tx = &tx;
            for path in &file_paths {
                let path = path.clone();
                s.spawn(move |_| {
                    let r = parser::ass::parse_ass_file(&path, radar_lat, radar_lon, ms_incl_ref, ms_excl_ref, m3a_incl_ref, m3a_excl_ref, mag_dec, |_| {})
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

/// WebView2 네이티브 PrintToPdf — CDP(Chrome DevTools Protocol) Page.printToPDF 사용
/// 벡터 텍스트 PDF, GPU 가속 렌더링, html2canvas 대비 5-10x 빠름
/// 반환: PDF base64 (DB 저장용)
#[tauri::command]
async fn webview_print_to_pdf(
    _app_handle: tauri::AppHandle,
    _path: String,
    _window_label: Option<String>,
) -> Result<String, String> {
    #[cfg(windows)]
    {
        use std::sync::mpsc;

        // 호출한 창의 WebView에서 PDF 생성 (멀티윈도우 대응)
        let window = {
            let windows = _app_handle.webview_windows();
            let label = _window_label.as_deref().unwrap_or("main");
            windows.get(label)
                .or_else(|| windows.get("main"))
                .cloned()
                .ok_or("윈도우를 찾을 수 없습니다")?
        };

        let (tx, rx) = mpsc::channel::<Result<String, String>>();

        // CDP Page.printToPDF 호출 — UI 스레드에서 실행
        window
            .with_webview(move |webview| {
                unsafe {
                    let controller = webview.controller();
                    let core = controller.CoreWebView2().unwrap();

                    // CDP 파라미터: A4 용지, 여백 0, 배경색 출력
                    let params = r#"{
                        "landscape": false,
                        "printBackground": true,
                        "paperWidth": 8.27,
                        "paperHeight": 11.69,
                        "marginTop": 0,
                        "marginBottom": 0,
                        "marginLeft": 0,
                        "marginRight": 0,
                        "scale": 1,
                        "preferCSSPageSize": true
                    }"#;

                    let method_h: windows::core::HSTRING = "Page.printToPDF".into();
                    let params_h: windows::core::HSTRING = params.into();

                    // webview2-com 고수준 래퍼: wait_for_async_operation 패턴
                    let tx_inner = tx.clone();
                    let result = webview2_com::CallDevToolsProtocolMethodCompletedHandler
                        ::wait_for_async_operation(
                            Box::new(move |handler| {
                                core.CallDevToolsProtocolMethod(&method_h, &params_h, &handler)
                                    .map_err(webview2_com::Error::WindowsError)
                            }),
                            Box::new(move |hr_result, json_str| {
                                match hr_result {
                                    Ok(()) => { let _ = tx_inner.send(Ok(json_str)); }
                                    Err(e) => { let _ = tx_inner.send(Err(format!("CDP 실패: {:?}", e))); }
                                }
                                Ok(())
                            }),
                        );

                    if let Err(e) = result {
                        let _ = tx.send(Err(format!("CDP 호출 실패: {}", e)));
                    }
                }
            })
            .map_err(|e| format!("with_webview 실패: {}", e))?;

        // 비동기로 CDP 결과 대기
        let cdp_result = tokio::task::spawn_blocking(move || {
            rx.recv_timeout(std::time::Duration::from_secs(60))
                .map_err(|_| "PrintToPdf 타임아웃 (60초)".to_string())?
        })
        .await
        .map_err(|e| format!("spawn_blocking 실패: {}", e))??;

        // CDP 응답에서 base64 PDF 데이터 추출
        let json: serde_json::Value = serde_json::from_str(&cdp_result)
            .map_err(|e| format!("CDP 응답 파싱 실패: {}", e))?;

        let pdf_base64 = json["data"]
            .as_str()
            .ok_or("CDP 응답에 data 필드가 없습니다")?;

        // base64 디코딩 후 파일 저장
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let pdf_bytes = STANDARD
            .decode(pdf_base64)
            .map_err(|e| format!("PDF base64 디코딩 실패: {}", e))?;

        fs::write(&_path, &pdf_bytes)
            .map_err(|e| format!("PDF 파일 저장 실패: {}", e))?;

        // base64 반환 (DB 저장용)
        Ok(pdf_base64.to_string())
    }

    #[cfg(not(windows))]
    {
        Err("WebView2 PrintToPdf는 Windows에서만 지원됩니다".to_string())
    }
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

    // 기존 연결 닫기 (락 해제 후 파일 I/O 수행)
    {
        let mut conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
        // 기존 연결을 in-memory로 교체하여 파일 핸들 해제
        drop(std::mem::replace(&mut *conn, rusqlite::Connection::open_in_memory().map_err(|e| format!("임시 DB 오류: {}", e))?));
    } // 락 해제

    // DB 파일 교체 (락 없이 수행 — 대용량 파일도 다른 명령 차단 안 함)
    fs::copy(src, &db_path)
        .map_err(|e| format!("파일 복사 실패: {}", e))?;
    // WAL/SHM 잔여 파일 제거
    let _ = fs::remove_file(db_path.with_extension("db-wal"));
    let _ = fs::remove_file(db_path.with_extension("db-shm"));

    // 새 연결 수립 (락 재획득)
    let mut conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    let new_conn = db::init_db(&db_path)
        .map_err(|e| format!("DB 재연결 실패: {}", e))?;
    *conn = new_conn;

    info!("Database imported from: {}", src_path);
    Ok(())
}

/// 360° LoS 파노라마 계산 (지형 + 건물통합정보 + 수동건물)
#[tauri::command]
fn calculate_los_panorama(
    state: tauri::State<'_, AppState>,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    max_range_km: Option<f64>,
    azimuth_step_deg: Option<f64>,
    range_step_m: Option<f64>,
    exclude_manual_ids: Option<Vec<i64>>,
) -> Result<Vec<analysis::panorama::PanoramaPoint>, String> {
    let max_range = max_range_km.unwrap_or(100.0);
    let az_step = azimuth_step_deg.unwrap_or(0.5);
    let r_step = range_step_m.unwrap_or(200.0);
    let exclude_ids = exclude_manual_ids.unwrap_or_default();

    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;

    Ok(analysis::panorama::calculate_panorama(
        &mut srtm, &conn,
        radar_lat, radar_lon, radar_height_m,
        max_range, az_step, r_step, &exclude_ids,
    ))
}

/// GPU 파노라마용: Rust에서 SRTM 조회 수행 후 elevation 배열만 전송 (경량)
/// 18M개 destination_point + SRTM 바이리니어 보간을 rayon 병렬로 수행
/// 결과: base64(f32 LE) — num_azimuths × num_steps 순서
#[tauri::command]
fn presample_panorama_elevations(
    state: tauri::State<'_, AppState>,
    radar_lat: f64,
    radar_lon: f64,
    max_range_km: Option<f64>,
    azimuth_step_deg: Option<f64>,
    range_step_m: Option<f64>,
) -> Result<PreSampledElevations, String> {
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use rayon::prelude::*;

    let max_range_m = max_range_km.unwrap_or(100.0) * 1000.0;
    let az_step = azimuth_step_deg.unwrap_or(0.01);
    let r_step = range_step_m.unwrap_or(200.0);
    let num_azimuths = (360.0 / az_step).round() as usize;
    let num_steps = (max_range_m / r_step).floor() as usize;

    // 메모리 안전 체크: f32 72MB + base64 96MB + u8 72MB = ~240MB 피크
    let total_samples = num_azimuths * num_steps;
    let estimated_mb = total_samples as f64 * 4.0 / 1_000_000.0;
    if estimated_mb > 200.0 {
        return Err(format!(
            "Pre-sample too large: {}MB ({} azimuths × {} steps). Reduce resolution or range.",
            estimated_mb as u64, num_azimuths, num_steps
        ));
    }

    // SRTM 타일 프리로드
    let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
    let range_deg = (max_range_m / 111_000.0).ceil() as i32 + 1;
    srtm.preload_tiles(
        radar_lat.floor() as i32 - range_deg,
        radar_lat.floor() as i32 + range_deg,
        radar_lon.floor() as i32 - range_deg,
        radar_lon.floor() as i32 + range_deg,
    );
    let tiles = srtm.tiles_ref();

    // rayon 병렬: 각 azimuth ray에 대해 모든 range step의 고도 조회
    let elevations: Vec<f32> = (0..num_azimuths)
        .into_par_iter()
        .flat_map_iter(|az_idx| {
            let az_deg = az_idx as f64 * az_step;
            (1..=num_steps).map(move |s| {
                let d = s as f64 * r_step;
                let (lat, lon) = geo::destination_point_m(
                    radar_lat, radar_lon, az_deg, d,
                );
                srtm::elevation_from_tiles(tiles, lat, lon) as f32
            })
        })
        .collect();

    // f32 LE bytes → base64 (72MB → 96MB, 피크 ~240MB)
    let bytes: Vec<u8> = elevations.into_iter().flat_map(|v| v.to_le_bytes()).collect();
    let data_b64 = STANDARD.encode(&bytes);
    drop(bytes); // base64 인코딩 후 원본 해제

    Ok(PreSampledElevations {
        data_b64,
        num_azimuths: num_azimuths as u32,
        num_steps: num_steps as u32,
    })
}

#[derive(serde::Serialize)]
struct PreSampledElevations {
    data_b64: String,
    num_azimuths: u32,
    num_steps: u32,
}

/// GPU 파노라마 건물 병합 (GPU에서 계산한 지형 결과에 건물 데이터 오버레이)
#[tauri::command]
fn panorama_merge_buildings(
    state: tauri::State<'_, AppState>,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    max_range_km: Option<f64>,
    azimuth_step_deg: Option<f64>,
    terrain_results: Vec<analysis::panorama::TerrainResult>,
) -> Result<Vec<analysis::panorama::PanoramaPoint>, String> {
    let max_range = max_range_km.unwrap_or(100.0);
    let az_step = azimuth_step_deg.unwrap_or(0.01);

    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;

    Ok(analysis::panorama::merge_buildings_into_panorama(
        &mut srtm, &conn,
        &terrain_results,
        radar_lat, radar_lon, radar_height_m,
        max_range * 1000.0, az_step,
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
#[tauri::command]
fn get_srtm_status(
    state: tauri::State<'_, AppState>,
) -> Result<Option<(i64, i64)>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    db::get_srtm_status(&conn).map_err(|e| e.to_string())
}

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

// ---------- 건물 데이터 ----------

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

// ---------- 건물통합정보 (F_FAC_BUILDING) ----------

#[tauri::command]
async fn import_fac_building_data(
    app_handle: tauri::AppHandle,
    zip_path: String,
    region: String,
) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    let handle = app_handle.clone();
    let region_clone = region.clone();

    let count = fac_building::import_from_zip(&conn, &zip_path, &region, &|progress| {
        let _ = handle.emit("fac-building-import-progress", progress);
    })?;

    Ok(format!("{} 건물통합정보 {}건 임포트 완료", region_clone, count))
}

#[tauri::command]
fn query_fac_buildings_3d(
    state: tauri::State<'_, AppState>,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: Option<f64>,
    max_count: Option<usize>,
) -> Result<Vec<building::Building3D>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    fac_building::query_fac_buildings_3d(
        &conn,
        min_lat, max_lat, min_lon, max_lon,
        min_height_m.unwrap_or(3.0),
        max_count.unwrap_or(10_000),
    )
}

#[tauri::command]
fn get_fac_building_import_status(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<fac_building::FacBuildingImportStatus>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    fac_building::get_import_status(&conn)
}

#[tauri::command]
fn clear_fac_building_data(
    state: tauri::State<'_, AppState>,
    region: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    fac_building::clear_data(&conn, region.as_deref())
}

// ---------- 토지이용계획정보 ----------

#[tauri::command]
async fn import_landuse_data(
    app_handle: tauri::AppHandle,
    zip_path: String,
    region: String,
) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
    let conn = state.db.lock().map_err(|e| e.to_string())?;

    let handle = app_handle.clone();
    let region_clone = region.clone();

    let count = landuse::import_from_zip(&conn, &zip_path, &region, &|progress| {
        let _ = handle.emit("landuse-import-progress", serde_json::json!({
            "region": &progress.region,
            "processed": progress.processed,
            "status": &progress.status,
        }));
    })?;

    Ok(format!("{} 토지이용계획 {}건 임포트 완료", region_clone, count))
}

#[tauri::command]
fn query_landuse_in_bbox(
    state: tauri::State<'_, AppState>,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    max_count: Option<usize>,
) -> Result<Vec<landuse::LandUseZone>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    landuse::query_in_bbox(&conn, min_lat, max_lat, min_lon, max_lon, max_count.unwrap_or(50_000))
}

#[tauri::command]
fn get_landuse_import_status(
    state: tauri::State<'_, AppState>,
) -> Result<Vec<landuse::LandUseImportStatus>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    landuse::get_import_status(&conn)
}

#[tauri::command]
fn clear_landuse_data(
    state: tauri::State<'_, AppState>,
    region: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    landuse::clear_data(&conn, region.as_deref())
}

// ---------- 산봉우리 지명 데이터 ----------

#[tauri::command]
async fn import_peak_data(
    app_handle: tauri::AppHandle,
    zip_path: String,
) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let handle = app_handle.clone();
    let count = peak::import_from_zip(&conn, &zip_path, &|progress| {
        let _ = handle.emit("peak-import-progress", progress);
    })?;
    Ok(format!("산 정보 {}건 임포트 완료", count))
}

#[tauri::command]
fn query_nearby_peaks(
    state: tauri::State<'_, AppState>,
    lat: f64,
    lon: f64,
    radius_km: f64,
) -> Result<Vec<peak::NearbyPeak>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    peak::query_nearby_peaks(&conn, lat, lon, radius_km)
}

#[tauri::command]
fn get_peak_import_status(
    state: tauri::State<'_, AppState>,
) -> Result<Option<peak::PeakImportStatus>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    peak::get_import_status(&conn)
}

#[tauri::command]
fn clear_peak_data(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    peak::clear_data(&conn)
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

// ---------- 3D 건물 조회 ----------

#[tauri::command]
fn query_buildings_3d(
    state: tauri::State<'_, AppState>,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: Option<f64>,
    max_count: Option<usize>,
    exclude_sources: Option<Vec<String>>,
) -> Result<Vec<building::Building3D>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::query_buildings_3d(
        &conn,
        min_lat, max_lat, min_lon, max_lon,
        min_height_m.unwrap_or(3.0),
        max_count.unwrap_or(10_000),
        &exclude_sources.unwrap_or_default(),
    )
}

#[tauri::command]
fn query_buildings_3d_binary(
    state: tauri::State<'_, AppState>,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: Option<f64>,
    max_count: Option<usize>,
    exclude_sources: Option<Vec<String>>,
) -> Result<building::Buildings3DBinary, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::query_buildings_3d_binary(
        &conn,
        min_lat, max_lat, min_lon, max_lon,
        min_height_m.unwrap_or(3.0),
        max_count.unwrap_or(15_000),
        &exclude_sources.unwrap_or_default(),
    )
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
    area_bounds_json: Option<String>,
) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::add_building_group(&conn, &name, &color, &memo, area_bounds_json.as_deref())
}

#[tauri::command]
fn update_building_group(
    state: tauri::State<'_, AppState>,
    id: i64,
    name: String,
    color: String,
    memo: String,
    plan_opacity: Option<f64>,
    plan_rotation: Option<f64>,
    area_bounds_json: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::update_building_group(&conn, id, &name, &color, &memo, plan_opacity, plan_rotation, area_bounds_json.as_deref())
}

#[tauri::command]
fn delete_building_group(
    state: tauri::State<'_, AppState>,
    id: i64,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::delete_building_group(&conn, id)
}

#[tauri::command]
fn save_group_plan_image(
    state: tauri::State<'_, AppState>,
    group_id: i64,
    image_base64: String,
    bounds_json: String,
    opacity: f64,
    rotation: f64,
) -> Result<(), String> {
    use base64::Engine;
    let image_bytes = base64::engine::general_purpose::STANDARD
        .decode(&image_base64)
        .map_err(|e| format!("base64 디코드 실패: {}", e))?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::save_group_plan_image(&conn, group_id, &image_bytes, &bounds_json, opacity, rotation)
}

#[tauri::command]
fn load_group_plan_image(
    state: tauri::State<'_, AppState>,
    group_id: i64,
) -> Result<Option<serde_json::Value>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    match building::load_group_plan_image(&conn, group_id)? {
        Some((image_bytes, bounds_json, opacity, rotation)) => {
            use base64::Engine;
            let image_base64 = base64::engine::general_purpose::STANDARD.encode(&image_bytes);
            Ok(Some(serde_json::json!({
                "image_base64": image_base64,
                "bounds_json": bounds_json,
                "opacity": opacity,
                "rotation": rotation,
            })))
        }
        None => Ok(None),
    }
}

#[tauri::command]
fn update_plan_overlay_props(
    state: tauri::State<'_, AppState>,
    group_id: i64,
    opacity: Option<f64>,
    rotation: Option<f64>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::update_plan_overlay_props(&conn, group_id, opacity, rotation)
}

#[tauri::command]
fn delete_group_plan_image(
    state: tauri::State<'_, AppState>,
    group_id: i64,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    building::delete_group_plan_image(&conn, group_id)
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
    let gt = geometry_type.as_deref().unwrap_or("polygon");
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
    let gt = geometry_type.as_deref().unwrap_or("polygon");
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

// ========== LoS 분석 결과 영속화 ==========

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
fn has_coverage_cache(
    state: tauri::State<'_, AppState>,
    radar_name: String,
) -> Result<bool, String> {
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    db::has_coverage_cache(&conn, &radar_name).map_err(|e| format!("DB error: {}", e))
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

/// 장애물 월간 분석 IPC 커맨드
#[tauri::command]
async fn analyze_obstacle_monthly(
    app_handle: tauri::AppHandle,
    radar_file_sets: Vec<analysis::obstacle_monthly::RadarFileSet>,
    exclude_mode_s: Vec<String>,
) -> Result<analysis::obstacle_monthly::ObstacleMonthlyResult, String> {
    use analysis::obstacle_monthly::{self as om, ObstacleMonthlyProgress};

    info!(
        "Command: analyze_obstacle_monthly({} radars, exclude={:?})",
        radar_file_sets.len(),
        exclude_mode_s
    );

    // 편각: 첫 레이더의 첫 파일 기준
    let mag_dec = if let Some(rfs) = radar_file_sets.first() {
        if let Some(first_path) = rfs.file_paths.first() {
            resolve_declination(&app_handle, first_path, rfs.radar_lat, rfs.radar_lon).await
        } else {
            -8.5
        }
    } else {
        -8.5
    };

    let handle = app_handle.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let mut radar_results = Vec::new();

        for radar in &radar_file_sets {
            let h = handle.clone();
            let progress_fn = move |p: ObstacleMonthlyProgress| {
                let _ = h.emit("obstacle-monthly-progress", p);
            };

            match om::analyze_radar_monthly(radar, &exclude_mode_s, mag_dec, &progress_fn) {
                Ok(result) => radar_results.push(result),
                Err(e) => {
                    info!("[ObstacleMonthly] 레이더 '{}' 분석 실패: {}", radar.radar_name, e);
                }
            }
        }

        om::ObstacleMonthlyResult { radar_results }
    })
    .await
    .map_err(|e| format!("분석 스레드 오류: {}", e))?;

    Ok(result)
}

/// 장애물 전파영향 사전검토 IPC 커맨드
#[tauri::command]
async fn analyze_pre_screening(
    app_handle: tauri::AppHandle,
    radar_file_sets: Vec<analysis::obstacle_monthly::RadarFileSet>,
    proposed_buildings: Vec<analysis::pre_screening::ProposedBuilding>,
    exclude_mode_s: Vec<String>,
) -> Result<analysis::pre_screening::PreScreeningResult, String> {
    use analysis::obstacle_monthly::ObstacleMonthlyProgress;
    use analysis::pre_screening as ps;

    info!(
        "Command: analyze_pre_screening({} radars, {} buildings, exclude={:?})",
        radar_file_sets.len(), proposed_buildings.len(), exclude_mode_s
    );

    let mag_dec = if let Some(rfs) = radar_file_sets.first() {
        if let Some(first_path) = rfs.file_paths.first() {
            resolve_declination(&app_handle, first_path, rfs.radar_lat, rfs.radar_lon).await
        } else {
            -8.5
        }
    } else {
        -8.5
    };

    let handle = app_handle.clone();

    let result = tauri::async_runtime::spawn_blocking(move || {
        let state = handle.state::<AppState>();
        let mut radar_results = Vec::new();

        for radar in &radar_file_sets {
            let h = handle.clone();
            let progress_fn = move |p: ObstacleMonthlyProgress| {
                let _ = h.emit("pre-screening-progress", p);
            };

            match ps::analyze_pre_screening(
                radar, &proposed_buildings, &exclude_mode_s, mag_dec, &state.srtm, &progress_fn,
            ) {
                Ok(result) => radar_results.push(result),
                Err(e) => {
                    info!("[PreScreening] 레이더 '{}' 분석 실패: {}", radar.radar_name, e);
                }
            }
        }

        ps::PreScreeningResult { radar_results }
    })
    .await
    .map_err(|e| format!("분석 스레드 오류: {}", e))?;

    Ok(result)
}

/// 건물 제외 커버리지 프로파일 계산 (장애물 월간 보고서용)
#[tauri::command]
fn compute_coverage_terrain_profile_excluding(
    state: tauri::State<'_, AppState>,
    radar_name: String,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
    exclude_manual_ids: Vec<i64>,
    bearing_step_deg: Option<f64>,
) -> Result<analysis::coverage::ProfileMeta, String> {
    let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    Ok(analysis::coverage::compute_terrain_profile_excluding(
        &mut srtm, &conn,
        &radar_name, radar_lat, radar_lon, radar_altitude, antenna_height, range_nm,
        &exclude_manual_ids,
        bearing_step_deg.unwrap_or(0.1),
    ))
}

/// 건물 제외 캐시에서 레이어 배치 계산
#[tauri::command]
fn compute_coverage_layers_batch_excluded(
    alt_fts: Vec<f64>,
    bearing_step: Option<usize>,
) -> Result<Vec<analysis::coverage::CoverageLayer>, String> {
    let step = bearing_step.unwrap_or(1);
    Ok(analysis::coverage::compute_layers_batch_excluded(&alt_fts, step))
}

/// GPU용 커버리지 프리샘플 (SRTM + 건물 → base64)
#[tauri::command]
fn presample_coverage_elevations(
    state: tauri::State<'_, AppState>,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
    bearing_step_deg: Option<f64>,
    exclude_manual_ids: Option<Vec<i64>>,
    batch_start_ray: Option<usize>,
    batch_ray_count: Option<usize>,
) -> Result<analysis::coverage::PreSampledCoverage, String> {
    let step = bearing_step_deg.unwrap_or(0.1);
    let total_rays = (360.0 / step).floor() as usize;
    let start = batch_start_ray.unwrap_or(0);
    let count = batch_ray_count.unwrap_or(total_rays);

    let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;

    Ok(analysis::coverage::presample_elevations_batch(
        &mut srtm,
        &conn,
        radar_lat, radar_lon, radar_altitude, antenna_height, range_nm,
        step,
        exclude_manual_ids.as_deref(),
        start,
        count,
    ))
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

// ---------- 커버리지 계산 (GPU/rayon 최적화) ----------

#[tauri::command]
fn compute_coverage_terrain_profile(
    state: tauri::State<'_, AppState>,
    radar_name: String,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
    bearing_step_deg: Option<f64>,
) -> Result<analysis::coverage::ProfileMeta, String> {
    let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
    let conn = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;
    Ok(analysis::coverage::compute_terrain_profile(
        &mut srtm, &conn, &radar_name,
        radar_lat, radar_lon, radar_altitude, antenna_height, range_nm,
        bearing_step_deg.unwrap_or(0.1),
    ))
}

#[tauri::command]
fn compute_coverage_layer(
    alt_ft: f64,
    bearing_step: Option<usize>,
) -> Result<Option<analysis::coverage::CoverageLayer>, String> {
    Ok(analysis::coverage::compute_layer(alt_ft, bearing_step.unwrap_or(1)))
}

#[tauri::command]
fn compute_coverage_layers_batch(
    alt_fts: Vec<f64>,
    bearing_step: Option<usize>,
) -> Result<Vec<analysis::coverage::CoverageLayer>, String> {
    Ok(analysis::coverage::compute_layers_batch(&alt_fts, bearing_step.unwrap_or(1)))
}

#[tauri::command]
fn is_coverage_profile_valid(
    radar_name: String,
    radar_lat: f64,
    radar_lon: f64,
    radar_height: f64,
) -> bool {
    analysis::coverage::is_cache_valid(&radar_name, radar_lat, radar_lon, radar_height)
}

#[tauri::command]
fn invalidate_coverage_profile() {
    analysis::coverage::invalidate_cache();
}

// ---------- vworld 건물 데이터 자동 다운로드 ----------

#[tauri::command]
async fn vworld_download_buildings(
    app_handle: tauri::AppHandle,
    id: String,
    pw: String,
    region_codes: Vec<String>,
) -> Result<String, String> {
    let emit = |stage: &str, msg: &str, cur: usize, total: usize| {
        let _ = app_handle.emit(
            "vworld-progress",
            serde_json::json!({
                "stage": stage, "message": msg, "current": cur, "total": total,
            }),
        );
    };

    // 1. 로그인
    emit("login", "vworld 로그인 중...", 0, 0);
    let mut client = vworld::login(&id, &pw).await?;

    // 2. 파일 목록 수집 (지역별 쿼리, 세션 만료 시 재로그인)
    emit("listing", "파일 목록 수집 중...", 0, 0);
    let targets = match vworld::list_files_by_regions(&client, &region_codes).await {
        Ok(t) => t,
        Err(e) if e.contains("세션") || e.contains("만료") || e.contains("로그인") => {
            emit("login", "세션 만료, 재로그인 중...", 0, 0);
            client = vworld::login(&id, &pw).await?;
            vworld::list_files_by_regions(&client, &region_codes).await?
        }
        Err(e) => return Err(e),
    };

    if targets.is_empty() {
        return Err(format!(
            "매칭 파일 없음: sidoCd={:?} 에 해당하는 파일이 없습니다.",
            region_codes
        ));
    }

    // 3. 다운로드 + 임포트
    let total = targets.len();
    let mut imported = 0;

    for (i, file) in targets.iter().enumerate() {
        // 다운로드 (세션 만료 시 재로그인 후 재시도)
        emit(
            "downloading",
            &format!("{} 다운로드 중... ({}/{})", file.file_name, i + 1, total),
            i + 1,
            total,
        );
        let data = match vworld::download_file(&client, &file.ds_id, &file.file_no).await {
            Ok(d) => d,
            Err(e) if e.contains("세션") || e.contains("만료") || e.contains("로그인") => {
                // 세션 만료 → 재로그인 후 재시도
                emit("login", "세션 만료, 재로그인 중...", i + 1, total);
                client = vworld::login(&id, &pw).await?;
                vworld::download_file(&client, &file.ds_id, &file.file_no).await?
            }
            Err(e) => return Err(e),
        };

        // 임시 파일 저장
        let temp_path = std::env::temp_dir().join(format!("vworld_{}.zip", file.file_no));
        std::fs::write(&temp_path, &data)
            .map_err(|e| format!("임시 파일 저장 실패: {e}"))?;
        drop(data);

        // 임포트 (DB lock은 이 블록에서만)
        emit(
            "importing",
            &format!("{} 임포트 중... ({}/{})", file.file_name, i + 1, total),
            i + 1,
            total,
        );
        {
            let state = app_handle.state::<AppState>();
            let conn = state.db.lock().map_err(|e| format!("DB lock: {e}"))?;
            let region_key = vworld::region_code_to_key(&file.region_code);
            let handle_clone = app_handle.clone();
            let rk = region_key.to_string();
            fac_building::import_from_zip(&conn, temp_path.to_str().unwrap(), region_key, &|p| {
                let _ = handle_clone.emit(
                    "building-import-progress",
                    serde_json::json!({
                        "region": &rk,
                        "processed": p.processed,
                        "status": &p.status,
                    }),
                );
            })
            .map_err(|e| format!("{} 임포트 실패: {e}", file.file_name))?;
        }

        let _ = std::fs::remove_file(&temp_path);
        imported += 1;
    }

    emit(
        "done",
        &format!("{imported}개 지역 건물 데이터 완료"),
        imported,
        total,
    );
    Ok(format!("{imported}개 지역 건물 데이터 다운로드 및 임포트 완료"))
}

// ---------- 토지이용계획도 타일 다운로드 ----------

/// 토지이용계획도 타일 일괄 다운로드 (proxy.do 경유, 로그인 불필요)
#[tauri::command]
async fn download_landuse_tiles(
    app_handle: tauri::AppHandle,
    south: f64,
    west: f64,
    north: f64,
    east: f64,
    min_zoom: u32,
    max_zoom: u32,
) -> Result<String, String> {
    let emit = |msg: &str, cur: usize, total: usize| {
        let _ = app_handle.emit(
            "landuse-tile-progress",
            serde_json::json!({ "message": msg, "current": cur, "total": total }),
        );
    };

    // 타일 목록 생성
    let mut tiles: Vec<(u32, u32, u32)> = Vec::new();
    for z in min_zoom..=max_zoom {
        let n = 1u64 << z;
        let x_min = ((west + 180.0) / 360.0 * n as f64).floor() as u32;
        let x_max = ((east + 180.0) / 360.0 * n as f64).ceil() as u32;
        let y_min = ((1.0 - (north.to_radians().tan() + 1.0 / north.to_radians().cos()).ln() / std::f64::consts::PI) / 2.0 * n as f64).floor() as u32;
        let y_max = ((1.0 - (south.to_radians().tan() + 1.0 / south.to_radians().cos()).ln() / std::f64::consts::PI) / 2.0 * n as f64).ceil() as u32;
        for x in x_min..x_max {
            for y in y_min..y_max {
                tiles.push((z, x, y));
            }
        }
    }

    let total = tiles.len();

    // 기존 타일 삭제 후 새로 다운로드
    {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().map_err(|e| format!("DB lock: {e}"))?;
        conn.execute("DELETE FROM landuse_tiles", [])
            .map_err(|e| format!("기존 타일 삭제 실패: {e}"))?;
    }

    emit(&format!("총 {} 타일 다운로드 시작...", total), 0, total);

    let mut downloaded = 0usize;
    let mut errors = 0usize;

    for (i, &(z, x, y)) in tiles.iter().enumerate() {
        match vworld::download_landuse_tile(z, x, y).await {
            Ok(data) => {
                let state = app_handle.state::<AppState>();
                let conn = state.db.lock().map_err(|e| format!("DB lock: {e}"))?;
                conn.execute(
                    "INSERT OR REPLACE INTO landuse_tiles (z, x, y, data) VALUES (?1, ?2, ?3, ?4)",
                    params![z as i64, x as i64, y as i64, data],
                )
                .map_err(|e| format!("타일 저장 실패: {e}"))?;
                downloaded += 1;
            }
            Err(_) => {
                errors += 1;
            }
        }

        if (i + 1) % 10 == 0 || i + 1 == total {
            emit(
                &format!("{}/{} 타일 ({} 완료, {} 오류)", i + 1, total, downloaded, errors),
                i + 1,
                total,
            );
        }

        // 서버 부하 방지 딜레이
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
    }

    emit("완료", downloaded, total);
    Ok(format!(
        "토지이용계획도 타일 다운로드 완료: {} 완료 / {} 오류 (총 {})",
        downloaded, errors, total
    ))
}

/// 캐시된 타일 수 조회
#[tauri::command]
fn get_landuse_tile_count(
    state: tauri::State<'_, AppState>,
) -> Result<i64, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.query_row("SELECT COUNT(*) FROM landuse_tiles", [], |row| row.get(0))
        .map_err(|e| format!("타일 카운트 실패: {e}"))
}

/// 캐시된 타일 삭제
#[tauri::command]
fn clear_landuse_tiles(
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM landuse_tiles", [])
        .map_err(|e| format!("타일 삭제 실패: {e}"))?;
    Ok(())
}

/// 단일 타일 조회 (DB 캐시에서 base64 반환)
#[tauri::command]
fn get_landuse_tile(
    state: tauri::State<'_, AppState>,
    z: i64,
    x: i64,
    y: i64,
) -> Result<Option<String>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    match conn.query_row(
        "SELECT data FROM landuse_tiles WHERE z=?1 AND x=?2 AND y=?3",
        params![z, x, y],
        |row| row.get::<_, Vec<u8>>(0),
    ) {
        Ok(data) => {
            use base64::{engine::general_purpose::STANDARD, Engine};
            Ok(Some(STANDARD.encode(&data)))
        }
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(e) => Err(format!("타일 조회 실패: {e}")),
    }
}

// ---------- vworld 건물통합정보 (F_FAC_BUILDING) 자동 다운로드 ----------

#[tauri::command]
async fn vworld_download_fac_buildings(
    app_handle: tauri::AppHandle,
    id: String,
    pw: String,
    region_codes: Vec<String>,
) -> Result<String, String> {
    let emit = |stage: &str, msg: &str, cur: usize, total: usize| {
        let _ = app_handle.emit(
            "fac-building-vworld-progress",
            serde_json::json!({
                "stage": stage, "message": msg, "current": cur, "total": total,
            }),
        );
    };

    // 1. 로그인
    emit("login", "vworld 로그인 중...", 0, 0);
    let mut client = vworld::login(&id, &pw).await?;

    // 2. 파일 목록 수집
    emit("listing", "건물통합정보 파일 목록 수집 중...", 0, 0);
    let targets = match vworld::list_fac_building_files(&client, &region_codes).await {
        Ok(t) => t,
        Err(e) if e.contains("세션") || e.contains("만료") || e.contains("로그인") => {
            emit("login", "세션 만료, 재로그인 중...", 0, 0);
            client = vworld::login(&id, &pw).await?;
            vworld::list_fac_building_files(&client, &region_codes).await?
        }
        Err(e) => return Err(e),
    };

    if targets.is_empty() {
        return Err(format!(
            "매칭 파일 없음: 지역={:?} 에 해당하는 건물통합정보 파일이 없습니다.",
            region_codes
        ));
    }

    // 3. 다운로드 + 임포트
    let total = targets.len();
    let mut imported = 0;

    for (i, file) in targets.iter().enumerate() {
        emit(
            "downloading",
            &format!("{} 다운로드 중... ({}/{})", file.file_name, i + 1, total),
            i + 1,
            total,
        );
        let data = match vworld::download_file(&client, &file.ds_id, &file.file_no).await {
            Ok(d) => d,
            Err(e) if e.contains("세션") || e.contains("만료") || e.contains("로그인") => {
                emit("login", "세션 만료, 재로그인 중...", i + 1, total);
                client = vworld::login(&id, &pw).await?;
                vworld::download_file(&client, &file.ds_id, &file.file_no).await?
            }
            Err(e) => {
                log::warn!("건물통합정보 다운로드 실패 (건너뜀): {} — {e}", file.file_name);
                continue;
            }
        };

        let temp_path = std::env::temp_dir().join(format!("vworld_fac_{}.zip", file.file_no));
        std::fs::write(&temp_path, &data)
            .map_err(|e| format!("임시 파일 저장 실패: {e}"))?;
        drop(data);

        // 파일명에서 지역코드 추출 (F_FAC_BUILDING_41570_202603.zip → 41570)
        let region_key = {
            let fname = &file.file_name;
            let code_match = fname
                .split(|c: char| c == '_' || c == '.')
                .find(|s| s.len() == 5 && s.chars().all(|c| c.is_ascii_digit()));
            code_match.unwrap_or(fname.trim_end_matches(".zip")).to_string()
        };

        emit(
            "importing",
            &format!("{} 임포트 중... ({}/{})", file.file_name, i + 1, total),
            i + 1,
            total,
        );
        {
            let state = app_handle.state::<AppState>();
            let conn = state.db.lock().map_err(|e| format!("DB lock: {e}"))?;
            let handle_clone = app_handle.clone();
            let rk = region_key.clone();
            fac_building::import_from_zip(&conn, temp_path.to_str().unwrap(), &region_key, &|p| {
                let _ = handle_clone.emit(
                    "fac-building-import-progress",
                    serde_json::json!({
                        "region": &rk,
                        "processed": p.processed,
                        "status": &p.status,
                    }),
                );
            })
            .map_err(|e| format!("{} 임포트 실패: {e}", file.file_name))?;
        }

        let _ = std::fs::remove_file(&temp_path);
        imported += 1;
    }

    emit(
        "done",
        &format!("{imported}개 건물통합정보 파일 완료"),
        imported,
        total,
    );
    Ok(format!("{imported}개 건물통합정보 파일 다운로드 및 임포트 완료 (총 {total}개 중)"))
}

// ---------- vworld 토지이용계획정보 자동 다운로드 ----------

#[tauri::command]
async fn vworld_download_landuse(
    app_handle: tauri::AppHandle,
    id: String,
    pw: String,
    region_codes: Vec<String>,
) -> Result<String, String> {
    let emit = |stage: &str, msg: &str, cur: usize, total: usize| {
        let _ = app_handle.emit(
            "landuse-download-progress",
            serde_json::json!({
                "stage": stage, "message": msg, "current": cur, "total": total,
            }),
        );
    };

    // 1. 로그인
    emit("login", "vworld 로그인 중...", 0, 0);
    let mut client = vworld::login(&id, &pw).await?;

    // 2. 파일 목록 수집
    emit("listing", "토지이용계획 파일 목록 수집 중...", 0, 0);
    let targets = match vworld::list_landuse_files(&client, &region_codes).await {
        Ok(t) => t,
        Err(e) if e.contains("세션") || e.contains("만료") || e.contains("로그인") => {
            emit("login", "세션 만료, 재로그인 중...", 0, 0);
            client = vworld::login(&id, &pw).await?;
            vworld::list_landuse_files(&client, &region_codes).await?
        }
        Err(e) => return Err(e),
    };

    if targets.is_empty() {
        return Err(format!(
            "매칭 파일 없음: sidoCd={:?} 에 해당하는 토지이용계획 파일이 없습니다.",
            region_codes
        ));
    }

    // 3. 다운로드 + 임포트
    let total = targets.len();
    let mut imported = 0;

    for (i, file) in targets.iter().enumerate() {
        emit(
            "downloading",
            &format!("{} 다운로드 중... ({}/{})", file.file_name, i + 1, total),
            i + 1,
            total,
        );
        let data = match vworld::download_file(&client, &file.ds_id, &file.file_no).await {
            Ok(d) => d,
            Err(e) if e.contains("세션") || e.contains("만료") || e.contains("로그인") => {
                emit("login", "세션 만료, 재로그인 중...", i + 1, total);
                client = vworld::login(&id, &pw).await?;
                vworld::download_file(&client, &file.ds_id, &file.file_no).await?
            }
            Err(e) => return Err(e),
        };

        let temp_path = std::env::temp_dir().join(format!("vworld_landuse_{}.zip", file.file_no));
        std::fs::write(&temp_path, &data)
            .map_err(|e| format!("임시 파일 저장 실패: {e}"))?;
        drop(data);

        emit(
            "importing",
            &format!("{} 임포트 중... ({}/{})", file.file_name, i + 1, total),
            i + 1,
            total,
        );
        {
            let state = app_handle.state::<AppState>();
            let conn = state.db.lock().map_err(|e| format!("DB lock: {e}"))?;
            let region_key = vworld::region_code_to_key(&file.region_code);
            let handle_clone = app_handle.clone();
            let rk = region_key.to_string();
            landuse::import_from_zip(&conn, temp_path.to_str().unwrap(), region_key, &|p| {
                let _ = handle_clone.emit(
                    "landuse-import-progress",
                    serde_json::json!({
                        "region": &rk,
                        "processed": p.processed,
                        "status": &p.status,
                    }),
                );
            })
            .map_err(|e| format!("{} 임포트 실패: {e}", file.file_name))?;
        }

        let _ = std::fs::remove_file(&temp_path);
        imported += 1;
    }

    emit(
        "done",
        &format!("{imported}개 지역 토지이용계획 완료"),
        imported,
        total,
    );
    Ok(format!("{imported}개 지역 토지이용계획정보 다운로드 및 임포트 완료"))
}

#[tauri::command]
async fn vworld_download_n3p(
    app_handle: tauri::AppHandle,
    id: String,
    pw: String,
) -> Result<String, String> {
    let emit = |stage: &str, msg: &str, cur: usize, total: usize| {
        let _ = app_handle.emit(
            "n3p-download-progress",
            serde_json::json!({
                "stage": stage, "message": msg, "current": cur, "total": total,
            }),
        );
    };

    // 1. 로그인
    emit("login", "vworld 로그인 중...", 0, 0);
    let mut client = vworld::login(&id, &pw).await?;

    // 2. N3P 파일 목록
    emit("listing", "N3P 파일 목록 수집 중...", 0, 0);
    let targets = match vworld::list_n3p_files(&client).await {
        Ok(t) => t,
        Err(e) if e.contains("세션") || e.contains("만료") || e.contains("로그인") => {
            emit("login", "세션 만료, 재로그인 중...", 0, 0);
            client = vworld::login(&id, &pw).await?;
            vworld::list_n3p_files(&client).await?
        }
        Err(e) => return Err(e),
    };

    if targets.is_empty() {
        return Err("N3P 파일을 찾을 수 없습니다. vworld에서 연속수치지형도 데이터셋을 확인해 주세요.".into());
    }

    let file = &targets[0];

    // 3. 다운로드
    emit(
        "downloading",
        &format!("{} 다운로드 중...", file.file_name),
        0,
        1,
    );
    let data = match vworld::download_file(&client, &file.ds_id, &file.file_no).await {
        Ok(d) => d,
        Err(e) if e.contains("세션") || e.contains("만료") || e.contains("로그인") => {
            emit("login", "세션 만료, 재로그인 중...", 0, 1);
            client = vworld::login(&id, &pw).await?;
            vworld::download_file(&client, &file.ds_id, &file.file_no).await?
        }
        Err(e) => return Err(e),
    };

    // 4. 임시 파일 저장
    let temp_path = std::env::temp_dir().join(format!("vworld_n3p_{}.zip", file.file_no));
    std::fs::write(&temp_path, &data)
        .map_err(|e| format!("임시 파일 저장 실패: {e}"))?;
    drop(data);

    // 5. 임포트
    emit("importing", "산 이름 데이터 임포트 중...", 1, 1);
    {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().map_err(|e| format!("DB lock: {e}"))?;
        let handle_clone = app_handle.clone();
        peak::import_from_zip(&conn, temp_path.to_str().unwrap(), &|progress| {
            let _ = handle_clone.emit("peak-import-progress", &progress);
        })
        .map_err(|e| format!("N3P 임포트 실패: {e}"))?;
    }

    let _ = std::fs::remove_file(&temp_path);

    emit("done", "산 이름 데이터 다운로드 및 임포트 완료", 1, 1);
    Ok("산 이름 데이터(N3P) 다운로드 및 임포트 완료".to_string())
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
                srtm: Mutex::new(srtm::SrtmReader::new(srtm_dir, db_path.clone())),
            });

            // 프로덕션 빌드에서도 DevTools 활성화 (F12)
            #[cfg(not(debug_assertions))]
            if let Some(w) = app.get_webview_window("main") {
                w.open_devtools();
            }

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
            load_setting,
            save_setting,
            export_database,
            import_database,
            calculate_los_panorama,
            presample_panorama_elevations,
            presample_coverage_elevations,
            panorama_merge_buildings,
            save_panorama_cache,
            load_panorama_cache,
            clear_panorama_cache,
            fetch_elevation,
            get_srtm_status,
            download_srtm_korea,
            query_buildings_along_path,
            query_buildings_in_bbox,
            query_buildings_3d,
            query_buildings_3d_binary,
            // 건물통합정보 (F_FAC_BUILDING)
            import_fac_building_data,
            query_fac_buildings_3d,
            get_fac_building_import_status,
            clear_fac_building_data,
            // 산봉우리 지명
            import_peak_data,
            query_nearby_peaks,
            get_peak_import_status,
            clear_peak_data,
            list_building_groups,
            add_building_group,
            update_building_group,
            delete_building_group,
            save_group_plan_image,
            load_group_plan_image,
            update_plan_overlay_props,
            delete_group_plan_image,
            list_manual_buildings,
            add_manual_building,
            update_manual_building,
            delete_manual_building,
            // LoS 결과 영속화
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
            has_coverage_cache,
            clear_coverage_cache,
            // 커버리지 계산 (rayon 최적화)
            compute_coverage_terrain_profile,
            compute_coverage_layer,
            compute_coverage_layers_batch,
            is_coverage_profile_valid,
            invalidate_coverage_profile,
            // 보고서
            save_report,
            list_saved_reports,
            load_report_detail,
            delete_saved_report,
            // 자기편각
            get_magnetic_declination,
            refresh_declination_cache,
            // 장애물 월간 분석
            analyze_obstacle_monthly,
            // 장애물 사전검토
            analyze_pre_screening,
            compute_coverage_terrain_profile_excluding,
            compute_coverage_layers_batch_excluded,
            // 토지이용계획정보
            import_landuse_data,
            query_landuse_in_bbox,
            get_landuse_import_status,
            clear_landuse_data,
            // 토지이용계획도 타일
            download_landuse_tiles,
            get_landuse_tile_count,
            clear_landuse_tiles,
            get_landuse_tile,
            // vworld 자동 다운로드
            vworld_download_buildings,
            vworld_download_fac_buildings,
            vworld_download_landuse,
            vworld_download_n3p,
            // WebView2 네이티브 PDF
            webview_print_to_pdf,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // 모든 윈도우가 닫히면 프로세스 명시적 종료
            // (백그라운드 async 태스크가 남아있어도 확실히 종료)
            if let tauri::RunEvent::WindowEvent {
                event: tauri::WindowEvent::Destroyed,
                ..
            } = &event
            {
                if app_handle.webview_windows().is_empty() {
                    app_handle.exit(0);
                }
            }
        });
}
