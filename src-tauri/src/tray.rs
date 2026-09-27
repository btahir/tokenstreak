//! Menu-bar icon, its right-click menu, and the popover anchored to it.

use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use parking_lot::Mutex;
use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Emitter, LogicalPosition, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent, Wry};
use tauri_plugin_autostart::ManagerExt;
use tokenstreak_core::api::{AppSnapshot, MenuBarDisplay, Settings};

use crate::worker::{toward_goal, Core, Msg};

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
/// Last title and tooltip set, so unchanged values don't make AppKit relayout.
static LAST_TEXT: Mutex<(Option<String>, String)> = Mutex::new((None, String::new()));
/// When the last open was requested (click or shortcut), for the open-latency log.
static OPEN_REQUESTED: Mutex<Option<Instant>> = Mutex::new(None);

/// Menu items whose state changes at runtime.
pub struct TrayMenu {
    pub login: CheckMenuItem<Wry>,
}

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn icon(bucket: usize) -> Option<Image<'static>> {
    match Image::from_bytes(ICONS[bucket.min(4)]) {
        Ok(i) => Some(i),
        Err(e) => {
            tracing::error!(error = %e, "tray icon could not be decoded");
            None
        }
    }
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
    let open = MenuItem::with_id(app, "open-dashboard", "Open Dashboard", true, Some("CmdOrCtrl+D"))?;
    let refresh = MenuItem::with_id(app, "refresh", "Refresh", true, Some("CmdOrCtrl+R"))?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", true, Some("CmdOrCtrl+,"))?;
    let autostart_on = app.autolaunch().is_enabled().unwrap_or(false);
    let login = CheckMenuItem::with_id(app, "launch-at-login", "Launch at Login", true, autostart_on, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Tokenstreak", true, Some("CmdOrCtrl+Q"))?;
    let menu = Menu::with_items(
        app,
        &[
            &open,
            &refresh,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &login,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    app.manage(TrayMenu { login: login.clone() });
    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .icon_as_template(true)
        .tooltip("Tokenstreak")
        .menu(&menu)
        // Left click toggles the popover; right click (or control-click) opens the menu.
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "open-dashboard" => show_dashboard(app),
            "refresh" => app.state::<Core>().send(Msg::Refresh(None)),
            "settings" => show_settings(app),
            "launch-at-login" => {
                let enabled = app.autolaunch().is_enabled().unwrap_or(false);
                set_launch_at_login(app, !enabled);
            }
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                // Tray events arrive on the main thread already.
                toggle_popover_now(tray.app_handle());
            }
        });
    if let Some(i) = icon(0) {
        builder = builder.icon(i);
    }
    builder.build(app)
}

/// Turns launch at login on or off, keeping the menu check mark, the saved
/// setting and the UI in sync.
pub fn set_launch_at_login(app: &AppHandle, on: bool) {
    let r = if on { app.autolaunch().enable() } else { app.autolaunch().disable() };
    if let Err(e) = r {
        tracing::warn!(error = %e, "launch at login could not be changed");
    }
    let now = app.autolaunch().is_enabled().unwrap_or(false);
    if let Some(m) = app.try_state::<TrayMenu>() {
        let _ = m.login.set_checked(now);
    }
    let core = app.state::<Core>();
    let changed = core.engine.lock().settings().launch_at_login != now;
    if changed {
        if let Ok(s) = core.engine.lock().update_settings(&serde_json::json!({ "launchAtLogin": now })) {
            let _ = app.emit("settings", &s);
        }
    }
    core.send(Msg::Publish);
}

pub fn popover(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window("popover")
}

/// Toggles the popover. Window work runs on the main thread, so opening from
/// a shortcut or a second launch behaves exactly like a click.
pub fn toggle_popover(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || toggle_popover_now(&handle));
}

fn toggle_popover_now(app: &AppHandle) {
    let Some(w) = popover(app) else { return };
    if w.is_visible().unwrap_or(false) {
        hide_popover(app);
        return;
    }
    // A click on the icon first blurs (and hides) an open popover; don't reopen it.
    if now_ms().saturating_sub(LAST_HIDE_MS.load(Ordering::Relaxed)) < 250 {
        return;
    }
    show_popover(app);
}

