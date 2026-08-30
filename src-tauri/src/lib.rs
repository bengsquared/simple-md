use ignore::WalkBuilder;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher, Utf32Str};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant, UNIX_EPOCH};
use tauri::{Emitter, Manager, State};

const INDEXED_EXTS: &[&str] = &[
    "md", "markdown", "mdx", "txt", "text", "rst", "adoc", "org",
];

/// How long the on-disk index cache is trusted before a background rebuild.
const REBUILD_TTL_SECS: u64 = 300;

/// How long the watcher coalesces filesystem events before touching the
/// index, so a git checkout storm becomes one batch instead of thousands
/// of per-event index scans.
const WATCH_BATCH: Duration = Duration::from_millis(200);

#[derive(Default)]
struct AppState {
    // Full paths of indexed files, sorted most-recently-modified first.
    index: Mutex<Vec<String>>,
    indexing: Mutex<bool>,
    // Watcher changes made while a rebuild walk is running; replayed on top
    // of the fresh index before it is published, so the rebuild cannot
    // clobber live updates. (String path -> still exists?)
    journal: Mutex<Vec<(String, bool)>>,
    pending_open: Mutex<Vec<String>>,
    // Held so the filesystem watcher lives as long as the app.
    watcher: Mutex<Option<notify::RecommendedWatcher>>,
}

/// Lock that recovers from poisoning: a panic in one thread must not wedge
/// every future access to this state for the life of the process.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

#[derive(Serialize, Deserialize, Clone)]
struct RootsConfig {
    roots: Vec<String>,
}

#[derive(Serialize)]
struct FileContent {
    content: String,
    mtime: u64,
}

#[derive(Serialize)]
struct SearchResult {
    path: String,
    score: u32,
}

#[derive(Serialize)]
struct IndexStatus {
    count: usize,
    indexing: bool,
}

/// On-disk snapshot of the index so relaunches search instantly instead of
/// re-walking the roots. Invalid when the roots changed; stale (but still
/// served) past REBUILD_TTL_SECS, which triggers a background rebuild.
#[derive(Serialize, Deserialize)]
struct IndexCache {
    roots: Vec<String>,
    built_at: u64,
    files: Vec<String>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn expand_tilde(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = dirs::home_dir() {
            return home.join(rest);
        }
    }
    PathBuf::from(path)
}

fn config_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("roots.json"))
}

fn cache_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("index-cache.json"))
}

fn load_roots(app: &tauri::AppHandle) -> Vec<String> {
    if let Some(path) = config_path(app) {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(cfg) = serde_json::from_str::<RootsConfig>(&raw) {
                if !cfg.roots.is_empty() {
                    return cfg.roots;
                }
            }
        }
    }
    default_roots()
}

fn default_roots() -> Vec<String> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        for candidate in ["Documents", "Desktop", "Downloads"] {
            let p = home.join(candidate);
            if p.is_dir() {
                roots.push(p.to_string_lossy().to_string());
            }
        }
    }
    roots
}

