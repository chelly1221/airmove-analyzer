pub mod analysis;
pub mod building;
pub mod bulk;
pub mod coord;
pub mod db;
pub mod declination;
pub mod fac_building;
pub mod geo;
pub mod vworld_search;
pub mod landuse;
pub mod measured_building;
pub mod models;
pub mod parser;
pub mod peak;
pub mod srtm;
pub mod suppression;
pub mod terrain_tiles;
pub mod vworld;

use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use log::info;
use rusqlite::params;

use tauri::{Emitter, Manager};

use models::{Aircraft, AnalysisResult, TrackPoint};

/// TrackPoint 청크 스트리밍 이벤트 페이로드 — **차용** 페이로드로 직렬화 직전 deep copy 를 없앤다
/// (chunk.to_vec() 은 50k 포인트≈10MB 를 통째 복제 — 10M 포인트 배치에서 수 GB memcpy).
/// JSON 필드명·형태는 owned 버전과 완전히 동일하므로 프론트 영향 없음.
#[derive(Clone, serde::Serialize)]
struct TrackPointsChunkRef<'a> {
    file_path: &'a str,
    points: &'a [TrackPoint],
    /// 파싱 요청 태그(호출자 생성 고유값) — 이벤트는 요청 창에만 배달되지만(emit_to), 창 라벨로는
    /// 같은 창의 다른 페이지(/dualtarget ↔ /acas)·잔존 파싱의 청크를 구분할 수 없다.
    /// 리스너는 반드시 자기 태그와 엄격 일치로 필터할 것(신규 리스너 포함 — 이중 방어).
    request_tag: &'a str,
}

/// TrackPoints를 청크 단위로 이벤트 emit한 뒤, 원본에서 제거.
/// 50K = 메인 listener 호출 빈도 1/10로 감소 + 메인 메모리 통과 시간 짧음.
const CHUNK_SIZE: usize = 50_000;

fn emit_and_drain_track_points(
    handle: &tauri::AppHandle,
    target_label: &str,
    file_path: &str,
    request_tag: &str,
    points: &mut Vec<TrackPoint>,
) {
    for chunk in points.chunks(CHUNK_SIZE) {
        let _ = handle.emit_to(target_label, "parse-points-chunk", TrackPointsChunkRef {
            file_path,
            points: chunk,
            request_tag,
        });
    }
    // 메모리 해제 — 이미 프론트엔드로 전송됨
    points.clear();
    points.shrink_to_fit();
}

/// 유령표적(반사 이중표적) 보존분을 청크 단위로 emit한 뒤, 원본에서 제거.
/// 항적(track_points)과 별도 채널 — Loss 탐지/항적 파이프라인에 영향 없음.
fn emit_and_drain_ghost_points(
    handle: &tauri::AppHandle,
    target_label: &str,
    file_path: &str,
    request_tag: &str,
    points: &mut Vec<TrackPoint>,
) {
    for chunk in points.chunks(CHUNK_SIZE) {
        let _ = handle.emit_to(target_label, "parse-ghost-chunk", TrackPointsChunkRef {
            file_path,
            points: chunk,
            request_tag,
        });
    }
    // 메모리 해제 — 이미 프론트엔드로 전송됨
    points.clear();
    points.shrink_to_fit();
}

/// CAT008 기상 벡터 청크 스트리밍 이벤트 페이로드 — 차용 페이로드(복제 없이 직렬화, JSON 동일)
#[derive(Clone, serde::Serialize)]
struct WeatherChunkRef<'a> {
    file_path: &'a str,
    vectors: &'a [models::WeatherVector],
    /// 파싱 요청 태그 (TrackPointsChunkRef 와 동일 목적 — 리스너는 엄격 일치 필터 필수)
    request_tag: &'a str,
}

/// 기상 벡터를 청크 단위로 이벤트 emit한 뒤, 원본에서 제거.
fn emit_and_drain_weather_vectors(
    handle: &tauri::AppHandle,
    target_label: &str,
    file_path: &str,
    request_tag: &str,
    vectors: &mut Vec<models::WeatherVector>,
) {
    for chunk in vectors.chunks(CHUNK_SIZE) {
        let _ = handle.emit_to(target_label, "parse-weather-chunk", WeatherChunkRef {
            file_path,
            vectors: chunk,
            request_tag,
        });
    }
    vectors.clear();
    vectors.shrink_to_fit();
}

/// Application state for managing aircraft data.
pub(crate) struct AppState {
    pub(crate) app_data_dir: Mutex<PathBuf>,
    pub(crate) db: Mutex<db::DbPool>,
    pub(crate) srtm: Mutex<srtm::SrtmReader>,
    pub(crate) analysis_cancel: Arc<AtomicBool>,
    /// Cesium 3D Tiles(실측 건물) 루트 디렉터리 — tiles3d:// 프로토콜 서빙 기준 경로.
    /// None = 미설정(프로토콜 404). settings 키 "tiles3d_dir" 로 영속화.
    pub(crate) tiles3d_dir: Mutex<Option<PathBuf>>,
}

/// 앱 데이터 디렉토리 경로 확보
fn get_app_data_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    // 포터블 모드: exe 옆 data/ 폴더 우선 사용
    if let Ok(exe_path) = std::env::current_exe() {
        if let Some(exe_dir) = exe_path.parent() {
            let portable_dir = exe_dir.join("data");
            // data 폴더가 이미 있거나, 새로 생성 가능하면 포터블 모드
            if portable_dir.exists() || fs::create_dir_all(&portable_dir).is_ok() {
                info!("Portable mode: {:?}", portable_dir);
                return Ok(portable_dir);
            }
        }
    }

    // 폴백: 기존 AppData 경로
    let app_data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data directory: {}", e))?;

    if !app_data_dir.exists() {
        fs::create_dir_all(&app_data_dir)
            .map_err(|e| format!("Failed to create app data directory: {}", e))?;
    }

    Ok(app_data_dir)
}

// ---------- Tauri Commands ----------

/// Parse an ASS binary file and return structured track data.

/// Analyze parsed track data: detect loss segments and compute statistics.