pub fn show_popover(app: &AppHandle) {
    let Some(w) = popover(app) else { return };
    *OPEN_REQUESTED.lock() = Some(Instant::now());
    position_popover(app, &w);
    // The window is created hidden at launch and the snapshot is in memory,
    // so showing it is immediate; fresh numbers follow (incremental, ~30 ms).
    let t = Instant::now();
    // Hidden, the popover gets no snapshot events; bring it up to date first.
    let latest = app.state::<Core>().snapshot();
    let _ = app.emit_to("popover", "snapshot", &*latest);
    let _ = w.show();
    let _ = w.set_focus();
    let _ = app.emit_to("popover", "popover-shown", ());
    tracing::debug!(us = t.elapsed().as_micros() as u64, "popover shown");
    app.state::<Core>().send(Msg::Refresh(None));
}

/// Called when the popover gains focus: logs click-to-focus latency.
pub fn popover_focused() {
    if let Some(t) = OPEN_REQUESTED.lock().take() {
        tracing::info!(ms = t.elapsed().as_millis() as u64, "popover opened");
    }
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
    open_dashboard(app, None);
}

/// Opens the dashboard on its settings page: `open-settings` event when it
/// is already open, `?section=settings` when it is created for this.
pub fn show_settings(app: &AppHandle) {
    open_dashboard(app, Some("settings"));
}

/// The dashboard window is created on demand and destroyed when closed, so
/// its web process and GPU surfaces (~100 MB) only exist while it is open.
/// A new window is shown once its page has loaded (no blank flash); size and
/// position are restored by the window-state plugin.
fn open_dashboard(app: &AppHandle, section: Option<&'static str>) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let app = &handle;
        hide_popover(app);
        // While the dashboard is open the app is a regular app (Dock, Cmd-Tab).
        #[cfg(target_os = "macos")]
        let _ = app.set_activation_policy(tauri::ActivationPolicy::Regular);
        if let Some(w) = app.get_webview_window("dashboard") {
            reveal_dashboard(app, &w, section);
            return;
        }
        let url = match section {
            Some(s) => format!("index.html?view=dashboard&section={s}"),
            None => "index.html?view=dashboard".to_string(),
        };
        let t = Instant::now();
        let built = WebviewWindowBuilder::new(app, "dashboard", WebviewUrl::App(url.into()))
            .title("Tokenstreak")
            .inner_size(1180.0, 800.0)
            .min_inner_size(900.0, 620.0)
            .center()
            .visible(false)
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true)
            .traffic_light_position(LogicalPosition::new(20.0, 24.0))
            .on_page_load(move |w, payload| {
                if payload.event() == PageLoadEvent::Finished && !w.is_visible().unwrap_or(true) {
                    tracing::info!(ms = t.elapsed().as_millis() as u64, "dashboard loaded");
                    reveal_dashboard(w.app_handle(), &w, None);
                }
            })
            .build();
        match built {
            Ok(w) => {
                let app = app.clone();
                w.on_window_event(move |e| match e {
                    WindowEvent::CloseRequested { .. } => {
                        use tauri_plugin_window_state::{AppHandleExt, StateFlags};
                        let _ = app.save_window_state(StateFlags::SIZE | StateFlags::POSITION | StateFlags::MAXIMIZED);
                    }
                    WindowEvent::Destroyed => {
                        // Back to a menu-bar-only app.
                        #[cfg(target_os = "macos")]
                        let _ = app.set_activation_policy(tauri::ActivationPolicy::Accessory);
                        crate::engine_release_memory(&app);
                    }
                    _ => {}
                });
            }
            Err(e) => tracing::error!(error = %e, "dashboard window could not be created"),
        }
    });
}

fn reveal_dashboard(app: &AppHandle, w: &WebviewWindow, section: Option<&str>) {
    let _ = w.show();
    let _ = w.unminimize();
    let _ = w.set_focus();
    let _ = app.emit_to("dashboard", "dashboard-shown", ());
    if section == Some("settings") {
        let _ = app.emit_to("dashboard", "open-settings", ());
    }
}

// ---- positioning ---------------------------------------------------------

/// Gap between the menu bar and the popover, and the minimum distance from a
/// screen edge, in points.
const GAP: f64 = 6.0;
const MARGIN: f64 = 8.0;

/// A display as Tauri reports it on macOS: physical values are the logical
/// (point) values times that display's own scale factor.
#[derive(Clone, Copy, Debug)]
pub struct Display {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
    /// Work area (below the menu bar, beside the Dock), physical.
    pub work: (f64, f64, f64, f64),
    pub scale: f64,
}

