// The native macOS menu bar: structure, accelerators, and the Open Recent
// list (persisted in recents.json beside roots.json). Menu items carry no
// behavior here beyond recents housekeeping - every document action is
// forwarded as a "menu" event to the focused window, so the frontend stays
// the single owner of document flow.
use tauri::menu::{Menu, MenuEvent, MenuItemBuilder, Submenu, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

const MAX_RECENTS: usize = 10;

/// Item ids the frontend handles; everything else is menu-internal.
const FORWARDED: &[&str] = &[
    "new",
    "new-window",
    "open",
    "open-quick",
    "save",
    "save-as",
    "revert",
    "zoom-in",
    "zoom-out",
    "zoom-actual",
];

fn recents_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("recents.json"))
}

fn load_recents(app: &AppHandle) -> Vec<String> {
    let mut recents: Vec<String> = recents_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    // Prune moved/deleted files so dead entries don't pin the menu forever.
    recents.retain(|p| std::path::Path::new(p).is_file());
    recents
}

fn save_recents(app: &AppHandle, recents: &[String]) {
    let Some(path) = recents_path(app) else { return };
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Ok(json) = serde_json::to_string_pretty(recents) {
        let _ = std::fs::write(path, json);
    }
}

fn recents_submenu(app: &AppHandle) -> tauri::Result<Submenu<Wry>> {
    let recents = load_recents(app);
    let mut builder = SubmenuBuilder::new(app, "Open Recent");
    for path in &recents {
        let name = path.rsplit('/').next().unwrap_or(path);
        builder = builder.item(
            &MenuItemBuilder::with_id(format!("recent:{path}"), name).build(app)?,
        );
    }
    if !recents.is_empty() {
        builder = builder.separator();
    }
    builder = builder.item(
        &MenuItemBuilder::with_id("clear-recents", "Clear Menu")
            .enabled(!recents.is_empty())
            .build(app)?,
    );
    builder.build()
}

pub fn build_menu(app: &AppHandle) -> tauri::Result<Menu<Wry>> {
    let app_menu = SubmenuBuilder::new(app, "Simple MD")
        .about(None)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let item = |id: &str, text: &str, accel: Option<&str>| {
        let mut b = MenuItemBuilder::with_id(id, text);
        if let Some(a) = accel {
            b = b.accelerator(a);
        }
        b.build(app)
    };

    let file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New", Some("Cmd+N"))?)
        .item(&item("new-window", "New Window", Some("Shift+Cmd+N"))?)
        .separator()
        .item(&item("open", "Open…", Some("Cmd+O"))?)
        .item(&item("open-quick", "Open Quickly…", Some("Cmd+P"))?)
        .item(&recents_submenu(app)?)
        .separator()
        .close_window()
        .separator()
        .item(&item("save", "Save", Some("Cmd+S"))?)
        .item(&item("save-as", "Save As…", Some("Shift+Cmd+S"))?)
        .separator()
        .item(&item("revert", "Revert to Saved", Some("Cmd+R"))?)
        .build()?;

    let edit = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .separator()
        .select_all()
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("zoom-in", "Zoom In", Some("Cmd+="))?)
        .item(&item("zoom-out", "Zoom Out", Some("Cmd+-"))?)
        .item(&item("zoom-actual", "Actual Size", Some("Cmd+0"))?)
        .separator()
        .fullscreen()
        .build()?;

    let window = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize_with_text("Zoom")
        .build()?;

    Menu::with_items(app, &[&app_menu, &file, &edit, &view, &window])
}

fn rebuild(app: &AppHandle) {
    if let Ok(menu) = build_menu(app) {
        let _ = app.set_menu(menu);
    }
}

/// Record a successfully opened file and refresh the Open Recent submenu.
/// A path already at the front is a no-op, so plain re-saves of the open
/// document never churn the native menu.
pub fn note_recent(app: &AppHandle, path: String) {
    let mut recents = load_recents(app);
    if recents.first() == Some(&path) {
        return;
    }
    recents.retain(|p| *p != path);
    recents.insert(0, path);
    recents.truncate(MAX_RECENTS);
    save_recents(app, &recents);
    rebuild(app);
}

pub fn handle_event(app: &AppHandle, event: MenuEvent) {
    let id = event.id().0.as_str();
    if id == "clear-recents" {
        save_recents(app, &[]);
        rebuild(app);
        return;
    }
    if FORWARDED.contains(&id) || id.starts_with("recent:") {
        // Deliver to the focused window only: menu actions are per-document,
        // and every window runs the full app. When none reports focus (a
        // panel sheet is up, a transition), the last-focused label keeps the
        // target deterministic instead of a HashMap-order pick.
        let windows = app.webview_windows();
        let target = windows
            .values()
            .find(|w| w.is_focused().unwrap_or(false))
            .map(|w| w.label().to_string())
            .or_else(|| {
                crate::lock(&app.state::<crate::AppState>().last_focused)
                    .clone()
                    .filter(|label| windows.contains_key(label))
            })
            .or_else(|| windows.keys().next().cloned());
        if let Some(label) = target {
            let _ = app.emit_to(&label, "menu", id);
        }
    }
}
