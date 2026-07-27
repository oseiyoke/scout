use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, Menu, MenuItem},
    path::BaseDirectory,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, Runtime, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_autostart::ManagerExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader as AsyncBufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::Mutex as AsyncMutex;
use tokio::time::{timeout, Duration as TokioDuration};

const KEYRING_SERVICE: &str = "com.obose.scout";
const CHROME_DEVTOOLS_MCP_VERSION: &str = "1.6.0";

fn secret_entry(key: &str) -> Result<keyring::Entry, String> {
    let connector_key =
        key.starts_with("connector:") && (key.ends_with(":headers") || key.ends_with(":auth"));
    if key.len() > 200 || (key != "api_key" && !connector_key) {
        return Err("Unsupported credential key".to_string());
    }
    keyring::Entry::new(KEYRING_SERVICE, key)
        .map_err(|error| format!("Could not access the system credential store: {error}"))
}

#[tauri::command]
fn get_secret(key: String) -> Result<Option<String>, String> {
    match secret_entry(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(error) => Err(format!(
            "Could not read from the system credential store: {error}"
        )),
    }
}

#[tauri::command]
fn set_secret(key: String, value: String) -> Result<(), String> {
    secret_entry(&key)?
        .set_password(&value)
        .map_err(|error| format!("Could not save to the system credential store: {error}"))
}

#[tauri::command]
fn delete_secret(key: String) -> Result<(), String> {
    match secret_entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(error) => Err(format!(
            "Could not delete from the system credential store: {error}"
        )),
    }
}

// ── Tray state ───────────────────────────────────────────────────────────────

struct TrayState {
    title: Mutex<String>,
}

fn set_tray_title<R: Runtime>(app: &AppHandle<R>, title: &str) {
    if let Some(tray) = app.tray_by_id("scout-tray") {
        if title.is_empty() {
            let _ = tray.set_title(None::<&str>);
        } else {
            let _ = tray.set_title(Some(title));
        }
    }
    if let Some(state) = app.try_state::<TrayState>() {
        *state.title.lock().unwrap() = title.to_string();
    }
}

#[tauri::command]
fn set_tray_badge(app: AppHandle, count: u32) {
    set_tray_title(
        &app,
        &if count == 0 {
            String::new()
        } else {
            format!(" {count}")
        },
    );
}

#[tauri::command]
fn set_tray_error(app: AppHandle, message: Option<String>) {
    set_tray_title(&app, " !");
    if let Some(tray) = app.tray_by_id("scout-tray") {
        let _ = tray.set_tooltip(message.as_deref());
    }
}

#[tauri::command]
fn show_main_window(app: AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
    if let Some(p) = app.get_webview_window("panel") {
        let _ = p.hide();
    }
}

#[tauri::command]
fn open_chrome_setup() -> Result<(), String> {
    const URL: &str = "chrome://inspect/#remote-debugging";

    #[cfg(target_os = "macos")]
    let result = std::process::Command::new("open")
        .args(["-a", "Google Chrome", URL])
        .spawn();

    #[cfg(target_os = "windows")]
    let result = std::process::Command::new("cmd")
        .args(["/C", "start", "", URL])
        .spawn();

    #[cfg(target_os = "linux")]
    let result = std::process::Command::new("google-chrome").arg(URL).spawn();

    result
        .map(|_| ())
        .map_err(|error| format!("Could not open Chrome setup: {error}"))
}

#[tauri::command]
fn set_menu_bar_only(app: AppHandle, enabled: bool) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        app.set_activation_policy(if enabled {
            tauri::ActivationPolicy::Accessory
        } else {
            tauri::ActivationPolicy::Regular
        })
        .map_err(|e| e.to_string())?;
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, enabled);
        Err("Menu bar only mode is only supported on macOS".to_string())
    }
}

// ── OAuth loopback callback ────────────────────────────────────────────────

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct OAuthCallbackPayload {
    connector_id: String,
    url: Option<String>,
    error: Option<String>,
}