impl Display {
    fn frame(&self) -> (f64, f64, f64, f64) {
        (self.x / self.scale, self.y / self.scale, self.w / self.scale, self.h / self.scale)
    }
    fn work_logical(&self) -> (f64, f64, f64, f64) {
        let (x, y, w, h) = self.work;
        (x / self.scale, y / self.scale, w / self.scale, h / self.scale)
    }
}

/// Where to put the popover's top-left corner, in logical points (the
/// global macOS coordinate space, which is the same on every display).
///
/// `tray` is the status item's rect in physical pixels of the display it is
/// on (tray-icon multiplies points by that display's scale), so each display
/// is tried with its own scale until one contains the icon. The popover is
/// centred under the icon, below the menu bar (the rect's height is the menu
/// bar height, taller on notched MacBooks), and kept inside that display.
/// Without a usable rect (icon hidden behind the notch, or a keyboard
/// shortcut before the first click) it goes to the top-right corner of the
/// `fallback` display's work area.
pub fn popover_origin(
    tray: Option<(f64, f64, f64, f64)>,
    displays: &[Display],
    popover_width: f64,
    fallback: Option<usize>,
) -> Option<(f64, f64)> {
    if let Some((tx, ty, tw, th)) = tray {
        // Several displays can "contain" the icon when divided by the wrong
        // scale; the right one is where the icon is as tall as the menu bar.
        let mut best: Option<(f64, (f64, f64))> = None;
        for d in displays {
            let (lx, ly, lw, lh) = (tx / d.scale, ty / d.scale, tw / d.scale, th / d.scale);
            let (cx, cy) = (lx + lw / 2.0, ly + lh / 2.0);
            let (fx, fy, fw, fh) = d.frame();
            if lw > 0.0 && cx >= fx && cx < fx + fw && cy >= fy && cy < fy + fh {
                let menu_bar = d.work_logical().1 - fy;
                let menu_bar = if menu_bar > 0.0 { menu_bar } else { 24.0 };
                let score = (lh - menu_bar).abs();
                let min_x = fx + MARGIN;
                let max_x = (fx + fw - popover_width - MARGIN).max(min_x);
                let x = (cx - popover_width / 2.0).clamp(min_x, max_x);
                let origin = (x.round(), (ly + lh + GAP).round());
                if best.is_none_or(|(s, _)| score < s) {
                    best = Some((score, origin));
                }
            }
        }
        if let Some((_, origin)) = best {
            return Some(origin);
        }
    }
    let d = displays.get(fallback.unwrap_or(0)).or(displays.first())?;
    let (wx, wy, ww, _) = d.work_logical();
    Some(((wx + ww - popover_width - MARGIN).round(), (wy + GAP).round()))
}

/// Displays straight from AppKit (points, flipped to a top-left origin, then
/// scaled like Tauri's physical values). Tauri's monitor list can come back
/// empty for an accessory app with no visible window.
#[cfg(target_os = "macos")]
fn native_displays() -> (Vec<Display>, Option<usize>) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSEvent, NSScreen};
    let Some(mtm) = MainThreadMarker::new() else { return (Vec::new(), None) };
    let screens = NSScreen::screens(mtm);
    let primary_h = screens.firstObject().map(|s| s.frame().size.height).unwrap_or(0.0);
    let mouse = NSEvent::mouseLocation();
    let mut under_cursor = None;
    let list = screens
        .iter()
        .enumerate()
        .map(|(i, s)| {
            let (f, v, k) = (s.frame(), s.visibleFrame(), s.backingScaleFactor());
            if mouse.x >= f.origin.x
                && mouse.x < f.origin.x + f.size.width
                && mouse.y >= f.origin.y
                && mouse.y < f.origin.y + f.size.height
            {
                under_cursor = Some(i);
            }
            let top = primary_h - (f.origin.y + f.size.height);
            let vtop = primary_h - (v.origin.y + v.size.height);
            Display {
                x: f.origin.x * k,
                y: top * k,
                w: f.size.width * k,
                h: f.size.height * k,
                work: (v.origin.x * k, vtop * k, v.size.width * k, v.size.height * k),
                scale: k,
            }
        })
        .collect();
    (list, under_cursor)
}

