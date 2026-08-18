//! DSH Desktop runtime log hub.
//!
//! Every log line is a structured record with five independent axes:
//! * level   — TRACE / DEBUG / INFO / WARN / ERROR / FATAL
//! * module  — which part of the shell produced the line
//! * kind    — what kind of activity it describes
//! * message — free-form human readable text
//! * context — optional structured JSON payload
//!
//! Records go to three sinks simultaneously:
//! 1. a bounded in-memory ring buffer (fast search/filter from the UI),
//! 2. a JSONL file in the app-log directory (`dsh-desktop.log`),
//! 3. a `log://entry` event to every open window (live tail in the UI).

use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    thread,
};

pub const EVENT_LOG_ENTRY: &str = "log://entry";

/// Sink used to broadcast an entry to the UI. Kept as a callback (instead of
/// a Tauri handle) so the log hub stays testable without linking the window
/// shell.
pub type LogEmitter = Arc<dyn Fn(&LogEntry) + Send + Sync>;

pub const DEFAULT_CAPACITY: usize = 5_000;
pub const DEFAULT_PAGE: usize = 300;
pub const MAX_PAGE: usize = 1_000;
pub const MAX_MESSAGE_CHARS: usize = 16_000;
pub const MAX_TAG_CHARS: usize = 24;
pub const FILE_ROTATE_BYTES: u64 = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// classifications
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LogLevel {
    Trace,
    Debug,
    Info,
    Warn,
    Error,
    Fatal,
}

impl LogLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Trace => "TRACE",
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
            Self::Fatal => "FATAL",
        }
    }
}

pub fn parse_level(text: &str) -> Result<LogLevel, String> {
    match text.trim().to_ascii_uppercase().as_str() {
        "TRACE" => Ok(LogLevel::Trace),
        "DEBUG" => Ok(LogLevel::Debug),
        "INFO" => Ok(LogLevel::Info),
        "WARN" | "WARNING" => Ok(LogLevel::Warn),
        "ERROR" => Ok(LogLevel::Error),
        "FATAL" | "CRITICAL" => Ok(LogLevel::Fatal),
        other => Err(format!("unknown log level {other:?}")),
    }
}

pub const LEVELS: [&str; 6] = ["TRACE", "DEBUG", "INFO", "WARN", "ERROR", "FATAL"];

pub const MODULE_APP: &str = "app";
pub const MODULE_BOOT: &str = "boot";
pub const MODULE_HARNESS: &str = "harness";
pub const MODULE_PLUGIN: &str = "plugin";
pub const MODULE_WINDOW: &str = "window";
pub const MODULE_TRAY: &str = "tray";
pub const MODULE_ATTACHMENT: &str = "attachment";
pub const MODULE_IPC: &str = "ipc";
pub const MODULE_LOGGER: &str = "logger";

pub const MODULES: [&str; 9] = [
    MODULE_APP,
    MODULE_BOOT,
    MODULE_HARNESS,
    MODULE_PLUGIN,
    MODULE_WINDOW,
    MODULE_TRAY,
    MODULE_ATTACHMENT,
    MODULE_IPC,
    MODULE_LOGGER,
];

pub const KIND_LIFECYCLE: &str = "lifecycle";
pub const KIND_STATE: &str = "state";
pub const KIND_NETWORK: &str = "network";
pub const KIND_PROCESS: &str = "process";
pub const KIND_FILE: &str = "file";
pub const KIND_IPC: &str = "ipc";
pub const KIND_COMMAND: &str = "command";
pub const KIND_UI: &str = "ui";
pub const KIND_PERFORMANCE: &str = "performance";
pub const KIND_DIAGNOSTIC: &str = "diagnostic";
pub const KIND_CHILD_STDOUT: &str = "stdout";
pub const KIND_CHILD_STDERR: &str = "stderr";

pub const KINDS: [&str; 12] = [
    KIND_LIFECYCLE,
    KIND_STATE,
    KIND_NETWORK,
    KIND_PROCESS,
    KIND_FILE,
    KIND_IPC,
    KIND_COMMAND,
    KIND_UI,
    KIND_PERFORMANCE,
    KIND_DIAGNOSTIC,
    KIND_CHILD_STDOUT,
    KIND_CHILD_STDERR,
];

