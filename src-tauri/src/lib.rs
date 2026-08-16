//! DSH Desktop — the DeepSeek Harness as a native Windows app.
//!
//! Boot model: a splash window (static avant-garde frontend) is shown while a
//! background thread resolves the bundled runtime (node.exe + the pinned
//! @deepseek-ai/dsh tree), either reuses an already-running `dsh web` server
//! or spawns one on a fixed loopback port, then opens the main window pointed
//! at the harness UI. Closing the main window hides it to the tray; quitting
//! from the tray tears the child process tree down.

mod logging;

use logging::{
    LogHub, LogLevel, LogMeta, LogPage, LogQuery, KIND_CHILD_STDOUT, KIND_COMMAND, KIND_DIAGNOSTIC,
    KIND_FILE, KIND_IPC, KIND_LIFECYCLE, KIND_NETWORK, KIND_PERFORMANCE, KIND_PROCESS, KIND_STATE,
    KIND_UI, MODULE_APP, MODULE_ATTACHMENT, MODULE_BOOT, MODULE_HARNESS, MODULE_LOGGER,
    MODULE_PLUGIN, MODULE_TRAY, MODULE_WINDOW,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent,
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

/// Windows: launch the child without a console window.
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Fixed loopback ports the app may run the harness on. Keeping the set fixed
/// lets the capability file grant IPC to these exact origins.
const FIXED_PORTS: [u16; 4] = [3080, 43210, 43211, 43212];

const BOOT_TIMEOUT: Duration = Duration::from_secs(240);
const POLL_INTERVAL: Duration = Duration::from_millis(250);

#[derive(Clone, Serialize, Default)]
struct BootState {
    /// probe | spawn | wait | serve | ready | failed
    stage: String,
    /// human-readable detail line for the splash boot log
    detail: String,
    /// terminal error message when stage == failed
    error: Option<String>,
    /// resolved harness URL when ready
    url: Option<String>,
    /// tail of the server log, for the failed panel
    log_tail: Option<String>,
}

struct AppState {
    boot: Arc<Mutex<BootState>>,
    child: Arc<Mutex<Option<Child>>>,
    /// bumped on retry so a stale boot thread bails out
    generation: Arc<Mutex<u64>>,
    /// structured runtime log hub (ring buffer + JSONL file + UI events)
    logs: Arc<LogHub>,
    /// Windows job object: when the app dies for ANY reason, the OS kills the
    /// harness process tree (KILL_ON_JOB_CLOSE). Kept alive for the app's
    /// lifetime (raw handle as isize — HANDLE is not Send in windows 0.61).
    #[cfg(windows)]
    job: Arc<Mutex<Option<isize>>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            boot: Arc::new(Mutex::new(BootState::default())),
            child: Arc::new(Mutex::new(None)),
            generation: Arc::new(Mutex::new(0)),
            logs: Arc::new(LogHub::default()),
            #[cfg(windows)]
            job: Arc::new(Mutex::new(None)),
        }
    }
}

#[cfg(windows)]
fn assign_to_kill_job(child: &Child) -> Option<isize> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };
    unsafe {
        let job = CreateJobObjectW(None, windows::core::PCWSTR::null()).ok()?;
        let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let size = std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32;
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const std::ffi::c_void,
            size,
        )
        .ok()?;
        AssignProcessToJobObject(job, HANDLE(child.as_raw_handle() as *mut _)).ok()?;
        Some(job.0 as isize)
    }
}

// ---------------------------------------------------------------------------
// environment / ports
// ---------------------------------------------------------------------------

fn resolve_dsh_home() -> PathBuf {
    if let Ok(home) = std::env::var("DSH_HOME") {
        if !home.trim().is_empty() {
            return PathBuf::from(home);
        }
    }
    if let Ok(profile) = std::env::var("USERPROFILE") {
        return PathBuf::from(profile).join(".dsh");
    }
    PathBuf::from(".dsh")
}

fn app_log_file(app: &AppHandle, name: &str) -> PathBuf {
    match app.path().app_log_dir() {
        Ok(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            dir.join(name)
        }
        Err(_) => std::env::temp_dir().join(format!("dsh-desktop-{name}")),
    }
}

fn is_dsh_response(body: &str) -> bool {
    body.contains("__DSH_BOOT__")
}

/// TCP-connect + minimal HTTP GET; returns the body when the port serves DSH.
fn probe_dsh(port: u16) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let request = format!("GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
    stream.write_all(request.as_bytes()).ok()?;
    let mut buf = Vec::new();
    let mut chunk = [0u8; 8192];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 256 * 1024 {
                    break;
                }
            }
        }
    }
    let body = String::from_utf8_lossy(&buf).to_string();
    is_dsh_response(&body).then_some(body)
}

fn tcp_free(port: u16) -> bool {
    TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// POST a minimal settings.describe RPC and report whether the settings
/// service answered ok. The harness's HTTP server binds before its plugin
/// tree (settings included) is fully up, so a page loaded in that window
/// hits failing RPCs — which leaves the 内测声明 dialog stuck. This probe
/// gates the main window on the settings service actually being ready.
fn settings_ready(port: u16) -> bool {
    let Ok(mut stream) = TcpStream::connect(("127.0.0.1", port)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let body = r#"{"type":"client-request","rpcId":"dsh-desktop-readiness","method":"settings.describe","payload":{}}"#;
    let request = format!(
        "POST /api/settings.describe HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        body.len(),
        body
    );
    if stream.write_all(request.as_bytes()).is_err() {
        return false;
    }
    let mut buf = Vec::new();
    let mut chunk = [0u8; 4096];
    loop {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                buf.extend_from_slice(&chunk[..n]);
                if buf.len() > 64 * 1024 {
                    break;
                }
            }
        }
    }
    let text = String::from_utf8_lossy(&buf);
    text.contains("\"ok\":true") || text.contains("\"ok\": true")
}

/// Wait up to `timeout` for the harness settings service on `port` to answer
/// settings.describe successfully. Best effort: returns regardless.
fn wait_settings_ready(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while !settings_ready(port) && Instant::now() < deadline {
        thread::sleep(POLL_INTERVAL);
    }
    settings_ready(port)
}

/// Pick the port the harness should run on: reuse a live DSH when present,
/// otherwise the first fixed port that is free, otherwise any free port.
/// `DSH_DESKTOP_FORCE_PORT` (testing hook) skips probing and forces a spawn.
fn resolve_target_port(logs: &LogHub) -> (u16, Option<String>) {
    if let Ok(forced) = std::env::var("DSH_DESKTOP_FORCE_PORT") {
        if let Ok(port) = forced.parse::<u16>() {
            logs.debug(
                MODULE_BOOT,
                KIND_NETWORK,
                format!("DSH_DESKTOP_FORCE_PORT is set; forcing spawn on {port}"),
            );
            return (port, None);
        }
    }
    for port in FIXED_PORTS {
        match probe_dsh(port) {
            Some(body) => {
                logs.debug(
                    MODULE_BOOT,
                    KIND_NETWORK,
                    format!("port {port} answered the DSH probe; will reuse it"),
                );
                return (port, Some(body));
            }
            None => {
                logs.trace(
                    MODULE_BOOT,
                    KIND_NETWORK,
                    format!("port {port} did not answer the DSH probe"),
                );
            }
        }
    }
    for port in FIXED_PORTS {
        if tcp_free(port) {
            logs.debug(
                MODULE_BOOT,
                KIND_NETWORK,
                format!("fixed port {port} is free; selected for a new harness"),
            );
            return (port, None);
        }
    }
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) {
        if let Ok(addr) = listener.local_addr() {
            logs.warn(
                MODULE_BOOT,
                KIND_NETWORK,
                format!(
                    "all fixed ports are busy; falling back to ephemeral port {}",
                    addr.port()
                ),
            );
            return (addr.port(), None);
        }
    }
    logs.error(
        MODULE_BOOT,
        KIND_NETWORK,
        "could not bind any loopback port; falling back to 3080",
    );
    (3080, None)
}

// ---------------------------------------------------------------------------
// child process management
// ---------------------------------------------------------------------------