#[cfg(not(target_os = "macos"))]
fn native_displays() -> (Vec<Display>, Option<usize>) {
    (Vec::new(), None)
}

fn displays(w: &WebviewWindow) -> (Vec<Display>, Option<usize>) {
    let native = native_displays();
    if !native.0.is_empty() {
        return native;
    }
    let monitors = match w.available_monitors() {
        Ok(m) => m,
        Err(e) => {
            tracing::warn!(error = %e, "displays unavailable");
            Vec::new()
        }
    };
    let cursor = w.cursor_position().ok();
    let mut under_cursor = None;
    let list: Vec<Display> = monitors
        .iter()
        .enumerate()
        .map(|(i, m)| {
            let (p, s, wa) = (m.position(), m.size(), m.work_area());
            let d = Display {
                x: p.x as f64,
                y: p.y as f64,
                w: s.width as f64,
                h: s.height as f64,
                work: (wa.position.x as f64, wa.position.y as f64, wa.size.width as f64, wa.size.height as f64),
                scale: m.scale_factor(),
            };
            if let Some(c) = cursor {
                if c.x >= d.x && c.x < d.x + d.w && c.y >= d.y && c.y < d.y + d.h {
                    under_cursor = Some(i);
                }
            }
            d
        })
        .collect();
    (list, under_cursor)
}

fn position_popover(app: &AppHandle, w: &WebviewWindow) {
    let tray = app.tray_by_id(TRAY_ID).and_then(|t| t.rect().ok().flatten()).map(|r| {
        // On macOS both are physical; convert defensively if not.
        let (p, s) = (r.position.to_physical::<f64>(1.0), r.size.to_physical::<f64>(1.0));
        (p.x, p.y, s.width, s.height)
    });
    let width = w
        .outer_size()
        .ok()
        .zip(w.scale_factor().ok())
        .map(|(s, f)| s.width as f64 / f)
        .unwrap_or(380.0);
    let (list, cursor) = displays(w);
    let origin = popover_origin(tray, &list, width, cursor);
    tracing::debug!(?tray, displays = ?list, ?origin, "popover position");
    if let Some((x, y)) = origin {
        if let Err(e) = w.set_position(LogicalPosition::new(x, y)) {
            tracing::warn!(error = %e, "popover could not be positioned");
        }
    }
}

// ---- menu-bar title --------------------------------------------------------

/// The text shown next to the icon for a display setting.
pub fn title_for(snap: &AppSnapshot, display: MenuBarDisplay) -> Option<String> {
    match display {
        MenuBarDisplay::Icon => None,
        MenuBarDisplay::Today => Some(toward_goal(snap.today.tokens.total, snap.today.goal)),
        MenuBarDisplay::Streak => Some(format!("{}d", snap.streak.current)),
    }
}

/// Whole percent of the goal, never shown as 100 before the goal is met.
fn percent_of_goal(progress: f64) -> String {
    let p = progress * 100.0;
    if p < 100.0 {
        format!("{:.0}", p.floor())
    } else {
        format!("{:.0}", p.round())
    }
}

