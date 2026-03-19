// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Force WebView2 to use hardware GPU acceleration (prevents software rendering fallback)
    std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--enable-gpu --enable-webgl --ignore-gpu-blocklist --enable-gpu-rasterization --enable-zero-copy --disable-gpu-driver-bug-workarounds --force_high_performance_gpu --enable-unsafe-webgpu --enable-features=Vulkan,WebGPU");

    airmove_analyzer_lib::run()
}
