//! DSH Desktop — the DeepSeek Harness as a native Windows app.
//!
//! Boot model: a splash window (static avant-garde frontend) is shown while a
//! background thread resolves the bundled runtime (node.exe + the pinned
//! @deepseek-ai/dsh tree), either reuses an already-running `dsh web` server
//! or spawns one on a fixed loopback port, then opens the main window pointed
//! at the harness UI. Closing the main window hides it to the tray; quitting
//! from the tray tears the child process tree down.

use serde::Serialize;
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
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

#[derive(Default)]
struct AppState {
    boot: Arc<Mutex<BootState>>,
    child: Arc<Mutex<Option<Child>>>,
    /// bumped on retry so a stale boot thread bails out
    generation: Arc<Mutex<u64>>,
    /// Windows job object: when the app dies for ANY reason, the OS kills the
    /// harness process tree (KILL_ON_JOB_CLOSE). Kept alive for the app's
    /// lifetime (raw handle as isize — HANDLE is not Send in windows 0.61).
    #[cfg(windows)]
    job: Arc<Mutex<Option<isize>>>,
}

#[cfg(windows)]
fn assign_to_kill_job(child: &Child) -> Option<isize> {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::HANDLE;
    use windows::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
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

fn is_dsh_response(body: &str) -> bool {
    body.contains("__DSH_BOOT__")
}

/// TCP-connect + minimal HTTP GET; returns the body when the port serves DSH.
fn probe_dsh(port: u16) -> Option<String> {
    let mut stream = TcpStream::connect(("127.0.0.1", port)).ok()?;
    stream
        .set_read_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    let request = format!(
        "GET / HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );
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

/// Pick the port the harness should run on: reuse a live DSH when present,
/// otherwise the first fixed port that is free, otherwise any free port.
/// `DSH_DESKTOP_FORCE_PORT` (testing hook) skips probing and forces a spawn.
fn resolve_target_port() -> (u16, Option<String>) {
    if let Ok(forced) = std::env::var("DSH_DESKTOP_FORCE_PORT") {
        if let Ok(port) = forced.parse::<u16>() {
            return (port, None);
        }
    }
    for port in FIXED_PORTS {
        if let Some(body) = probe_dsh(port) {
            return (port, Some(body));
        }
    }
    for port in FIXED_PORTS {
        if tcp_free(port) {
            return (port, None);
        }
    }
    if let Ok(listener) = TcpListener::bind(("127.0.0.1", 0)) {
        if let Ok(addr) = listener.local_addr() {
            return (addr.port(), None);
        }
    }
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

fn spawn_harness(app: &AppHandle, node: &PathBuf, bin: &PathBuf, runtime_dir: &PathBuf, dsh_home: &PathBuf, port: u16, log_path: &PathBuf) -> std::io::Result<Child> {
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
    match std::fs::File::create(log_path) {
        Ok(mut file) => {
            // Diagnostics: record exactly what we launch (surfaced in the boot log).
            let _ = writeln!(
                file,
                "dsh-desktop spawn: node={:?} bin={:?} cwd={:?} dsh_home={:?} port={port}",
                node, bin, runtime_dir, dsh_home
            );
            cmd.stdout(Stdio::from(file.try_clone()?));
            cmd.stderr(Stdio::from(file));
        }
        Err(_) => {
            cmd.stdout(Stdio::null());
            cmd.stderr(Stdio::null());
        }
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

fn log_tail(path: &PathBuf, lines: usize) -> String {
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
            if let Some(splash) = handle.get_webview_window("splash") {
                let _ = splash.close();
            }
        })
        .build()
    {
        Ok(window) => window,
        Err(error) => {
            eprintln!("dsh-desktop: could not open the main window: {error}");
            return;
        }
    };
    let _ = window;
}

fn boot_flow(app: AppHandle, state: AppState, generation: u64) {
    let set = |stage: &str, detail: &str, error: Option<String>, url: Option<String>, log_tail: Option<String>| {
        if !generation_current(&state, generation) {
            return;
        }
        set_boot(&app, &state, BootState {
            stage: stage.to_string(),
            detail: detail.to_string(),
            error,
            url,
            log_tail,
        });
    };

    set("probe", "scanning for a live harness", None, None, None);

    // Resolve bundled runtime pieces.
    let resource_root = match app.path().resolve("resources/runtime", tauri::path::BaseDirectory::Resource) {
        Ok(path) if path.join("node.exe").exists() => path,
        Ok(_) => match app.path().resolve("runtime", tauri::path::BaseDirectory::Resource) {
            Ok(fallback) => fallback,
            Err(error) => {
                set("failed", "runtime resources are missing", Some(format!("resource resolution failed: {error}")), None, None);
                return;
            }
        },
        Err(error) => {
            set("failed", "runtime resources are missing", Some(format!("resource resolution failed: {error}")), None, None);
            return;
        }
    };
    let node = resource_root.join("node.exe");
    let bin = resource_root.join("node_modules").join("@deepseek-ai").join("dsh").join("lib").join("bin.js");
    if !node.exists() || !bin.exists() {
        set(
            "failed",
            "runtime bundle is incomplete",
            Some(format!("expected node.exe and the dsh CLI at:\n{}\n{}", node.display(), bin.display())),
            None,
            None,
        );
        return;
    }
    let dsh_home = resolve_dsh_home();
    let log_path = match app.path().app_log_dir() {
        Ok(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            dir.join("dsh-web.log")
        }
        Err(_) => std::env::temp_dir().join("dsh-desktop-web.log"),
    };

    let (port, reuse_body) = resolve_target_port();
    let url = format!("http://127.0.0.1:{port}/");

    if reuse_body.is_some() {
        set("reuse", &format!("harness already live on 127.0.0.1:{port}"), None, Some(url.clone()), None);
        let _ = open_main_window(&app, url);
        return;
    }

    set("spawn", &format!("booting harness on 127.0.0.1:{port}"), None, None, None);

    let child = match spawn_harness(&app, &node, &bin, &resource_root, &dsh_home, port, &log_path) {
        Ok(child) => child,
        Err(error) => {
            set("failed", "could not start the harness", Some(error.to_string()), None, None);
            return;
        }
    };
    *state.child.lock().unwrap() = Some(child);

    // Guarantee the harness dies with us, even on TerminateProcess.
    #[cfg(windows)]
    {
        if let Ok(mut guard) = state.job.lock() {
            if let Some(previous) = guard.take() {
                let _ = unsafe {
                    windows::Win32::Foundation::CloseHandle(windows::Win32::Foundation::HANDLE(previous as *mut std::ffi::c_void))
                };
            }
            if let Some(child) = state.child.lock().unwrap().as_ref() {
                *guard = assign_to_kill_job(child);
            }
        }
    }

    set("wait", "composing plugin tree", None, None, None);

    let deadline = Instant::now() + BOOT_TIMEOUT;
    loop {
        if !generation_current(&state, generation) {
            return;
        }
        if tcp_free(port) {
            // port not bound yet — keep waiting
        } else if let Some(body) = probe_dsh(port) {
            let _ = body;
            set("serve", "serving the harness UI", None, Some(url.clone()), None);
            let _ = open_main_window(&app, url);
            return;
        }
        if Instant::now() > deadline {
            let tail = log_tail(&log_path, 30);
            set("failed", "harness did not come up in time", Some("the server log tail may explain why".to_string()), None, Some(tail));
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
            set("failed", "the harness process exited during boot", None, None, Some(tail));
            return;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

fn start_boot(app: &AppHandle, state: &AppState) {
    // Kill any previous child, bump the generation so stale threads bail.
    if let Ok(mut guard) = state.child.lock() {
        if let Some(mut child) = guard.take() {
            kill_child_tree(&mut child);
        }
    }
    let generation = {
        let mut guard = state.generation.lock().unwrap();
        *guard += 1;
        *guard
    };
    let app = app.clone();
    let state = AppState {
        boot: state.boot.clone(),
        child: state.child.clone(),
        generation: state.generation.clone(),
        #[cfg(windows)]
        job: state.job.clone(),
    };
    thread::spawn(move || boot_flow(app, state, generation));
}

fn show_main(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    } else if let Some(splash) = app.get_webview_window("splash") {
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
    start_boot(&app, &state);
}

#[tauri::command]
fn reveal_logs(app: AppHandle) {
    if let Ok(dir) = app.path().app_log_dir() {
        let _ = Command::new("explorer")
            .arg(&dir)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn();
    }
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
fn stage_attachments(paths: Vec<String>) -> Result<Vec<StagedAttachment>, String> {
    let dir = resolve_dsh_home().join("attachments");
    std::fs::create_dir_all(&dir).map_err(|error| format!("create attachments dir: {error}"))?;

    let mut staged = Vec::new();
    for raw in paths {
        let src = PathBuf::from(&raw);
        if !src.exists() {
            continue;
        }
        let name = src
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "attachment".to_string());
        let dst = unique_destination(&dir, &name);
        if src.is_dir() {
            copy_dir_recursive(&src, &dst).map_err(|error| format!("copy dir {raw}: {error}"))?;
            staged.push(StagedAttachment {
                original: raw,
                path: clean_path(&dst).display().to_string(),
                name,
                kind: "directory".to_string(),
            });
        } else if src.is_file() {
            std::fs::copy(&src, &dst).map_err(|error| format!("copy {raw}: {error}"))?;
            staged.push(StagedAttachment {
                original: raw,
                path: clean_path(&dst).display().to_string(),
                name,
                kind: "file".to_string(),
            });
        }
    }
    Ok(staged)
}

// ---------------------------------------------------------------------------
// plugin management (the exe speaks the same `dsh plugin` pnpm protocol)
// ---------------------------------------------------------------------------

#[derive(serde::Serialize)]
struct PluginList {
    home: String,
    profile: String,
    bundles: Vec<String>,
    dependencies: Vec<serde_json::Value>,
    pnpm: bool,
}

fn read_profile_manifest(home: &PathBuf) -> Option<(String, serde_json::Value)> {
    let path = home.join("profiles").join("web").join("package.json");
    let raw = std::fs::read_to_string(&path).ok()?;
    let value: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some((path.display().to_string(), value))
}

#[tauri::command]
fn plugin_list(app: AppHandle) -> PluginList {
    let home = resolve_dsh_home();
    let (profile, manifest) = read_profile_manifest(&home).unwrap_or_else(|| {
        (
            home.join("profiles")
                .join("web")
                .join("package.json")
                .display()
                .to_string(),
            serde_json::json!({}),
        )
    });
    let bundles = manifest
        .pointer("/dsh/profile/bundles")
        .and_then(|v| v.as_array())
        .map(|rows| {
            rows.iter()
                .filter_map(|v| v.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let dependencies = manifest
        .pointer("/dependencies")
        .and_then(|v| v.as_object())
        .map(|deps| {
            deps.iter()
                .map(|(k, v)| serde_json::json!({ "name": k, "spec": v }))
                .collect()
        })
        .unwrap_or_default();
    let pnpm = tools_dir(&app)
        .map(|dir| dir.join("pnpm.exe").exists() || dir.join("pnpm").join("pnpm.exe").exists())
        .unwrap_or(false);
    PluginList {
        home: home.display().to_string(),
        profile,
        bundles,
        dependencies,
        pnpm,
    }
}

/// Forward a `dsh plugin` operation to pnpm through the bundled runtime:
/// action is `add` or `remove`, `name` is any pnpm spec (name, file:, link:,
/// git+, ...). Runs `node bin.js plugin --profile web <action> <name>`.
#[tauri::command]
fn plugin_manage(app: AppHandle, action: String, name: String) -> Result<String, String> {
    if action != "add" && action != "remove" {
        return Err(format!("unknown plugin action {action:?}"));
    }
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("plugin spec is empty".to_string());
    }
    let resource_root = app
        .path()
        .resolve("resources/runtime", tauri::path::BaseDirectory::Resource)
        .or_else(|_| app.path().resolve("runtime", tauri::path::BaseDirectory::Resource))
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
    let home = resolve_dsh_home();
    let mut cmd = Command::new(&node);
    cmd.arg(&bin)
        .args(["plugin", "--profile", "web", &action, &name])
        .env("DSH_HOME", &home)
        .env("PATH", child_path(&app))
        .current_dir(&home);
    #[cfg(windows)]
    {
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let output = cmd.output().map_err(|error| error.to_string())?;
    let mut combined = String::from_utf8_lossy(&output.stdout).to_string();
    combined.push_str(&String::from_utf8_lossy(&output.stderr));
    if !output.status.success() {
        return Err(combined);
    }
    Ok(combined)
}

// ---------------------------------------------------------------------------
// entry
// ---------------------------------------------------------------------------

pub fn run() {
    #[cfg(debug_assertions)]
    {
        // Allow CDP inspection of the WebView2 for design verification.
        if std::env::var_os("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").is_none() {
            std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "--remote-debugging-port=9333");
        }
    }

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }))
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![boot_state, retry_boot, reveal_logs, stage_attachments, plugin_list, plugin_manage])
        .setup(|app| {
            let handle = app.handle().clone();
            build_tray(&handle)?;
            let state: tauri::State<'_, AppState> = app.state();
            start_boot(&handle, &state);
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let WindowEvent::CloseRequested { api, .. } = event {
                    // Closing hides to tray; the agent keeps working.
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building the DSH Desktop app");

    app.run(|app_handle, event| match event {
        RunEvent::ExitRequested { .. } | RunEvent::Exit => {
            let child = {
                let child_arc = app_handle.state::<AppState>().child.clone();
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