struct OAuthCallbackHandle {
    connector_id: String,
    active: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
struct OAuthCallbackState {
    current: Mutex<Option<OAuthCallbackHandle>>,
}

fn stop_callback(handle: OAuthCallbackHandle) {
    handle.active.store(false, Ordering::Release);
    let _ = handle.thread.join();
}

/// Starts a short-lived RFC 8252 loopback receiver. Remote MCP OAuth servers
/// redirect the system browser here; Scout then exchanges the code via PKCE.
#[tauri::command]
fn start_oauth_callback(
    app: AppHandle,
    state: tauri::State<'_, OAuthCallbackState>,
    connector_id: String,
) -> Result<String, String> {
    const CALLBACK: &str = "http://127.0.0.1:3119/oauth/callback";

    let previous = state
        .current
        .lock()
        .map_err(|_| "Could not access Scout's sign-in state".to_string())?
        .take();
    if let Some(previous) = previous {
        let previous_connector_id = previous.connector_id.clone();
        stop_callback(previous);
        let _ = app.emit(
            "scout:oauth-callback",
            OAuthCallbackPayload {
                connector_id: previous_connector_id,
                url: None,
                error: Some("A newer sign-in was started.".to_string()),
            },
        );
    }

    let listener = TcpListener::bind("127.0.0.1:3119")
        .map_err(|_| "Scout's callback port is being used by another application. Close that process and try again.".to_string())?;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("Could not prepare OAuth callback: {e}"))?;

    let active = Arc::new(AtomicBool::new(true));
    let thread_active = active.clone();
    let thread_connector_id = connector_id.clone();
    let thread = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(300);
        while thread_active.load(Ordering::Acquire) {
            match listener.accept() {
                Ok((mut stream, _)) => {
                    let mut buffer = [0_u8; 8192];
                    let read = stream.read(&mut buffer).unwrap_or(0);
                    let request = String::from_utf8_lossy(&buffer[..read]);
                    let target = request
                        .lines()
                        .next()
                        .and_then(|line| line.split_whitespace().nth(1));

                    let (url, error) = match target {
                        Some(path) if path.starts_with("/oauth/callback") => {
                            (Some(format!("http://127.0.0.1:3119{path}")), None)
                        }
                        _ => (None, Some("OAuth callback request was invalid".to_string())),
                    };

                    let success = url.is_some();
                    let heading = if success {
                        "Connected to Scout"
                    } else {
                        "Sign-in could not finish"
                    };
                    let message = if success {
                        "You can close this tab. Scout is finishing the connection."
                    } else {
                        "Return to Scout and try connecting again."
                    };
                    let body = format!(
                        "<!doctype html><html><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width\"><title>{heading}</title><style>body{{font:15px system-ui;background:#f4f7fb;color:#152238;display:grid;place-items:center;min-height:100vh;margin:0}}main{{background:white;border:1px solid #dfe5ee;border-radius:18px;padding:32px;max-width:420px;box-shadow:0 20px 60px #18304d1c}}h1{{font-size:22px;margin:0 0 8px}}p{{color:#637083;line-height:1.5;margin:0}}</style></head><body><main><h1>{heading}</h1><p>{message}</p></main></body></html>"
                    );
                    let response = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        body.len(), body
                    );
                    let _ = stream.write_all(response.as_bytes());
                    let _ = stream.flush();

                    let _ = app.emit(
                        "scout:oauth-callback",
                        OAuthCallbackPayload {
                            connector_id: thread_connector_id,
                            url,
                            error,
                        },
                    );
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if Instant::now() >= deadline {
                        let _ = app.emit(
                            "scout:oauth-callback",
                            OAuthCallbackPayload {
                                connector_id: thread_connector_id,
                                url: None,
                                error: Some("Sign-in timed out. Try connecting again.".to_string()),
                            },
                        );
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(100));
                }
                Err(error) => {
                    let _ = app.emit(
                        "scout:oauth-callback",
                        OAuthCallbackPayload {
                            connector_id: thread_connector_id,
                            url: None,
                            error: Some(format!("OAuth callback failed: {error}")),
                        },
                    );
                    break;
                }
            }
        }
    });

    state
        .current
        .lock()
        .map_err(|_| "Could not save Scout's sign-in state".to_string())?
        .replace(OAuthCallbackHandle {
            connector_id,
            active,
            thread,
        });

    Ok(CALLBACK.to_string())
}

