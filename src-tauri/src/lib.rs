pub mod analysis;
pub mod models;
pub mod parser;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use log::info;
use rayon::prelude::*;
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
    aircraft_path: Mutex<PathBuf>,
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

            app.manage(AppState {
                aircraft_path: Mutex::new(aircraft_path),
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
