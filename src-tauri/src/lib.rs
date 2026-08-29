use ignore::WalkBuilder;
use nucleo_matcher::pattern::{CaseMatching, Normalization, Pattern};
use nucleo_matcher::{Config, Matcher};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::UNIX_EPOCH;
use tauri::{Emitter, Manager, State};

const INDEXED_EXTS: &[&str] = &[
    "md", "markdown", "mdx", "txt", "text", "rst", "adoc", "org",
];

#[derive(Default)]
struct AppState {
    // Full paths of indexed files, sorted most-recently-modified first.
    index: Mutex<Vec<String>>,
    indexing: Mutex<bool>,
    pending_open: Mutex<Vec<String>>,
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

fn mtime_of(path: &Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

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
    entries.sort_by(|a, b| b.0.cmp(&a.0));
    entries.dedup_by(|a, b| a.1 == b.1);
    entries.into_iter().map(|(_, p)| p).collect()
}

fn rebuild_index_async(app: tauri::AppHandle) {
    let state = app.state::<AppState>();
    {
        let mut indexing = state.indexing.lock().unwrap();
        if *indexing {
            return;
        }
        *indexing = true;
    }
    let roots = load_roots(&app);
    std::thread::spawn(move || {
        let index = build_index(&roots);
        let count = index.len();
        let state = app.state::<AppState>();
        *state.index.lock().unwrap() = index;
        *state.indexing.lock().unwrap() = false;
        let _ = app.emit("index-ready", count);
    });
}

#[tauri::command]
fn search_files(query: String, state: State<AppState>) -> Vec<SearchResult> {
    let index = state.index.lock().unwrap();
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
    let mut results: Vec<SearchResult> = pattern
        .match_list(index.iter(), &mut matcher)
        .into_iter()
        .map(|(p, score)| SearchResult {
            path: p.clone(),
            score,
        })
        .collect();
    results.truncate(80);
    results
}

#[tauri::command]
fn refresh_index(app: tauri::AppHandle) {
    rebuild_index_async(app);
}

#[tauri::command]
fn index_status(state: State<AppState>) -> (usize, bool) {
    (
        state.index.lock().unwrap().len(),
        *state.indexing.lock().unwrap(),
    )
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
    rebuild_index_async(app);
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

#[tauri::command]
fn write_file(path: String, content: String) -> Result<u64, String> {
    let path = expand_tilde(&path);
    std::fs::write(&path, content).map_err(|e| e.to_string())?;
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
    std::mem::take(&mut *state.pending_open.lock().unwrap())
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
        ])
        .setup(|app| {
            rebuild_index_async(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
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
                let state = app.state::<AppState>();
                state.pending_open.lock().unwrap().extend(paths.clone());
                let _ = app.emit("open-files", paths);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.set_focus();
                }
            }
            let _ = (app, &event);
        });
}