// ---------------------------------------------------------------------------
// structured record
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    /// Monotonic per-run sequence number; stable cursor for pagination.
    pub seq: u64,
    /// Local wall-clock time, e.g. `2025-08-16 14:31:05.203`.
    pub ts: String,
    /// Milliseconds since UNIX epoch for exact ordering/export.
    pub epoch_ms: u64,
    pub level: String,
    pub module: String,
    pub kind: String,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LogQuery {
    /// Whitespace-separated terms; every term must match the combined
    /// timestamp/level/module/kind/message text (case-insensitive).
    pub text: String,
    /// Empty means "all levels".
    pub levels: Vec<String>,
    /// Empty means "all modules".
    pub modules: Vec<String>,
    /// Empty means "all kinds".
    pub kinds: Vec<String>,
    /// Fetch entries older than this seq. `None` fetches the newest page.
    pub before: Option<u64>,
    pub limit: usize,
}

impl LogQuery {
    fn normalized_limit(&self) -> usize {
        if self.limit == 0 {
            DEFAULT_PAGE
        } else {
            self.limit.clamp(1, MAX_PAGE)
        }
    }

    fn terms(&self) -> Vec<String> {
        self.text
            .split_whitespace()
            .map(|term| term.to_lowercase())
            .collect()
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogPage {
    /// Chronological page (oldest first inside the page).
    pub entries: Vec<LogEntry>,
    /// Number of entries matching the filters (including ones beyond the page).
    pub total_matches: usize,
    /// True when older matching entries exist.
    pub has_more: bool,
    /// Cursor for the next older page (the oldest seq in this page).
    pub before: Option<u64>,
    pub ring_entries: usize,
    pub capacity: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LogMeta {
    pub levels: Vec<String>,
    pub modules: Vec<String>,
    pub kinds: Vec<String>,
    pub file: Option<String>,
    pub ring_entries: usize,
    pub capacity: usize,
    pub last_seq: u64,
}

// ---------------------------------------------------------------------------
// hub
// ---------------------------------------------------------------------------

struct LogStore {
    entries: VecDeque<LogEntry>,
    next_seq: u64,
    capacity: usize,
}

impl LogStore {
    fn new(capacity: usize) -> Self {
        Self {
            entries: VecDeque::with_capacity(capacity.min(1024)),
            next_seq: 1,
            capacity,
        }
    }
}

pub struct LogHub {
    store: Mutex<LogStore>,
    file: Mutex<Option<File>>,
    file_path: Mutex<Option<PathBuf>>,
    emitter: Mutex<Option<LogEmitter>>,
}

impl Default for LogHub {
    fn default() -> Self {
        Self {
            store: Mutex::new(LogStore::new(DEFAULT_CAPACITY)),
            file: Mutex::new(None),
            file_path: Mutex::new(None),
            emitter: Mutex::new(None),
        }
    }
}

fn lock_guard<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn truncate_chars(mut text: String, max_chars: usize) -> String {
    if text.chars().count() > max_chars {
        if let Some((index, _)) = text.char_indices().nth(max_chars) {
            text.truncate(index);
        }
        text.push_str(" … [truncated]");
    }
    text
}

fn sanitize_tag(value: &str, fallback: &str) -> String {
    let mut cleaned: String = value
        .trim()
        .chars()
        .map(|c| c.to_ascii_lowercase())
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    if cleaned.is_empty() {
        return fallback.to_string();
    }
    if cleaned.chars().count() > MAX_TAG_CHARS {
        cleaned = cleaned.chars().take(MAX_TAG_CHARS).collect();
    }
    cleaned
}

impl LogHub {
    /// Attach the JSONL log file. Safe to call once during setup.
    pub fn attach(&self, path: &Path) -> std::io::Result<()> {
        *lock_guard(&self.file_path) = Some(path.to_path_buf());

        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        Self::rotate_if_needed(path);
        let file = OpenOptions::new().create(true).append(true).open(path)?;
        *lock_guard(&self.file) = Some(file);
        Ok(())
    }

    fn rotate_if_needed(path: &Path) {
        let Ok(metadata) = fs::metadata(path) else {
            return;
        };
        if metadata.len() <= FILE_ROTATE_BYTES {
            return;
        }
        let stem = path
            .file_stem()
            .and_then(|stem| stem.to_str())
            .unwrap_or("dsh-desktop");
        let ext = path
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| format!(".{ext}"))
            .unwrap_or_default();
        let rotated = path.with_file_name(format!("{stem}.1{ext}"));
        let _ = fs::remove_file(&rotated);
        let _ = fs::rename(path, &rotated);
    }

    pub fn trace(&self, module: &str, kind: &str, message: impl Into<String>) -> LogEntry {
        self.record(LogLevel::Trace, module, kind, message.into(), None)
    }

    pub fn debug(&self, module: &str, kind: &str, message: impl Into<String>) -> LogEntry {
        self.record(LogLevel::Debug, module, kind, message.into(), None)
    }

    pub fn info(&self, module: &str, kind: &str, message: impl Into<String>) -> LogEntry {
        self.record(LogLevel::Info, module, kind, message.into(), None)
    }

    pub fn warn(&self, module: &str, kind: &str, message: impl Into<String>) -> LogEntry {
        self.record(LogLevel::Warn, module, kind, message.into(), None)
    }

    pub fn error(&self, module: &str, kind: &str, message: impl Into<String>) -> LogEntry {
        self.record(LogLevel::Error, module, kind, message.into(), None)
    }

    #[allow(dead_code)] // kept as the public severity API; child-line classification reaches it via LogLevel
    pub fn fatal(&self, module: &str, kind: &str, message: impl Into<String>) -> LogEntry {
        self.record(LogLevel::Fatal, module, kind, message.into(), None)
    }

    pub fn log_with(
        &self,
        level: LogLevel,
        module: &str,
        kind: &str,
        message: impl Into<String>,
        context: serde_json::Value,
    ) -> LogEntry {
        self.record(level, module, kind, message.into(), Some(context))
    }

    pub fn record(
        &self,
        level: LogLevel,
        module: &str,
        kind: &str,
        message: String,
        context: Option<serde_json::Value>,
    ) -> LogEntry {
        let now = chrono::Local::now();
        let module = sanitize_tag(module, MODULE_APP);
        let kind = sanitize_tag(kind, KIND_DIAGNOSTIC);
        let message = truncate_chars(message, MAX_MESSAGE_CHARS);

        let entry = {
            let mut store = lock_guard(&self.store);
            let seq = store.next_seq;
            store.next_seq += 1;
            let entry = LogEntry {
                seq,
                ts: now.format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
                epoch_ms: now.timestamp_millis() as u64,
                level: level.as_str().to_string(),
                module,
                kind,
                message,
                context,
            };
            store.entries.push_back(entry.clone());
            while store.entries.len() > store.capacity {
                store.entries.pop_front();
            }
            entry
        };

        self.write_file(&entry);
        self.emit(&entry);
        entry
    }

    fn write_file(&self, entry: &LogEntry) {
        if let Some(file) = lock_guard(&self.file).as_mut() {
            if let Ok(line) = serde_json::to_string(entry) {
                let _ = writeln!(file, "{line}");
                let _ = file.flush();
            }
        }
    }

    /// Install the UI broadcast sink. The shell passes a closure that emits a
    /// Tauri event; tests can leave it unset.
    pub fn set_emitter(&self, emitter: LogEmitter) {
        *lock_guard(&self.emitter) = Some(emitter);
    }

    fn emit(&self, entry: &LogEntry) {
        let emitter = lock_guard(&self.emitter).clone();
        if let Some(emit) = emitter {
            emit(entry);
        }
    }

    pub fn query(&self, query: &LogQuery) -> LogPage {
        let (matching, ring_entries, capacity) = {
            let store = lock_guard(&self.store);
            let terms = query.terms();
            let matching: Vec<LogEntry> = store
                .entries
                .iter()
                .filter(|entry| Self::entry_matches(entry, query, &terms))
                .cloned()
                .collect();
            (matching, store.entries.len(), store.capacity)
        };

        // `total_matches` stays stable while paging; the cursor only limits
        // which slice of that result set is returned.
        let total_matches = matching.len();
        let mut matched: Vec<LogEntry> = match query.before {
            Some(before) => matching
                .into_iter()
                .filter(|entry| entry.seq < before)
                .collect(),
            None => matching,
        };

        let limit = query.normalized_limit();
        let has_more = matched.len() > limit;
        let start = matched.len().saturating_sub(limit);
        let entries = matched.split_off(start);
        let before = entries.first().map(|entry| entry.seq);
        LogPage {
            entries,
            total_matches,
            has_more,
            before,
            ring_entries,
            capacity,
        }
    }

    fn entry_matches(entry: &LogEntry, query: &LogQuery, terms: &[String]) -> bool {
        if !query.levels.is_empty()
            && !query
                .levels
                .iter()
                .any(|level| entry.level.eq_ignore_ascii_case(level))
        {
            return false;
        }
        if !query.modules.is_empty()
            && !query
                .modules
                .iter()
                .any(|module| entry.module.eq_ignore_ascii_case(module))
        {
            return false;
        }
        if !query.kinds.is_empty()
            && !query
                .kinds
                .iter()
                .any(|kind| entry.kind.eq_ignore_ascii_case(kind))
        {
            return false;
        }
        if terms.is_empty() {
            return true;
        }
        let mut haystack = format!(
            "{} {} {} {} {} {}",
            entry.ts, entry.level, entry.module, entry.kind, entry.message, entry.seq
        );
        if let Some(context) = entry.context.as_ref() {
            haystack.push(' ');
            haystack.push_str(&context.to_string());
        }
        let haystack = haystack.to_lowercase();
        terms.iter().all(|term| haystack.contains(term))
    }

    pub fn meta(&self) -> LogMeta {
        let (file, ring_entries, capacity, last_seq) = {
            let file = lock_guard(&self.file_path).clone();
            let store = lock_guard(&self.store);
            (
                file.map(|path| path.display().to_string()),
                store.entries.len(),
                store.capacity,
                store.next_seq.saturating_sub(1),
            )
        };
        LogMeta {
            levels: LEVELS.iter().map(|level| level.to_string()).collect(),
            modules: MODULES.iter().map(|module| module.to_string()).collect(),
            kinds: KINDS.iter().map(|kind| kind.to_string()).collect(),
            file,
            ring_entries,
            capacity,
            last_seq,
        }
    }

    /// Clear the in-memory ring only. The JSONL file is append-only and keeps
    /// the complete history; callers should log a marker after clearing.
    pub fn clear_ring(&self) -> usize {
        let mut store = lock_guard(&self.store);
        let cleared = store.entries.len();
        store.entries.clear();
        cleared
    }
}

// ---------------------------------------------------------------------------
// child-process stdout/stderr tee
// ---------------------------------------------------------------------------

/// Read a child pipe line-by-line, tee raw text into `file`, and publish each
/// line as a structured DEBUG-level harness record (errors/warnings in the
/// text are promoted to the matching level).
pub fn stream_child_output<R: Read + Send + 'static>(
    stream: R,
    stderr: bool,
    file: Arc<Mutex<File>>,
    logs: Arc<LogHub>,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let kind = if stderr {
            KIND_CHILD_STDERR
        } else {
            KIND_CHILD_STDOUT
        };
        let mut reader = BufReader::new(stream);
        let mut bytes = Vec::with_capacity(4096);
        loop {
            bytes.clear();
            match reader.read_until(b'\n', &mut bytes) {
                Ok(0) => break,
                Ok(_) => {
                    if bytes.last() == Some(&b'\n') {
                        bytes.pop();
                    }
                    if bytes.last() == Some(&b'\r') {
                        bytes.pop();
                    }
                    // `read_until` + lossy conversion keeps the stream alive
                    // even when the child emits non-UTF-8 bytes.
                    let line = truncate_chars(
                        String::from_utf8_lossy(&bytes).to_string(),
                        MAX_MESSAGE_CHARS,
                    );
                    if let Ok(mut file) = file.lock() {
                        let _ = writeln!(file, "{line}");
                    }
                    let level = classify_child_line(&line, stderr);
                    logs.record(level, MODULE_HARNESS, kind, line, None);
                }
                Err(_) => {
                    logs.warn(
                        MODULE_HARNESS,
                        KIND_PROCESS,
                        "harness child pipe closed while reading output",
                    );
                    break;
                }
            }
        }
    })
}