fn kill_child_tree(child: &mut Child) {
    let pid = child.id();
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// Tauri's path resolver returns Windows extended-length (`\\?\`) paths, which
/// Node's argv/realpath handling rejects. Strip the prefix for child-process use.
fn clean_path(path: &std::path::Path) -> PathBuf {
    let text = path.to_string_lossy();
    if let Some(stripped) = text.strip_prefix(r"\\?\") {
        PathBuf::from(stripped)
    } else if let Some(stripped) = text.strip_prefix(r"\\.\") {
        PathBuf::from(stripped)
    } else {
        path.to_path_buf()
    }
}

/// Resolve the bundled tools directory (pnpm lives there for plugin management).
fn tools_dir(app: &AppHandle) -> Option<PathBuf> {
    let candidates = [
        app.path()
            .resolve("resources/tools", tauri::path::BaseDirectory::Resource)
            .ok(),
        app.path()
            .resolve("tools", tauri::path::BaseDirectory::Resource)
            .ok(),
    ];
    candidates
        .into_iter()
        .flatten()
        .find(|path| path.is_dir())
        .map(|path| clean_path(&path))
}

/// PATH for child processes: bundled tools first, then the system PATH.
fn child_path(app: &AppHandle) -> String {
    let system = std::env::var("PATH").unwrap_or_default();
    let mut entries: Vec<String> = Vec::new();
    if let Some(tools) = tools_dir(app) {
        entries.push(tools.display().to_string());
        entries.push(tools.join("pnpm").display().to_string());
    }
    entries.push(system);
    entries.join(";")
}

fn spawn_harness(
    app: &AppHandle,
    node: &Path,
    bin: &Path,
    runtime_dir: &Path,
    dsh_home: &Path,
    port: u16,
    log_path: &Path,
    logs: &Arc<LogHub>,
) -> std::io::Result<Child> {
    let node = clean_path(node);
    let bin = clean_path(bin);
    let runtime_dir = clean_path(runtime_dir);
    let mut cmd = Command::new(&node);
    cmd.arg(&bin)
        .args(["web", "--host", "127.0.0.1", "--port", &port.to_string()])
        .args([
            "--trusted-host",
            &format!("127.0.0.1:{port}"),
            "--trusted-host",
            &format!("localhost:{port}"),
        ])
        .env("DSH_HOME", dsh_home)
        .env("PATH", child_path(app))
        .current_dir(&runtime_dir);

    // The raw dsh-web.log stays human-readable (it is also the boot-failure
    // tail shown by the splash), while each child output line is mirrored
    // into the structured log hub below.
    let raw_file = match std::fs::File::create(log_path) {
        Ok(file) => Some(file),
        Err(error) => {
            logs.warn(
                MODULE_BOOT,
                KIND_FILE,
                format!(
                    "could not create the raw harness log {}: {error}",
                    log_path.display()
                ),
            );
            cmd.stdout(Stdio::null());
            cmd.stderr(Stdio::null());
            None
        }
    };
    if raw_file.is_some() {
        cmd.stdout(Stdio::piped());
        cmd.stderr(Stdio::piped());
    }

    logs.info(
        MODULE_BOOT,
        KIND_PROCESS,
        format!(
            "spawn dsh web: node={} bin={} cwd={} dsh_home={} port={} raw_log={}",
            node.display(),
            bin.display(),
            runtime_dir.display(),
            dsh_home.display(),
            port,
            log_path.display()
        ),
    );

    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd.spawn()?;

    if let Some(file) = raw_file {
        let writer = Arc::new(Mutex::new(file));
        {
            let mut writer = writer.lock().unwrap();
            let _ = writeln!(
                writer,
                "dsh-desktop spawn: node={:?} bin={:?} cwd={:?} dsh_home={:?} port={port}",
                node, bin, runtime_dir, dsh_home
            );
        }
        if let Some(stdout) = child.stdout.take() {
            logging::stream_child_output(stdout, false, writer.clone(), logs.clone());
        }
        if let Some(stderr) = child.stderr.take() {
            logging::stream_child_output(stderr, true, writer, logs.clone());
        }
    }
    Ok(child)
}

fn log_tail(path: &Path, lines: usize) -> String {
    let Ok(content) = std::fs::read_to_string(path) else {
        return String::new();
    };
    let all: Vec<&str> = content.lines().collect();
    let start = all.len().saturating_sub(lines);
    all[start..].join("\n")
}

// ---------------------------------------------------------------------------
// boot flow
// ---------------------------------------------------------------------------

fn set_boot(app: &AppHandle, state: &AppState, next: BootState) {
    if let Ok(mut current) = state.boot.lock() {
        *current = next.clone();
    }

    let level = match next.stage.as_str() {
        "failed" => LogLevel::Error,
        "ready" | "serve" => LogLevel::Info,
        _ => LogLevel::Debug,
    };
    let mut message = format!("boot stage -> {} | {}", next.stage, next.detail);
    if let Some(error) = next.error.as_deref() {
        message.push_str(" | error: ");
        message.push_str(error);
    }
    if let Some(url) = next.url.as_deref() {
        message.push_str(" | url: ");
        message.push_str(url);
    }
    let context = serde_json::json!({
        "stage": next.stage.clone(),
        "url": next.url.clone(),
        "error": next.error.clone(),
        "logTail": next.log_tail.clone(),
    });
    state
        .logs
        .log_with(level, MODULE_BOOT, KIND_STATE, message, context);

    let _ = app.emit("boot://stage", &next);
}

fn generation_current(state: &AppState, generation: u64) -> bool {
    state
        .generation
        .lock()
        .map(|guard| *guard == generation)
        .unwrap_or(false)
}

fn open_main_window(app: &AppHandle, url: String) {
    // A retry (or a port change) with an existing window navigates it instead.
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(parsed) = url.parse::<tauri::Url>() {
            let logs = app.state::<AppState>().logs.clone();
            logs.debug(
                MODULE_WINDOW,
                KIND_UI,
                format!("main window already exists; navigating to {url}"),
            );
            let _ = window.navigate(parsed);
            let _ = window.show();
            let _ = window.set_focus();
        }
        return;
    }
    // The Aurora Engine skin: injected at document creation on every page of
    // this webview (assembled by scripts/build-skin.mjs from skin/ sources).
    const SKIN: &str = include_str!("../scripts/init.js");
    const PROBE: &str = "window.__dsh_probe=(window.__dsh_probe||0)+1;";
    let parsed = match url.parse::<tauri::Url>() {
        Ok(parsed) => parsed,
        Err(error) => {
            let logs = app.state::<AppState>().logs.clone();
            logs.error(
                MODULE_BOOT,
                KIND_DIAGNOSTIC,
                format!("invalid harness URL {url:?}: {error}"),
            );
            eprintln!("dsh-desktop: invalid harness URL: {error}");
            return;
        }
    };
    let handle = app.clone();
    let window = match WebviewWindowBuilder::new(app, "main", WebviewUrl::External(parsed))
        .title("DSH")
        .inner_size(1480.0, 940.0)
        .min_inner_size(1024.0, 640.0)
        .center()
        .decorations(false)
        .shadow(true)
        .visible(false)
        .initialization_script(PROBE)
        .initialization_script(SKIN)
        .on_page_load(move |win, _payload| {
            // Belt-and-braces: re-apply the (idempotent) skin once the page
            // finishes loading, in case document-created injection was skipped.
            let _ = win.eval(SKIN);
            let _ = win.show();
            let _ = win.set_focus();
            let logs = handle.state::<AppState>().logs.clone();
            logs.info(
                MODULE_WINDOW,
                KIND_LIFECYCLE,
                "main window loaded; splash can close",
            );
            if let Some(splash) = handle.get_webview_window("splash") {
                let _ = splash.close();
            }
        })
        .build()
    {
        Ok(window) => window,
        Err(error) => {
            let logs = app.state::<AppState>().logs.clone();
            logs.error(
                MODULE_WINDOW,
                KIND_DIAGNOSTIC,
                format!("could not open the main window: {error}"),
            );
            eprintln!("dsh-desktop: could not open the main window: {error}");
            return;
        }
    };
    let _ = window;
}

fn boot_flow(app: AppHandle, state: AppState, generation: u64) {
    let set = |stage: &str,
               detail: &str,
               error: Option<String>,
               url: Option<String>,
               log_tail: Option<String>| {
        if !generation_current(&state, generation) {
            return;
        }
        set_boot(
            &app,
            &state,
            BootState {
                stage: stage.to_string(),
                detail: detail.to_string(),
                error,
                url,
                log_tail,
            },
        );
    };

    state.logs.info(
        MODULE_BOOT,
        KIND_LIFECYCLE,
        format!("boot flow started (generation {generation})"),
    );
    set("probe", "scanning for a live harness", None, None, None);

    // Resolve bundled runtime pieces.
    let resource_root = match app
        .path()
        .resolve("resources/runtime", tauri::path::BaseDirectory::Resource)
    {
        Ok(path) if path.join("node.exe").exists() => path,
        Ok(_) => match app
            .path()
            .resolve("runtime", tauri::path::BaseDirectory::Resource)
        {
            Ok(fallback) => fallback,
            Err(error) => {
                set(
                    "failed",
                    "runtime resources are missing",
                    Some(format!("resource resolution failed: {error}")),
                    None,
                    None,
                );
                return;
            }
        },
        Err(error) => {
            set(
                "failed",
                "runtime resources are missing",
                Some(format!("resource resolution failed: {error}")),
                None,
                None,
            );
            return;
        }
    };
    let node = resource_root.join("node.exe");
    let bin = resource_root
        .join("node_modules")
        .join("@deepseek-ai")
        .join("dsh")
        .join("lib")
        .join("bin.js");
    state.logs.debug(
        MODULE_BOOT,
        KIND_FILE,
        format!(
            "bundled runtime resolved: root={} node={} cli={}",
            resource_root.display(),
            node.display(),
            bin.display()
        ),
    );
    if !node.exists() || !bin.exists() {
        set(
            "failed",
            "runtime bundle is incomplete",
            Some(format!(
                "expected node.exe and the dsh CLI at:\n{}\n{}",
                node.display(),
                bin.display()
            )),
            None,
            None,
        );
        return;
    }
    let dsh_home = resolve_dsh_home();
    state.logs.debug(
        MODULE_BOOT,
        KIND_STATE,
        format!("DSH_HOME resolved to {}", dsh_home.display()),
    );

    // Bring the DSH Desktop hot-swap patch layer forward to this harness
    // generation *before* the process composes its tree. After a restart,
    // plugins previously supplied by the old boot bundle snapshot must be
    // written back as full hot-layer rows, otherwise they would be missing
    // until the plugin panel happened to refresh.
    if let Some((_, manifest)) = read_profile_manifest(&dsh_home) {
        let profile = profile_dir(&dsh_home);
        let bundles = manifest_bundle_names(&manifest);
        let mut plugin_state = load_plugin_state(&profile);
        if let Err(error) =
            refresh_plugin_state_generation(&profile, &mut plugin_state, generation, &bundles)
        {
            state.logs.warn(
                MODULE_PLUGIN,
                KIND_STATE,
                format!("plugin hot-swap state migration failed: {error}"),
            );
            eprintln!("dsh-desktop: plugin hot-swap state migration failed: {error}");
        }
    }

    let log_path = app_log_file(&app, "dsh-web.log");

    let (port, reuse_body) = resolve_target_port(&state.logs);
    let url = format!("http://127.0.0.1:{port}/");
    state.logs.debug(
        MODULE_BOOT,
        KIND_NETWORK,
        format!(
            "target port resolved: {port} ({})",
            if reuse_body.is_some() {
                "live harness found"
            } else {
                "spawning a new harness"
            }
        ),
    );

    if reuse_body.is_some() {
        set(
            "reuse",
            &format!("harness already live on 127.0.0.1:{port}"),
            None,
            Some(url.clone()),
            None,
        );
        // The server may still be composing its plugin tree; a page loaded
        // now would hit failing settings RPCs (stuck 内测声明 dialog). Wait
        // briefly for the settings service before opening the window.
        let ready = wait_settings_ready(port, Duration::from_secs(6));
        state.logs.info(
            MODULE_BOOT,
            KIND_NETWORK,
            format!("reused harness settings service ready={ready} on port {port}"),
        );
        let _ = open_main_window(&app, url);
        return;
    }

    set(
        "spawn",
        &format!("booting harness on 127.0.0.1:{port}"),
        None,
        None,
        None,
    );

    let child = match spawn_harness(
        &app,
        &node,
        &bin,
        &resource_root,
        &dsh_home,
        port,
        &log_path,
        &state.logs,
    ) {
        Ok(child) => child,
        Err(error) => {
            set(
                "failed",
                "could not start the harness",
                Some(error.to_string()),
                None,
                None,
            );
            return;
        }
    };
    let child_pid = child.id();
    state.logs.info(
        MODULE_HARNESS,
        KIND_PROCESS,
        format!("harness child process started (pid {child_pid})"),
    );
    *state.child.lock().unwrap() = Some(child);

    // Guarantee the harness dies with us, even on TerminateProcess.
    #[cfg(windows)]
    {
        if let Ok(mut guard) = state.job.lock() {
            if let Some(previous) = guard.take() {
                let _ = unsafe {
                    windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(
                        previous as *mut std::ffi::c_void,
                    ))
                };
            }
            if let Some(child) = state.child.lock().unwrap().as_ref() {
                let assigned = assign_to_kill_job(child);
                state.logs.debug(
                    MODULE_HARNESS,
                    KIND_PROCESS,
                    format!(
                        "kill-on-close job object assigned={} for pid {}",
                        assigned.is_some(),
                        child.id()
                    ),
                );
                *guard = assigned;
            }
        }
    }

    set("wait", "composing plugin tree", None, None, None);

    let deadline = Instant::now() + BOOT_TIMEOUT;
    let mut last_heartbeat = Instant::now();
    loop {
        if !generation_current(&state, generation) {
            return;
        }
        if last_heartbeat.elapsed() >= Duration::from_secs(5) {
            state.logs.trace(
                MODULE_BOOT,
                KIND_NETWORK,
                format!(
                    "still waiting for the harness on 127.0.0.1:{port} ({:.1}s elapsed)",
                    (Instant::now() + BOOT_TIMEOUT - deadline).as_secs_f32()
                ),
            );
            last_heartbeat = Instant::now();
        }
        if tcp_free(port) {
            // port not bound yet — keep waiting
        } else if let Some(body) = probe_dsh(port) {
            let _ = body;
            set(
                "serve",
                "serving the harness UI",
                None,
                Some(url.clone()),
                None,
            );
            // Same readiness gate as the reuse path: never open the window
            // against a half-initialized settings service.
            let ready = wait_settings_ready(port, Duration::from_secs(6));
            state.logs.info(
                MODULE_BOOT,
                KIND_NETWORK,
                format!("harness answered on port {port}; settings service ready={ready}"),
            );
            let _ = open_main_window(&app, url);
            return;
        }
        if Instant::now() > deadline {
            let tail = log_tail(&log_path, 30);
            state.logs.error(
                MODULE_BOOT,
                KIND_NETWORK,
                format!(
                    "harness did not come up on port {port} in {}s; killing child; log tail:\n{tail}",
                    BOOT_TIMEOUT.as_secs()
                ),
            );
            set(
                "failed",
                "harness did not come up in time",
                Some("the server log tail may explain why".to_string()),
                None,
                Some(tail),
            );
            kill_child_tree(state.child.lock().unwrap().as_mut().expect("child exists"));
            return;
        }
        let exited = state
            .child
            .lock()
            .unwrap()
            .as_mut()
            .map(|child| child.try_wait().ok().flatten().is_some())
            .unwrap_or(false);
        if exited {
            let tail = log_tail(&log_path, 30);
            state.logs.error(
                MODULE_HARNESS,
                KIND_PROCESS,
                format!("harness process exited during boot; log tail:\n{tail}"),
            );
            set(
                "failed",
                "the harness process exited during boot",
                None,
                None,
                Some(tail),
            );
            return;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn start_boot(app: &AppHandle, state: &AppState) {
    // Kill any previous child, bump the generation so stale threads bail.
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            state.logs.warn(
                MODULE_HARNESS,
                KIND_PROCESS,
                format!("killing previous harness child (pid {})", child.id()),
            );
            kill_child_tree(&mut child);
        }
    }
    let generation = {
        let mut guard = state.generation.lock().unwrap();
        *guard += 1;
        *guard
    };
    state.logs.info(
        MODULE_BOOT,
        KIND_LIFECYCLE,
        format!("boot requested; stale boot threads will use generation {generation} as a barrier"),
    );
    let app = app.clone();
    let state = AppState {
        boot: state.boot.clone(),
        child: state.child.clone(),
        generation: state.generation.clone(),
        logs: state.logs.clone(),
        #[cfg(windows)]
        job: state.job.clone(),
    };
    thread::spawn(move || boot_flow(app, state, generation));
}

