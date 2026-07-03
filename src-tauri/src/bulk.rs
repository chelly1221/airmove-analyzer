//! 대용량 IPC 응답의 파일 매개 전송 (bulk:// 커스텀 프로토콜)
//!
//! WebView2 에서 Tauri invoke 의 커스텀 프로토콜 fetch 가 1회라도 실패하면
//! (거대 응답 json() 실패, 부하 중 ERR_INSUFFICIENT_RESOURCES 등) ipc-protocol.js 가
//! postMessage+eval 경로로 **영구 강등**된다. 이 경로는 응답 전체를
//! `Runtime.evaluate` 스크립트 문자열(JSON→이스케이프→CDP 봉투→파싱, 수 배 복제)로
//! 공유 브라우저 프로세스에 밀어 넣어, 수백 MB 응답에서 브라우저 프로세스가
//! OOM(0xE0000008, Chromium TerminateBecauseOutOfMemory) 크래시한다 —
//! 모든 창 동시 백지 + 호스트 앱 동반 크래시.
//! (2026-07-03 Crashpad 덤프 확진: ProcessType=browser, SubCode=0xe0000008,
//!  analyze_obstacle_monthly 결과의 runCallback Runtime.evaluate 포착)
//! 또한 응답이 `{`/`[` 로 시작하지 않는 커맨드(String 반환 등)는 강등과 무관하게
//! **항상** eval 경로를 탄다 (tauri-2.10.3 src/ipc/protocol.rs).
//!
//! 따라서 수 MB+ 응답은 invoke 에 싣지 않고 임시 파일에 쓴 뒤 BulkRef(id)만 반환하고,
//! 프론트(utils/bulkIpc.ts)가 bulk:// 프로토콜 fetch 로 스트리밍 수신한다.
//! eval 강등이 일어나도 id 문자열만 eval 되므로 안전하다.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde::Serialize;
use tauri::Manager;

/// invoke 응답으로 반환되는 참조 — 본문은 프론트가 bulk:// fetch 로 수신
#[derive(Serialize, Clone, Debug)]
pub struct BulkRef {
    pub bulk_id: String,
    pub bytes: u64,
}

static BULK_SEQ: AtomicU64 = AtomicU64::new(0);

/// bulk 파일 디렉토리 (app_data/bulk_ipc)
fn dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = {
        let state = app.state::<crate::AppState>();
        let guard = state
            .app_data_dir
            .lock()
            .map_err(|e| format!("app_data_dir lock: {}", e))?;
        guard.clone()
    };
    let d = base.join("bulk_ipc");
    if !d.exists() {
        fs::create_dir_all(&d).map_err(|e| format!("bulk 디렉토리 생성 실패: {}", e))?;
    }
    Ok(d)
}

fn next_id(ext: &str) -> String {
    format!(
        "b{}-{}.{}",
        std::process::id(),
        BULK_SEQ.fetch_add(1, Ordering::Relaxed),
        ext
    )
}

/// id 검증 — 경로 조작 차단 (bulk 디렉토리 밖 접근 금지)
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() < 128
        && !id.contains("..")
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_' || b == b'.')
}

/// 직렬화 가능한 값을 JSON 파일로 기록 (스트리밍 직렬화 — 전체 문자열 복제 없음)
pub fn write_json<T: Serialize>(app: &tauri::AppHandle, value: &T) -> Result<BulkRef, String> {
    let id = next_id("json");
    let path = dir(app)?.join(&id);
    let file = fs::File::create(&path).map_err(|e| format!("bulk 파일 생성 실패: {}", e))?;
    let mut w = std::io::BufWriter::with_capacity(1 << 20, file);
    serde_json::to_writer(&mut w, value).map_err(|e| format!("bulk 직렬화 실패: {}", e))?;
    w.flush().map_err(|e| format!("bulk flush 실패: {}", e))?;
    let bytes = fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(BulkRef { bulk_id: id, bytes })
}

/// 바이트 버퍼를 파일로 기록 (raw f32 heightmap, RGBA 비트맵, 캐시 JSON 문자열 등)
pub fn write_bytes(app: &tauri::AppHandle, data: &[u8], ext: &str) -> Result<BulkRef, String> {
    let id = next_id(ext);
    let path = dir(app)?.join(&id);
    fs::write(&path, data).map_err(|e| format!("bulk 파일 기록 실패: {}", e))?;
    Ok(BulkRef {
        bulk_id: id,
        bytes: data.len() as u64,
    })
}

/// bulk:// 프로토콜 핸들러용 읽기
pub fn read(app: &tauri::AppHandle, id: &str) -> Result<Vec<u8>, String> {
    if !valid_id(id) {
        return Err(format!("잘못된 bulk id: {}", id));
    }
    let path = dir(app)?.join(id);
    fs::read(&path).map_err(|e| format!("bulk 읽기 실패 ({}): {}", id, e))
}

/// 소비 완료된 파일 삭제 (프론트 readBulk* 가 수신 후 호출)
pub fn remove(app: &tauri::AppHandle, id: &str) -> Result<(), String> {
    if !valid_id(id) {
        return Err(format!("잘못된 bulk id: {}", id));
    }
    let path = dir(app)?.join(id);
    fs::remove_file(&path).map_err(|e| format!("bulk 삭제 실패 ({}): {}", id, e))
}

/// 시작 시 잔여 파일 정리 — 10분 이상 지난 파일만 (동시 실행 인스턴스의 전송 중 파일 보호)
pub fn sweep(app: &tauri::AppHandle) {
    let Ok(d) = dir(app) else { return };
    let Ok(entries) = fs::read_dir(&d) else { return };
    let now = std::time::SystemTime::now();
    let mut removed = 0u32;
    for entry in entries.flatten() {
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| now.duration_since(t).ok())
            .map(|age| age.as_secs() > 600)
            .unwrap_or(true);
        if stale && fs::remove_file(entry.path()).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        log::info!("[Bulk] 잔여 전송 파일 {}개 정리", removed);
    }
}