fn classify_child_line(line: &str, stderr: bool) -> LogLevel {
    let lower = line.to_ascii_lowercase();
    let has = |needle: &str| lower.contains(needle);
    if has("fatal") || has("panic") {
        LogLevel::Fatal
    } else if has("error")
        || has("exception")
        || has("traceback")
        || has("eaddrinuse")
        || has("address already in use")
        || has("failed to")
    {
        LogLevel::Error
    } else if has("warn") || has("deprecat") {
        LogLevel::Warn
    } else if has("trace") {
        LogLevel::Trace
    } else if has("debug") || has("verbose") {
        LogLevel::Debug
    } else if stderr {
        LogLevel::Info
    } else {
        LogLevel::Debug
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structured_query_filters_and_searches() {
        let hub = LogHub::default();
        hub.info(
            MODULE_BOOT,
            KIND_NETWORK,
            "port 3080 answered the DSH probe",
        );
        hub.warn(MODULE_PLUGIN, KIND_PROCESS, "plugin demo failed to load");
        hub.error(
            MODULE_HARNESS,
            KIND_CHILD_STDERR,
            "Error: listen EADDRINUSE",
        );

        let all = hub.query(&LogQuery::default());
        assert_eq!(all.total_matches, 3);

        let text = hub.query(&LogQuery {
            text: "3080".to_string(),
            ..LogQuery::default()
        });
        assert_eq!(text.total_matches, 1);
        assert_eq!(text.entries[0].module, MODULE_BOOT);

        let errors = hub.query(&LogQuery {
            levels: vec!["ERROR".to_string()],
            ..LogQuery::default()
        });
        assert_eq!(errors.total_matches, 1);
        assert_eq!(errors.entries[0].kind, KIND_CHILD_STDERR);

        let plugin = hub.query(&LogQuery {
            modules: vec![MODULE_PLUGIN.to_string()],
            kinds: vec![KIND_PROCESS.to_string()],
            ..LogQuery::default()
        });
        assert_eq!(plugin.total_matches, 1);
    }

    #[test]
    fn jsonl_file_persists_every_entry() {
        let path =
            std::env::temp_dir().join(format!("dsh-desktop-log-test-{}.log", std::process::id()));
        let _ = fs::remove_file(&path);
        let hub = LogHub::default();
        hub.attach(&path).expect("attach log file");
        hub.info(MODULE_APP, KIND_LIFECYCLE, "file persistence probe");
        hub.warn(MODULE_BOOT, KIND_NETWORK, "port probe timed out");

        let text = fs::read_to_string(&path).expect("read log file");
        assert_eq!(text.lines().count(), 2);
        assert!(text.contains("file persistence probe"));
        assert!(text.contains("port probe timed out"));
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn pagination_walks_older_entries() {
        let hub = LogHub::default();
        for n in 1..=10 {
            hub.info(MODULE_BOOT, KIND_STATE, format!("entry {n}"));
        }
        let first = hub.query(&LogQuery {
            limit: 4,
            ..LogQuery::default()
        });
        assert_eq!(first.entries.len(), 4);
        assert!(first.has_more);
        assert_eq!(first.entries[0].message, "entry 7");

        let older = hub.query(&LogQuery {
            limit: 10,
            before: first.before,
            ..LogQuery::default()
        });
        assert_eq!(older.entries.len(), 6);
        assert!(!older.has_more);
        assert_eq!(older.entries[0].message, "entry 1");
    }
}