fn show_main(app: &AppHandle) {
    let logs = app.state::<AppState>().logs.clone();
    if let Some(window) = app.get_webview_window("main") {
        logs.debug(
            MODULE_WINDOW,
            KIND_UI,
            "showing the main window from tray/single-instance",
        );
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else if let Some(splash) = app.get_webview_window("splash") {
        logs.debug(
            MODULE_WINDOW,
            KIND_UI,
            "main window is not ready; showing splash instead",
        );
        let _ = splash.show();
        let _ = splash.set_focus();
    }
}

// ---------------------------------------------------------------------------
// tray
// ---------------------------------------------------------------------------

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Show DSH Desktop", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit DSH Desktop", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    TrayIconBuilder::with_id("dsh-tray")
        .icon(app.default_window_icon().expect("bundle icon").clone())
        .tooltip("DSH Desktop")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    let logs = app.state::<AppState>().logs.clone();
    logs.debug(
        MODULE_TRAY,
        KIND_LIFECYCLE,
        "system tray icon ready (show / quit)",
    );
    Ok(())
}

// ---------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------

#[tauri::command]
fn boot_state(state: tauri::State<'_, AppState>) -> BootState {
    state.boot.lock().unwrap().clone()
}

#[tauri::command]
fn retry_boot(app: AppHandle, state: tauri::State<'_, AppState>) {
    state
        .logs
        .info(MODULE_BOOT, KIND_COMMAND, "retry_boot invoked from the UI");
    start_boot(&app, &state);
}

#[tauri::command]
fn reveal_logs(app: AppHandle, state: tauri::State<'_, AppState>) {
    let opened = if let Ok(dir) = app.path().app_log_dir() {
        let _ = std::fs::create_dir_all(&dir);
        Command::new("explorer")
            .arg(&dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .is_ok()
    } else {
        false
    };
    state.logs.info(
        MODULE_LOGGER,
        KIND_FILE,
        format!("reveal_logs invoked; explorer spawned={opened}"),
    );
}

#[tauri::command]
fn log_query(query: LogQuery, state: tauri::State<'_, AppState>) -> LogPage {
    state.logs.query(&query)
}

#[tauri::command]
fn log_meta(state: tauri::State<'_, AppState>) -> LogMeta {
    state.logs.meta()
}

#[tauri::command]
fn log_clear(state: tauri::State<'_, AppState>) -> Result<usize, String> {
    let cleared = state.logs.clear_ring();
    state.logs.info(
        MODULE_LOGGER,
        KIND_STATE,
        format!("in-memory ring cleared ({cleared} entries); JSONL file history is untouched"),
    );
    Ok(cleared)
}

#[tauri::command]
fn log_client(
    level: String,
    module: String,
    message: String,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    let level = logging::parse_level(&level)?;
    state.logs.record(level, &module, KIND_UI, message, None);
    Ok(())
}

#[derive(Clone, Serialize)]
struct StagedAttachment {
    /// 用户拖入的原始路径
    original: String,
    /// 复制后的绝对路径（供 agent 的 read 工具读取）
    path: String,
    /// 文件名/目录名（不含父目录）
    name: String,
    /// "file" | "directory"
    kind: String,
}

/// 生成不冲突的目标路径：foo.txt → foo.txt / foo-1.txt / foo-2.txt …
fn unique_destination(dir: &std::path::Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = std::path::Path::new(name);
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "attachment".to_string());
    let ext = path
        .extension()
        .map(|e| format!(".{}", e.to_string_lossy()))
        .unwrap_or_default();
    for n in 1.. {
        let candidate = dir.join(format!("{stem}-{n}{ext}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

/// 递归复制目录（跳过符号链接等非常规文件）。
fn copy_dir_recursive(src: &std::path::Path, dst: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dst)?;
    for entry in std::fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let from = entry.path();
        let to = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&from, &to)?;
        } else if ty.is_file() {
            std::fs::copy(&from, &to)?;
        }
    }
    Ok(())
}

