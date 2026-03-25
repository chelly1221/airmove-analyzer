// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // 크래시 시 오류 다이얼로그 표시
    std::panic::set_hook(Box::new(|info| {
        let message = if let Some(s) = info.payload().downcast_ref::<&str>() {
            s.to_string()
        } else if let Some(s) = info.payload().downcast_ref::<String>() {
            s.clone()
        } else {
            "알 수 없는 오류".to_string()
        };

        let location = info
            .location()
            .map(|loc| format!("\n\n위치: {}:{}:{}", loc.file(), loc.line(), loc.column()))
            .unwrap_or_default();

        let full_message = format!(
            "프로그램에서 예기치 않은 오류가 발생했습니다.\n\n{}{}\n\n이 오류를 개발팀에 보고해 주세요.",
            message, location
        );

        #[cfg(windows)]
        {
            use windows::core::PCWSTR;
            use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

            let title: Vec<u16> = "항적분석체계 오류\0".encode_utf16().collect();
            let body: Vec<u16> = format!("{}\0", full_message).encode_utf16().collect();

            unsafe {
                MessageBoxW(
                    None,
                    PCWSTR(body.as_ptr()),
                    PCWSTR(title.as_ptr()),
                    MB_ICONERROR | MB_OK,
                );
            }
        }

        // stderr에도 출력 (로그 파일 등에 기록)
        eprintln!("PANIC: {}{}", message, location);
    }));

    // Force WebView2 to use hardware GPU acceleration (prevents software rendering fallback)
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--enable-gpu --enable-webgl --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --disable-gpu-driver-bug-workarounds --force_high_performance_gpu --enable-unsafe-webgpu --enable-features=Vulkan,WebGPU");

    airmove_analyzer_lib::run()
}