fn load_cache(app: &tauri::AppHandle) -> Option<IndexCache> {
    let raw = std::fs::read_to_string(cache_path(app)?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn save_cache(app: &tauri::AppHandle, cache: &IndexCache) {
    let Some(path) = cache_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string(cache) {
        let _ = std::fs::write(path, json);
    }
}

fn mtime_of(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---------- Index building ----------

fn build_index(roots: &[String]) -> Vec<String> {
    let mut entries: Vec<(u64, String)> = Vec::new();
    for root in roots {
        let root = expand_tilde(root);
        if !root.is_dir() {
            continue;
        }
        let walker = WalkBuilder::new(&root)
            .hidden(true)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .follow_links(false)
            .max_depth(Some(14))
            .build();
        for entry in walker.flatten() {
            let path = entry.path();
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let ext_ok = path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| INDEXED_EXTS.contains(&e.to_ascii_lowercase().as_str()))
                .unwrap_or(false);
            if !ext_ok {
                continue;
            }
            entries.push((mtime_of(path), path.to_string_lossy().to_string()));
        }
    }
    // Dedup (overlapping/nested roots index the same file twice) needs
    // path-adjacency, so sort by path first, then by recency for the final
    // most-recently-modified-first order.
    entries.sort_by(|a, b| a.1.cmp(&b.1));
    entries.dedup_by(|a, b| a.1 == b.1);
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.into_iter().map(|(_, p)| p).collect()
}

/// Remove `touched` paths from `index` and re-insert the still-existing
/// ones at the front (most recent). O(index + touched).
fn apply_touched(index: &mut Vec<String>, touched: &HashMap<String, bool>) {
    let old = std::mem::take(index);
    let mut fresh: Vec<String> = touched
        .iter()
        .filter(|(_, exists)| **exists)
        .map(|(p, _)| p.clone())
        .collect();
    fresh.extend(old.into_iter().filter(|p| !touched.contains_key(p)));
    *index = fresh;
}

/// Clears the indexing flag even if the rebuild thread panics, so a failed
/// rebuild can never permanently block future rebuilds.
struct IndexingGuard(tauri::AppHandle);

impl Drop for IndexingGuard {
    fn drop(&mut self) {
        *lock(&self.0.state::<AppState>().indexing) = false;
    }
}

fn rebuild_index_async(app: tauri::AppHandle) {
    {
        let state = app.state::<AppState>();
        let mut indexing = lock(&state.indexing);
        if *indexing {
            return;
        }
        *indexing = true;
        lock(&state.journal).clear();
    }
    let roots = load_roots(&app);
    std::thread::spawn(move || {
        let _guard = IndexingGuard(app.clone());
        let mut index = build_index(&roots);
        let state = app.state::<AppState>();
        // Replay watcher changes that happened during the walk.
        let journal = std::mem::take(&mut *lock(&state.journal));
        if !journal.is_empty() {
            let touched: HashMap<String, bool> = journal.into_iter().collect();
            apply_touched(&mut index, &touched);
        }
        save_cache(
            &app,
            &IndexCache {
                roots,
                built_at: now_secs(),
                files: index.clone(),
            },
        );
        let count = index.len();
        *lock(&state.index) = index;
        let _ = app.emit("index-ready", count);
    });
}

// ---------- Filesystem watcher ----------

/// Should this path be in the index? Mirrors the walker's filters closely
/// enough for live updates: right extension, no hidden or dependency dirs.
fn is_indexable(path: &Path) -> bool {
    let ext_ok = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| INDEXED_EXTS.contains(&e.to_ascii_lowercase().as_str()))
        .unwrap_or(false);
    ext_ok
        && !path.components().any(|c| {
            let name = c.as_os_str().to_string_lossy();
            (name.starts_with('.') && name.len() > 1) || name == "node_modules" || name == "target"
        })
}

/// Keep the in-memory index current while the app runs. Events are batched
/// for WATCH_BATCH and folded to a final per-path state before the index is
/// touched once per batch.
fn start_watcher(app: tauri::AppHandle, roots: &[String]) {
    use notify::{RecursiveMode, Watcher};
    let (tx, rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = match notify::recommended_watcher(tx) {
        Ok(w) => w,
        Err(err) => {
            eprintln!("watcher init failed: {err}");
            let _ = app.emit("index-warning", "live updates unavailable");
            return;
        }
    };
    for root in roots {
        if let Err(err) = watcher.watch(&expand_tilde(root), RecursiveMode::Recursive) {
            eprintln!("cannot watch {root}: {err}");
            let _ = app.emit("index-warning", format!("not watching {root}"));
        }
    }
    *lock(&app.state::<AppState>().watcher) = Some(watcher);

    std::thread::spawn(move || {
        loop {
            let first = match rx.recv() {
                Ok(ev) => ev,
                Err(_) => break, // watcher dropped (replaced or app exit)
            };
            let mut batch: Vec<notify::Event> = first.into_iter().collect();
            let deadline = Instant::now() + WATCH_BATCH;
            loop {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    break;
                }
                match rx.recv_timeout(remaining) {
                    Ok(Ok(ev)) => batch.push(ev),
                    Ok(Err(_)) => {}
                    Err(_) => break,
                }
            }

            let mut touched: HashMap<String, bool> = HashMap::new();
            for event in &batch {
                for path in &event.paths {
                    if is_indexable(path) {
                        touched.insert(path.to_string_lossy().to_string(), path.is_file());
                    }
                }
            }
            if touched.is_empty() {
                continue;
            }

            let state = app.state::<AppState>();
            if *lock(&state.indexing) {
                lock(&state.journal).extend(touched.iter().map(|(k, v)| (k.clone(), *v)));
            }
            let count = {
                let mut index = lock(&state.index);
                apply_touched(&mut index, &touched);
                index.len()
            };
            let _ = app.emit("index-ready", count);
        }
    });
}

/// Serve the cached index immediately; rebuild in the background only when
/// there is no usable cache or it has gone stale.
fn init_index(app: tauri::AppHandle) {
    let roots = load_roots(&app);
    let fresh = match load_cache(&app) {
        Some(cache) if cache.roots == roots => {
            let fresh = now_secs().saturating_sub(cache.built_at) < REBUILD_TTL_SECS;
            *lock(&app.state::<AppState>().index) = cache.files;
            fresh
        }
        _ => false,
    };
    if !fresh {
        rebuild_index_async(app.clone());
    }
    start_watcher(app, &roots);
}

/// Persist the live index at quit so the next launch starts warm.
fn save_cache_on_exit(app: &tauri::AppHandle) {
    let state = app.state::<AppState>();
    if *lock(&state.indexing) {
        return; // a rebuild is mid-flight; don't snapshot a partial index
    }
    let files = lock(&state.index).clone();
    if files.is_empty() {
        return;
    }
    save_cache(
        app,
        &IndexCache {
            roots: load_roots(app),
            built_at: now_secs(),
            files,
        },
    );
}

// ---------- Commands ----------

#[tauri::command]
fn search_files(query: String, state: State<AppState>) -> Vec<SearchResult> {
    let index = lock(&state.index);
    let trimmed = query.trim();
    if trimmed.is_empty() {
        // Empty query: most recently modified files.
        return index
            .iter()
            .take(50)
            .map(|p| SearchResult {
                path: p.clone(),
                score: 0,
            })
            .collect();
    }
    let mut matcher = Matcher::new(Config::DEFAULT.match_paths());
    let pattern = Pattern::parse(trimmed, CaseMatching::Ignore, Normalization::Smart);
    let mut path_buf = Vec::new();
    let mut name_buf = Vec::new();
    // Score the full path, then heavily boost matches that also hit the
    // filename itself so "test" ranks test-doc.md above foo/tests/bar.txt.
    let mut scored: Vec<(u32, &String)> = index
        .iter()
        .filter_map(|p| {
            let score = pattern.score(Utf32Str::new(p, &mut path_buf), &mut matcher)?;
            let name = p.rsplit('/').next().unwrap_or(p);
            let name_bonus = pattern
                .score(Utf32Str::new(name, &mut name_buf), &mut matcher)
                .unwrap_or(0);
            Some((score + name_bonus * 2, p))
        })
        .collect();
    scored.sort_unstable_by(|a, b| b.0.cmp(&a.0));
    scored
        .into_iter()
        .take(80)
        .map(|(score, p)| SearchResult {
            path: p.clone(),
            score,
        })
        .collect()
}

#[tauri::command]
fn refresh_index(app: tauri::AppHandle) {
    rebuild_index_async(app);
}

#[tauri::command]
fn index_status(state: State<AppState>) -> IndexStatus {
    IndexStatus {
        count: lock(&state.index).len(),
        indexing: *lock(&state.indexing),
    }
}

#[tauri::command]
fn get_roots(app: tauri::AppHandle) -> Vec<String> {
    load_roots(&app)
}

#[tauri::command]
fn set_roots(app: tauri::AppHandle, roots: Vec<String>) -> Result<(), String> {
    let path = config_path(&app).ok_or("no config dir")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let cfg = RootsConfig { roots };
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).unwrap())
        .map_err(|e| e.to_string())?;
    rebuild_index_async(app.clone());
    start_watcher(app, &cfg.roots); // replaces (and drops) the old watcher
    Ok(())
}