/// 把拖入的本地文件/目录复制到 `~/.dsh/attachments/`，返回落盘绝对路径。
/// 路径列表通常来自 Tauri 的 `tauri://drag-drop` 事件。
#[tauri::command]
fn stage_attachments(
    paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<Vec<StagedAttachment>, String> {
    let dir = resolve_dsh_home().join("attachments");
    std::fs::create_dir_all(&dir).map_err(|error| {
        let message = format!("create attachments dir: {error}");
        state.logs.error(MODULE_ATTACHMENT, KIND_FILE, &message);
        message
    })?;
    state.logs.debug(
        MODULE_ATTACHMENT,
        KIND_IPC,
        format!(
            "stage_attachments received {} path(s); staging into {}",
            paths.len(),
            dir.display()
        ),
    );

    let mut staged = Vec::new();
    for raw in paths {
        let src = PathBuf::from(&raw);
        if !src.exists() {
            state.logs.warn(
                MODULE_ATTACHMENT,
                KIND_FILE,
                format!("skipping missing drop path {raw}"),
            );
            continue;
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "attachment".to_string());
        let dst = unique_destination(&dir, &name);
        if src.is_dir() {
            copy_dir_recursive(&src, &dst).map_err(|error| {
                let message = format!("copy dir {raw}: {error}");
                state.logs.error(MODULE_ATTACHMENT, KIND_FILE, &message);
                message
            })?;
            let staged_path = clean_path(&dst).display().to_string();
            state.logs.info(
                MODULE_ATTACHMENT,
                KIND_FILE,
                format!("staged directory {raw} -> {staged_path}"),
            );
            staged.push(StagedAttachment {
                original: raw,
                path: staged_path,
                name,
                kind: "directory".to_string(),
            });
        } else if src.is_file() {
            std::fs::copy(&src, &dst).map_err(|error| {
                let message = format!("copy {raw}: {error}");
                state.logs.error(MODULE_ATTACHMENT, KIND_FILE, &message);
                message
            })?;
            let staged_path = clean_path(&dst).display().to_string();
            state.logs.info(
                MODULE_ATTACHMENT,
                KIND_FILE,
                format!("staged file {raw} -> {staged_path}"),
            );
            staged.push(StagedAttachment {
                original: raw,
                path: staged_path,
                name,
                kind: "file".to_string(),
            });
        }
    }
    state.logs.info(
        MODULE_ATTACHMENT,
        KIND_COMMAND,
        format!("stage_attachments done: {} item(s) staged", staged.len()),
    );
    Ok(staged)
}

// ---------------------------------------------------------------------------
// plugin management (the exe speaks the same `dsh plugin` pnpm protocol)
// ---------------------------------------------------------------------------

const PLUGIN_PROFILE: &str = "web";
const PLUGIN_STATE_FILENAME: &str = ".dsh-desktop-plugins.json";
const PATCH_MANAGED_BEGIN: &str =
    "# BEGIN DSH_DESKTOP_PLUGINS — managed by DSH Desktop; edits between the markers are overwritten.";
const PATCH_MANAGED_END: &str = "# END DSH_DESKTOP_PLUGINS";
const PLUGIN_BLOCK_MARKER: &str = "# dsh-desktop:plugin ";

#[derive(Serialize, Deserialize, Clone)]
struct PluginSwitchEntry {
    name: String,
    #[serde(default = "default_enabled")]
    enabled: bool,
    /// `boot-bundle`: the running harness already composes this package from
    /// the boot-time bundle snapshot, so the hot layer only needs
    /// `disabled` overrides. `hot-layer`: the hot patch layer owns the full
    /// row set (used for plugins installed during this harness run and for
    /// every managed plugin after the next harness restart).
    #[serde(default = "default_origin")]
    origin: String,
    /// The patch rows this package contributes when it is enabled. These are
    /// either the package's own `dsh.bundle.patch` list, an existing user
    /// patch row discovered in cordis.patch.yml, or a generated row.
    rows: Vec<serde_json::Value>,
    /// Set when rows came from the package manifest (informational).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    bundle_patch: Option<String>,
    /// Original YAML text of the bundle patch. Preserved verbatim so custom
    /// YAML tags such as `!!js` survive the hot layer round-trip.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    patch_text: Option<String>,
    /// True when the package contributes a browser half (`dsh.client` or an
    /// `exports["./client"]` entry). The webview needs a page reload after a
    /// host-side hot swap so the new client graph is actually injected.
    #[serde(default)]
    client: bool,
}

#[derive(Serialize, Deserialize, Default, Clone)]
struct PluginSwitchState {
    #[serde(default = "plugin_state_version")]
    version: u32,
    /// AppState generation of the harness run this state was authored for.
    /// When it differs, the harness has restarted and `boot-bundle` entries
    /// can safely become `hot-layer` entries (the synced manifest no longer
    /// puts them in the boot bundle snapshot).
    #[serde(default)]
    generation: u64,
    #[serde(default)]
    plugins: BTreeMap<String, PluginSwitchEntry>,
}

fn plugin_state_version() -> u32 {
    3
}

fn default_enabled() -> bool {
    true
}

fn default_origin() -> String {
    "hot-layer".to_string()
}

fn current_harness_generation(app_state: &tauri::State<'_, AppState>) -> u64 {
    app_state.generation.lock().map(|guard| *guard).unwrap_or(0)
}

/// After a harness restart the boot bundle snapshot no longer contains
/// state-managed packages (they were removed from `dsh.profile.bundles`), so
/// the hot patch layer must contribute their full row set again.
fn refresh_plugin_state_generation(
    profile: &PathBuf,
    state: &mut PluginSwitchState,
    generation: u64,
    manifest_bundles: &[String],
) -> Result<bool, String> {
    if state.generation == generation {
        return Ok(false);
    }
    // The harness restarted. A package that is still in the fresh boot
    // bundle list keeps using override-only patches; every other managed
    // package must now contribute its full rows from the hot layer.
    for entry in state.plugins.values_mut() {
        entry.origin = if manifest_bundles.iter().any(|bundle| bundle == &entry.name) {
            "boot-bundle".to_string()
        } else {
            "hot-layer".to_string()
        };
    }
    state.generation = generation;
    if !state.plugins.is_empty() {
        write_managed_patch(profile, state)?;
    }
    save_plugin_state(profile, state)?;
    Ok(true)
}

#[derive(serde::Serialize)]
struct PluginDependency {
    name: String,
    spec: serde_json::Value,
    enabled: bool,
    managed: bool,
    client: bool,
}

#[derive(serde::Serialize)]
struct PluginList {
    home: String,
    profile: String,
    bundles: Vec<String>,
    dependencies: Vec<PluginDependency>,
    pnpm: bool,
}

#[derive(serde::Serialize)]
struct PluginToggleResult {
    message: String,
    reload: bool,
}

#[derive(serde::Serialize)]
struct PluginManageResult {
    output: String,
    reload: bool,
    /// Package names whose browser half changed; the webview reloads after
    /// the host graph has caught up so the new client graph is injected.
    clients: Vec<String>,
}

// ---------------------------------------------------------------------------
// small file helpers (atomic writes keep the HMR watcher from seeing halves)
// ---------------------------------------------------------------------------

fn profile_dir(home: &PathBuf) -> PathBuf {
    home.join("profiles").join(PLUGIN_PROFILE)
}

fn profile_manifest_path(profile: &PathBuf) -> PathBuf {
    profile.join("package.json")
}

fn profile_patch_path(profile: &PathBuf) -> PathBuf {
    profile.join("cordis.patch.yml")
}

fn plugin_state_path(profile: &PathBuf) -> PathBuf {
    profile.join(PLUGIN_STATE_FILENAME)
}

fn read_profile_manifest(home: &PathBuf) -> Option<(String, serde_json::Value)> {
    let profile = profile_dir(home);
    let path = profile_manifest_path(&profile);
    let raw = std::fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some((path.display().to_string(), value))
}

fn read_json(path: &std::path::Path) -> Result<serde_json::Value, String> {
    let raw = std::fs::read_to_string(path)
        .map_err(|error| format!("read {}: {error}", path.display()))?;
    serde_json::from_str(&raw).map_err(|error| format!("parse {}: {error}", path.display()))
}

fn write_atomic(path: &std::path::Path, content: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("create {}: {error}", parent.display()))?;
    }
    let file_name = path
        .file_name()
        .map(|name| name.to_string_lossy().to_string())
        .unwrap_or_else(|| "dsh-desktop-tmp".to_string());
    let nonce = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or(0);
    let tmp = path.with_file_name(format!(
        ".{file_name}.dsh-desktop-{}-{nonce}.tmp",
        std::process::id()
    ));
    std::fs::write(&tmp, content).map_err(|error| format!("write {}: {error}", tmp.display()))?;
    if let Err(rename_error) = std::fs::rename(&tmp, path) {
        // Windows fallback: some filesystems refuse replacing an existing file
        // through rename, even though Rust normally uses MOVEFILE_REPLACE_EXISTING.
        let _ = std::fs::remove_file(path);
        std::fs::rename(&tmp, path)
            .map_err(|error| format!("replace {} after {rename_error}: {error}", path.display()))?;
    }
    Ok(())
}

fn write_json(path: &std::path::Path, value: &serde_json::Value) -> Result<(), String> {
    let mut text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    text.push('\n');
    write_atomic(path, &text)
}

fn load_plugin_state(profile: &PathBuf) -> PluginSwitchState {
    let path = plugin_state_path(profile);
    let Ok(raw) = std::fs::read_to_string(&path) else {
        let state = PluginSwitchState::default();
        return PluginSwitchState {
            version: plugin_state_version(),
            ..state
        };
    };
    let mut state: PluginSwitchState = serde_json::from_str(&raw).unwrap_or_default();
    state.version = plugin_state_version();
    state
}

fn save_plugin_state(profile: &PathBuf, state: &PluginSwitchState) -> Result<(), String> {
    let value = serde_json::to_value(state).map_err(|error| error.to_string())?;
    write_json(&plugin_state_path(profile), &value)
}

fn parse_yaml_to_json_array(text: &str) -> Result<Vec<serde_json::Value>, String> {
    let parsed: serde_yaml::Value =
        serde_yaml::from_str(text).map_err(|error| format!("parse YAML: {error}"))?;
    let sequence = parsed
        .as_sequence()
        .ok_or_else(|| "YAML patch must be a top-level list".to_string())?;
    sequence
        .iter()
        .map(|item| serde_json::to_value(item).map_err(|error| error.to_string()))
        .collect()
}

fn yaml_rows_string(rows: &[serde_json::Value]) -> Result<String, String> {
    serde_yaml::to_string(&rows).map_err(|error| format!("serialize YAML: {error}"))
}

// ---------------------------------------------------------------------------
// patch-row discovery / hot-swap patch generation
// ---------------------------------------------------------------------------

fn package_dir(profile: &PathBuf, package_name: &str) -> Option<PathBuf> {
    let candidate = profile.join("node_modules").join(package_name);
    if candidate.join("package.json").exists() {
        return Some(candidate);
    }
    // pnpm's hoisted layout usually places scoped packages exactly at
    // node_modules/@scope/name; the candidate above already covers that.
    None
}

fn bundle_patch_rows(
    package_dir: &PathBuf,
    package: &serde_json::Value,
) -> Result<Option<(Vec<serde_json::Value>, String)>, String> {
    let Some(patch_rel) = package
        .pointer("/dsh/bundle/patch")
        .and_then(|value| value.as_str())
    else {
        return Ok(None);
    };
    let patch_path = package_dir.join(patch_rel);
    let text = std::fs::read_to_string(&patch_path)
        .map_err(|error| format!("read bundle patch {}: {error}", patch_path.display()))?;
    Ok(Some((parse_yaml_to_json_array(&text)?, text)))
}

/// Find every row object in a patch tree whose `name` equals `package_name`.
fn collect_rows_by_name(
    value: &serde_json::Value,
    package_name: &str,
    out: &mut Vec<serde_json::Value>,
) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                collect_rows_by_name(item, package_name, out);
            }
        }
        serde_json::Value::Object(map) => {
            if map.get("name").and_then(|name| name.as_str()) == Some(package_name) {
                out.push(value.clone());
            }
            for child in map.values() {
                collect_rows_by_name(child, package_name, out);
            }
        }
        _ => {}
    }
}

/// Find every row that LOADS `package_name` (a row whose `name` field names
/// the package) while preserving how the row must be written back. The loader
/// only loads packages from `insert` lists: a bare top-level row is an
/// id-targeted override that is skipped with an "entry not found" warning
/// when no row with that id exists yet. A row found inside an `insert` list
/// therefore keeps its insert wrapper, so reusing it for a hot-layer toggle
/// still activates the package instead of silently writing a dead override.
fn collect_load_rows_by_name(
    value: &serde_json::Value,
    package_name: &str,
    out: &mut Vec<serde_json::Value>,
) {
    collect_load_rows_inner(value, package_name, out, false);
}

fn collect_load_rows_inner(
    value: &serde_json::Value,
    package_name: &str,
    out: &mut Vec<serde_json::Value>,
    in_insert: bool,
) {
    match value {
        serde_json::Value::Array(items) => {
            for item in items {
                collect_load_rows_inner(item, package_name, out, in_insert);
            }
        }
        serde_json::Value::Object(map) => {
            if map.get("name").and_then(|name| name.as_str()) == Some(package_name) {
                if in_insert {
                    out.push(serde_json::json!({ "insert": [value.clone()] }));
                } else {
                    out.push(value.clone());
                }
            }
            for (key, child) in map {
                collect_load_rows_inner(child, package_name, out, in_insert || key == "insert");
            }
        }
        _ => {}
    }
}

fn read_user_patch_rows(profile: &PathBuf) -> Vec<serde_json::Value> {
    let path = profile_patch_path(profile);
    let Ok(text) = std::fs::read_to_string(&path) else {
        return Vec::new();
    };
    parse_yaml_to_json_array(&text).unwrap_or_default()
}

fn slug_id(name: &str) -> String {
    let tail = name.rsplit('/').next().unwrap_or(name);
    let mut slug = String::new();
    let mut previous_dash = false;
    for ch in tail.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' {
            if ch == '-' && previous_dash {
                continue;
            }
            slug.push(ch.to_ascii_lowercase());
            previous_dash = ch == '-';
        } else if !previous_dash {
            slug.push('-');
            previous_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    if slug.is_empty() {
        "plugin".to_string()
    } else {
        format!("dsh-desktop-{slug}")
    }
}

fn package_has_client(package: &serde_json::Value) -> bool {
    if package.pointer("/dsh/client").is_some() {
        return true;
    }
    package
        .get("exports")
        .and_then(|exports| exports.get("./client"))
        .is_some()
}