#[tauri::command]
fn cancel_oauth_callback(
    app: AppHandle,
    state: tauri::State<'_, OAuthCallbackState>,
    connector_id: String,
) -> Result<(), String> {
    let handle = {
        let mut current = state
            .current
            .lock()
            .map_err(|_| "Could not access Scout's sign-in state".to_string())?;
        if current
            .as_ref()
            .is_some_and(|handle| handle.connector_id == connector_id)
        {
            current.take()
        } else {
            None
        }
    };
    if let Some(handle) = handle {
        stop_callback(handle);
        let _ = app.emit(
            "scout:oauth-callback",
            OAuthCallbackPayload {
                connector_id,
                url: None,
                error: Some("Sign-in cancelled.".to_string()),
            },
        );
    }
    Ok(())
}

// ── Signed-in Chrome browser connector ─────────────────────────────────────

struct ChromeBrowserProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: AsyncBufReader<ChildStdout>,
    next_id: u64,
}

#[derive(Default)]
struct ChromeBrowserState {
    process: AsyncMutex<Option<ChromeBrowserProcess>>,
}

fn local_chrome_mcp_binary() -> Option<PathBuf> {
    let executable = if cfg!(windows) {
        "chrome-devtools-mcp.cmd"
    } else {
        "chrome-devtools-mcp"
    };
    let cwd = std::env::current_dir().ok()?;
    [
        cwd.join("node_modules").join(".bin").join(executable),
        cwd.join("scout-app")
            .join("node_modules")
            .join(".bin")
            .join(executable),
    ]
    .into_iter()
    .find(|path| path.is_file())
}

fn bundled_chrome_runtime(app: &AppHandle) -> Option<(PathBuf, PathBuf)> {
    let executable_name = if cfg!(windows) {
        "scout-node.exe"
    } else {
        "scout-node"
    };
    let executable_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();
    let node = {
        let expected = executable_dir.join(executable_name);
        if expected.is_file() {
            expected
        } else {
            std::fs::read_dir(&executable_dir)
                .ok()?
                .flatten()
                .map(|entry| entry.path())
                .find(|path| {
                    path.file_name()
                        .and_then(|name| name.to_str())
                        .is_some_and(|name| name.starts_with("scout-node-"))
                })?
        }
    };
    let script = app
        .path()
        .resolve(
            "browser-runtime/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js",
            BaseDirectory::Resource,
        )
        .ok()?;
    (node.is_file() && script.is_file()).then_some((node, script))
}

fn chrome_mcp_command(app: &AppHandle) -> Command {
    let mut command = if let Ok(path) = std::env::var("SCOUT_CHROME_DEVTOOLS_MCP") {
        Command::new(path)
    } else if let Some(path) = local_chrome_mcp_binary() {
        Command::new(path)
    } else if let Some((node, script)) = bundled_chrome_runtime(app) {
        let mut command = Command::new(node);
        command.arg(script);
        command
    } else {
        let mut command = Command::new(if cfg!(windows) { "npx.cmd" } else { "npx" });
        command
            .arg("-y")
            .arg(format!("chrome-devtools-mcp@{CHROME_DEVTOOLS_MCP_VERSION}"));
        command
    };
    command
        .arg("--autoConnect")
        .arg("--no-usage-statistics")
        .arg("--no-performance-crux")
        .arg("--no-category-emulation")
        .arg("--no-category-performance")
        .arg("--no-category-network")
        .arg("--redact-network-headers")
        .env("CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS", "true")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    command
}