#[tauri::command]
fn read_file(path: String) -> Result<FileContent, String> {
    let path = expand_tilde(&path);
    let content = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    Ok(FileContent {
        content,
        mtime: mtime_of(&path),
    })
}

/// Error prefix the frontend matches on to distinguish a conflict from an
/// IO failure.
const CONFLICT: &str = "conflict";

/// Atomic save with server-side conflict detection: when `expected_mtime`
/// is given and the file on disk no longer matches it, nothing is written
/// and a `conflict` error is returned. Pass no expected mtime to force.
#[tauri::command]
fn write_file(path: String, content: String, expected_mtime: Option<u64>) -> Result<u64, String> {
    let path = expand_tilde(&path);
    if let Some(expected) = expected_mtime {
        if path.exists() && mtime_of(&path) != expected {
            return Err(format!("{CONFLICT}: file changed on disk"));
        }
    }
    // Atomic save: write a sibling temp file, then rename over the target,
    // so a crash mid-write can never truncate the document.
    let dir = path.parent().ok_or("path has no parent directory")?;
    let mut tmp = dir.join(format!(
        ".{}.mdmachine-tmp",
        path.file_name()
            .and_then(|n| n.to_str())
            .ok_or("path has no file name")?
    ));
    if tmp.exists() {
        tmp = dir.join(format!(".{}.mdmachine-tmp2", now_secs()));
    }
    std::fs::write(&tmp, content).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })?;
    Ok(mtime_of(&path))
}

