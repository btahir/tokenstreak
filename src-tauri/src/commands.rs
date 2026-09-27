//! Tauri IPC commands. Every command maps 1:1 to a method of the
//! `TokenstreakApi` TypeScript interface (`src/api/client.ts`); the browser
//! mock implements the same interface.

use std::sync::mpsc::channel;
use std::time::Duration;

use tauri::{AppHandle, Manager, State};
use tauri_plugin_autostart::ManagerExt;
use tokenstreak_core::api::*;

use crate::worker::{Core, Msg};
use crate::{shortcut, tray};

type Res<T> = Result<T, String>;

#[tauri::command]
pub fn get_snapshot(core: State<'_, Core>) -> AppSnapshot {
    (*core.snapshot()).clone()
}

#[tauri::command(async)]
pub fn get_breakdown(core: State<'_, Core>, range: RangeQuery) -> Breakdown {
    core.engine.lock().breakdown(&range)
}

#[tauri::command]
pub fn get_settings(core: State<'_, Core>) -> Settings {
    core.engine.lock().settings().clone()
}

/// Deep-merges a partial settings object; returns the full settings.
/// A new `popoverShortcut` is registered before it is saved, so an invalid
/// or taken shortcut returns an error and leaves settings unchanged (`""`
/// turns the shortcut off).
#[tauri::command(async)]
pub fn update_settings(app: AppHandle, core: State<'_, Core>, mut patch: serde_json::Value) -> Res<Settings> {
    if let Some(v) = patch.get_mut("popoverShortcut") {
        if v.as_str().is_some_and(|s| s.trim().is_empty()) {
            *v = serde_json::Value::Null;
        }
    }
    let before = core.engine.lock().settings().clone();
    let preview = tokenstreak_core::state::merge_settings(&before, &patch)?;
    if preview.popover_shortcut != before.popover_shortcut {
        shortcut::apply(&app, preview.popover_shortcut.as_deref())?;
    }
    let after = core.engine.lock().update_settings(&patch)?;
    if after.launch_at_login != before.launch_at_login {
        let r = if after.launch_at_login { app.autolaunch().enable() } else { app.autolaunch().disable() };
        if let Err(e) = r {
            tracing::warn!(error = %e, "launch at login could not be changed");
        }
        if let Some(m) = app.try_state::<tray::TrayMenu>() {
            let _ = m.login.set_checked(app.autolaunch().is_enabled().unwrap_or(after.launch_at_login));
        }
    }
    if after.tools != before.tools || after.timezone != before.timezone {
        core.send(Msg::SettingsChanged);
    } else {
        core.send(Msg::Publish);
    }
    Ok(after)
}

#[tauri::command(async)]
pub fn set_goals(core: State<'_, Core>, goals: GoalsInput) -> Res<AppSnapshot> {
    let snap = {
        let mut e = core.engine.lock();
        e.set_goals(&goals)?;
        e.snapshot()
    };
    core.send(Msg::Publish);
    Ok(snap)
}

#[tauri::command(async)]
pub fn complete_onboarding(core: State<'_, Core>, goals: GoalsInput) -> Res<AppSnapshot> {
    let snap = {
        let mut e = core.engine.lock();
        e.complete_onboarding(&goals)?;
        e.snapshot()
    };
    core.send(Msg::Publish);
    Ok(snap)
}

/// Rescans now and returns the fresh snapshot.
#[tauri::command(async)]
pub fn refresh(core: State<'_, Core>) -> Res<AppSnapshot> {
    let (tx, rx) = channel();
    core.send(Msg::Refresh(Some(tx)));
    rx.recv_timeout(Duration::from_secs(120)).map_err(|e| e.to_string())
}

/// Downloads a fresh LiteLLM price list. The only network call in the app.
#[tauri::command(async)]
pub fn refresh_prices(core: State<'_, Core>) -> PriceRefreshResult {
    let r = core.engine.lock().refresh_prices();
    core.send(Msg::Publish);
    r
}

#[tauri::command(async)]
pub fn get_share_card(core: State<'_, Core>, options: ShareOptions) -> ShareCardData {
    core.engine.lock().share_card(&options)
}

#[tauri::command(async)]
pub fn export_csv(core: State<'_, Core>, range: RangeQuery) -> String {
    core.engine.lock().csv(&range)
}

#[tauri::command]
pub fn acknowledge_celebration(core: State<'_, Core>, date: String) {
    core.engine.lock().acknowledge_celebration(&date);
    core.send(Msg::Publish);
}

#[tauri::command]
pub fn acknowledge_achievements(core: State<'_, Core>, ids: Vec<String>) {
    core.engine.lock().acknowledge_achievements(&ids);
    core.send(Msg::Publish);
}

#[tauri::command]
pub fn get_app_info(app: AppHandle, core: State<'_, Core>) -> AppInfo {
    AppInfo {
        version: app.package_info().version.to_string(),
        data_dir: core.engine.lock().data_dir().display().to_string(),
        backend: "tauri".into(),
        launch_at_login: app.autolaunch().is_enabled().unwrap_or(false),
        notifications_permitted: None,
    }
}

#[tauri::command]
pub fn open_dashboard(app: AppHandle) {
    tray::show_dashboard(&app);
}

/// Opens the dashboard on its settings page (emits `open-settings` to it).
#[tauri::command]
pub fn open_settings(app: AppHandle) {
    tray::show_settings(&app);
}

/// Reveals the app's log folder in Finder (for bug reports; logs hold counts
/// and timings only).
#[tauri::command]
pub fn reveal_logs(app: AppHandle) -> Res<()> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    let file = dir.join(crate::logging::FILE_NAME);
    let target = if file.exists() { file } else { dir };
    std::process::Command::new("open").arg("-R").arg(&target).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn hide_popover(app: AppHandle) {
    tray::hide_popover(&app);
}

/// Resizes the popover to fit its content (height in logical pixels).
#[tauri::command]
pub fn set_popover_height(app: AppHandle, height: f64) {
    if let Some(w) = app.get_webview_window("popover") {
        let width = w.inner_size().ok().and_then(|s| w.scale_factor().ok().map(|f| s.width as f64 / f)).unwrap_or(380.0);
        let _ = w.set_size(tauri::LogicalSize::new(width, height.clamp(200.0, 900.0)));
    }
}

#[tauri::command]
pub fn quit_app(app: AppHandle) {
    app.exit(0);
}

/// Opens an https URL in the default browser (support link, docs).
#[tauri::command]
pub fn open_external(url: String) -> Res<()> {
    if !url.starts_with("https://") {
        return Err("only https links can be opened".into());
    }
    std::process::Command::new("open").arg(&url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// Saves an export (share card PNG, CSV) to ~/Downloads with a unique name,
/// reveals it in Finder and returns the path.
#[tauri::command(async)]
pub fn save_export(app: AppHandle, file_name: String, data_base64: String) -> Res<String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD.decode(data_base64.as_bytes()).map_err(|e| e.to_string())?;
    let safe: String = file_name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ' ') { c } else { '-' })
        .collect();
    let safe = if safe.trim().is_empty() { "tokenstreak-export".to_string() } else { safe };
    let dir = app.path().download_dir().map_err(|e| e.to_string())?;
    let (stem, ext) = match safe.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{e}")),
        None => (safe.clone(), String::new()),
    };
    let mut path = dir.join(&safe);
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem} ({n}){ext}"));
        n += 1;
    }
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    let _ = std::process::Command::new("open").arg("-R").arg(&path).spawn();
    Ok(path.display().to_string())
}
