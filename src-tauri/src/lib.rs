mod analysis;
mod models;
mod parser;

use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use log::info;
use tauri::Manager;

use models::{Aircraft, AnalysisResult, ParsedFile, TrackPoint};

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
fn parse_ass_file(path: String) -> Result<ParsedFile, String> {
    info!("Command: parse_ass_file({})", path);
    parser::ass::parse_ass_file(&path).map_err(|e| e.to_string())
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

/// Parse an ASS file and immediately analyze it (combined command for convenience).
#[tauri::command]
fn parse_and_analyze(file_path: String) -> Result<AnalysisResult, String> {
    info!("Command: parse_and_analyze({})", file_path);
    let parsed = parser::ass::parse_ass_file(&file_path).map_err(|e| e.to_string())?;
    Ok(analysis::loss::analyze_tracks(parsed, analysis::loss::DEFAULT_THRESHOLD_SECS))
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
            get_aircraft_list,
            save_aircraft,
            delete_aircraft,
            filter_tracks_by_mode_s,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
