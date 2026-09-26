//! Menu-bar icon, its menu, and the popover anchored to it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_positioner::{Position, WindowExt};
use tokenstreak_core::api::{AppSnapshot, MenuBarDisplay, Settings};

use crate::worker::{human, Core, Msg};

pub const TRAY_ID: &str = "tokenstreak-tray";

/// Progress-state template icons (designed in `brand/menubar/progress`).
const ICONS: [&[u8]; 5] = [
    include_bytes!("../icons/tray/tray-000Template@2x.png"),
    include_bytes!("../icons/tray/tray-025Template@2x.png"),
    include_bytes!("../icons/tray/tray-050Template@2x.png"),
    include_bytes!("../icons/tray/tray-075Template@2x.png"),
    include_bytes!("../icons/tray/tray-100Template@2x.png"),
];

static LAST_HIDE_MS: AtomicU64 = AtomicU64::new(0);
static ICON_BUCKET: AtomicU64 = AtomicU64::new(u64::MAX);

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn icon(bucket: usize) -> Image<'static> {
    Image::from_bytes(ICONS[bucket.min(4)]).expect("tray icon png")
}

pub fn bucket(progress: f64) -> usize {
    if progress >= 1.0 {
        4
    } else if progress >= 0.75 {
        3
    } else if progress >= 0.5 {
        2
    } else if progress >= 0.25 {
        1
    } else {
        0
    }
}

pub fn create(app: &AppHandle) -> tauri::Result<TrayIcon> {
    let open = MenuItem::with_id(app, "open-dashboard", "Open Dashboard…", true, Some("CmdOrCtrl+D"))?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh Now", true, Some("CmdOrCtrl+R"))?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, "launch-at-login", "Launch at Login", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Tokenstreak", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(
        app,
        &[&open, &refresh, &PredefinedMenuItem::separator(app)?, &login, &PredefinedMenuItem::separator(app)?, &quit],
    )?;
    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(0))
        .icon_as_template(true)
        .tooltip("Tokenstreak")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open-dashboard" => show_dashboard(app),
            "refresh" => app.state::<Core>().send(Msg::Refresh(None)),
            "launch-at-login" => {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                let _ = if enabled { app.autolaunch().disable() } else { app.autolaunch().enable() };
                let now = app.autolaunch().is_enabled().unwrap_or(false);
                let core = app.state::<Core>();
                let _ = core.engine.lock().update_settings(&serde_json::json!({ "launchAtLogin": now }));
                let _ = login.set_checked(now);
                core.send(Msg::Publish);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            tauri_plugin_positioner::on_tray_event(tray.app_handle(), &event);
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                toggle_popover(tray.app_handle());
            }
        })
        .build(app)
}

pub fn popover(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("popover")
}

pub fn toggle_popover(app: &AppHandle) {
    let Some(w) = popover(app) else { return };
    if w.is_visible().unwrap_or(false) {
        hide_popover(app);
        return;
    }
    // A click on the icon first blurs (and hides) an open popover; don't reopen it.
    if now_ms().saturating_sub(LAST_HIDE_MS.load(Ordering::Relaxed)) < 250 {
        return;
    }
    let _ = w.move_window(Position::TrayCenter);
    // Opening the popover asks for fresh numbers (incremental, ~30 ms).
    app.state::<Core>().send(Msg::Refresh(None));
    let _ = w.show();
    let _ = w.set_focus();
    let _ = app.emit_to("popover", "popover-shown", ());
}

pub fn hide_popover(app: &AppHandle) {
    if let Some(w) = popover(app) {
        if w.is_visible().unwrap_or(false) {
            let _ = w.hide();
            LAST_HIDE_MS.store(now_ms(), Ordering::Relaxed);
            let _ = app.emit_to("popover", "popover-hidden", ());
        }
    }
}

pub fn show_dashboard(app: &AppHandle) {
    hide_popover(app);
    if let Some(w) = app.get_webview_window("dashboard") {
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
        let _ = app.emit_to("dashboard", "dashboard-shown", ());
    }
}

/// Updates icon (goal progress) and title (per settings).
pub fn update(app: &AppHandle, snap: &AppSnapshot, settings: &Settings) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let b = bucket(snap.today.progress) as u64;
    if ICON_BUCKET.swap(b, Ordering::Relaxed) != b {
        let _ = tray.set_icon(Some(icon(b as usize)));
        let _ = tray.set_icon_as_template(true);
    }
    let title = match settings.menu_bar {
        MenuBarDisplay::Icon => None,
        MenuBarDisplay::Today => Some(human(snap.today.tokens.total)),
        MenuBarDisplay::Streak => Some(format!("{}d", snap.streak.current)),
    };
    let _ = tray.set_title(title.as_deref());
    let tip = format!(
        "Tokenstreak — {} today ({:.0}% of goal), {}-day streak",
        human(snap.today.tokens.total),
        snap.today.progress * 100.0,
        snap.streak.current
    );
    let _ = tray.set_tooltip(Some(tip));
}