fn build_switch_entry(
    profile: &PathBuf,
    package_name: &str,
    patch_rows: &[serde_json::Value],
    origin: &str,
) -> Result<PluginSwitchEntry, String> {
    let mut bundle_patch = None;
    let mut client = false;
    if let Some(dir) = package_dir(profile, package_name) {
        let package =
            read_json(&dir.join("package.json")).unwrap_or_else(|_| serde_json::json!({}));
        client = package_has_client(&package);
        if let Some((rows, patch_text)) = bundle_patch_rows(&dir, &package)? {
            bundle_patch = package
                .pointer("/dsh/bundle/patch")
                .and_then(|value| value.as_str())
                .map(String::from);
            if !rows.is_empty() {
                return Ok(PluginSwitchEntry {
                    name: package_name.to_string(),
                    enabled: true,
                    origin: origin.to_string(),
                    rows,
                    bundle_patch,
                    patch_text: Some(patch_text),
                    client,
                });
            }
        }
    }

    // A package without `dsh.bundle.patch` can still be a plugin: it needs an
    // explicit row in cordis.patch.yml. Reuse an existing row authored by the
    // user so toggling does not duplicate the service. Rows inside an `insert`
    // list keep their wrapper (see collect_load_rows_by_name) — the loader
    // treats a bare row as an id-targeted override, so stripping the wrapper
    // would write back a row that can never load the package.
    let mut existing = Vec::new();
    for row in patch_rows {
        collect_load_rows_by_name(row, package_name, &mut existing);
    }
    if let Some(row) = existing.into_iter().last() {
        return Ok(PluginSwitchEntry {
            name: package_name.to_string(),
            enabled: true,
            origin: origin.to_string(),
            rows: vec![row],
            bundle_patch,
            patch_text: None,
            client,
        });
    }

    Ok(PluginSwitchEntry {
        name: package_name.to_string(),
        enabled: true,
        origin: origin.to_string(),
        // The loader only loads packages from `insert` lists; a bare row is an
        // id-targeted override and is skipped with an "entry not found"
        // warning when no row with that id exists yet. Generate the load row
        // inside an insert so toggling a bundle-less plugin actually
        // activates it.
        rows: vec![serde_json::json!({
            "insert": [{
                "id": slug_id(package_name),
                "name": package_name,
            }]
        })],
        bundle_patch,
        patch_text: None,
        client,
    })
}

fn collect_bundle_targets(value: &serde_json::Value, out: &mut Vec<serde_json::Value>) {
    fn walk(value: &serde_json::Value, out: &mut Vec<serde_json::Value>, inside_insert: bool) {
        match value {
            serde_json::Value::Array(items) => {
                for item in items {
                    walk(item, out, inside_insert);
                }
            }
            serde_json::Value::Object(map) => {
                if let Some(insert) = map.get("insert") {
                    walk(insert, out, true);
                    return;
                }
                // Only rows the bundle patch *inserts* belong to the plugin;
                // id-targeted overrides in the same file patch earlier rows
                // and must not be disabled alongside the plugin.
                if inside_insert {
                    if let Some(id) = map.get("id").and_then(|id| id.as_str()) {
                        let mut target = serde_json::json!({ "id": id });
                        if let Some(name) = map.get("name").and_then(|name| name.as_str()) {
                            target["name"] = serde_json::Value::String(name.to_string());
                        }
                        out.push(target);
                    }
                }
            }
            _ => {}
        }
    }
    walk(value, out, false);
}

fn boot_bundle_disable_rows(rows: &[serde_json::Value]) -> Vec<serde_json::Value> {
    let mut targets = Vec::new();
    for row in rows {
        collect_bundle_targets(row, &mut targets);
    }
    targets
        .into_iter()
        .map(|mut target| {
            target["disabled"] = serde_json::Value::Bool(true);
            target
        })
        .collect()
}

fn normalize_patch_text_for_embed(text: &str) -> String {
    let text = text.trim_start_matches('\u{feff}');
    let mut lines = text.lines().collect::<Vec<_>>();
    while lines.first().is_some_and(|line| line.trim() == "---") {
        lines.remove(0);
    }
    while lines.last().is_some_and(|line| line.trim() == "...") {
        lines.pop();
    }
    let mut normalized = lines.join("\n");
    if !normalized.is_empty() {
        normalized.push('\n');
    }
    normalized
}

fn managed_patch_text(state: &PluginSwitchState) -> Result<String, String> {
    let mut body = String::new();
    for (name, entry) in &state.plugins {
        let rows_text = if entry.origin == "boot-bundle" {
            if entry.enabled {
                // The boot-time bundle snapshot already composes these rows;
                // writing them again would create duplicate entry ids.
                None
            } else {
                Some(yaml_rows_string(&boot_bundle_disable_rows(&entry.rows))?)
            }
        } else if entry.enabled {
            // Hot-layer plugins keep their original bundle patch text so
            // `!!js` expressions and comments survive verbatim.
            Some(match &entry.patch_text {
                Some(text) => normalize_patch_text_for_embed(text),
                None => yaml_rows_string(&entry.rows)?,
            })
        } else {
            // Disabled hot-layer plugins are simply absent from the patch
            // layer; removing the rows hot-unloads the plugin.
            None
        };
        let Some(yaml) = rows_text else {
            continue;
        };
        body.push_str(PLUGIN_BLOCK_MARKER);
        body.push_str(name);
        body.push('\n');
        body.push_str(yaml.trim_end_matches('\n'));
        body.push_str("\n\n");
    }
    Ok(format!(
        "{PATCH_MANAGED_BEGIN}\n{body}{PATCH_MANAGED_END}\n"
    ))
}

fn strip_managed_patch_section(text: &str) -> String {
    let mut output = String::new();
    let mut skipping = false;
    for line in text.split_inclusive('\n') {
        let trimmed = line.trim_end_matches(['\r', '\n']);
        if !skipping && trimmed == PATCH_MANAGED_BEGIN {
            skipping = true;
            continue;
        }
        if skipping {
            if trimmed == PATCH_MANAGED_END {
                skipping = false;
            }
            continue;
        }
        output.push_str(line);
    }
    output
}

fn write_managed_patch(profile: &PathBuf, state: &PluginSwitchState) -> Result<(), String> {
    let path = profile_patch_path(profile);
    let existing = std::fs::read_to_string(&path).unwrap_or_default();
    let base = strip_managed_patch_section(&existing);
    let base = base.trim_end_matches(['\r', '\n']);
    let managed = managed_patch_text(state)?;
    let text = if base.is_empty() {
        // A file containing only comments parses as YAML null, not as the
        // top-level patch array DSH requires. Seed an empty list when the
        // managed section would otherwise be the only content.
        let managed_has_rows = managed.starts_with("- ") || managed.contains("\n- ");
        if managed_has_rows {
            managed
        } else {
            format!("[]\n{managed}")
        }
    } else {
        format!("{base}\n\n{managed}")
    };
    write_atomic(&path, &text)
}

/// Remove every state-managed plugin from the persisted profile bundle list.
/// The managed patch layer owns those rows now, so the bundle layer must not
/// duplicate them on the next restart.
fn remove_state_plugins_from_bundles(
    profile: &PathBuf,
    state: &PluginSwitchState,
) -> Result<(), String> {
    let path = profile_manifest_path(profile);
    let mut manifest = read_json(&path).unwrap_or_else(|_| serde_json::json!({}));
    let bundles = manifest
        .pointer("/dsh/profile/bundles")
        .and_then(|value| value.as_array())
        .cloned()
        .unwrap_or_default();
    let bundles = bundles
        .into_iter()
        .filter(|value| {
            value
                .as_str()
                .map(|name| !state.plugins.contains_key(name))
                .unwrap_or(true)
        })
        .collect::<Vec<_>>();
    if manifest.get("dsh").is_none() {
        manifest["dsh"] = serde_json::json!({});
    }
    if manifest["dsh"].get("profile").is_none() {
        manifest["dsh"]["profile"] = serde_json::json!({});
    }
    manifest["dsh"]["profile"]["bundles"] = serde_json::Value::Array(bundles);
    write_json(&path, &manifest)
}

fn ensure_switch_entry(
    profile: &PathBuf,
    package_name: &str,
    state: &mut PluginSwitchState,
    origin: &str,
) -> Result<PluginSwitchEntry, String> {
    if let Some(entry) = state.plugins.get_mut(package_name) {
        // Older state files predate the `client` flag. Re-discover it from
        // the installed package so browser-half plugins always trigger the
        // post-toggle page reload.
        if !entry.client {
            if let Some(dir) = package_dir(profile, package_name) {
                if let Ok(package) = read_json(&dir.join("package.json")) {
                    entry.client = package_has_client(&package);
                }
            }
        }
        return Ok(entry.clone());
    }
    let patch_rows = read_user_patch_rows(profile);
    build_switch_entry(profile, package_name, &patch_rows, origin)
}