impl ChromeBrowserProcess {
    async fn spawn(app: &AppHandle) -> Result<Self, String> {
        let mut child = chrome_mcp_command(app).spawn().map_err(|error| {
            format!(
                "Scout could not start its Chrome browser runtime: {error}. Install Node.js 22 or set SCOUT_CHROME_DEVTOOLS_MCP to the chrome-devtools-mcp executable."
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Chrome browser runtime did not open stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Chrome browser runtime did not open stdout".to_string())?;
        Ok(Self {
            child,
            stdin,
            stdout: AsyncBufReader::new(stdout),
            next_id: 1,
        })
    }

    async fn write_message(&mut self, message: &Value) -> Result<(), String> {
        let mut bytes = serde_json::to_vec(message)
            .map_err(|error| format!("Could not encode Chrome browser request: {error}"))?;
        bytes.push(b'\n');
        self.stdin
            .write_all(&bytes)
            .await
            .map_err(|error| format!("Could not send request to Chrome: {error}"))?;
        self.stdin
            .flush()
            .await
            .map_err(|error| format!("Could not flush request to Chrome: {error}"))
    }

    async fn notify(&mut self, method: &str, params: Value) -> Result<(), String> {
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        }))
        .await
    }

    async fn rpc(
        &mut self,
        method: &str,
        params: Value,
        timeout_seconds: u64,
    ) -> Result<Value, String> {
        let id = self.next_id;
        self.next_id += 1;
        self.write_message(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await?;

        timeout(TokioDuration::from_secs(timeout_seconds), async {
            loop {
                let mut line = String::new();
                let read = self
                    .stdout
                    .read_line(&mut line)
                    .await
                    .map_err(|error| format!("Could not read Chrome response: {error}"))?;
                if read == 0 {
                    let exit = self.child.try_wait().ok().flatten();
                    return Err(match exit {
                        Some(status) => format!("Chrome browser runtime exited with {status}"),
                        None => "Chrome browser runtime closed its connection".to_string(),
                    });
                }
                let Ok(message) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if message.get("id").and_then(Value::as_u64) != Some(id) {
                    continue;
                }
                if let Some(error) = message.get("error") {
                    let detail = error
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or("Chrome browser tool failed");
                    return Err(detail.to_string());
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
        })
        .await
        .map_err(|_| {
            format!("Chrome did not respond to {method} within {timeout_seconds} seconds")
        })?
    }

    async fn initialize(&mut self) -> Result<Vec<Value>, String> {
        self.rpc(
            "initialize",
            json!({
                "protocolVersion": "2025-06-18",
                "capabilities": {},
                "clientInfo": { "name": "Scout", "version": "0.1.0" }
            }),
            30,
        )
        .await?;
        self.notify("notifications/initialized", json!({})).await?;
        self.list_tools().await
    }

    async fn list_tools(&mut self) -> Result<Vec<Value>, String> {
        let result = self.rpc("tools/list", json!({}), 30).await?;
        Ok(result
            .get("tools")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default())
    }

    async fn stop(&mut self) {
        let _ = self.child.kill().await;
        let _ = self.child.wait().await;
    }
}

#[tauri::command]
async fn start_chrome_browser(
    app: AppHandle,
    state: tauri::State<'_, ChromeBrowserState>,
) -> Result<Vec<Value>, String> {
    let mut process = state.process.lock().await;
    if let Some(existing) = process.as_mut() {
        return existing.list_tools().await;
    }

    let mut next = ChromeBrowserProcess::spawn(&app).await?;
    let tools = next.initialize().await?;
    // The server connects lazily. A harmless tab listing forces Chrome's own
    // signed-in-profile permission dialog to appear during the explicit setup.
    if let Err(error) = next
        .rpc(
            "tools/call",
            json!({ "name": "list_pages", "arguments": {} }),
            120,
        )
        .await
    {
        next.stop().await;
        return Err(format!(
            "Chrome did not grant Scout access. Enable Remote Debugging at chrome://inspect/#remote-debugging, try Connect again, and click Allow in Chrome. {error}"
        ));
    }
    *process = Some(next);
    Ok(tools)
}

#[tauri::command]
async fn call_chrome_browser_tool(
    state: tauri::State<'_, ChromeBrowserState>,
    name: String,
    arguments: Value,
) -> Result<Value, String> {
    let mut process = state.process.lock().await;
    let running = process
        .as_mut()
        .ok_or_else(|| "Chrome is not connected to Scout".to_string())?;
    running
        .rpc(
            "tools/call",
            json!({ "name": name, "arguments": arguments }),
            90,
        )
        .await
}

#[tauri::command]
async fn stop_chrome_browser(state: tauri::State<'_, ChromeBrowserState>) -> Result<(), String> {
    let mut process = state.process.lock().await;
    if let Some(mut running) = process.take() {
        running.stop().await;
    }
    Ok(())
}

#[tauri::command]
async fn chrome_browser_connected(
    state: tauri::State<'_, ChromeBrowserState>,
) -> Result<bool, String> {
    let mut process = state.process.lock().await;
    let Some(running) = process.as_mut() else {
        return Ok(false);
    };
    match running.child.try_wait() {
        Ok(None) => Ok(true),
        _ => {
            process.take();
            Ok(false)
        }
    }
}

// ── Panel window (compact tray panel) ────────────────────────────────────────

fn toggle_panel<R: Runtime>(app: &AppHandle<R>, anchor: Option<(f64, f64, f64, f64)>) {
    let Some(panel) = app.get_webview_window("panel") else {
        return;
    };
    if panel.is_visible().unwrap_or(false) {
        let _ = panel.hide();
        return;
    }
    if let Some((x, y, w, h)) = anchor {
        // Tray bounds and window positions are physical pixels. Use the
        // panel's actual physical width so centering also works on HiDPI.
        let panel_width = panel
            .outer_size()
            .map(|size| size.width as f64)
            .unwrap_or_else(|_| 360.0 * panel.scale_factor().unwrap_or(1.0));
        let px = x + (w - panel_width) / 2.0;
        let py = y + h + 4.0;
        let _ = panel.set_position(tauri::PhysicalPosition::new(
            px.round() as i32,
            py.round() as i32,
        ));
    }
    let _ = panel.show();
    let _ = panel.set_focus();
}

// ── Tray glyph: tiny radar drawn in code (template-friendly monochrome) ─────

fn radar_icon() -> Image<'static> {
    const S: u32 = 32;
    let mut rgba = vec![0u8; (S * S * 4) as usize];
    let c = (S as f32 - 1.0) / 2.0;
    for y in 0..S {
        for x in 0..S {
            let dx = x as f32 - c;
            let dy = y as f32 - c;
            let d = (dx * dx + dy * dy).sqrt();
            // outer ring + inner ring + sweep beam (NE direction) + center dot
            let ring = (d - 13.5).abs() < 1.2 || (d - 8.0).abs() < 0.9;
            let beam = dy <= 0.0 && dx >= 0.0 && (dy + dx).abs() < 1.0 && d < 13.5;
            let dot = d < 2.2;
            if ring || beam || dot {
                let i = ((y * S + x) * 4) as usize;
                rgba[i] = 0;
                rgba[i + 1] = 0;
                rgba[i + 2] = 0;
                rgba[i + 3] = 255;
            }
        }
    }
    Image::new_owned(rgba, S, S)
}

// ── App setup ────────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::new().build())
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_autostart::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_sql::Builder::new().build())
        .plugin(tauri_plugin_opener::init())
        .manage(TrayState {
            title: Mutex::new(String::new()),
        })
        .manage(OAuthCallbackState::default())
        .manage(ChromeBrowserState::default())
        .setup(|app| {
            // Panel window: compact, frameless, hides on blur.
            let panel =
                WebviewWindowBuilder::new(app, "panel", WebviewUrl::App("panel.html".into()))
                    .title("Scout Panel")
                    .inner_size(360.0, 480.0)
                    .resizable(false)
                    .decorations(false)
                    .always_on_top(true)
                    .visible_on_all_workspaces(true)
                    .skip_taskbar(true)
                    .visible(false)
                    .focused(false)
                    .build()?;
            #[cfg(target_os = "macos")]
            unsafe {
                use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};

                // SAFETY: Tauri owns this NSWindow for the lifetime of `panel`,
                // and setup runs on the macOS main thread.
                let native = &*(panel.ns_window()? as *const NSWindow);
                native.setCollectionBehavior(
                    native.collectionBehavior() | NSWindowCollectionBehavior::FullScreenAuxiliary,
                );
            }
            let panel_for_blur = panel.clone();
            panel.on_window_event(move |event| {
                if let tauri::WindowEvent::Focused(false) = event {
                    let _ = panel_for_blur.hide();
                }
            });

            // Tray menu (right-click).
            let sweep_now = MenuItem::with_id(app, "sweep_now", "Sweep now", true, None::<&str>)?;
            let open_scout =
                MenuItem::with_id(app, "open_scout", "Open Scout", true, None::<&str>)?;
            let pause = MenuItem::with_id(app, "pause_1h", "Pause 1h", true, None::<&str>)?;
            let autostart = CheckMenuItem::with_id(
                app,
                "autostart",
                "Launch at login",
                true,
                false,
                None::<&str>,
            )?;
            let quit = MenuItem::with_id(app, "quit", "Quit Scout", true, None::<&str>)?;
            let menu =
                Menu::with_items(app, &[&sweep_now, &open_scout, &pause, &autostart, &quit])?;

            TrayIconBuilder::with_id("scout-tray")
                .icon(radar_icon())
                .icon_as_template(true)
                .tooltip("Scout")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => app.exit(0),
                    "open_scout" => {
                        if let Some(w) = app.get_webview_window("main") {
                            let _ = w.unminimize();
                            let _ = w.show();
                            let _ = w.set_focus();
                        }
                    }
                    "sweep_now" => {
                        let _ = app.emit("scout:menu", "sweep_now");
                    }
                    "pause_1h" => {
                        let _ = app.emit("scout:menu", "pause_1h");
                    }
                    "autostart" => {
                        let manager = app.autolaunch();
                        match manager.is_enabled() {
                            Ok(true) => {
                                let _ = manager.disable();
                            }
                            Ok(false) => {
                                let _ = manager.enable();
                            }
                            _ => {}
                        }
                    }
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        rect,
                        ..
                    } = event
                    {
                        let scale = tray
                            .app_handle()
                            .get_webview_window("main")
                            .and_then(|w| w.scale_factor().ok())
                            .unwrap_or(1.0);
                        let p = rect.position.to_physical::<i32>(scale);
                        let s = rect.size.to_physical::<u32>(scale);
                        toggle_panel(
                            tray.app_handle(),
                            Some((p.x as f64, p.y as f64, s.width as f64, s.height as f64)),
                        );
                    }
                })
                .build(app)?;

            // Sync autostart check state.
            if let Ok(enabled) = app.autolaunch().is_enabled() {
                let _ = autostart.set_checked(enabled);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Main window hides to tray instead of closing — the sweep loop keeps running.
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            set_tray_badge,
            set_tray_error,
            show_main_window,
            open_chrome_setup,
            set_menu_bar_only,
            get_secret,
            set_secret,
            delete_secret,
            start_oauth_callback,
            cancel_oauth_callback,
            start_chrome_browser,
            call_chrome_browser_tool,
            stop_chrome_browser,
            chrome_browser_connected
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
