fn main() {
    const COMMANDS: &[&str] = &[
        "set_tray_badge",
        "set_tray_error",
        "show_main_window",
        "open_chrome_setup",
        "set_menu_bar_only",
        "get_secret",
        "set_secret",
        "delete_secret",
        "start_oauth_callback",
        "cancel_oauth_callback",
        "start_chrome_browser",
        "call_chrome_browser_tool",
        "stop_chrome_browser",
        "chrome_browser_connected",
    ];
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to build Tauri application");
}