fn manifest_bundle_names(manifest: &serde_json::Value) -> Vec<String> {
    manifest
        .pointer("/dsh/profile/bundles")
        .and_then(|value| value.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|value| value.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn dependency_names(manifest: &serde_json::Value) -> Vec<String> {
    let mut names = manifest
        .pointer("/dependencies")
        .and_then(|value| value.as_object())
        .map(|deps| deps.keys().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    names.sort();
    names
}

// ---------------------------------------------------------------------------
// command plumbing
// ---------------------------------------------------------------------------

fn bundled_runtime(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let resource_root = app
        .path()
        .resolve("resources/runtime", tauri::path::BaseDirectory::Resource)
        .or_else(|_| {
            app.path()
                .resolve("runtime", tauri::path::BaseDirectory::Resource)
        })
        .map_err(|error| error.to_string())?;
    let node = clean_path(&resource_root.join("node.exe"));
    let bin = clean_path(
        &resource_root
            .join("node_modules")
            .join("@deepseek-ai")
            .join("dsh")
            .join("lib")
            .join("bin.js"),
    );
    if !node.exists() || !bin.exists() {
        return Err("bundled runtime is incomplete".to_string());
    }
    Ok((node, bin))
}

fn run_plugin_command(app: &AppHandle, args: &[String], logs: &LogHub) -> Result<String, String> {
    let (node, bin) = bundled_runtime(app)?;
    let home = resolve_dsh_home();
    let started = Instant::now();
    let command_line = format!("{} {}", node.display(), args.join(" "));
    logs.info(
        MODULE_PLUGIN,
        KIND_PROCESS,
        format!(
            "run dsh plugin command: {command_line} (cwd {})",
            home.display()
        ),
    );
    let mut cmd = Command::new(&node);
    cmd.arg(&bin)
        .args(args)
        .env("DSH_HOME", &home)
        .env("PATH", child_path(app))
        .current_dir(&home);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|error| {
        logs.error(
            MODULE_PLUGIN,
            KIND_PROCESS,
            format!(
                "dsh plugin command failed to launch after {:.1?}: {error}",
                started.elapsed()
            ),
        );
        error.to_string()
    })?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    let elapsed = started.elapsed();
    let level = if output.status.success() {
        LogLevel::Info
    } else {
        LogLevel::Error
    };
    for line in combined.lines().take(500) {
        if !line.trim().is_empty() {
            logs.debug(
                MODULE_PLUGIN,
                KIND_CHILD_STDOUT,
                format!("dsh plugin: {line}"),
            );
        }
    }
    if combined.lines().count() > 500 {
        logs.debug(
            MODULE_PLUGIN,
            KIND_DIAGNOSTIC,
            format!(
                "dsh plugin output truncated in the structured log ({} total lines)",
                combined.lines().count()
            ),
        );
    }
    let tail = combined
        .lines()
        .rev()
        .take(12)
        .collect::<Vec<_>>()
        .join(" | ");
    logs.log_with(
        level,
        MODULE_PLUGIN,
        KIND_PERFORMANCE,
        format!(
            "dsh plugin command finished in {:.1?} (exit {:?}, {} bytes output): {tail}",
            elapsed,
            output.status.code(),
            combined.len(),
        ),
        serde_json::json!({ "args": args, "exitCode": output.status.code(), "elapsedMs": elapsed.as_millis() }),
    );
    if !output.status.success() {
        return Err(combined);
    }
    Ok(combined)
}

fn ignored_build_keys(output: &str) -> Vec<String> {
    for line in output.lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix("Ignored build scripts:") {
            return rest
                .trim()
                .trim_end_matches('.')
                .split(',')
                .map(|key| key.trim().to_string())
                .filter(|key| !key.is_empty())
                .collect();
        }
    }
    Vec::new()
}

fn run_plugin_action(
    app: &AppHandle,
    action: &str,
    spec: &str,
    allow_build: &[String],
    logs: &LogHub,
) -> Result<String, String> {
    let mut args = vec![
        "plugin".to_string(),
        "--profile".to_string(),
        PLUGIN_PROFILE.to_string(),
        action.to_string(),
    ];
    if action == "add" {
        for key in allow_build {
            args.push(format!("--allow-build={key}"));
        }
    }
    args.push(spec.to_string());
    logs.debug(
        MODULE_PLUGIN,
        KIND_COMMAND,
        format!("plugin {action} {spec} (allow_build={})", allow_build.len()),
    );
    run_plugin_command(app, &args, logs)
}

/// Turn a pasted GitHub URL into the pnpm shorthand `github:owner/repo`.
/// Anything that is already a valid pnpm spec passes through unchanged.
fn normalize_plugin_spec(input: &str) -> String {
    let input = input.trim();
    if input.is_empty() {
        return String::new();
    }

    let github_path = |text: &str| -> Option<String> {
        let text = text
            .trim_start_matches("https://")
            .trim_start_matches("http://")
            .trim_start_matches("git+")
            .trim_start_matches("www.")
            .trim_start_matches("github.com/");
        let text = text.split('?').next().unwrap_or(text);
        let (text, fragment) = match text.split_once('#') {
            Some((path, fragment)) => (path, Some(fragment.trim_end_matches('/'))),
            None => (text, None),
        };
        // `/tree/<branch>` in a browser URL is the same selector pnpm
        // expresses as `github:owner/repo#<branch>`.
        let (path, tree_branch) = match text.split_once("/tree/") {
            Some((path, branch)) => (path, Some(branch.trim_end_matches('/'))),
            None => (text, None),
        };
        let path = path.split("/blob/").next().unwrap_or(path);
        let path = path.trim_end_matches('/');
        let mut parts = path.split('/');
        let owner = parts.next()?;
        let repo = parts.next()?;
        if owner.is_empty() || repo.is_empty() {
            return None;
        }
        let repo = repo.trim_end_matches(".git");
        if repo.is_empty() {
            return None;
        }
        let branch = tree_branch
            .filter(|branch| !branch.is_empty())
            .or_else(|| fragment.filter(|branch| !branch.is_empty()));
        Some(match branch {
            Some(branch) => format!("{owner}/{repo}#{branch}"),
            None => format!("{owner}/{repo}"),
        })
    };

    if let Some(rest) = input.strip_prefix("git@github.com:") {
        if let Some(repo) = github_path(rest) {
            return format!("github:{repo}");
        }
    }
    for prefix in [
        "https://github.com/",
        "http://github.com/",
        "https://www.github.com/",
        "http://www.github.com/",
        "github.com/",
        "git+https://github.com/",
        "git+http://github.com/",
    ] {
        if let Some(rest) = input.strip_prefix(prefix) {
            if let Some(repo) = github_path(rest) {
                return format!("github:{repo}");
            }
        }
    }
    if input.starts_with("github:") {
        if let Some(repo) = github_path(input.trim_start_matches("github:")) {
            return format!("github:{repo}");
        }
    }

    // `owner/repo` is not a valid npm package name, so it is unambiguous.
    let bare = input.trim_end_matches('/');
    if !bare.contains(':')
        && !bare.contains('@')
        && !bare.starts_with('.')
        && !bare.starts_with('/')
        && bare.split('/').count() == 2
        && !bare.contains(' ')
    {
        if let Some(repo) = github_path(bare) {
            return format!("github:{repo}");
        }
    }

    input.to_string()
}

#[tauri::command]
fn plugin_list(app: AppHandle, app_state: tauri::State<'_, AppState>) -> PluginList {
    let home = resolve_dsh_home();
    let profile = profile_dir(&home);
    let (profile_path, manifest) = read_profile_manifest(&home).unwrap_or_else(|| {
        (
            profile_manifest_path(&profile).display().to_string(),
            serde_json::json!({}),
        )
    });
    let bundles: Vec<String> = manifest_bundle_names(&manifest);
    let generation = current_harness_generation(&app_state);
    let mut state = load_plugin_state(&profile);
    let _ = refresh_plugin_state_generation(&profile, &mut state, generation, &bundles);
    let user_patch_rows = read_user_patch_rows(&profile);
    let dependencies = manifest
        .pointer("/dependencies")
        .and_then(|v| v.as_object())
        .map(|deps| {
            deps.iter()
                .map(|(name, spec)| {
                    let enabled = if let Some(entry) = state.plugins.get(name) {
                        entry.enabled
                    } else {
                        let mut matches = Vec::new();
                        for row in &user_patch_rows {
                            collect_rows_by_name(row, name, &mut matches);
                        }
                        match matches.last() {
                            Some(row) => {
                                row.get("disabled").and_then(|d| d.as_bool()) != Some(true)
                            }
                            None => bundles.iter().any(|bundle| bundle == name),
                        }
                    };
                    let managed = state.plugins.contains_key(name)
                        || user_patch_rows.iter().any(|row| {
                            let mut matches = Vec::new();
                            collect_rows_by_name(row, name, &mut matches);
                            !matches.is_empty()
                        });
                    let client = package_dir(&profile, name)
                        .and_then(|dir| read_json(&dir.join("package.json")).ok())
                        .map(|package| package_has_client(&package))
                        .unwrap_or_else(|| {
                            state
                                .plugins
                                .get(name)
                                .map(|entry| entry.client)
                                .unwrap_or(false)
                        });
                    PluginDependency {
                        name: name.clone(),
                        spec: spec.clone(),
                        enabled,
                        managed,
                        client,
                    }
                })
                .collect()
        })
        .unwrap_or_default();
    let pnpm = tools_dir(&app)
        .map(|dir| dir.join("pnpm.exe").exists() || dir.join("pnpm").join("pnpm.exe").exists())
        .unwrap_or(false);
    let result = PluginList {
        home: home.display().to_string(),
        profile: profile_path,
        bundles: bundles.clone(),
        dependencies,
        pnpm,
    };
    app_state.logs.debug(
        MODULE_PLUGIN,
        KIND_IPC,
        format!(
            "plugin_list served: {} bundle(s), {} dependency(ies), pnpm={}",
            result.bundles.len(),
            result.dependencies.len(),
            pnpm
        ),
    );
    result
}

/// Hot-enable/disable an installed plugin by rewriting the DSH Desktop
/// section of `profiles/web/cordis.patch.yml`. The running harness watches
/// that file through Cordis HMR and applies the row changes immediately.
#[tauri::command]
fn plugin_set_enabled(
    name: String,
    enabled: bool,
    app_state: tauri::State<'_, AppState>,
) -> Result<PluginToggleResult, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        app_state.logs.warn(
            MODULE_PLUGIN,
            KIND_COMMAND,
            "plugin_set_enabled rejected: empty name",
        );
        return Err("plugin name is empty".to_string());
    }
    app_state.logs.info(
        MODULE_PLUGIN,
        KIND_COMMAND,
        format!("plugin_set_enabled: {name} -> {enabled}"),
    );
    let home = resolve_dsh_home();
    let profile = profile_dir(&home);
    let mut state = load_plugin_state(&profile);
    let generation = current_harness_generation(&app_state);
    let manifest = read_profile_manifest(&home)
        .map(|(_, manifest)| manifest)
        .unwrap_or_else(|| serde_json::json!({}));
    let is_installed = manifest
        .pointer("/dependencies")
        .and_then(|deps| deps.as_object())
        .map(|deps| deps.contains_key(&name))
        .unwrap_or(false);
    if !is_installed {
        app_state.logs.warn(
            MODULE_PLUGIN,
            KIND_STATE,
            format!("plugin_set_enabled rejected: {name} is not in the web profile manifest"),
        );
        return Err(format!("{name} is not installed in the web profile"));
    }
    let bundles = manifest_bundle_names(&manifest);
    let _ = refresh_plugin_state_generation(&profile, &mut state, generation, &bundles)?;
    let origin = if let Some(existing) = state.plugins.get(&name) {
        existing.origin.clone()
    } else if bundles.iter().any(|bundle| bundle == &name) {
        "boot-bundle".to_string()
    } else {
        "hot-layer".to_string()
    };
    let mut entry = ensure_switch_entry(&profile, &name, &mut state, &origin)?;
    entry.name = name.clone();
    entry.origin = origin;
    entry.enabled = enabled;
    let reload = entry.client;
    state.plugins.insert(name.clone(), entry);
    save_plugin_state(&profile, &state)?;
    write_managed_patch(&profile, &state)?;
    remove_state_plugins_from_bundles(&profile, &state)?;
    app_state.logs.info(
        MODULE_PLUGIN,
        KIND_STATE,
        format!(
            "plugin {name} {}; managed patch rewritten and handed to cordis HMR",
            if enabled { "enabled" } else { "disabled" }
        ),
    );
    Ok(PluginToggleResult {
        message: format!(
            "[dsh-desktop] {name} {} — cordis HMR is applying the patch layer now",
            if enabled { "enabled" } else { "disabled" }
        ),
        reload,
    })
}