/// Updates icon (goal progress), title (per settings) and tooltip.
pub fn update(app: &AppHandle, snap: &AppSnapshot, settings: &Settings) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else { return };
    let b = bucket(snap.today.progress) as u64;
    if ICON_BUCKET.swap(b, Ordering::Relaxed) != b {
        if let Some(i) = icon(b as usize) {
            let _ = tray.set_icon(Some(i));
            let _ = tray.set_icon_as_template(true);
        }
    }
    let title = title_for(snap, settings.menu_bar);
    let tip = format!(
        "Tokenstreak: {} today ({}% of goal), {}-day streak",
        toward_goal(snap.today.tokens.total, snap.today.goal),
        percent_of_goal(snap.today.progress),
        snap.streak.current
    );
    let mut last = LAST_TEXT.lock();
    if last.0 != title {
        let _ = tray.set_title(title.as_deref());
        last.0 = title;
    }
    if last.1 != tip {
        let _ = tray.set_tooltip(Some(tip.as_str()));
        last.1 = tip;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn retina(x: f64, y: f64, w: f64, h: f64, menu: f64) -> Display {
        let s = 2.0;
        Display { x: x * s, y: y * s, w: w * s, h: h * s, work: (x * s, (y + menu) * s, w * s, (h - menu) * s), scale: s }
    }

    #[test]
    fn centres_under_the_icon_on_a_retina_display() {
        let d = [retina(0.0, 0.0, 1512.0, 982.0, 37.0)];
        // Icon at x=1200pt, 30pt wide, menu bar 37pt (notched MacBook).
        let tray = Some((2400.0, 0.0, 60.0, 74.0));
        assert_eq!(popover_origin(tray, &d, 380.0, None), Some((1025.0, 43.0)));
    }

    #[test]
    fn stays_on_screen_near_the_right_edge() {
        let d = [retina(0.0, 0.0, 1440.0, 900.0, 24.0)];
        let tray = Some((2860.0, 0.0, 40.0, 48.0)); // icon at 1430pt
        let (x, y) = popover_origin(tray, &d, 380.0, None).unwrap();
        assert_eq!(x, 1440.0 - 380.0 - MARGIN);
        assert_eq!(y, 30.0);
    }

    #[test]
    fn mixed_scale_displays_pick_the_one_with_the_icon() {
        // Primary: 1x external 2560x1440 at origin. Secondary: retina laptop
        // 1512pt wide to the right (physical origin = logical x 2).
        let ext = Display {
            x: 0.0,
            y: 0.0,
            w: 2560.0,
            h: 1440.0,
            work: (0.0, 25.0, 2560.0, 1415.0),
            scale: 1.0,
        };
        let laptop = retina(2560.0, 0.0, 1512.0, 982.0, 37.0);
        // Icon on the laptop's menu bar at 3900pt: physical = 7800 (x2).
        let tray = Some((7800.0, 0.0, 60.0, 74.0));
        let (x, y) = popover_origin(tray, &[ext, laptop], 380.0, None).unwrap();
        assert_eq!(y, 43.0);
        assert!(x > 2560.0 && x + 380.0 <= 2560.0 + 1512.0, "{x}");
        // The same icon on the 1x display is found there instead.
        let tray = Some((1000.0, 0.0, 30.0, 25.0));
        assert_eq!(popover_origin(tray, &[ext, laptop], 380.0, None), Some((825.0, 31.0)));
    }

    #[test]
    fn ambiguous_scales_resolve_by_menu_bar_height() {
        // Retina laptop at the origin, 1x external to its right. An icon on
        // the external display at 2000pt (physical 2000) would also land on
        // the laptop when divided by 2.
        let laptop = retina(0.0, 0.0, 1512.0, 982.0, 37.0);
        let ext = Display {
            x: 1512.0,
            y: 0.0,
            w: 1920.0,
            h: 1080.0,
            work: (1512.0, 25.0, 1920.0, 1055.0),
            scale: 1.0,
        };
        let tray = Some((2000.0, 0.0, 30.0, 25.0));
        assert_eq!(popover_origin(tray, &[laptop, ext], 380.0, None), Some((1825.0, 31.0)));
        // And an icon really on the laptop still resolves there.
        let tray = Some((2000.0, 0.0, 60.0, 74.0));
        assert_eq!(popover_origin(tray, &[laptop, ext], 380.0, None), Some((825.0, 43.0)));
    }

    #[test]
    fn falls_back_to_the_top_right_of_the_active_display() {
        let a = retina(0.0, 0.0, 1512.0, 982.0, 37.0);
        let b = retina(1512.0, 0.0, 1920.0, 1080.0, 25.0);
        assert_eq!(popover_origin(None, &[a, b], 380.0, Some(1)), Some((1512.0 + 1920.0 - 388.0, 31.0)));
        // A rect that is on no display (hidden behind the notch).
        assert_eq!(popover_origin(Some((-100.0, -100.0, 0.0, 0.0)), &[a], 380.0, None), Some((1124.0, 43.0)));
        assert_eq!(popover_origin(None, &[], 380.0, None), None);
    }

    #[test]
    fn percent_never_claims_the_goal_early() {
        assert_eq!(percent_of_goal(0.996), "99");
        assert_eq!(percent_of_goal(1.0), "100");
        assert_eq!(percent_of_goal(1.236), "124");
        assert_eq!(percent_of_goal(0.0), "0");
    }

    #[test]
    fn progress_buckets() {
        assert_eq!(bucket(0.0), 0);
        assert_eq!(bucket(0.3), 1);
        assert_eq!(bucket(0.74), 2);
        assert_eq!(bucket(0.99), 3);
        assert_eq!(bucket(2.0), 4);
    }
}