/// Get the list of registered aircraft.
#[tauri::command]
async fn get_aircraft_list(app_handle: tauri::AppHandle) -> Result<Vec<Aircraft>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        db::get_aircraft_list(&conn).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// Save (add or update) an aircraft to the persistent store.
#[tauri::command]
async fn save_aircraft(aircraft: Aircraft, app_handle: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        info!("Command: save_aircraft(id={}, name={})", aircraft.id, aircraft.name);
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        db::save_aircraft(&conn, &aircraft).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// Delete an aircraft by its ID.
#[tauri::command]
async fn delete_aircraft(id: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        info!("Command: delete_aircraft(id={})", id);
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        let changed = db::delete_aircraft(&conn, &id).map_err(|e| format!("DB error: {}", e))?;
        if changed == 0 {
            return Err(format!("Aircraft with id '{}' not found", id));
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 배치 파싱 결과 이벤트 페이로드 (파일 하나 완료 시 emit, track_points는 청크로 별도 전송)
#[derive(Clone, serde::Serialize)]
struct BatchResultEvent {
    file_path: String,
    success: bool,
    /// 파일 메타정보 (track_points 제외 — 청크 스트리밍으로 별도 전송)
    file_info: Option<BatchFileInfo>,
    error: Option<String>,
    /// 파싱 요청 태그 (TrackPointsChunkRef 와 동일 목적 — 리스너는 엄격 일치 필터 필수)
    request_tag: String,
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
    /// TCAS/ACAS 보고 (트랙 독립 전수 추출)
    tcas_reports: Vec<models::TcasReport>,
    /// CAT008 기상 벡터 개수 (벡터 자체는 청크로 별도 스트리밍)
    weather_vector_count: usize,
}

/// 배치 완료 이벤트 페이로드.
/// 모든 청크·결과 emit **이후** 마지막에 emit 되므로, 프론트 파싱 플로우가 request_tag 일치
/// 대기(청크 완전 수신 배리어)로 소비한다 — invoke 응답이 마지막 청크를 추월하는 레이스 방지.
#[derive(Clone, serde::Serialize)]
struct BatchDoneEvent {
    total: usize,
    succeeded: usize,
    failed: usize,
    /// 방출 총계 3종 — 프론트가 수신 누계와 대조해 이벤트 유실(=수신 절단)을 탐지하는 정확 배리어.
    /// (emit 직전 각 벡터 len 을 누적 — drain 이 clear 하므로 호출 전 캡처)
    points_emitted: usize,
    ghost_points_emitted: usize,
    weather_vectors_emitted: usize,
    /// 파싱 요청 태그 (TrackPointsChunkRef 와 동일 목적 — 리스너는 엄격 일치 필터 필수)
    request_tag: String,
}

/// 여러 ASS 파일을 병렬로 파싱+분석.
/// rayon 병렬 파싱 + 채널 기반 즉시 스트리밍 (파일 완료 즉시 메모리 해제)
#[tauri::command]
async fn parse_and_analyze_batch(
    app_handle: tauri::AppHandle,
    // 요청 창(자동 주입 — 프론트 invoke 인자 무변경). 모든 파싱 이벤트를 이 창 라벨로만 배달한다
    window: tauri::WebviewWindow,
    // 호출자가 생성한 요청 고유 태그(JS: requestTag) — 청크·결과·완료 이벤트에 그대로 스탬프된다
    request_tag: String,
    file_paths: Vec<String>,
    radar_lat: f64,
    radar_lon: f64,
    mode_s_include: Vec<String>,
    mode_s_exclude: Vec<String>,
    mode3a_include: Vec<u16>,
    mode3a_exclude: Vec<u16>,
    // 관심 채널 플래그(JS: wantPoints/wantGhostPoints/wantWeather) — 호출 페이지가 리스너를
    // 등록한 채널만 true. false 인 채널은 청크 직렬화·emit 을 통째로 생략한다(clear 만).
    want_points: bool,
    want_ghost_points: bool,
    want_weather: bool,
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
    // 요청 창에만 배달 — 방관 창이 수십 MB 청크를 역직렬화 후 버리는 낭비 제거.
    // request_tag 는 같은 창 내 페이지·잔존 파싱 구분용으로 유지(이중 방어).
    let target_label = window.label().to_string();
    let total = file_paths.len();

    tauri::async_runtime::spawn_blocking(move || {
        // 병렬 파싱 스레드: 완료 즉시 채널로 전송 (메모리 일괄 보유 방지)
        let ms_incl_ref = &mode_s_include;
        let ms_excl_ref = &mode_s_exclude;
        let m3a_incl_ref = &mode3a_include;
        let m3a_excl_ref = &mode3a_exclude;
        // 소비 스레드가 차용 캡처할 참조들 (std::thread::scope 는 스코프 밖 값의 차용을 허용)
        let handle_ref = &handle;
        let target_label_ref = target_label.as_str();
        let request_tag_ref = request_tag.as_str();
        let file_paths_ref = &file_paths;

        // 드레인(소비)을 rayon 파싱과 **동시** 실행한다.
        // rayon::scope 는 전 파일 파싱 완료까지 블록하므로, 같은 스레드에서 뒤이어 드레인하면
        // 모든 파일의 AnalysisResult 가 무제한 mpsc 채널에 동시 체류한 뒤에야 해제된다
        // (= 스트리밍이 아니라 전량 버퍼링 — 10M+ 배치에서 백엔드 메모리 스파이크).
        std::thread::scope(|ts| {
            // 채널은 반드시 이 클로저 **안**에서 생성한다 — 파싱 패닉(rayon::scope 재전파) 시
            // 클로저 로컬인 tx 가 언와인딩 중 drop 되어야 rx 가 닫히고 소비 스레드가 종료된다.
            // 클로저 밖에 두면 thread::scope 가 소비 스레드 조인을 무한 대기(교착)한다.
            let (tx, rx) = std::sync::mpsc::channel::<(String, Result<AnalysisResult, String>)>();

            // ── 이벤트 emit 순서 불변식 ──
            // 청크들 → 그 파일의 batch-parse-result → … → 마지막 batch-parse-done.
            // **단일 소비 스레드**가 rx 수신 순서대로 이 emit 을 전부 수행하므로 순서가 자동
            // 보장된다. emit 을 파싱 스레드나 추가 소비 스레드로 분산하면 즉시 깨지므로 금지.
            let consumer = ts.spawn(move || {
                // 수신 루프: 결과 도착 즉시 스트리밍 + 메모리 해제 (파싱과 동시 진행)
                let mut succeeded = 0usize;
                let mut failed = 0usize;
                // 채널별 방출 총계 — done 이벤트로 전달해 프론트 수신 누계와 대조(절단 탐지)
                let mut points_emitted = 0usize;
                let mut ghost_points_emitted = 0usize;
                let mut weather_vectors_emitted = 0usize;

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
                                tcas_reports: std::mem::take(&mut analysis.file_info.tcas_reports),
                                weather_vector_count: analysis.file_info.weather_vectors.len(),
                            };
                            // 관심 채널만 emit — 리스너 미등록 채널은 clear 만 하고 직렬화를 생략한다.
                            // 그 채널의 emitted 는 0 으로 남지만, 프론트 완전성 대조는 **등록한 채널만**
                            // 보므로 정합(parseBatch.ts 의 complete 판정 참조).
                            // 방출 총계 누적은 반드시 drain **호출 전** (drain 이 벡터를 clear 한다)
                            if want_points {
                                points_emitted += analysis.file_info.track_points.len();
                                // track_points를 청크로 스트리밍 후 메모리 해제
                                emit_and_drain_track_points(handle_ref, target_label_ref, &path, request_tag_ref, &mut analysis.file_info.track_points);
                            } else {
                                analysis.file_info.track_points.clear();
                                analysis.file_info.track_points.shrink_to_fit();
                            }
                            if want_ghost_points {
                                ghost_points_emitted += analysis.file_info.ghost_points.len();
                                // 유령표적 보존분을 청크로 스트리밍 후 메모리 해제 (이중표적 분석용 별도 채널)
                                emit_and_drain_ghost_points(handle_ref, target_label_ref, &path, request_tag_ref, &mut analysis.file_info.ghost_points);
                            } else {
                                analysis.file_info.ghost_points.clear();
                                analysis.file_info.ghost_points.shrink_to_fit();
                            }
                            if want_weather {
                                weather_vectors_emitted += analysis.file_info.weather_vectors.len();
                                // 기상 벡터를 청크로 스트리밍 후 메모리 해제
                                emit_and_drain_weather_vectors(handle_ref, target_label_ref, &path, request_tag_ref, &mut analysis.file_info.weather_vectors);
                            } else {
                                analysis.file_info.weather_vectors.clear();
                                analysis.file_info.weather_vectors.shrink_to_fit();
                            }

                            // analysis는 여기서 drop → 메모리 즉시 해제
                            BatchResultEvent {
                                file_path: path,
                                success: true,
                                file_info: Some(file_info),
                                error: None,
                                request_tag: request_tag_ref.to_string(),
                            }
                        }
                        Err(e) => {
                            failed += 1;
                            BatchResultEvent {
                                file_path: path,
                                success: false,
                                file_info: None,
                                error: Some(e),
                                request_tag: request_tag_ref.to_string(),
                            }
                        }
                    };
                    let _ = handle_ref.emit_to(target_label_ref, "batch-parse-result", event);
                }

                // rx 종료(= 모든 파싱 완료 + tx drop) 후 마지막 emit — 이 스레드가 위 청크·결과
                // emit 을 모두 마친 뒤이므로 done 이 항상 최후미다
                let _ = handle_ref.emit_to(target_label_ref, "batch-parse-done", BatchDoneEvent {
                    total,
                    succeeded,
                    failed,
                    points_emitted,
                    ghost_points_emitted,
                    weather_vectors_emitted,
                    request_tag: request_tag_ref.to_string(),
                });
            });

            rayon::scope(|s| {
                let tx = &tx;
                for path in file_paths_ref {
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
            // rayon scope 완료 후 sender drop → rx 종료 → 소비 스레드가 done emit 후 종료
            drop(tx);
            // 소비 스레드 패닉은 그대로 재전파 — 기존(단일 스레드 드레인) 동작과 동일하게
            // invoke 가 "Task join error" 로 거절되어 프론트가 failed=true 로 인지한다
            if let Err(p) = consumer.join() {
                std::panic::resume_unwind(p);
            }
        });
    })
    .await
    .map_err(|e| format!("Task join error: {}", e))
}

/// ASTERIX 스캔 진행 이벤트.
#[derive(Clone, serde::Serialize)]
struct AsterixScanProgress {
    done: usize,
    total: usize,
    filename: String,
}

/// "ASTERIX 분석" 탭: 선택 ASS 파일들을 전수 1패스 스캔하여 집계 통계 반환.
/// 트랙/비행/ACAS 보고와 무관하게 모든 프레임/블록/레코드를 순회한다.
#[tauri::command]
async fn scan_asterix_batch(
    app_handle: tauri::AppHandle,
    file_paths: Vec<String>,
) -> Result<parser::ass::AsterixStats, String> {
    info!("Command: scan_asterix_batch({} files)", file_paths.len());
    tauri::async_runtime::spawn_blocking(move || {
        let total = file_paths.len();
        let mut state = parser::ass::AsterixScanState::default();
        for (i, path) in file_paths.iter().enumerate() {
            let filename = std::path::Path::new(path)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| path.clone());
            if let Err(e) = parser::ass::asterix_scan_file(path, &mut state) {
                info!("[ASTERIX] 스캔 실패 {}: {}", filename, e);
            }
            let _ = app_handle.emit(
                "asterix-scan-progress",
                AsterixScanProgress {
                    done: i + 1,
                    total,
                    filename,
                },
            );
        }
        Ok(parser::ass::asterix_finalize(state))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// "ASTERIX 분석" 탭: 필터 기반 온디맨드 프레임 조회 (재스캔, 상한까지 수집).
#[tauri::command]
async fn query_asterix_frames(
    file_paths: Vec<String>,
    filter: parser::ass::AsterixFilter,
) -> Result<parser::ass::AsterixQueryResult, String> {
    tauri::async_runtime::spawn_blocking(move || parser::ass::asterix_query(&file_paths, &filter))
        .await
        .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// Filter track points by Mode-S code (case-insensitive match).

/// base64 데이터를 파일로 저장 (PDF 등)
#[tauri::command]
async fn write_file_base64(path: String, data: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        use base64::{Engine as _, engine::general_purpose::STANDARD};
        let bytes = STANDARD.decode(&data).map_err(|e| format!("Base64 decode error: {}", e))?;
        fs::write(&path, &bytes).map_err(|e| format!("Failed to write file: {}", e))?;
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// WebView2 네이티브 PrintToPdf — CDP(Chrome DevTools Protocol) Page.printToPDF 사용
/// 벡터 텍스트 PDF, GPU 가속 렌더링, html2canvas 대비 5-10x 빠름
/// PDF 파일을 path 에 직접 저장. 저장 기능이 없어 base64 반환은 제거(대용량 PDF IPC 왕복 낭비 제거).
#[tauri::command]
async fn webview_print_to_pdf(
    _app_handle: tauri::AppHandle,
    _path: String,
    _window_label: Option<String>,
) -> Result<(), String> {
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
                    // preferCSSPageSize:true 라 @page{size:210mm 297mm} 가 시트를 결정하고 아래
                    // paperWidth/Height 는 폴백값이다. 반올림(8.27/11.69=210.06×296.93mm)이 아닌
                    // 정확한 A4 인치(210/25.4, 297/25.4)로 못박아, 혹 preferCSSPageSize 가 무시되는
                    // 빌드에서도 시트가 정확히 210×297mm 가 되게 한다 (296.93mm 폴백 시 매 장 빈 페이지 방지).
                    let params = r#"{
                        "landscape": false,
                        "printBackground": true,
                        "paperWidth": 8.2677165354,
                        "paperHeight": 11.6929133858,
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

        Ok(())
    }

    #[cfg(not(windows))]
    {
        Err("WebView2 PrintToPdf는 Windows에서만 지원됩니다".to_string())
    }
}

/// 설정값 로드 (프론트엔드용)
#[tauri::command]
async fn load_setting(
    key: String,
    app_handle: tauri::AppHandle,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        db::get_setting(&conn, &key).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 설정값 저장 (프론트엔드용)
#[tauri::command]
async fn save_setting(
    key: String,
    value: String,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        db::set_setting(&conn, &key, &value).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// DB 파일 경로 반환 (내보내기/가져오기 용)
fn get_db_path(state: &AppState) -> Result<PathBuf, String> {
    let app_data_dir = state.app_data_dir.lock().map_err(|e| format!("Lock error: {}", e))?;
    Ok(app_data_dir.join("adsb.db"))
}

// ---------- DB 백업(ZIP) 내보내기/가져오기 ----------
//
// 백업 형식: 무압축(Stored) ZIP 한 개
//   adsb.db          — DB 본체 (수 GB 가능 → zip64)
//   tiles3d/<파일>   — 등록된 실측 3D 타일 폴더 (b3dm·tileset.json·buildings_3d.bin)
// legacy 단일 .db 백업도 가져오기에서 계속 지원 (선두 매직으로 분기)

/// 백업 복사 버퍼 8MB — 수 GB DB 를 io::copy 대신 수동 루프로 옮기며 진행률을 방출하기 위한 단위
const BACKUP_BUF_SIZE: usize = 8 * 1024 * 1024;

/// 백업 전송 진행 이벤트 (내보내기/가져오기 공용)
/// unit: "bytes"(바이트 진행) | "files"(파일 수 진행) — 프론트 표기 분기용
fn emit_transfer_progress(
    handle: &tauri::AppHandle,
    phase: &str,
    unit: &str,
    current: u64,
    total: u64,
) {
    let _ = handle.emit(
        "db-transfer-progress",
        serde_json::json!({ "phase": phase, "unit": unit, "current": current, "total": total }),
    );
}

/// 바이트 크기 → MB/GB 표기 (요약 메시지용)
fn format_backup_size(bytes: u64) -> String {
    const MB: f64 = 1024.0 * 1024.0;
    const GB: f64 = MB * 1024.0;
    let b = bytes as f64;
    if b >= GB {
        format!("{:.1}GB", b / GB)
    } else {
        format!("{:.1}MB", b / MB)
    }
}

/// 버퍼 재사용 복사 (진행 이벤트 없음) — 타일처럼 작은 파일 다수용
fn copy_buffered<R: std::io::Read, W: std::io::Write>(
    reader: &mut R,
    writer: &mut W,
    buf: &mut [u8],
) -> std::io::Result<u64> {
    let mut done: u64 = 0;
    loop {
        let n = reader.read(buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        done += n as u64;
    }
    Ok(done)
}

/// 8MB 버퍼 복사 + 바이트 진행 이벤트 — DB 본체(수 GB)용
fn copy_with_progress<R: std::io::Read, W: std::io::Write>(
    reader: &mut R,
    writer: &mut W,
    total: u64,
    handle: &tauri::AppHandle,
    phase: &str,
) -> std::io::Result<u64> {
    let mut buf = vec![0u8; BACKUP_BUF_SIZE];
    let mut done: u64 = 0;
    loop {
        let n = reader.read(&mut buf)?;
        if n == 0 {
            break;
        }
        writer.write_all(&buf[..n])?;
        done += n as u64;
        emit_transfer_progress(handle, phase, "bytes", done, total.max(done));
    }
    emit_transfer_progress(handle, phase, "bytes", done, total.max(done));
    Ok(done)
}

/// 폴더 내 파일을 재귀 수집 — (절대경로, root 기준 상대경로 '/' 구분) 목록
fn collect_files_rel(
    root: &std::path::Path,
    cur: &std::path::Path,
    out: &mut Vec<(PathBuf, String)>,
) -> Result<(), String> {
    let entries = fs::read_dir(cur).map_err(|e| format!("폴더 읽기 실패 {:?}: {}", cur, e))?;
    for ent in entries {
        let ent = ent.map_err(|e| format!("폴더 항목 읽기 실패: {}", e))?;
        let p = ent.path();
        if p.is_dir() {
            collect_files_rel(root, &p, out)?;
        } else if p.is_file() {
            let rel = p
                .strip_prefix(root)
                .map_err(|e| format!("상대경로 계산 실패: {}", e))?;
            // ZIP 엔트리명은 플랫폼 무관하게 항상 '/' 구분자
            let rel_str = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            out.push((p, rel_str));
        }
    }
    Ok(())
}

/// 백업 ZIP 작성 (adsb.db + 선택적 tiles3d/) — 요약 문자열 반환
fn write_backup_zip(
    handle: &tauri::AppHandle,
    db_path: &std::path::Path,
    tiles_dir: Option<&std::path::Path>,
    dest_path: &str,
) -> Result<String, String> {
    use std::io::Write;

    let dest = fs::File::create(dest_path).map_err(|e| format!("백업 파일 생성 실패: {}", e))?;
    let mut zipw = zip::ZipWriter::new(std::io::BufWriter::new(dest));
    // 무압축(Stored): 수 GB DB 를 deflate 하면 시간이 과도하고, b3dm 은 이미 압축된 바이너리 메시
    // large_file: zip64 헤더 — DB 4GB 초과 대비
    let opts = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Stored)
        .large_file(true);

    // ① DB 본체
    let db_size = fs::metadata(db_path)
        .map_err(|e| format!("DB 파일 정보 조회 실패: {}", e))?
        .len();
    zipw.start_file("adsb.db", opts)
        .map_err(|e| format!("ZIP 항목 생성 실패(adsb.db): {}", e))?;
    {
        let mut f = fs::File::open(db_path).map_err(|e| format!("DB 파일 열기 실패: {}", e))?;
        copy_with_progress(&mut f, &mut zipw, db_size, handle, "DB 내보내는 중")
            .map_err(|e| format!("DB 쓰기 실패: {}", e))?;
    }

    // ② 실측 3D 타일 폴더 — 현재 데이터는 평탄 구조지만 하위 폴더도 방어적으로 재귀
    let mut tile_count = 0usize;
    let mut tile_bytes = 0u64;
    if let Some(dir) = tiles_dir {
        let mut files: Vec<(PathBuf, String)> = Vec::new();
        collect_files_rel(dir, dir, &mut files)?;
        let total = files.len();
        let mut buf = vec![0u8; BACKUP_BUF_SIZE];
        for (i, (path, rel)) in files.iter().enumerate() {
            zipw.start_file(format!("tiles3d/{}", rel), opts)
                .map_err(|e| format!("ZIP 항목 생성 실패({}): {}", rel, e))?;
            let mut f =
                fs::File::open(path).map_err(|e| format!("타일 파일 열기 실패({}): {}", rel, e))?;
            tile_bytes += copy_buffered(&mut f, &mut zipw, &mut buf)
                .map_err(|e| format!("타일 쓰기 실패({}): {}", rel, e))?;
            tile_count += 1;
            if (i + 1) % 50 == 0 {
                emit_transfer_progress(
                    handle,
                    "3D 타일 내보내는 중",
                    "files",
                    (i + 1) as u64,
                    total as u64,
                );
            }
        }
        emit_transfer_progress(
            handle,
            "3D 타일 내보내는 중",
            "files",
            total as u64,
            total as u64,
        );
    }

    let mut inner = zipw.finish().map_err(|e| format!("ZIP 마무리 실패: {}", e))?;
    inner.flush().map_err(|e| format!("백업 파일 기록 실패: {}", e))?;

    Ok(if tile_count > 0 {
        format!(
            "DB {} + 3D 타일 {}개({}) 내보내기 완료",
            format_backup_size(db_size),
            tile_count,
            format_backup_size(tile_bytes)
        )
    } else {
        format!(
            "DB {} 내보내기 완료 (3D 타일 미등록)",
            format_backup_size(db_size)
        )
    })
}

/// DB 내보내기 — adsb.db + (등록 시) 실측 3D 타일 폴더를 무압축 ZIP 한 개로 저장
#[tauri::command]
async fn export_database(
    dest_path: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let db_path = get_db_path(&state)?;
        // WAL 체크포인트 → 단일 파일로 정리
        {
            let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
            conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE);")
                .map_err(|e| format!("WAL checkpoint error: {}", e))?;
        }
        // 실측 3D 타일 폴더 (등록 + 실존 시에만 포함) — db lock 해제 후 순차 획득
        let tiles_dir: Option<PathBuf> = {
            let guard = state
                .tiles3d_dir
                .lock()
                .map_err(|e| format!("tiles3d_dir lock: {}", e))?;
            guard.as_ref().filter(|p| p.is_dir()).cloned()
        };

        match write_backup_zip(&app_handle, &db_path, tiles_dir.as_deref(), &dest_path) {
            Ok(summary) => {
                info!("Database exported to: {} ({})", dest_path, summary);
                Ok(summary)
            }
            Err(e) => {
                // 쓰다 만 백업 파일 정리
                let _ = fs::remove_file(&dest_path);
                Err(e)
            }
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 교체된 DB 의 settings "tiles3d_dir" 로 AppState 를 갱신 (재시작 없이 반영, 시작 시 복원과 동일 규칙)
fn sync_tiles3d_from_db(state: &AppState) -> Result<(), String> {
    let stored: Option<String> = {
        let conn = state
            .db
            .lock()
            .map_err(|e| format!("DB lock: {}", e))?
            .get()
            .map_err(|e| format!("DB pool: {}", e))?;
        db::get_setting(&conn, "tiles3d_dir").ok().flatten()
    };
    let resolved = stored
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(PathBuf::from);

    let mut guard = state
        .tiles3d_dir
        .lock()
        .map_err(|e| format!("tiles3d_dir lock: {}", e))?;
    *guard = resolved;
    Ok(())
}

/// legacy 단일 .db 백업 가져오기 — 풀 임시교체 → 파일 복사 → wal/shm 제거 → 풀 재생성
fn import_legacy_db(
    state: &AppState,
    src: &std::path::Path,
    db_path: &std::path::Path,
) -> Result<(), String> {
    {
        // 풀 교체 (Mutex 잠금 상태에서 수행 → 다른 커맨드 차단)
        let mut pool_guard = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;

        // 기존 풀 drop → 모든 연결 해제
        // 인메모리 풀로 임시 교체하여 파일 핸들 확실히 해제
        let temp_manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let temp_pool = r2d2::Pool::builder()
            .max_size(1)
            .build(temp_manager)
            .map_err(|e| format!("임시 풀 오류: {}", e))?;
        *pool_guard = temp_pool;

        // DB 파일 교체
        fs::copy(src, db_path).map_err(|e| format!("파일 복사 실패: {}", e))?;
        // WAL/SHM 잔여 파일 제거
        let _ = fs::remove_file(db_path.with_extension("db-wal"));
        let _ = fs::remove_file(db_path.with_extension("db-shm"));

        // 새 풀 생성 (마이그레이션 포함)
        let new_pool = db::init_db_pool(db_path)?;
        *pool_guard = new_pool;
    }
    // db lock 해제 후 tiles3d_dir lock (두 잠금 동시 보유 금지)
    sync_tiles3d_from_db(state)
}

/// 백업 ZIP 가져오기 — 타일 먼저 추출(DB 무손상 보장) 후 DB 교체. 요약 문자열 반환
fn import_backup_zip(
    handle: &tauri::AppHandle,
    state: &AppState,
    src: &std::path::Path,
    db_path: &std::path::Path,
) -> Result<String, String> {
    let file = fs::File::open(src).map_err(|e| format!("파일 열기 실패: {}", e))?;
    let mut archive = zip::ZipArchive::new(std::io::BufReader::new(file))
        .map_err(|e| format!("ZIP 열기 실패: {}", e))?;

    // adsb.db 존재 검증 — 없으면 기존 DB 를 건드리지 않고 종료
    if archive.by_name("adsb.db").is_err() {
        return Err("백업 ZIP 에 adsb.db 가 없습니다.".to_string());
    }

    // tiles3d/ 엔트리 수집 — enclosed_name 으로 '..'·절대경로(zip slip) 차단
    let mut tile_entries: Vec<(usize, PathBuf)> = Vec::new();
    for i in 0..archive.len() {
        let entry = match archive.by_index(i) {
            Ok(e) => e,
            Err(_) => continue,
        };
        if entry.is_dir() || !entry.name().starts_with("tiles3d/") {
            continue;
        }
        let safe = match entry.enclosed_name() {
            Some(p) => p,
            None => continue,
        };
        let rel = match safe.strip_prefix("tiles3d") {
            Ok(r) => r.to_path_buf(),
            Err(_) => continue,
        };
        // enclosed_name 은 중간 '..'(예: tiles3d/../x)을 허용하므로 일반 성분만 남은 경로로 한정
        if rel.as_os_str().is_empty()
            || !rel
                .components()
                .all(|c| matches!(c, std::path::Component::Normal(_)))
        {
            continue;
        }
        tile_entries.push((i, rel));
    }

    // ① 타일 먼저 추출 (DB 교체 전 — 추출이 실패해도 기존 DB 는 무손상)
    let mut tiles_root: Option<PathBuf> = None;
    if !tile_entries.is_empty() {
        let managed = {
            let dir = state
                .app_data_dir
                .lock()
                .map_err(|e| format!("Lock error: {}", e))?;
            dir.join("tiles3d")
        };
        let _ = fs::remove_dir_all(&managed); // 이전 복원본 정리 (없으면 무시)
        fs::create_dir_all(&managed).map_err(|e| format!("타일 폴더 생성 실패: {}", e))?;

        let total = tile_entries.len();
        let mut buf = vec![0u8; BACKUP_BUF_SIZE];
        for (n, (idx, rel)) in tile_entries.iter().enumerate() {
            let out_path = managed.join(rel);
            if let Some(parent) = out_path.parent() {
                fs::create_dir_all(parent).map_err(|e| format!("타일 폴더 생성 실패: {}", e))?;
            }
            let mut zf = archive
                .by_index(*idx)
                .map_err(|e| format!("ZIP 항목 읽기 실패: {}", e))?;
            let mut of =
                fs::File::create(&out_path).map_err(|e| format!("타일 파일 생성 실패: {}", e))?;
            copy_buffered(&mut zf, &mut of, &mut buf)
                .map_err(|e| format!("타일 복원 실패: {}", e))?;
            if (n + 1) % 50 == 0 {
                emit_transfer_progress(
                    handle,
                    "3D 타일 복원 중",
                    "files",
                    (n + 1) as u64,
                    total as u64,
                );
            }
        }
        emit_transfer_progress(handle, "3D 타일 복원 중", "files", total as u64, total as u64);
        tiles_root = Some(managed);
    }

    // ② DB 교체 (legacy 와 동일 패턴: 풀 임시교체 → 추출 → wal/shm 제거 → 풀 재생성)
    {
        let mut pool_guard = state.db.lock().map_err(|e| format!("DB lock: {}", e))?;

        let temp_manager = r2d2_sqlite::SqliteConnectionManager::memory();
        let temp_pool = r2d2::Pool::builder()
            .max_size(1)
            .build(temp_manager)
            .map_err(|e| format!("임시 풀 오류: {}", e))?;
        *pool_guard = temp_pool;

        {
            let mut zf = archive
                .by_name("adsb.db")
                .map_err(|e| format!("ZIP 항목 읽기 실패(adsb.db): {}", e))?;
            let total = zf.size();
            let mut of =
                fs::File::create(db_path).map_err(|e| format!("DB 파일 생성 실패: {}", e))?;
            copy_with_progress(&mut zf, &mut of, total, handle, "DB 복원 중")
                .map_err(|e| format!("DB 복원 실패: {}", e))?;
        }
        let _ = fs::remove_file(db_path.with_extension("db-wal"));
        let _ = fs::remove_file(db_path.with_extension("db-shm"));

        let new_pool = db::init_db_pool(db_path)?;
        *pool_guard = new_pool;
    }

    // ③ 가져온 DB 의 tiles3d_dir 반영 → 타일을 복원했으면 관리 폴더 경로로 덮어쓴다
    sync_tiles3d_from_db(state)?;
    let tile_count = tile_entries.len();
    if let Some(root) = tiles_root {
        let dir_str = root.to_string_lossy().to_string();
        {
            let conn = state
                .db
                .lock()
                .map_err(|e| format!("DB lock: {}", e))?
                .get()
                .map_err(|e| format!("DB pool: {}", e))?;
            db::set_setting(&conn, "tiles3d_dir", &dir_str)
                .map_err(|e| format!("3D 타일 폴더 저장 실패: {}", e))?;
        }
        let mut guard = state
            .tiles3d_dir
            .lock()
            .map_err(|e| format!("tiles3d_dir lock: {}", e))?;
        *guard = Some(root);
    }

    Ok(if tile_count > 0 {
        format!("데이터베이스 + 3D 타일 {}개를 가져왔습니다.", tile_count)
    } else {
        "데이터베이스를 가져왔습니다. (3D 타일 없음)".to_string()
    })
}

/// DB 가져오기 — 백업 ZIP(adsb.db + tiles3d/) 또는 legacy 단일 .db 겸용
#[tauri::command]
async fn import_database(
    src_path: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        use std::io::Read;

        let state = app_handle.state::<AppState>();
        let db_path = get_db_path(&state)?;
        let src = std::path::Path::new(&src_path);

        // 형식 판별 — 선두 16바이트만 읽는다 (수백 MB~수 GB 파일이라 전체 읽기 금지)
        let mut head = [0u8; 16];
        let head_len = {
            let mut f = fs::File::open(src).map_err(|e| format!("파일 읽기 실패: {}", e))?;
            let mut n = 0usize;
            while n < head.len() {
                match f.read(&mut head[n..]) {
                    Ok(0) => break,
                    Ok(k) => n += k,
                    Err(e) => return Err(format!("파일 읽기 실패: {}", e)),
                }
            }
            n
        };

        let summary = if head_len == head.len() && &head[..] == b"SQLite format 3\0" {
            import_legacy_db(&state, src, &db_path)?;
            "데이터베이스를 가져왔습니다.".to_string()
        } else if head_len >= 4 && &head[..4] == b"PK\x03\x04" {
            import_backup_zip(&app_handle, &state, src, &db_path)?
        } else {
            return Err("유효한 백업 파일이 아닙니다 (.zip 또는 .db).".to_string());
        };

        // ── 복원 후 인메모리 캐시 무효화 (두 포맷 분기 공통 초크포인트) ──
        // DB 가 통째로 교체돼 srtm_ground_corrections·건물 세대가 바뀌는데, 프로세스 수명인
        // AppState.srtm 타일 캐시와 coverage 정적 캐시는 그대로 살아남아 복원 전 지형/프로파일을
        // 계속 서비스한다(프론트 window.location.reload 는 웹뷰만 재기동).
        {
            let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
            srtm.clear_cache();
        }
        analysis::coverage::invalidate_building_caches();
        // 설정 창은 reload 하지만 열려 있는 지도/도면 창은 재기동하지 않으므로 재조회를 유도
        let _ = app_handle.emit("fac-buildings-changed", ());
        let _ = app_handle.emit("manual-buildings-changed", ());
        // panorama_cache 는 복원된 DB 안에 함께 실려 와 그 DB 의 보정 세대와 자기정합이므로
        // 여기서 clear_panorama_cache_all 을 호출하면 백업의 유효 캐시만 버리게 된다 — 의도적으로 제외.

        info!("Database imported from: {} ({})", src_path, summary);
        Ok(summary)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// GPU 파노라마 건물 병합 (GPU에서 계산한 지형 결과에 건물 데이터 오버레이)
/// 결과는 수 MB~수십 MB — bulk:// 파일 매개 전송 (BulkRef 반환, bulk.rs 참조)
#[tauri::command]
async fn panorama_merge_buildings(
    app_handle: tauri::AppHandle,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    max_range_km: Option<f64>,
    azimuth_step_deg: Option<f64>,
    terrain_results: Vec<analysis::panorama::TerrainResult>,
    exclude_manual_ids: Option<Vec<i64>>,
) -> Result<bulk::BulkRef, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let max_range = max_range_km.unwrap_or(100.0);
        let az_step = azimuth_step_deg.unwrap_or(0.01);
        let exclude_ids = exclude_manual_ids.unwrap_or_default();

        let result = {
            let state = app_handle.state::<AppState>();
            let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
            let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;

            analysis::panorama::merge_buildings_into_panorama(
                &mut srtm, &conn,
                &terrain_results,
                radar_lat, radar_lon, radar_height_m,
                max_range * 1000.0, az_step, &exclude_ids,
            )
        };
        bulk::write_json(&app_handle, &result)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// GPU 파노라마 건물 병합 (dual) — with/without manual targets 를 단일 IPC로 반환.
/// terrain 직렬화/송신을 1회만 수행하여 기존 대비 IPC 비용 절반 수준.
/// 결과(terrain 36K + 건물 실루엣 ×2)는 수십 MB — bulk:// 파일 매개 전송
#[tauri::command]
async fn panorama_merge_buildings_dual(
    app_handle: tauri::AppHandle,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    max_range_km: Option<f64>,
    terrain_results: Vec<analysis::panorama::TerrainResult>,
    exclude_manual_ids: Option<Vec<i64>>,
) -> Result<bulk::BulkRef, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let max_range = max_range_km.unwrap_or(100.0);
        let exclude_ids = exclude_manual_ids.unwrap_or_default();

        let result = {
            let state = app_handle.state::<AppState>();
            let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
            let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;

            analysis::panorama::merge_buildings_into_panorama_dual(
                &mut srtm, &conn,
                &terrain_results,
                radar_lat, radar_lon, radar_height_m,
                max_range * 1000.0, &exclude_ids,
            )
        };
        bulk::write_json(&app_handle, &result)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 파노라마 캐시 저장
#[tauri::command]
async fn save_panorama_cache(
    app_handle: tauri::AppHandle,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    data_json: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        db::save_panorama_cache(&conn, radar_lat, radar_lon, radar_height_m, &data_json)
            .map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 파노라마 캐시 로드 (저장 높이와 불일치 시 None → 호출부 재계산)
/// 캐시 JSON 은 수십 MB 급 문자열 — String 응답은 항상 eval(CDP) 경로를 타므로 bulk:// 전송
#[tauri::command]
async fn load_panorama_cache(
    app_handle: tauri::AppHandle,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
) -> Result<Option<bulk::BulkRef>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cached = {
            let state = app_handle.state::<AppState>();
            let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
            db::load_panorama_cache(&conn, radar_lat, radar_lon, radar_height_m)
                .map_err(|e| format!("DB error: {}", e))?
        };
        match cached {
            Some(json) => Ok(Some(bulk::write_bytes(&app_handle, json.as_bytes(), "json")?)),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 파노라마 캐시 삭제
#[tauri::command]
async fn clear_panorama_cache(
    app_handle: tauri::AppHandle,
    radar_lat: f64,
    radar_lon: f64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        db::clear_panorama_cache(&conn, radar_lat, radar_lon)
            .map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// SRTM HGT 기반 고도 조회 (30m 해상도, 로컬 파일)
#[tauri::command]
async fn fetch_elevation(
    app_handle: tauri::AppHandle,
    latitudes: Vec<f64>,
    longitudes: Vec<f64>,
) -> Result<Vec<f64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if latitudes.len() != longitudes.len() {
            return Err("latitudes/longitudes 길이가 다릅니다".to_string());
        }
        if latitudes.is_empty() {
            return Ok(vec![]);
        }

        let state = app_handle.state::<AppState>();
        let mut reader = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        Ok(reader.get_elevations(&latitudes, &longitudes))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 한국 SRTM 타일 다운로드 (AWS Terrain Tiles, 인증 불필요)
#[tauri::command]
async fn get_srtm_status(
    app_handle: tauri::AppHandle,
) -> Result<Option<(i64, i64)>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        db::get_srtm_status(&conn).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
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
async fn query_buildings_along_path(
    app_handle: tauri::AppHandle,
    radar_lat: f64,
    radar_lon: f64,
    target_lat: f64,
    target_lon: f64,
    corridor_width_m: Option<f64>,
    // OM 보고서 전용: 그룹 활성화 상태와 무관하게 모든 수동 건물 포함 (기본 false).
    ignore_group_enabled: Option<bool>,
) -> Result<Vec<building::BuildingOnPath>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        let width = corridor_width_m.unwrap_or(100.0);
        building::query_buildings_along_path(&conn, &mut srtm, radar_lat, radar_lon, target_lat, target_lon, width, ignore_group_enabled.unwrap_or(false))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// BRA 호버 툴팁: 타겟 건물 제외 LoS 기준선 — 응답 수십 바이트라 bulk:// 비대상
#[tauri::command]
async fn query_los_baseline(
    app_handle: tauri::AppHandle,
    radar_lat: f64,
    radar_lon: f64,
    radar_h_amsl: f64,
    target_lat: f64,
    target_lon: f64,
) -> Result<building::LosBaselineResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        building::query_los_baseline(&conn, &mut srtm, radar_lat, radar_lon, radar_h_amsl, target_lat, target_lon)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// BRA(Building Restricted Area) 침범 검사 — 원추면(0.25° 기본)을 관통하는 건물 전수 조회.
/// 결과는 침범 건물 폴리곤을 포함해 수 MB 가능 → bulk:// 파일 매개 전송 (BulkRef 반환, bulk.rs 참조)
#[tauri::command]
async fn analyze_bra_penetration(
    app_handle: tauri::AppHandle,
    radar_lat: f64,
    radar_lon: f64,
    radar_height_m: f64,
    angle_deg: f64,
    max_range_km: f64,
) -> Result<bulk::BulkRef, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = {
            let state = app_handle.state::<AppState>();
            let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
            let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
            analysis::bra::analyze_penetration(
                &mut srtm, &conn,
                radar_lat, radar_lon, radar_height_m, angle_deg, max_range_km,
            )?
        };
        // lock 해제 후 기록 (panorama_merge_buildings 패턴)
        bulk::write_json(&app_handle, &result)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 건물 클릭 좌표 인근 FAC 건물 1건 상세 (로컬 DB, 오프라인 가능)
#[tauri::command]
async fn get_fac_building_detail(
    app_handle: tauri::AppHandle,
    lat: f64,
    lon: f64,
) -> Result<Option<building::FacBuildingDetail>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        // 지반고는 live SRTM(융합 보정 반영) — ground_elev 캐시 컬럼 미사용
        let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        building::query_fac_building_detail(&conn, &mut srtm, lat, lon, 40.0)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 주소검색 좌표 인근 건물 1건 (footprint 포함) — 주소검색→3D 자동 표출용.
/// 응답은 폴리곤 1건 수 KB 수준이라 일반 invoke 반환 OK(bulk:// 불필요).
#[tauri::command]
async fn find_building_near_point(
    app_handle: tauri::AppHandle,
    lat: f64,
    lon: f64,
    radius_m: Option<f64>,
) -> Result<Option<building::BuildingNearPoint>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        building::query_building_near_point(&conn, &mut srtm, lat, lon, radius_m.unwrap_or(80.0))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

// ---------- 건물통합정보 (F_FAC_BUILDING) ----------

#[tauri::command]
async fn import_fac_building_data(
    app_handle: tauri::AppHandle,
    zip_path: String,
    region: String,
) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
    let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
    let mut srtm = state.srtm.lock().unwrap();

    let handle = app_handle.clone();
    let region_clone = region.clone();

    let count = fac_building::import_from_zip(&conn, &mut srtm, &zip_path, &region, &|progress| {
        let _ = handle.emit("fac-building-import-progress", progress);
    })?;

    // 건물 높이 변경 → 파노라마·커버리지 캐시 전건 무효화 (캐시 키에 건물 세대 없음)
    let _ = db::clear_panorama_cache_all(&conn);
    analysis::coverage::invalidate_building_caches();
    // 전 창(메인/TrackMap/도면)에 건물 자료 세대 변경 통보 — 각 창이 건물 레이어를 다시 조회한다
    let _ = app_handle.emit("fac-buildings-changed", ());

    Ok(format!("{} 건물통합정보 {}건 임포트 완료", region_clone, count))
}


#[tauri::command]
async fn get_fac_building_import_status(
    app_handle: tauri::AppHandle,
) -> Result<Vec<fac_building::FacBuildingImportStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        fac_building::get_import_status(&conn)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

#[tauri::command]
async fn clear_fac_building_data(
    app_handle: tauri::AppHandle,
    region: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        fac_building::clear_data(&conn, region.as_deref())?;
        // 건물 높이 변경 → 파노라마·커버리지 캐시 전건 무효화 (캐시 키에 건물 세대 없음)
        let _ = db::clear_panorama_cache_all(&conn);
        analysis::coverage::invalidate_building_caches();
        let _ = app_handle.emit("fac-buildings-changed", ());
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

// ---------- 실측 3D 건물 (1m DSM) ----------

/// 실측 건물 박스(buildings_3d.bin) 임포트 —
/// 기존 fac_buildings 에 실측 지붕고(height_measured) 반영 + 미매칭 건물 신규 등록.
/// 진행률은 "measured-building-import-progress" 이벤트로 방출.
#[tauri::command]
async fn import_measured_buildings(
    app_handle: tauri::AppHandle,
    bin_path: String,
) -> Result<measured_building::MeasuredImportSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        let handle = app_handle.clone();
        let summary = measured_building::import_from_bin(&conn, &mut srtm, &bin_path, &|progress| {
            let _ = handle.emit("measured-building-import-progress", progress);
        })?;
        // 자동(SRTM) 모드 수동 건물 지반고 재동기화 — 저장 스냅샷이라 융합 보정을 스스로 따라가지 못한다.
        //   import_from_bin 내부에서 보정 확정 → clear_cache 가 끝난 뒤라 여기 조회값은 융합값.
        //   캐시 무효화보다 '먼저' 수행해야 뒤이은 재계산이 새 지반고를 읽는다.
        let manual_resynced = match building::resync_auto_manual_ground(&conn, &mut srtm) {
            Ok(n) => n,
            Err(e) => { log::warn!("[수동건물] 지반고 재동기화 실패: {}", e); 0 }
        };
        // 건물 높이 변경 → 파노라마·커버리지 캐시 전건 무효화 (캐시 키에 건물 세대 없음)
        let _ = db::clear_panorama_cache_all(&conn);
        analysis::coverage::invalidate_building_caches();
        let _ = app_handle.emit("fac-buildings-changed", ());
        // 수동 건물 지반고가 실제로 바뀐 경우에만 수동건물 이벤트 추가 발신 (수신측은 DB 재조회만)
        if manual_resynced > 0 {
            let _ = app_handle.emit("manual-buildings-changed", ());
        }
        Ok(summary)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 실측 데이터 초기화 (실측 지붕고 해제 + 실측 신규행 삭제)
#[tauri::command]
async fn clear_measured_buildings(app_handle: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        measured_building::clear_measured(&conn)?;
        // 지반고 융합 보정이 사라졌으므로 SRTM 인메모리 캐시도 무효화 — 다음 로드부터 순수 SRTM 복귀
        let manual_resynced = {
            let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
            srtm.clear_cache();
            // 자동(SRTM) 모드 수동 건물 지반고도 순수 SRTM 값으로 복귀 (캐시 클리어 이후 조회)
            match building::resync_auto_manual_ground(&conn, &mut srtm) {
                Ok(n) => n,
                Err(e) => { log::warn!("[수동건물] 지반고 재동기화 실패: {}", e); 0 }
            }
        };
        // 건물 높이 변경 → 파노라마·커버리지 캐시 전건 무효화 (캐시 키에 건물 세대 없음)
        let _ = db::clear_panorama_cache_all(&conn);
        analysis::coverage::invalidate_building_caches();
        let _ = app_handle.emit("fac-buildings-changed", ());
        // 수동 건물 지반고가 실제로 바뀐 경우에만 수동건물 이벤트 추가 발신 (수신측은 DB 재조회만)
        if manual_resynced > 0 {
            let _ = app_handle.emit("manual-buildings-changed", ());
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 실측(1m DSM) 커버리지 bbox 조회 — `[min_lat, max_lat, min_lon, max_lon]`, 실측 데이터 없으면 None.
/// TrackMap 이 메시 표출 중 이 영역 안의 fill-extrusion 박스를 전부 숨기는 데 사용한다.
/// 응답이 32바이트라 bulk:// 파일 매개 대상 아님(수 MB+ 응답만 해당).
#[tauri::command]
async fn get_measured_coverage_bbox(app_handle: tauri::AppHandle) -> Result<Option<[f64; 4]>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        measured_building::coverage_bbox(&conn)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// Cesium 3D Tiles 루트 디렉터리 설정 (None = 해제). tileset.json 존재를 검증한다.
#[tauri::command]
async fn set_tiles3d_dir(
    app_handle: tauri::AppHandle,
    dir: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();

        let resolved: Option<PathBuf> = match dir.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
            Some(d) => {
                let p = PathBuf::from(d);
                if !p.is_dir() {
                    return Err(format!("3D 타일 폴더를 찾을 수 없습니다: {}", d));
                }
                if !p.join("tileset.json").is_file() {
                    return Err("선택한 폴더에 tileset.json 이 없습니다".to_string());
                }
                Some(p)
            }
            None => None,
        };

        // 영속화: 해제는 빈 문자열로 저장
        let value = resolved
            .as_ref()
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_default();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        db::set_setting(&conn, "tiles3d_dir", &value)
            .map_err(|e| format!("3D 타일 폴더 저장 실패: {}", e))?;

        let mut guard = state
            .tiles3d_dir
            .lock()
            .map_err(|e| format!("tiles3d_dir lock: {}", e))?;
        *guard = resolved;
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 현재 설정된 3D Tiles 루트 디렉터리 (미설정이면 None)
#[tauri::command]
async fn get_tiles3d_dir(app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let guard = state
            .tiles3d_dir
            .lock()
            .map_err(|e| format!("tiles3d_dir lock: {}", e))?;
        Ok(guard.as_ref().map(|p| p.to_string_lossy().to_string()))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

// ---------- 토지이용계획정보 ----------





// ---------- 산봉우리 지명 데이터 ----------

#[tauri::command]
async fn import_peak_data(
    app_handle: tauri::AppHandle,
    zip_path: String,
) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
    let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
    let handle = app_handle.clone();
    let count = peak::import_from_zip(&conn, &zip_path, &|progress| {
        let _ = handle.emit("peak-import-progress", progress);
    })?;
    Ok(format!("산 정보 {}건 임포트 완료", count))
}

#[tauri::command]
async fn query_nearby_peaks(
    app_handle: tauri::AppHandle,
    lat: f64,
    lon: f64,
    radius_km: f64,
) -> Result<Vec<peak::NearbyPeak>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        peak::query_nearby_peaks(&conn, lat, lon, radius_km)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

#[tauri::command]
async fn get_peak_import_status(
    app_handle: tauri::AppHandle,
) -> Result<Option<peak::PeakImportStatus>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        peak::get_import_status(&conn)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}


// ---------- 영역 내 건물 조회 (커버리지 맵용) ----------


// ---------- 3D 건물 조회 ----------


#[tauri::command]
async fn query_buildings_3d_binary(
    app_handle: tauri::AppHandle,
    min_lat: f64,
    max_lat: f64,
    min_lon: f64,
    max_lon: f64,
    min_height_m: Option<f64>,
    max_count: Option<usize>,
    exclude_sources: Option<Vec<String>>,
) -> Result<building::Buildings3DBinary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        // FAC 건물 지반고는 live SRTM(융합 보정 반영) — ground_elev 캐시 컬럼 미사용
        let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        building::query_buildings_3d_binary(
            &conn,
            &mut srtm,
            min_lat, max_lat, min_lon, max_lon,
            min_height_m.unwrap_or(3.0),
            max_count.unwrap_or(15_000),
            &exclude_sources.unwrap_or_default(),
        )
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

// ---------- 건물 그룹 ----------

#[tauri::command]
async fn list_building_groups(
    app_handle: tauri::AppHandle,
) -> Result<Vec<building::BuildingGroup>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        building::list_building_groups(&conn)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

#[tauri::command]
async fn add_building_group(
    app_handle: tauri::AppHandle,
    name: String,
    color: String,
    memo: String,
    area_bounds_json: Option<String>,
) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        building::add_building_group(&conn, &name, &color, &memo, area_bounds_json.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

#[tauri::command]
async fn update_building_group(
    app_handle: tauri::AppHandle,
    id: i64,
    name: String,
    color: String,
    memo: String,
    plan_opacity: Option<f64>,
    plan_rotation: Option<f64>,
    area_bounds_json: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        building::update_building_group(&conn, id, &name, &color, &memo, plan_opacity, plan_rotation, area_bounds_json.as_deref())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

#[tauri::command]
async fn delete_building_group(
    app_handle: tauri::AppHandle,
    id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        building::delete_building_group(&conn, id)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

#[tauri::command]
async fn set_building_group_enabled(
    app_handle: tauri::AppHandle,
    id: i64,
    enabled: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        building::set_building_group_enabled(&conn, id, enabled)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

// ---------- 수동 등록 건물 ----------

#[tauri::command]
async fn list_manual_buildings(
    app_handle: tauri::AppHandle,
) -> Result<Vec<building::ManualBuilding>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        building::list_manual_buildings(&conn)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

#[tauri::command]
async fn add_manual_building(
    app_handle: tauri::AppHandle,
    name: String,
    latitude: f64,
    longitude: f64,
    height: f64,
    ground_elev: f64,
    elev_mode: String,
    memo: String,
    geometry_type: Option<String>,
    geometry_json: Option<String>,
    group_id: Option<i64>,
) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        let gt = geometry_type.as_deref().unwrap_or("polygon");
        let gj = geometry_json.as_deref();
        let id = building::add_manual_building(&conn, &name, latitude, longitude, height, ground_elev, &elev_mode, &memo, gt, gj, group_id)?;
        // 건물 세대 변경(수동 등록 + 중복억제 재계산) → 파노라마·커버리지 캐시 무효화 (캐시 키에 건물 세대 없음)
        let _ = db::clear_panorama_cache_all(&conn);
        analysis::coverage::invalidate_building_caches();
        Ok(id)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

#[tauri::command]
async fn update_manual_building(
    app_handle: tauri::AppHandle,
    id: i64,
    name: String,
    latitude: f64,
    longitude: f64,
    height: f64,
    ground_elev: f64,
    elev_mode: String,
    memo: String,
    geometry_type: Option<String>,
    geometry_json: Option<String>,
    group_id: Option<i64>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        let gt = geometry_type.as_deref().unwrap_or("polygon");
        let gj = geometry_json.as_deref();
        building::update_manual_building(&conn, id, &name, latitude, longitude, height, ground_elev, &elev_mode, &memo, gt, gj, group_id)?;
        // 건물 세대 변경(수동 수정 + 중복억제 재계산) → 파노라마·커버리지 캐시 무효화
        let _ = db::clear_panorama_cache_all(&conn);
        analysis::coverage::invalidate_building_caches();
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

#[tauri::command]
async fn delete_manual_building(
    app_handle: tauri::AppHandle,
    id: i64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        building::delete_manual_building(&conn, id)?;
        // 건물 세대 변경(수동 삭제 + 억제 해제/재계산) → 파노라마·커버리지 캐시 무효화
        let _ = db::clear_panorama_cache_all(&conn);
        analysis::coverage::invalidate_building_caches();
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

// ========== 커버리지 캐시 ==========

#[tauri::command]
async fn save_coverage_cache(
    app_handle: tauri::AppHandle,
    radar_name: String,
    radar_lat: f64,
    radar_lon: f64,
    radar_height: f64,
    max_elev_deg: f64,
    layers_json: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        db::save_coverage_cache(&conn, &radar_name, radar_lat, radar_lon, radar_height, max_elev_deg, &layers_json)
            .map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 커버리지 캐시 로드 — 레이어 JSON 은 수십 MB 급 문자열이므로 bulk:// 전송
/// (String 응답은 IPC 폴백과 무관하게 항상 eval(CDP) 경로를 타 브라우저 프로세스를 압박)
#[tauri::command]
async fn load_coverage_cache(
    app_handle: tauri::AppHandle,
    radar_name: String,
) -> Result<Option<bulk::BulkRef>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let cached = {
            let state = app_handle.state::<AppState>();
            let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
            db::load_coverage_cache(&conn, &radar_name).map_err(|e| format!("DB error: {}", e))?
        };
        match cached {
            Some(json) => Ok(Some(bulk::write_bytes(&app_handle, json.as_bytes(), "json")?)),
            None => Ok(None),
        }
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

#[tauri::command]
async fn has_coverage_cache(
    app_handle: tauri::AppHandle,
    radar_name: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        db::has_coverage_cache(&conn, &radar_name).map_err(|e| format!("DB error: {}", e))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
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
        let guard = state.db.lock().ok().and_then(|pool| pool.get().ok());
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
            let _ = state.db.lock().ok().and_then(|pool| pool.get().ok()).map(|conn| {
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
    let guard = state.db.lock().ok().and_then(|pool| pool.get().ok());
    match guard {
        Some(conn) => declination::get_declination_sync(&conn, radar_lat, radar_lon, &date),
        None => -8.5,
    }
}

/// 분석 취소
#[tauri::command]
fn cancel_analysis(state: tauri::State<'_, AppState>) {
    state.analysis_cancel.store(true, Ordering::Relaxed);
}

/// 장애물 월간 분석 IPC 커맨드
/// 결과(일별 az×elev 히스토그램·track_points_geo·loss_points_summary)는 수백 MB 급 —
/// invoke 응답에 실으면 IPC eval 폴백 시 브라우저 프로세스 OOM(전 창 백지)이므로 bulk:// 전송
#[tauri::command]
async fn analyze_obstacle_monthly(
    app_handle: tauri::AppHandle,
    radar_file_sets: Vec<analysis::obstacle_monthly::RadarFileSet>,
    exclude_mode_s: Vec<String>,
) -> Result<Vec<bulk::BulkRef>, String> {
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

    // 취소 토큰 초기화
    let cancel = {
        let state = app_handle.state::<AppState>();
        state.analysis_cancel.store(false, Ordering::Relaxed);
        Arc::clone(&state.analysis_cancel)
    };

    let handle = app_handle.clone();
    // 레이더별로 개별 bulk 파일을 기록하고 참조 목록(매니페스트)만 반환한다.
    // 결합 결과 JSON 을 하나로 전송하면 다중 레이더 시 V8 문자열 한계(~512MB)를 넘겨
    // 프론트 res.json() 이 truncation("Unexpected end of JSON input")된다 (커밋 1fd88a4 참조).
    // 레이더 단위로 나누면 각 파일이 한계 미만이라 프론트가 순차 파싱·병합할 수 있다.
    // 직렬화(수백 MB)도 blocking 스레드에서 수행.
    let bulk_refs = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<bulk::BulkRef>, String> {
        let mut refs: Vec<bulk::BulkRef> = Vec::new();

        for radar in &radar_file_sets {
            // 취소 체크
            if cancel.load(Ordering::Relaxed) {
                return Err("분석이 취소되었습니다".to_string());
            }

            let h = handle.clone();
            let progress_fn = move |p: ObstacleMonthlyProgress| {
                let _ = h.emit("obstacle-monthly-progress", p);
            };

            match om::analyze_radar_monthly(radar, &exclude_mode_s, mag_dec, &cancel, &progress_fn) {
                Ok(mut result) => {
                    // ── 기준월(참조 달) 재집계 + 캐시 통합 ──
                    // registry 에 이 레이더의 보관 ASS 가 있으면, 분석월과 완전히 동일한 쐐기
                    // 파이프라인(현재 sector·최소거리·좌표/안테나고·검사기 제외)으로 기준월 ASS 를
                    // 재집계해 result.reference 에 싣는다(같은 월 → Δ=0 불변식). 설정 해시로 디스크 캐시.
                    // 실패(파일 소실·파싱 에러)는 warn + noref — 보고서 생성을 막지 않는다.
                    match compute_radar_reference(&handle, radar, &exclude_mode_s, mag_dec, &cancel, &progress_fn) {
                        Ok(opt) => { result.reference = opt; }
                        Err(e) if e.contains("취소") => { return Err(e); }
                        Err(e) => {
                            log::warn!("[OmReference] 레이더 '{}' 기준월 재집계 실패 — 기준 미적용(noref): {}", radar.radar_name, e);
                        }
                    }
                    // 레이더 1개 결과를 개별 bulk 파일로 즉시 기록 → 메모리도 즉시 해제
                    let r = bulk::write_json(&handle, &result)?;
                    info!(
                        "[ObstacleMonthly] 레이더 '{}' 결과 bulk: {} ({:.1}MB)",
                        result.radar_name,
                        r.bulk_id,
                        r.bytes as f64 / 1024.0 / 1024.0
                    );
                    refs.push(r);
                }
                Err(e) if e.contains("취소") => {
                    return Err(e);
                }
                Err(e) => {
                    info!("[ObstacleMonthly] 레이더 '{}' 분석 실패: {}", radar.radar_name, e);
                    let h2 = handle.clone();
                    let radar_name = radar.radar_name.clone();
                    let err_msg = format!("레이더 '{}' 분석 실패: {}", radar_name, e);
                    let _ = h2.emit("obstacle-monthly-progress", ObstacleMonthlyProgress {
                        radar_name,
                        stage: "error".to_string(),
                        message: err_msg,
                        current: 0,
                        total: 0,
                    });
                }
            }
        }

        Ok(refs)
    })
    .await
    .map_err(|e| format!("분석 스레드 오류: {}", e))??;

    info!(
        "[ObstacleMonthly] 완료: {} 레이더, 총 {:.1}MB",
        bulk_refs.len(),
        bulk_refs.iter().map(|r| r.bytes).sum::<u64>() as f64 / 1024.0 / 1024.0
    );
    Ok(bulk_refs)
}

// ════════════════════════════════════════════════════════════════════════════
// OM 기준데이터(참조 달) — 등록(원본 ASS 사본 보관) + 보고서 생성 시 재집계·캐시
// ════════════════════════════════════════════════════════════════════════════
//
// 재설계: 등록(register_om_reference)은 원본 ASS 를 om_reference/ass/<dir>/ 에 복사하고
// 메타만 registry(settings)에 남긴다. 히스토그램은 보고서 생성 시(analyze_obstacle_monthly →
// compute_radar_reference)에 분석월과 동일 쐐기 파이프라인으로 재집계하고 om_reference/cache/<dir>/
// <hash>.json 에 디스크 캐시한다. 이 디렉토리들은 bulk_ipc 의 10분 sweep 대상이 아니다(영구
// 보관) — bulk.rs 와 동일한 app_data_dir 루트를 사용하되 별도 하위 디렉토리.

/// om_reference 영구 디렉토리 (app_data/om_reference) — bulk sweep 비대상
fn om_reference_dir(state: &AppState) -> Result<PathBuf, String> {
    let base = state
        .app_data_dir
        .lock()
        .map_err(|e| format!("app_data_dir lock: {}", e))?
        .clone();
    let d = base.join("om_reference");
    if !d.exists() {
        fs::create_dir_all(&d).map_err(|e| format!("om_reference 디렉토리 생성 실패: {}", e))?;
    }
    Ok(d)
}

/// 레지스트리: radar_name → {메타 + 원본 ASS 보관 디렉토리}. settings 키 om_reference_registry 에 JSON 저장.
type OmReferenceRegistry =
    std::collections::HashMap<String, analysis::obstacle_monthly::OmReferenceRegistryEntry>;

/// 레지스트리 로드 (없으면 빈 맵, 파싱 실패해도 빈 맵으로 복구 — 기능 브릭 방지).
/// 구버전 마이그레이션(1회 lazy cleanup): 구버전 엔트리의 집계 JSON 파일(file_path)·원시 포인트
/// 아카이브(points_dir)를 발견하면 삭제하고 필드를 비워 저장한다. ass_dir 은 그대로 유지 —
/// 구버전이 원본 ASS 를 보관했다면 새 시스템(재집계)에서 그대로 사용 가능하다.
fn load_om_registry(state: &AppState) -> Result<OmReferenceRegistry, String> {
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("db lock: {}", e))?
        .get()
        .map_err(|e| format!("DB pool: {}", e))?;
    let raw = db::get_setting(&conn, "om_reference_registry").map_err(|e| format!("DB error: {}", e))?;
    let mut registry: OmReferenceRegistry = match raw {
        Some(s) => serde_json::from_str(&s).unwrap_or_else(|e| {
            log::warn!("[OmReference] 레지스트리 파싱 실패(빈 맵으로 복구): {}", e);
            OmReferenceRegistry::new()
        }),
        None => OmReferenceRegistry::new(),
    };
    // conn 을 먼저 반납해야 save 경로가 다시 lock 할 수 있음
    drop(conn);

    // ── 구버전 잔재 lazy cleanup (1회) ──
    let mut dirty = false;
    for entry in registry.values_mut() {
        if !entry.file_path.is_empty() {
            let _ = fs::remove_file(&entry.file_path);
            entry.file_path.clear();
            dirty = true;
        }
        if !entry.points_dir.is_empty() {
            let _ = fs::remove_dir_all(&entry.points_dir);
            entry.points_dir.clear();
            dirty = true;
        }
    }
    if dirty {
        log::info!("[OmReference] 구버전 잔재 정리(집계 JSON·포인트 아카이브 삭제) 후 레지스트리 갱신");
        let _ = save_om_registry(state, &registry);
    }
    Ok(registry)
}

/// 레지스트리 저장
fn save_om_registry(state: &AppState, reg: &OmReferenceRegistry) -> Result<(), String> {
    let json = serde_json::to_string(reg).map_err(|e| format!("레지스트리 직렬화 실패: {}", e))?;
    let conn = state
        .db
        .lock()
        .map_err(|e| format!("db lock: {}", e))?
        .get()
        .map_err(|e| format!("DB pool: {}", e))?;
    db::set_setting(&conn, "om_reference_registry", &json).map_err(|e| format!("DB error: {}", e))
}

/// 기준데이터 등록 — 파싱·집계 없이 원본 ASS 사본만 om_reference/ass/<dir>/ 에 보관 + 메타/레지스트리 upsert.
/// 심각성 판정용 히스토그램은 보고서 생성 시(analyze_obstacle_monthly)에 현재 설정으로 재집계하므로
/// 여기선 좌표·안테나고 정합성 게이트가 불필요하다. 진행 이벤트 stage "copy". 대용량 IPC 없음.
/// 복사 실패/취소 = 등록 실패(반쯤 복사된 dest 제거). 재등록 시 해당 레이더 캐시 디렉토리 삭제.
#[tauri::command]
async fn register_om_reference(
    app_handle: tauri::AppHandle,
    radar_file_sets: Vec<analysis::obstacle_monthly::RadarFileSet>,
    month_label: String,
) -> Result<Vec<analysis::obstacle_monthly::OmReferenceMeta>, String> {
    use analysis::obstacle_monthly::{self as om, ObstacleMonthlyProgress};

    info!(
        "Command: register_om_reference({} radars, month={})",
        radar_file_sets.len(),
        month_label
    );

    // 취소 토큰 초기화 (analyze/register 공유 플래그 — cancel_analysis 로 중단 가능)
    let cancel = {
        let state = app_handle.state::<AppState>();
        state.analysis_cancel.store(false, Ordering::Relaxed);
        Arc::clone(&state.analysis_cancel)
    };

    let handle = app_handle.clone();
    let metas = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<om::OmReferenceMeta>, String> {
        let state = handle.state::<AppState>();
        let ref_dir = om_reference_dir(&state)?;
        let mut registry = load_om_registry(&state)?;
        let mut metas: Vec<om::OmReferenceMeta> = Vec::new();

        for radar in &radar_file_sets {
            if cancel.load(Ordering::Relaxed) {
                return Err("분석이 취소되었습니다".to_string());
            }

            let dirname = om::reference_dirname(&radar.radar_name);
            let ass_dest = ref_dir.join("ass").join(&dirname);
            let cache_dir = ref_dir.join("cache").join(&dirname);

            let h = handle.clone();
            let progress_fn = move |p: ObstacleMonthlyProgress| {
                let _ = h.emit("om-reference-progress", p);
            };

            // first/last date — 파일명 날짜 추출(Rust extract_date_from_filename, omFiles.ts 미러). 추출 실패 파일 무시.
            let mut dates: Vec<String> = radar
                .file_paths
                .iter()
                .filter_map(|p| parser::ass::extract_date_from_filename(p))
                .collect();
            dates.sort();
            let first_date = dates.first().cloned().unwrap_or_default();
            let last_date = dates.last().cloned().unwrap_or_default();

            // ── 원본 ASS 복사 (build 의 복사 루프 재사용 — 충돌명·진행 이벤트·취소 처리) ──
            if ass_dest.exists() {
                let _ = fs::remove_dir_all(&ass_dest);
            }
            fs::create_dir_all(&ass_dest)
                .map_err(|e| format!("레이더 '{}' 보관 디렉토리 생성 실패: {}", radar.radar_name, e))?;

            let n = radar.file_paths.len();
            let mut copied_bytes: u64 = 0;
            let mut used_names: std::collections::HashSet<String> = std::collections::HashSet::new();
            for (i, src) in radar.file_paths.iter().enumerate() {
                // 취소: 반쯤 복사된 dest 제거 후 등록 실패 반환
                if cancel.load(Ordering::Relaxed) {
                    let _ = fs::remove_dir_all(&ass_dest);
                    return Err("분석이 취소되었습니다".to_string());
                }
                let basename = std::path::Path::new(src)
                    .file_name()
                    .map(|nm| nm.to_string_lossy().to_string())
                    .unwrap_or_else(|| format!("file_{:03}", i));
                // basename 충돌 시 3자리 인덱스 접두 (날짜 추출은 '_' split 후 len==6 토큰 탐색 → 접두 무해)
                let name = if used_names.contains(&basename) {
                    format!("{:03}_{}", i, basename)
                } else {
                    basename
                };
                let dst = ass_dest.join(&name);
                progress_fn(ObstacleMonthlyProgress {
                    radar_name: radar.radar_name.clone(),
                    stage: "copy".to_string(),
                    message: format!("원본 ASS 보관 중 ({}/{})", i + 1, n),
                    current: i + 1,
                    total: n,
                });
                match fs::copy(src, &dst) {
                    Ok(nbytes) => {
                        copied_bytes += nbytes;
                        used_names.insert(name);
                    }
                    Err(e) => {
                        // 복사 IO 실패 = 등록 실패(반쯤 복사된 dest 제거).
                        let _ = fs::remove_dir_all(&ass_dest);
                        return Err(format!("레이더 '{}' 원본 ASS 보관 실패: {}", radar.radar_name, e));
                    }
                }
            }

            // 재등록: 이전 캐시 무효화 (보관 ASS 가 교체되었으므로) + 경로 규칙이 바뀐 구버전 잔재 정리
            let _ = fs::remove_dir_all(&cache_dir);
            if let Some(prev) = registry.get(&radar.radar_name) {
                if !prev.file_path.is_empty() {
                    let _ = fs::remove_file(&prev.file_path);
                }
                if !prev.points_dir.is_empty() {
                    let _ = fs::remove_dir_all(&prev.points_dir);
                }
                if !prev.ass_dir.is_empty() && prev.ass_dir != ass_dest.to_string_lossy() {
                    let _ = fs::remove_dir_all(&prev.ass_dir);
                }
            }

            let meta = om::OmReferenceMeta {
                radar_name: radar.radar_name.clone(),
                month_label: month_label.clone(),
                file_count: n as u32,
                first_date,
                last_date,
                created_at: om::now_iso8601(),
                radar_lat: radar.radar_lat,
                radar_lon: radar.radar_lon,
                radar_altitude: radar.radar_altitude,
                antenna_height: radar.antenna_height,
                ass_bytes: copied_bytes,
            };
            registry.insert(
                radar.radar_name.clone(),
                om::OmReferenceRegistryEntry {
                    meta: meta.clone(),
                    ass_dir: ass_dest.to_string_lossy().to_string(),
                    file_path: String::new(),
                    points_dir: String::new(),
                },
            );
            // 부분 진행 영속화 — 레이더 1개 끝날 때마다 레지스트리 저장
            save_om_registry(&state, &registry)?;
            info!(
                "[OmReference] 레이더 '{}' 등록: 원본 ASS {} files / {:.1}MB",
                radar.radar_name,
                n,
                copied_bytes as f64 / 1024.0 / 1024.0
            );
            metas.push(meta);
        }
        Ok(metas)
    })
    .await
    .map_err(|e| format!("등록 스레드 오류: {}", e))??;

    info!("[OmReference] 등록 완료: {} 레이더", metas.len());
    Ok(metas)
}

/// 저장된 기준데이터 메타 목록 (소형 JSON — 직접 반환). ass_bytes=0 = 원본 미보관(재등록 필요).
#[tauri::command]
async fn list_om_references(
    app_handle: tauri::AppHandle,
) -> Result<Vec<analysis::obstacle_monthly::OmReferenceMeta>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let registry = load_om_registry(&state)?;
        let mut metas: Vec<_> = registry.into_values().map(|e| e.meta).collect();
        metas.sort_by(|a, b| a.radar_name.cmp(&b.radar_name));
        Ok(metas)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 기준데이터 삭제 (원본 ASS 보관본 + 캐시 디렉토리 + 레지스트리 엔트리 + 구버전 잔재)
#[tauri::command]
async fn delete_om_reference(radar_name: String, app_handle: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let ref_dir = om_reference_dir(&state)?;
        let dirname = analysis::obstacle_monthly::reference_dirname(&radar_name);
        let mut registry = load_om_registry(&state)?;
        if let Some(entry) = registry.remove(&radar_name) {
            if !entry.ass_dir.is_empty() {
                let _ = fs::remove_dir_all(&entry.ass_dir);
            }
            // 구버전 잔재 (있으면 — load 시점 cleanup 을 못 탄 경로 방어)
            if !entry.file_path.is_empty() {
                let _ = fs::remove_file(&entry.file_path);
            }
            if !entry.points_dir.is_empty() {
                let _ = fs::remove_dir_all(&entry.points_dir);
            }
            // 재집계 캐시 디렉토리
            let _ = fs::remove_dir_all(ref_dir.join("cache").join(&dirname));
            save_om_registry(&state, &registry)?;
            info!("[OmReference] 레이더 '{}' 기준데이터 삭제 (원본 ASS + 캐시)", radar_name);
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 같은 월 패리티 자가진단 기록 — 기준월==분석월 테스트에서 프론트(ReportApp)가 분석월(daily_stats)·
/// 기준월(reference.daily) 양쪽 데이터 요약을 om_reference/debug/parity_<sanitized>.json 으로 남긴다.
/// 파일명은 reference_dirname(=sanitized_stem) 재사용해 안전화. 단순 fs::write — json 은 수백 KB 수준
/// 요약만(대용량 응답 아님·요청 방향이라 CLAUDE.md 위배 아님). 실패는 Err(호출측 fire-and-forget).
#[tauri::command]
fn write_om_parity_debug(
    radar_name: String,
    json: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let debug_dir = om_reference_dir(&state)?.join("debug");
    fs::create_dir_all(&debug_dir).map_err(|e| format!("parity debug 디렉토리 생성 실패: {}", e))?;
    let dirname = analysis::obstacle_monthly::reference_dirname(&radar_name);
    let path = debug_dir.join(format!("parity_{}.json", dirname));
    fs::write(&path, json.as_bytes()).map_err(|e| format!("parity debug 저장 실패: {}", e))?;
    info!("[OmParity] 패리티 자가진단 기록: {}", path.display());
    Ok(())
}

/// 캐시 디렉토리에서 mtime 기준 최신 `keep` 개만 남기고 삭제 (LRU 근사).
fn prune_cache_dir(cache_dir: &std::path::Path, keep: usize) {
    let Ok(rd) = fs::read_dir(cache_dir) else { return; };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = rd
        .flatten()
        .filter(|e| e.path().is_file())
        .filter_map(|e| {
            let t = e.metadata().ok().and_then(|m| m.modified().ok())?;
            Some((t, e.path()))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0)); // 최신 우선
    for (_, p) in files.into_iter().skip(keep) {
        let _ = fs::remove_file(p);
    }
}

/// 레이더 1개의 기준월 재집계 결과를 반환 — registry 에 보관 ASS 가 있으면 분석월과 동일 쐐기
/// 파이프라인으로 재집계(설정 해시 캐시). 미등록/미보관/캐시손상은 Ok(None)(noref), 취소만 Err.
/// analyze_obstacle_monthly 의 레이더 루프에서 분석월 분석 직후 호출된다.
fn compute_radar_reference(
    handle: &tauri::AppHandle,
    radar: &analysis::obstacle_monthly::RadarFileSet,
    exclude_mode_s: &[String],
    mag_dec: f64,
    cancel: &std::sync::atomic::AtomicBool,
    progress_fn: &dyn Fn(analysis::obstacle_monthly::ObstacleMonthlyProgress),
) -> Result<Option<analysis::obstacle_monthly::OmRefWedge>, String> {
    use analysis::obstacle_monthly::{self as om, ObstacleMonthlyProgress};

    let state = handle.state::<AppState>();
    let ref_dir = om_reference_dir(&state)?;
    let registry = load_om_registry(&state)?;
    let Some(entry) = registry.get(&radar.radar_name) else {
        return Ok(None); // 미등록 → noref
    };
    if entry.ass_dir.is_empty() || !std::path::Path::new(&entry.ass_dir).is_dir() {
        return Ok(None); // 원본 미보관 → noref (재등록 필요)
    }
    let month_label = entry.meta.month_label.clone();
    let ass_dir = entry.ass_dir.clone();
    let dirname = om::reference_dirname(&radar.radar_name);
    let cache_dir = ref_dir.join("cache").join(&dirname);

    // 보관 ASS 목록(정렬) + (이름, 바이트) — 캐시 키·파싱 입력
    let mut files: Vec<String> = Vec::new();
    let mut files_meta: Vec<(String, u64)> = Vec::new();
    let rd = std::fs::read_dir(&ass_dir).map_err(|e| format!("보관 디렉토리 읽기 실패: {}", e))?;
    for de in rd.flatten() {
        let p = de.path();
        if p.is_file()
            && p.extension()
                .and_then(|x| x.to_str())
                .map(|x| x.eq_ignore_ascii_case("ass"))
                .unwrap_or(false)
        {
            let name = p.file_name().map(|nm| nm.to_string_lossy().to_string()).unwrap_or_default();
            let bytes = de.metadata().map(|m| m.len()).unwrap_or(0);
            files.push(p.to_string_lossy().to_string());
            files_meta.push((name, bytes));
        }
    }
    if files.is_empty() {
        return Ok(None); // 보관 디렉토리에 ASS 없음 → noref
    }
    files.sort();

    let key = om::reference_cache_key(&month_label, &files_meta, radar, exclude_mode_s);
    let cache_path = cache_dir.join(format!("{}.json", key));

    // ── 캐시 히트 ──
    if cache_path.is_file() {
        if let Some(w) = fs::read(&cache_path)
            .ok()
            .and_then(|b| serde_json::from_slice::<om::OmRefWedge>(&b).ok())
        {
            // 프론트 진행바가 ref 구간을 건너뛰도록 1회 emit
            progress_fn(ObstacleMonthlyProgress {
                radar_name: radar.radar_name.clone(),
                stage: "ref".to_string(),
                message: "기준월 캐시 적용".to_string(),
                current: 1,
                total: 1,
            });
            info!("[OmReference] 레이더 '{}' 기준월 캐시 히트 ({})", radar.radar_name, key);
            return Ok(Some(w));
        }
        // 캐시 손상 → 미스로 처리(재집계)
    }

    // ── 캐시 미스 → 재집계 ──
    let wedge = om::compute_reference_wedge(radar, exclude_mode_s, &files, &month_label, mag_dec, cancel, progress_fn)?;

    // 캐시 저장 + prune (실패는 warn — 결과엔 영향 없음)
    match fs::create_dir_all(&cache_dir) {
        Ok(_) => match fs::File::create(&cache_path) {
            Ok(f) => {
                let mut w = std::io::BufWriter::new(f);
                if let Err(e) = serde_json::to_writer(&mut w, &wedge) {
                    log::warn!("[OmReference] 캐시 직렬화 실패(무시): {}", e);
                } else {
                    use std::io::Write;
                    let _ = w.flush();
                    prune_cache_dir(&cache_dir, 4);
                }
            }
            Err(e) => log::warn!("[OmReference] 캐시 파일 생성 실패(무시): {}", e),
        },
        Err(e) => log::warn!("[OmReference] 캐시 디렉토리 생성 실패(무시): {}", e),
    }

    Ok(Some(wedge))
}

/// 건물 제외 커버리지 프로파일 계산 (장애물 월간 보고서용)
#[tauri::command]
async fn compute_coverage_terrain_profile_excluding(
    app_handle: tauri::AppHandle,
    radar_name: String,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
    exclude_manual_ids: Vec<i64>,
    bearing_step_deg: Option<f64>,
) -> Result<analysis::coverage::ProfileMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        Ok(analysis::coverage::compute_terrain_profile_excluding(
            &mut srtm, &conn,
            &radar_name, radar_lat, radar_lon, radar_altitude, antenna_height, range_nm,
            &exclude_manual_ids,
            bearing_step_deg.unwrap_or(0.1),
        ))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 건물 제외 캐시에서 레이어 배치 계산
/// 레이어(고도 9 × bearing 수만 개)는 수십 MB — bulk:// 파일 매개 전송
#[tauri::command]
async fn compute_coverage_layers_batch_excluded(
    app_handle: tauri::AppHandle,
    alt_fts: Vec<f64>,
    bearing_step: Option<usize>,
) -> Result<bulk::BulkRef, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let step = bearing_step.unwrap_or(1);
        let layers = analysis::coverage::compute_layers_batch_excluded(&alt_fts, step);
        bulk::write_json(&app_handle, &layers)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// GPU용 커버리지 프리샘플 (SRTM + 건물 → base64)

/// build_heightmap 응답 메타 — 그리드 본체(f32 LE raw)는 bulk:// 파일 매개 전송
#[derive(serde::Serialize)]
struct HeightmapBulkResult {
    bulk_id: String,
    bytes: u64,
    width: u32,
    height: u32,
    pixel_size_m: f32,
    center_lat: f64,
    center_lon: f64,
    radar_height_m: f64,
    max_range_km: f64,
}

/// GPU용 2D heightmap 빌드 (SRTM + 건물 → f32 raw 그리드, bulk:// 전송)
/// 그리드는 ~16MB+ — base64 invoke 응답 대신 파일 매개로 전달 (bulk.rs 참조)
#[tauri::command]
async fn build_heightmap(
    app_handle: tauri::AppHandle,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
    pixel_size_m: Option<f64>,
    exclude_manual_ids: Option<Vec<i64>>,
    skip_buildings: Option<bool>,
) -> Result<HeightmapBulkResult, String> {
    let pix = pixel_size_m.unwrap_or(100.0);
    let skip_bldg = skip_buildings.unwrap_or(false);

    let handle = app_handle.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit = |msg: String| { let _ = handle.emit("panorama-debug", msg); };
        let state = handle.state::<AppState>();

        let t0 = std::time::Instant::now();
        emit("build_heightmap: SRTM lock 시도".into());
        let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        emit(format!("build_heightmap: SRTM lock 획득 ({}ms 대기)", t0.elapsed().as_millis()));

        let t1 = std::time::Instant::now();
        emit("build_heightmap: DB pool 시도".into());
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        emit(format!("build_heightmap: DB pool 획득 ({}ms)", t1.elapsed().as_millis()));

        let t2 = std::time::Instant::now();
        emit("build_heightmap: 내부 계산 시작".into());
        let handle2 = handle.clone();
        let progress_cb = move |msg: String| {
            let _ = handle2.emit("panorama-debug", msg);
        };
        let result = analysis::heightmap::build_heightmap_with_progress(
            &mut srtm,
            &conn,
            radar_lat, radar_lon, radar_altitude, antenna_height, range_nm,
            pix,
            exclude_manual_ids.as_deref(),
            skip_bldg,
            Some(&progress_cb),
        );
        drop(srtm);
        drop(conn);
        emit(format!("build_heightmap: 내부 계산 완료 ({}ms, {}×{}, f32 {:.1}MB)",
            t2.elapsed().as_millis(), result.width, result.height,
            (result.data.len() * 4) as f64 / 1024.0 / 1024.0));

        // f32 LE raw → bulk 파일 (base64 인코딩/디코딩 완전 제거)
        let mut bytes = Vec::with_capacity(result.data.len() * 4);
        for v in &result.data {
            bytes.extend_from_slice(&v.to_le_bytes());
        }
        let bulk_ref = bulk::write_bytes(&handle, &bytes, "bin")?;
        emit(format!("build_heightmap: bulk 기록 완료 ({}, {:.1}MB)",
            bulk_ref.bulk_id, bulk_ref.bytes as f64 / 1024.0 / 1024.0));

        Ok(HeightmapBulkResult {
            bulk_id: bulk_ref.bulk_id,
            bytes: bulk_ref.bytes,
            width: result.width,
            height: result.height,
            pixel_size_m: result.pixel_size_m,
            center_lat: result.center_lat,
            center_lon: result.center_lon,
            radar_height_m: result.radar_height_m,
            max_range_km: result.max_range_km,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 자기편각 조회 IPC 커맨드

/// WMM fallback 데이터를 NOAA 데이터로 치환하는 IPC 커맨드

/// WMM→NOAA 치환 로직 (IPC + 백그라운드 공용)
/// rusqlite::Connection은 Send가 아니므로 DB 접근(sync)과 API 호출(async)을 분리
async fn refresh_wmm_to_noaa(app_handle: &tauri::AppHandle) -> Result<usize, String> {
    // 1. DB에서 WMM 엔트리 목록 조회 (sync)
    let entries = {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
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
                let saved = state.db.lock().ok().and_then(|pool| pool.get().ok()).map(|conn| {
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
async fn compute_coverage_terrain_profile(
    app_handle: tauri::AppHandle,
    radar_name: String,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
    bearing_step_deg: Option<f64>,
) -> Result<analysis::coverage::ProfileMeta, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        Ok(analysis::coverage::compute_terrain_profile(
            &mut srtm, &conn, &radar_name,
            radar_lat, radar_lon, radar_altitude, antenna_height, range_nm,
            bearing_step_deg.unwrap_or(0.1),
        ))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}


/// 커버리지 레이어 배치 계산 — 수십 MB 응답이므로 bulk:// 파일 매개 전송
#[tauri::command]
async fn compute_coverage_layers_batch(
    app_handle: tauri::AppHandle,
    alt_fts: Vec<f64>,
    bearing_step: Option<usize>,
) -> Result<bulk::BulkRef, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let layers = analysis::coverage::compute_layers_batch(&alt_fts, bearing_step.unwrap_or(1));
        bulk::write_json(&app_handle, &layers)
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}



/// Per-pixel 커버리지 캐시 초기화 (SRTM + 건물 프리로드)
#[tauri::command]
async fn init_pixel_coverage(
    app_handle: tauri::AppHandle,
    radar_lat: f64,
    radar_lon: f64,
    radar_altitude: f64,
    antenna_height: f64,
    range_nm: f64,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {}", e))?;
        // 진행 이벤트 — 프론트(gpuCoverage.ts)가 listen("coverage-init-progress") 로 수신
        let h = app_handle.clone();
        analysis::coverage::init_pixel_coverage(
            &mut srtm, &conn,
            radar_lat, radar_lon, radar_altitude, antenna_height, range_nm,
            |pct, stage, msg, counts| {
                let _ = h.emit("coverage-init-progress", serde_json::json!({
                    "stage": stage,
                    "pct": pct,
                    "msg": msg,
                    "done": counts.map(|c| c.0),
                    "total": counts.map(|c| c.1),
                }));
            },
        );
        Ok(())
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 특정 좌표의 최저 탐지고도 조회
#[tauri::command]
async fn query_min_detection_alt(
    app_handle: tauri::AppHandle,
    lat: f64,
    lon: f64,
) -> Result<Option<f64>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
        Ok(analysis::coverage::query_min_detection_alt(&mut srtm, lat, lon))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// render_coverage_bitmap 응답 메타 — RGBA 본체는 bulk:// 파일 매개 전송
#[derive(serde::Serialize)]
struct CoverageBitmapBulkResult {
    bulk_id: String,
    bytes: u64,
    width: u32,
    height: u32,
    bounds: [f64; 4],
    used_alt_fts: Vec<f64>,
}

/// Per-pixel 커버리지 비트맵 렌더링 (무한해상도)
/// RGBA(최대 2048²×4 ≈ 16MB)는 base64 invoke 응답 대신 bulk:// 파일 매개 전송
#[tauri::command]
async fn render_coverage_bitmap(
    app_handle: tauri::AppHandle,
    alt_fts: Vec<f64>,
    show_cone: bool,
    west: f64,
    south: f64,
    east: f64,
    north: f64,
    width: u32,
    height: u32,
) -> Result<CoverageBitmapBulkResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let r = {
            let state = app_handle.state::<AppState>();
            let mut srtm = state.srtm.lock().map_err(|e| format!("SRTM lock: {}", e))?;
            analysis::coverage::render_coverage_bitmap(
                &mut srtm, &alt_fts, show_cone,
                west, south, east, north, width, height,
            ).ok_or_else(|| "커버리지 캐시 미초기화".to_string())?
        };
        let bulk_ref = bulk::write_bytes(&app_handle, &r.bitmap, "bin")?;
        Ok(CoverageBitmapBulkResult {
            bulk_id: bulk_ref.bulk_id,
            bytes: bulk_ref.bytes,
            width: r.width,
            height: r.height,
            bounds: r.bounds,
            used_alt_fts: r.used_alt_fts,
        })
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

// ---------- vworld 건물 데이터 자동 다운로드 ----------


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
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {e}"))?;
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
                let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {e}"))?;
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
async fn get_landuse_tile_count(
    app_handle: tauri::AppHandle,
) -> Result<i64, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
        conn.query_row("SELECT COUNT(*) FROM landuse_tiles", [], |row| row.get(0))
            .map_err(|e| format!("타일 카운트 실패: {e}"))
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
}

/// 캐시된 타일 삭제

/// 단일 타일 조회 (DB 캐시에서 base64 반환)
#[tauri::command]
async fn get_landuse_tile(
    app_handle: tauri::AppHandle,
    z: i64,
    x: i64,
    y: i64,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| e.to_string())?;
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
    })
    .await
    .map_err(|e| format!("spawn_blocking: {}", e))?
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
            let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {e}"))?;
            let mut srtm = state.srtm.lock().unwrap();
            let handle_clone = app_handle.clone();
            let rk = region_key.clone();
            fac_building::import_from_zip(&conn, &mut srtm, temp_path.to_str().unwrap(), &region_key, &|p: fac_building::FacBuildingImportProgress| {
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

    if imported > 0 {
        // 건물 자료 세대 변경 → 파노라마·커버리지 캐시 무효화 + 전 창 통보 (임포트 루프 전체에 1회)
        let state = app_handle.state::<AppState>();
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {e}"))?;
        let _ = db::clear_panorama_cache_all(&conn);
        analysis::coverage::invalidate_building_caches();
        let _ = app_handle.emit("fac-buildings-changed", ());
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
        let conn = state.db.lock().unwrap().get().map_err(|e| format!("DB pool: {e}"))?;
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

// ── vworld 주소 검색 ──────────────────────────────────────────

#[tauri::command]
async fn search_vworld_address(
    query: String,
    limit: Option<usize>,
) -> Result<Vec<vworld_search::VWorldSearchResult>, String> {
    let lim = limit.unwrap_or(8);
    vworld_search::search(&query, lim).await
}

#[tauri::command]
async fn get_vworld_building_info(
    lat: f64,
    lon: f64,
) -> Result<Option<vworld_search::VWorldBuildingInfo>, String> {
    vworld_search::fetch_building_info(lat, lon).await
}

/// 호출자 윈도우의 DevTools 활성화
#[tauri::command]
fn open_devtools(window: tauri::WebviewWindow) {
    window.open_devtools();
}

/// bulk 전송 파일 삭제 — 프론트(bulkIpc.ts)가 수신 완료 후 호출
#[tauri::command]
fn bulk_cleanup(app_handle: tauri::AppHandle, id: String) -> Result<(), String> {
    bulk::remove(&app_handle, &id)
}

// ---------- App Entry Point ----------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        // 대용량 IPC 응답 파일 매개 수신용 커스텀 프로토콜 (bulk.rs 참조).
        // invoke 응답에 수백 MB 를 실으면 IPC eval 폴백 경로에서 브라우저 프로세스가
        // OOM(0xE0000008) 크래시(전 창 백지)하므로, 본문은 이 프로토콜로 스트리밍한다.
        .register_asynchronous_uri_scheme_protocol("bulk", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let id = request.uri().path().trim_start_matches('/').to_string();
            tauri::async_runtime::spawn_blocking(move || {
                let response = match bulk::read(&app, &id) {
                    Ok(data) => tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", "application/octet-stream")
                        .header("Access-Control-Allow-Origin", "*")
                        .header("Cache-Control", "no-store")
                        .body(data),
                    Err(e) => tauri::http::Response::builder()
                        .status(404)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(e.into_bytes()),
                };
                match response {
                    Ok(r) => responder.respond(r),
                    Err(e) => log::warn!("[Bulk] 프로토콜 응답 빌드 실패: {}", e),
                }
            });
        })
        // 융합 SRTM 지형 DEM 타일 서빙 (terrarium PNG, terrain_tiles.rs 참조).
        // MapLibre 3D 지형면·힐셰이드가 외부 terrarium DEM 을 쓰면 실측 지반고 융합 보정이
        // 시각 지면에 영원히 반영되지 않아, 융합 SRTM 절대 AMSL 로 그리는 deck 기하
        // (LoS 커튼·BRA 원추면)와 지면이 보정량만큼 어긋난다. 타일 본문은 이 프로토콜로
        // 직접 바이트 응답한다 — 타일 1장이 수십 KB 이고 팬/줌마다 다수 요청이라
        // String 반환 invoke(항상 eval 경로) 로 실어 나르면 안 된다.
        .register_asynchronous_uri_scheme_protocol("fused-dem", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();

            tauri::async_runtime::spawn_blocking(move || {
                let err_response = |status: u16| {
                    tauri::http::Response::builder()
                        .status(status)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new())
                };

                let response = match terrain_tiles::parse_tile_path(&path) {
                    None => err_response(404),
                    Some((z, x, y)) => {
                        // SRTM 리더는 AppState 공유 인스턴스 — 실측 임포트/삭제의 clear_cache 가
                        // 곧 이 타일들의 무효화 계약이다(다음 요청부터 융합 세대 반영).
                        let png = match app.try_state::<AppState>() {
                            Some(state) => match state.srtm.lock() {
                                Ok(mut srtm) => Some(terrain_tiles::render_tile(&mut srtm, z, x, y)),
                                Err(_) => {
                                    log::warn!("[FusedDEM] SRTM lock 실패");
                                    None
                                }
                            },
                            None => None,
                        };
                        match png {
                            Some(data) => tauri::http::Response::builder()
                                .status(200)
                                .header("Content-Type", "image/png")
                                .header("Access-Control-Allow-Origin", "*")
                                // 캐시 무효화는 프론트 캐시버스터(?v=)가 담당 — 세션 내 재요청은 재사용
                                .header("Cache-Control", "public, max-age=3600")
                                .body(data),
                            None => err_response(503),
                        }
                    }
                };

                match response {
                    Ok(r) => responder.respond(r),
                    Err(e) => log::warn!("[FusedDEM] 프로토콜 응답 빌드 실패: {}", e),
                }
            });
        })
        // 실측 3D 건물 Cesium 3D Tiles 서빙 (tileset.json + *.b3dm).
        // set_tiles3d_dir 로 지정된 로컬 폴더를 루트로 하는 읽기 전용 정적 서버.
        // 경로는 화이트리스트 문자셋 + '..' 금지로 디렉터리 탈출을 차단한다.
        .register_asynchronous_uri_scheme_protocol("tiles3d", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let rel = request.uri().path().trim_start_matches('/').to_string();

            tauri::async_runtime::spawn_blocking(move || {
                // 응답 빌더 — 본문 없는 에러 응답
                let err_response = |status: u16| {
                    tauri::http::Response::builder()
                        .status(status)
                        .header("Access-Control-Allow-Origin", "*")
                        .body(Vec::new())
                };

                // ── 경로 검증 ── ('%' 등 화이트리스트 밖 문자는 즉시 거부)
                let path_ok = !rel.is_empty()
                    && rel.len() < 256
                    && rel.bytes().all(|b| {
                        b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'/' | b'-')
                    })
                    && rel.split('/').all(|seg| !seg.is_empty() && seg != "..");

                let response = if !path_ok {
                    err_response(403)
                } else {
                    // 루트 디렉터리 미설정이면 404 (setup 이전 요청은 state 부재 → 동일 404)
                    let base = match app.try_state::<AppState>() {
                        Some(state) => match state.tiles3d_dir.lock() {
                            Ok(g) => g.clone(),
                            Err(_) => {
                                log::warn!("[Tiles3D] 상태 lock 실패");
                                None
                            }
                        },
                        None => None,
                    };
                    match base {
                        None => err_response(404),
                        Some(dir) => match std::fs::read(dir.join(&rel)) {
                            Ok(data) => {
                                let ctype = if rel.to_ascii_lowercase().ends_with(".json") {
                                    "application/json"
                                } else {
                                    "application/octet-stream"
                                };
                                tauri::http::Response::builder()
                                    .status(200)
                                    .header("Content-Type", ctype)
                                    .header("Access-Control-Allow-Origin", "*")
                                    .header("Cache-Control", "public, max-age=3600")
                                    .body(data)
                            }
                            Err(_) => err_response(404),
                        },
                    }
                };

                match response {
                    Ok(r) => responder.respond(r),
                    Err(e) => log::warn!("[Tiles3D] 프로토콜 응답 빌드 실패: {}", e),
                }
            });
        })
        .setup(|app| {
            let app_data_dir = get_app_data_dir(app.handle())
                .map_err(|e| Box::new(std::io::Error::new(std::io::ErrorKind::Other, e)))?;
            info!("App data dir: {:?}", app_data_dir);

            // SQLite DB 초기화 (r2d2 연결 풀)
            let db_path = app_data_dir.join("adsb.db");
            let db_pool = db::init_db_pool(&db_path).map_err(|e| {
                Box::new(std::io::Error::new(
                    std::io::ErrorKind::Other,
                    format!("DB pool init error: {}", e),
                ))
            })?;
            info!("Database path: {:?}", db_path);

            // 백그라운드: fac_buildings.suppressed_by 1회 백필 (기존 DB 대응).
            // 풀 커넥션을 장시간 점유하지 않도록 **별도 Connection** 을 열어 전용 스레드에서 수행한다
            // (WAL 은 DB 속성이라 그대로 적용되고, busy_timeout 만 커넥션별로 다시 지정).
            {
                let bf_db_path = db_path.clone();
                let bf_handle = app.handle().clone();
                std::thread::spawn(move || {
                    let conn = match rusqlite::Connection::open(&bf_db_path) {
                        Ok(c) => c,
                        Err(e) => {
                            log::warn!("[중복억제] 백필 DB 열기 실패: {}", e);
                            return;
                        }
                    };
                    let _ = conn.execute_batch("PRAGMA busy_timeout=5000;");
                    match suppression::backfill_if_needed(&conn) {
                        // 백필이 실제로 행을 바꿨을 때만 — 기동 직후 이미 채워진 캐시/화면이 옛 상태다
                        Ok(n) if n > 0 => {
                            let _ = db::clear_panorama_cache_all(&conn);
                            analysis::coverage::invalidate_building_caches();
                            let _ = bf_handle.emit("fac-buildings-changed", ());
                        }
                        Ok(_) => {}
                        Err(e) => log::warn!("[중복억제] 백필 실패: {}", e),
                    }
                });
            }

            // 기존 aircraft.json → DB 마이그레이션
            let aircraft_json_path = app_data_dir.join("aircraft.json");
            if aircraft_json_path.exists() {
                info!("Migrating aircraft.json to SQLite...");
                if let Ok(conn) = db_pool.get() {
                    if let Err(e) = db::migrate_aircraft_json(&conn, &aircraft_json_path) {
                        log::warn!("Aircraft migration failed: {}", e);
                    }
                }
            }

            // SRTM 데이터 디렉토리 초기화
            let srtm_dir = app_data_dir.join("srtm");
            if !srtm_dir.exists() {
                let _ = fs::create_dir_all(&srtm_dir);
            }
            info!("SRTM data dir: {:?}", srtm_dir);

            // 실측 3D Tiles 루트 디렉터리 복원 (빈 문자열/미설정 → None)
            let tiles3d_dir: Option<PathBuf> = db_pool
                .get()
                .ok()
                .and_then(|c| db::get_setting(&c, "tiles3d_dir").ok().flatten())
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .map(PathBuf::from);
            if let Some(ref d) = tiles3d_dir {
                info!("3D Tiles dir: {:?}", d);
            }

            app.manage(AppState {
                app_data_dir: Mutex::new(app_data_dir.clone()),
                db: Mutex::new(db_pool),
                srtm: Mutex::new(srtm::SrtmReader::new(srtm_dir, db_path.clone())),
                analysis_cancel: Arc::new(AtomicBool::new(false)),
                tiles3d_dir: Mutex::new(tiles3d_dir),
            });

            // 이전 세션 잔여 bulk 전송 파일 정리
            bulk::sweep(app.handle());

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

            // 백그라운드: fac_buildings.ground_elev NULL 행 SRTM 백필 (앱 기동 후 1회)
            let bf_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                tauri::async_runtime::spawn_blocking(move || {
                    let state = bf_handle.state::<AppState>();
                    let conn = match state.db.lock().unwrap().get() {
                        Ok(c) => c,
                        Err(e) => { log::warn!("ground_elev 백필 DB 커넥션 실패: {}", e); return; }
                    };
                    let mut srtm = state.srtm.lock().unwrap();
                    match fac_building::backfill_ground_elev(&conn, &mut srtm) {
                        Ok(0) => {}
                        Ok(n) => info!("fac_buildings ground_elev 백필 {}행 완료", n),
                        Err(e) => log::warn!("fac_buildings ground_elev 백필 실패: {}", e),
                    }
                }).await.ok();
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            parse_and_analyze_batch,
            scan_asterix_batch,
            query_asterix_frames,
            get_aircraft_list,
            save_aircraft,
            delete_aircraft,
            write_file_base64,
            load_setting,
            save_setting,
            export_database,
            import_database,
            build_heightmap,
            panorama_merge_buildings,
            panorama_merge_buildings_dual,
            save_panorama_cache,
            load_panorama_cache,
            clear_panorama_cache,
            fetch_elevation,
            get_srtm_status,
            download_srtm_korea,
            query_buildings_along_path,
            query_los_baseline,
            query_buildings_3d_binary,
            analyze_bra_penetration,
            get_fac_building_detail,
            find_building_near_point,
            // 건물통합정보 (F_FAC_BUILDING)
            import_fac_building_data,
            get_fac_building_import_status,
            clear_fac_building_data,
            // 실측 3D 건물 (1m DSM) + Cesium 3D Tiles
            import_measured_buildings,
            clear_measured_buildings,
            get_measured_coverage_bbox,
            set_tiles3d_dir,
            get_tiles3d_dir,
            // 산봉우리 지명
            import_peak_data,
            query_nearby_peaks,
            get_peak_import_status,
            list_building_groups,
            add_building_group,
            update_building_group,
            delete_building_group,
            set_building_group_enabled,
            list_manual_buildings,
            add_manual_building,
            update_manual_building,
            delete_manual_building,
            // 커버리지 캐시
            save_coverage_cache,
            load_coverage_cache,
            has_coverage_cache,
            // 커버리지 계산 (rayon 최적화)
            compute_coverage_terrain_profile,
            compute_coverage_layers_batch,
            init_pixel_coverage,
            render_coverage_bitmap,
            query_min_detection_alt,
            // 장애물 월간 분석
            analyze_obstacle_monthly,
            cancel_analysis,
            // OM 기준데이터(참조 달) — 등록(원본 ASS 보관) + 목록/삭제 (재집계는 analyze 통합)
            register_om_reference,
            list_om_references,
            delete_om_reference,
            write_om_parity_debug,
            compute_coverage_terrain_profile_excluding,
            compute_coverage_layers_batch_excluded,
            // 토지이용계획도 타일
            download_landuse_tiles,
            get_landuse_tile_count,
            get_landuse_tile,
            // 주소 검색 + 건물 상세정보 (vworld)
            search_vworld_address,
            get_vworld_building_info,
            // vworld 자동 다운로드
            vworld_download_fac_buildings,
            vworld_download_n3p,
            // WebView2 네이티브 PDF
            webview_print_to_pdf,
            // 대용량 IPC 파일 매개 전송
            bulk_cleanup,
            // DevTools
            open_devtools,
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