/// Forward a `dsh plugin` operation to pnpm through the bundled runtime and
/// keep the hot-swap patch layer in sync afterwards.
#[tauri::command]
fn plugin_manage(
    app: AppHandle,
    action: String,
    name: String,
    app_state: tauri::State<'_, AppState>,
) -> Result<PluginManageResult, String> {
    if action != "add" && action != "remove" {
        app_state.logs.warn(
            MODULE_PLUGIN,
            KIND_COMMAND,
            format!("plugin_manage rejected: unknown action {action:?}"),
        );
        return Err(format!("unknown plugin action {action:?}"));
    }
    let raw = name.trim().to_string();
    if raw.is_empty() {
        app_state.logs.warn(
            MODULE_PLUGIN,
            KIND_COMMAND,
            "plugin_manage rejected: empty spec",
        );
        return Err("plugin spec is empty".to_string());
    }
    app_state.logs.info(
        MODULE_PLUGIN,
        KIND_COMMAND,
        format!("plugin_manage: {action} {raw}"),
    );
    let spec = if action == "add" {
        normalize_plugin_spec(&raw)
    } else {
        raw.clone()
    };

    let home = resolve_dsh_home();
    let profile = profile_dir(&home);
    let manifest_before = read_profile_manifest(&home)
        .map(|(_, manifest)| manifest)
        .unwrap_or_else(|| serde_json::json!({}));
    let names_before = dependency_names(&manifest_before);
    let bundles_before = manifest_bundle_names(&manifest_before);
    let mut state = load_plugin_state(&profile);
    let generation = current_harness_generation(&app_state);
    let _ = refresh_plugin_state_generation(&profile, &mut state, generation, &bundles_before)?;

    let mut client_changes = Vec::new();
    if action == "remove" {
        // Disable first (hot-unload), then let pnpm remove the package. The
        // disabled tombstone stays in the patch layer so the running process
        // never tries to re-import a package that has just been deleted.
        let origin = if let Some(existing) = state.plugins.get(&raw) {
            existing.origin.clone()
        } else if bundles_before.iter().any(|bundle| bundle == &raw) {
            "boot-bundle".to_string()
        } else {
            "hot-layer".to_string()
        };
        let mut entry = ensure_switch_entry(&profile, &raw, &mut state, &origin)?;
        entry.name = raw.clone();
        entry.origin = origin;
        entry.enabled = false;
        let client = entry.client;
        state.plugins.insert(raw.clone(), entry);
        save_plugin_state(&profile, &state)?;
        write_managed_patch(&profile, &state)?;
        remove_state_plugins_from_bundles(&profile, &state)?;
        if client {
            client_changes.push(raw.clone());
        }
    }

    let no_build_keys = Vec::new();
    let mut output = match run_plugin_action(&app, &action, &spec, &no_build_keys, &app_state.logs)
    {
        Ok(output) => output,
        Err(first_error) if action == "add" => {
            // pnpm 10+ blocks git-hosted build scripts until approved. Retry
            // with the exact build keys pnpm reported; the panel then behaves
            // like "paste a GitHub URL and install".
            let build_keys = ignored_build_keys(&first_error);
            if !build_keys.is_empty() {
                app_state.logs.warn(
                    MODULE_PLUGIN,
                    KIND_PROCESS,
                    format!(
                        "pnpm blocked git build scripts; retrying with {} allow-build key(s)",
                        build_keys.len()
                    ),
                );
                run_plugin_action(&app, &action, &spec, &build_keys, &app_state.logs)?
            } else if first_error.contains("EPERM") && first_error.contains("package.json") {
                // The running harness can briefly hold the profile manifest
                // on Windows. pnpm usually already installed the dependency
                // when this happens; a single delayed retry reconciles it.
                app_state.logs.warn(
                    MODULE_PLUGIN,
                    KIND_FILE,
                    "manifest EPERM race detected; retrying once after 450ms",
                );
                thread::sleep(Duration::from_millis(450));
                run_plugin_action(&app, &action, &spec, &no_build_keys, &app_state.logs)?
            } else {
                return Err(first_error);
            }
        }
        Err(error) => return Err(error),
    };

    if action == "add" {
        let manifest_after = read_profile_manifest(&home)
            .map(|(_, manifest)| manifest)
            .unwrap_or_else(|| serde_json::json!({}));
        let names_after = dependency_names(&manifest_after);
        let installed = names_after
            .iter()
            .filter(|name| !names_before.contains(name))
            .cloned()
            .collect::<Vec<_>>();
        let changed = if installed.is_empty() {
            // Reinstalling/updating an existing dependency can keep the
            // manifest key unchanged. Map the obvious package-name forms.
            match spec_name_for_existing(&spec) {
                Some(name) if names_after.iter().any(|entry| entry == &name) => vec![name],
                _ => Vec::new(),
            }
        } else {
            installed
        };

        if !changed.is_empty() {
            for package_name in &changed {
                // A removed boot-bundle plugin leaves a disabled tombstone
                // while this harness run is still alive. Reinstalling it in
                // the same run must stay override-based (`boot-bundle`) or
                // the hot patch would duplicate the boot snapshot rows.
                let previous_origin = state
                    .plugins
                    .get(package_name)
                    .map(|entry| entry.origin.clone())
                    .unwrap_or_else(|| "hot-layer".to_string());
                let mut entry =
                    ensure_switch_entry(&profile, package_name, &mut state, &previous_origin)?;
                entry.name = package_name.clone();
                entry.origin = previous_origin;
                entry.enabled = true;
                if entry.client {
                    client_changes.push(package_name.clone());
                }
                state.plugins.insert(package_name.clone(), entry);
            }
            save_plugin_state(&profile, &state)?;
            write_managed_patch(&profile, &state)?;
            remove_state_plugins_from_bundles(&profile, &state)?;
            output.push_str(&format!(
                "\n[dsh-desktop] {} hot-loaded through cordis HMR — no restart needed",
                changed.join(", ")
            ));
        } else {
            output.push_str(
                "\n[dsh-desktop] pnpm completed; the installed package could not be mapped to a profile dependency",
            );
        }
    }

    let result = PluginManageResult {
        reload: !client_changes.is_empty(),
        clients: client_changes,
        output,
    };
    app_state.logs.info(
        MODULE_PLUGIN,
        KIND_STATE,
        format!(
            "plugin_manage {action} {raw} complete: {} client(s) need reload, output {} bytes",
            result.clients.len(),
            result.output.len()
        ),
    );
    Ok(result)
}