#[tauri::command]
fn stat_mtime(path: String) -> Option<u64> {
    let path = expand_tilde(&path);
    if path.is_file() {
        Some(mtime_of(&path))
    } else {
        None
    }
}

#[tauri::command]
fn path_exists(path: String) -> bool {
    expand_tilde(&path).is_file()
}

#[tauri::command]
fn take_pending_open(state: State<AppState>) -> Vec<String> {
    std::mem::take(&mut *lock(&state.pending_open))
}

/// User override stylesheet, loaded after the built-in voice rules.
/// Lives beside roots.json; absent file means no overrides.
#[tauri::command]
fn read_theme_css(app: tauri::AppHandle) -> Option<String> {
    let path = app.path().app_config_dir().ok()?.join("theme.css");
    std::fs::read_to_string(path).ok()
}

/// Open an additional editor window (cmd+N). Each window runs the full app:
/// its own document, palette, and appearance state.
#[tauri::command]
fn new_window(app: tauri::AppHandle) -> Result<(), String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    static WIN_SEQ: AtomicUsize = AtomicUsize::new(1);
    let label = format!("win-{}", WIN_SEQ.fetch_add(1, Ordering::Relaxed));
    #[allow(unused_mut)]
    let mut builder = tauri::WebviewWindowBuilder::new(
        &app,
        &label,
        tauri::WebviewUrl::App("index.html".into()),
    )
    .title("MD Machine")
    .inner_size(1100.0, 820.0)
    .min_inner_size(600.0, 400.0);
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(tauri::LogicalPosition::new(16.0, 14.0));
    }
    builder.build().map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            search_files,
            refresh_index,
            index_status,
            get_roots,
            set_roots,
            read_file,
            write_file,
            stat_mtime,
            path_exists,
            take_pending_open,
            new_window,
            read_theme_css,
        ])
        .setup(|app| {
            init_index(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                save_cache_on_exit(app);
            }
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Opened { ref urls } = event {
                let paths: Vec<String> = urls
                    .iter()
                    .filter_map(|u| u.to_file_path().ok())
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();
                if paths.is_empty() {
                    return;
                }
                // The queue is the single source of open requests; the event
                // is only a wake-up. The frontend drains the queue both at
                // startup (event fired before it was listening) and on event.
                let state = app.state::<AppState>();
                lock(&state.pending_open).extend(paths);
                let _ = app.emit("open-request", ());
                if let Some(win) = app.webview_windows().values().next() {
                    let _ = win.set_focus();
                }
            }
            let _ = (app, &event);
        });
}