/// Best-effort mapping for plain package specs when an add operation did not
/// create a new manifest key (for example `pnpm add <name>@latest`).
fn spec_name_for_existing(spec: &str) -> Option<String> {
    if let Some(path) = spec
        .strip_prefix("file:")
        .or_else(|| spec.strip_prefix("link:"))
    {
        let path = std::path::Path::new(path);
        let package = read_json(&path.join("package.json")).ok()?;
        return package
            .get("name")
            .and_then(|name| name.as_str())
            .map(String::from);
    }
    if spec.starts_with('@') && spec.contains('/') {
        // @scope/name or @scope/name@version. The scope separator is the
        // first @, so rfind finds the optional version range separator.
        let rest = &spec[1..];
        let name = match rest.rfind('@') {
            Some(pos) if pos > 0 => format!("@{}", &rest[..pos]),
            _ => spec.to_string(),
        };
        return Some(name);
    }
    if spec.contains(':') || spec.contains('/') || spec.contains(' ') {
        return None;
    }
    Some(spec.split('@').next().unwrap_or(spec).to_string())
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

pub fn run() {
    #[cfg(debug_assertions)]
    {
        // Allow CDP inspection of the WebView2 for design verification.
        if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
            std::env::set_var(
                "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
                "--remote-debugging-port=9333",
            );
        }
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            boot_state,
            retry_boot,
            reveal_logs,
            stage_attachments,
            plugin_list,
            plugin_manage,
            plugin_set_enabled,
            log_query,
            log_meta,
            log_clear,
            log_client
        ])
        .setup(|app| {
            let handle = app.handle().clone();
            let state: tauri::State<'_, AppState> = app.state();

            // Structured log hub: attach the JSONL file + event emitter before
            // anything else so even tray/boot setup is captured.
            let log_file = app_log_file(&handle, "dsh-desktop.log");
            if let Err(error) = state.logs.attach(&log_file) {
                eprintln!("dsh-desktop: could not open structured log file: {error}");
            }
            {
                let emitter_handle = handle.clone();
                state.logs.set_emitter(Arc::new(move |entry| {
                    let _ = emitter_handle.emit(logging::EVENT_LOG_ENTRY, entry);
                }));
            }
            state.logs.info(
                MODULE_APP,
                KIND_LIFECYCLE,
                format!(
                    "DSH Desktop starting (version {}, log file {})",
                    app.package_info().version,
                    log_file.display()
                ),
            );

            build_tray(&handle)?;
            start_boot(&handle, &state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // Closing hides to tray; the agent keeps working.
                    let logs = window.app_handle().state::<AppState>().logs.clone();
                    logs.info(
                        MODULE_WINDOW,
                        KIND_UI,
                        "main window close requested; hiding to tray instead of quitting",
                    );
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the DSH Desktop app");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            let state = app_handle.state::<AppState>();
            state.logs.info(
                MODULE_APP,
                KIND_LIFECYCLE,
                "exit requested; tearing the harness process tree down",
            );
            let child = {
                let child_arc = state.child.clone();
                let taken = match child_arc.lock() {
                    Ok(mut guard) => guard.take(),
                    Err(_) => None,
                };
                taken
            };
            if let Some(mut child) = child {
                kill_child_tree(&mut child);
            }
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_github_urls() {
        assert_eq!(
            normalize_plugin_spec("https://github.com/foo/bar"),
            "github:foo/bar"
        );
        assert_eq!(
            normalize_plugin_spec("https://github.com/foo/bar.git"),
            "github:foo/bar"
        );
        assert_eq!(
            normalize_plugin_spec("https://github.com/foo/bar/tree/next"),
            "github:foo/bar#next"
        );
        assert_eq!(
            normalize_plugin_spec("github.com/foo/bar"),
            "github:foo/bar"
        );
        assert_eq!(
            normalize_plugin_spec("git@github.com:foo/bar.git"),
            "github:foo/bar"
        );
        assert_eq!(normalize_plugin_spec("foo/bar"), "github:foo/bar");
        assert_eq!(
            normalize_plugin_spec("git+https://github.com/foo/bar"),
            "github:foo/bar"
        );
        assert_eq!(
            normalize_plugin_spec("@scope/plugin@^1.0.0"),
            "@scope/plugin@^1.0.0"
        );
        assert_eq!(
            normalize_plugin_spec("file:../local-plugin"),
            "file:../local-plugin"
        );
    }

    #[test]
    fn generation_refresh_moves_unbundled_entries_to_hot_layer() {
        let base = std::env::temp_dir().join(format!("dsh-gen-test-{}", std::process::id()));
        let profile = base.join("profiles").join("web");
        std::fs::create_dir_all(&profile).expect("create temp profile");
        std::fs::write(profile.join("cordis.patch.yml"), "[]\n").expect("patch");
        std::fs::write(
            profile.join("package.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "dependencies": {},
                "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base"] } }
            }))
            .expect("json"),
        )
        .expect("manifest");

        let mut state = PluginSwitchState {
            version: 3,
            generation: 0,
            plugins: BTreeMap::from([(
                "demo-plugin".to_string(),
                PluginSwitchEntry {
                    name: "demo-plugin".to_string(),
                    enabled: false,
                    origin: "boot-bundle".to_string(),
                    rows: vec![serde_json::json!({
                        "insert": [{"id": "demo", "name": "demo-plugin"}]
                    })],
                    bundle_patch: None,
                    patch_text: None,
                    client: false,
                },
            )]),
        };
        let changed = refresh_plugin_state_generation(
            &profile,
            &mut state,
            2,
            &["@deepseek-ai/dsh-base".to_string()],
        )
        .expect("refresh");
        assert!(changed);
        assert_eq!(state.plugins["demo-plugin"].origin, "hot-layer");
        assert_eq!(state.generation, 2);
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn boot_bundle_entries_use_overrides_not_duplicate_inserts() {
        let state = PluginSwitchState {
            version: 3,
            generation: 1,
            plugins: BTreeMap::from([(
                "dsh-tavern".to_string(),
                PluginSwitchEntry {
                    name: "dsh-tavern".to_string(),
                    enabled: false,
                    origin: "boot-bundle".to_string(),
                    rows: vec![serde_json::json!({
                        "insert": [{"id": "tavern", "name": "dsh-tavern"}]
                    })],
                    bundle_patch: Some("cordis.patch.yml".to_string()),
                    patch_text: None,
                    client: false,
                },
            )]),
        };
        let managed = managed_patch_text(&state).expect("managed patch");
        assert!(!managed.contains("insert:"));
        assert!(managed.contains("id: tavern"));
        assert!(managed.contains("disabled: true"));
        let parsed = parse_yaml_to_json_array(&managed).expect("valid YAML");
        assert_eq!(parsed[0]["id"], "tavern");

        let mut enabled = state.clone();
        enabled.plugins.get_mut("dsh-tavern").unwrap().enabled = true;
        let managed = managed_patch_text(&enabled).expect("managed patch");
        assert!(!managed.contains("dsh-desktop:plugin dsh-tavern"));
    }

    #[test]
    fn managed_files_round_trip_without_losing_user_patch() {
        let base = std::env::temp_dir().join(format!("dsh-plugin-test-{}", std::process::id()));
        let profile = base.join("profiles").join("web");
        std::fs::create_dir_all(&profile).expect("create temp profile");
        std::fs::write(
            profile.join("cordis.patch.yml"),
            "# user patch\n- id: pwsh-sandbox\n  disabled: true\n",
        )
        .expect("write user patch");
        std::fs::write(
            profile.join("package.json"),
            serde_json::to_string_pretty(&serde_json::json!({
                "name": "dsh-profile-web",
                "dependencies": { "demo-plugin": "github:foo/demo" },
                "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "demo-plugin"] } }
            }))
            .expect("manifest json"),
        )
        .expect("write manifest");

        let state = PluginSwitchState {
            version: 3,
            generation: 1,
            plugins: BTreeMap::from([(
                "demo-plugin".to_string(),
                PluginSwitchEntry {
                    name: "demo-plugin".to_string(),
                    enabled: true,
                    origin: "hot-layer".to_string(),
                    rows: vec![serde_json::json!({
                        "insert": [{"id": "demo", "name": "demo-plugin"}]
                    })],
                    bundle_patch: None,
                    patch_text: None,
                    client: false,
                },
            )]),
        };
        save_plugin_state(&profile, &state).expect("save state");
        write_managed_patch(&profile, &state).expect("write managed patch");
        remove_state_plugins_from_bundles(&profile, &state).expect("sync bundles");

        let patch = std::fs::read_to_string(profile.join("cordis.patch.yml")).expect("patch");
        assert!(patch.contains("# user patch"));
        assert!(patch.contains("# dsh-desktop:plugin demo-plugin"));
        let rows = parse_yaml_to_json_array(&patch).expect("patch parses");
        assert!(rows.iter().any(|row| row["id"] == "pwsh-sandbox"));
        assert!(rows.iter().any(|row| row["insert"][0]["id"] == "demo"));

        let manifest: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(profile.join("package.json")).expect("manifest"),
        )
        .expect("manifest parses");
        let bundles = manifest_bundle_names(&manifest);
        assert_eq!(bundles, vec!["@deepseek-ai/dsh-base".to_string()]);

        let loaded = load_plugin_state(&profile);
        assert_eq!(loaded.generation, 1);
        assert_eq!(loaded.plugins["demo-plugin"].origin, "hot-layer");
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn hot_layer_entries_keep_full_insert_rows() {
        let state = PluginSwitchState {
            version: 3,
            generation: 1,
            plugins: BTreeMap::from([(
                "demo-plugin".to_string(),
                PluginSwitchEntry {
                    name: "demo-plugin".to_string(),
                    enabled: true,
                    origin: "hot-layer".to_string(),
                    rows: vec![serde_json::json!({
                        "insert": [{"id": "demo", "name": "demo-plugin"}]
                    })],
                    bundle_patch: Some("cordis.patch.yml".to_string()),
                    patch_text: None,
                    client: false,
                },
            )]),
        };
        let managed = managed_patch_text(&state).expect("managed patch");
        assert!(managed.contains("insert:"));
        assert!(managed.contains("id: demo"));
        let parsed = parse_yaml_to_json_array(&managed).expect("valid YAML");
        assert_eq!(parsed[0]["insert"][0]["id"], "demo");
    }

    #[test]
    fn hot_layer_preserves_raw_bundle_patch_text() {
        let raw = "- insert:\n    - id: demo\n      name: demo-plugin\n      config:\n        enabled: !!js '() => true'\n";
        let state = PluginSwitchState {
            version: 3,
            generation: 1,
            plugins: BTreeMap::from([(
                "demo-plugin".to_string(),
                PluginSwitchEntry {
                    name: "demo-plugin".to_string(),
                    enabled: true,
                    origin: "hot-layer".to_string(),
                    rows: vec![serde_json::json!({
                        "insert": [{"id": "demo", "name": "demo-plugin"}]
                    })],
                    bundle_patch: Some("cordis.patch.yml".to_string()),
                    patch_text: Some(raw.to_string()),
                    client: true,
                },
            )]),
        };
        let managed = managed_patch_text(&state).expect("managed patch");
        assert!(managed.contains("!!js '() => true'"), "managed: {managed}");
        assert!(managed.contains("id: demo"));
    }

    #[test]
    fn managed_section_survives_user_edits() {
        let state = PluginSwitchState {
            version: 3,
            generation: 0,
            plugins: BTreeMap::from([(
                "demo-plugin".to_string(),
                PluginSwitchEntry {
                    name: "demo-plugin".to_string(),
                    enabled: false,
                    origin: "boot-bundle".to_string(),
                    rows: vec![serde_json::json!({
                        "insert": [{"id": "demo", "name": "demo-plugin"}]
                    })],
                    bundle_patch: None,
                    patch_text: None,
                    client: false,
                },
            )]),
        };
        let managed = managed_patch_text(&state).expect("managed patch");
        assert!(managed.contains("# dsh-desktop:plugin demo-plugin"));
        assert!(managed.contains("disabled: true"));

        let user = "# user patch\n- id: something\n  disabled: true\n";
        let mixed = format!("{user}{managed}");
        let stripped = strip_managed_patch_section(&mixed);
        assert!(stripped.contains("# user patch"));
        assert!(!stripped.contains("dsh-desktop:plugin demo-plugin"));
    }

    #[test]
    fn bundleless_plugin_generates_insert_load_row() {
        let base = std::env::temp_dir().join(format!("dsh-switch-{}", std::process::id()));
        let profile = base.join("profiles").join("web");
        let pkg = profile.join("node_modules").join("demo-plugin");
        std::fs::create_dir_all(&pkg).expect("create package dir");
        std::fs::write(
            pkg.join("package.json"),
            serde_json::to_string(&serde_json::json!({
                "name": "demo-plugin",
                "version": "1.0.0",
                "main": "lib/index.js"
            }))
            .expect("json"),
        )
        .expect("write package");

        let entry = build_switch_entry(&profile, "demo-plugin", &[], "hot-layer").expect("entry");
        assert_eq!(entry.rows.len(), 1);
        // The generated row must be an insert: a bare row is an id-targeted
        // override that the loader skips ("entry not found").
        assert_eq!(entry.rows[0]["insert"][0]["id"], "dsh-desktop-demo-plugin");
        assert_eq!(entry.rows[0]["insert"][0]["name"], "demo-plugin");

        let managed = managed_patch_text(&PluginSwitchState {
            version: 3,
            generation: 1,
            plugins: BTreeMap::from([(
                "demo-plugin".to_string(),
                PluginSwitchEntry {
                    name: "demo-plugin".to_string(),
                    enabled: true,
                    origin: "hot-layer".to_string(),
                    rows: entry.rows.clone(),
                    bundle_patch: None,
                    patch_text: None,
                    client: false,
                },
            )]),
        })
        .expect("managed patch");
        assert!(managed.contains("insert:"));
        assert!(managed.contains("id: dsh-desktop-demo-plugin"));
        std::fs::remove_dir_all(base).ok();
    }

    #[test]
    fn bundleless_plugin_reuses_user_insert_row_with_wrapper() {
        let base = std::env::temp_dir().join(format!("dsh-reuse-{}", std::process::id()));
        let profile = base.join("profiles").join("web");
        let pkg = profile.join("node_modules").join("demo-plugin");
        std::fs::create_dir_all(&pkg).expect("create package dir");
        std::fs::write(
            pkg.join("package.json"),
            serde_json::to_string(&serde_json::json!({
                "name": "demo-plugin",
                "version": "1.0.0",
                "main": "lib/index.js"
            }))
            .expect("json"),
        )
        .expect("write package");

        let patch_rows = parse_yaml_to_json_array(
            "- insert:\n    - id: demo\n      name: demo-plugin\n      config:\n        foo: bar\n",
        )
        .expect("patch parses");
        let entry =
            build_switch_entry(&profile, "demo-plugin", &patch_rows, "hot-layer").expect("entry");
        assert_eq!(entry.rows.len(), 1);
        // The reused row keeps its insert wrapper, so writing it back still
        // loads the package instead of degrading to a dead override.
        assert_eq!(entry.rows[0]["insert"][0]["id"], "demo");
        assert_eq!(entry.rows[0]["insert"][0]["name"], "demo-plugin");
        assert_eq!(entry.rows[0]["insert"][0]["config"]["foo"], "bar");
        std::fs::remove_dir_all(base).ok();
    }
}
