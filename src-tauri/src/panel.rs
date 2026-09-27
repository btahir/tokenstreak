//! The popover as a macOS panel.
//!
//! A plain `NSWindow` from an accessory app does not show over a full-screen
//! app, and focusing it activates the app, which can switch Spaces away from
//! whatever the user was doing. Menu-bar apps solve this with a
//! non-activating `NSPanel`: the popover window is turned into one at launch
//! (`tauri-nspanel` swaps the window's class; Tauri still owns the window and
//! its delegate, so window events such as `Focused(false)` keep working).
//!
//! The panel:
//! - joins every Space and may sit over full-screen apps
//!   (`canJoinAllSpaces | fullScreenAuxiliary | transient | ignoresCycle`),
//! - floats at the status-window level (above normal and floating windows and
//!   the menu bar, below menus),
//! - becomes key without activating the app, so the frontmost app stays
//!   frontmost and a click anywhere else resigns key and hides the popover.

use tauri::AppHandle;

#[cfg(target_os = "macos")]
mod mac {
    use tauri::{AppHandle, Manager};
    use tauri_nspanel::{tauri_panel, CollectionBehavior, ManagerExt, PanelLevel, StyleMask, WebviewWindowExt};

    tauri_panel! {
        panel!(TokenstreakPopoverPanel {
            config: {
                can_become_key_window: true,
                can_become_main_window: false,
                is_floating_panel: true,
                // The app is never active while the popover is up, so AppKit's
                // hide-on-deactivate would only race our own blur handling.
                hides_on_deactivate: false
            }
        })
    }

    pub const LABEL: &str = "popover";

    /// Collection behaviour of the popover panel.
    pub fn collection_behavior() -> CollectionBehavior {
        CollectionBehavior::new().can_join_all_spaces().full_screen_auxiliary().transient().ignores_cycle()
    }

    pub fn install(app: &AppHandle) -> tauri::Result<()> {
        let Some(window) = app.get_webview_window(LABEL) else { return Ok(()) };
        let panel = window.to_panel::<TokenstreakPopoverPanel>()?;
        panel.set_level(PanelLevel::Status.value());
        panel.set_collection_behavior(collection_behavior().value());
        if let Err(e) = panel.add_style_mask(StyleMask::empty().nonactivating_panel().value()) {
            tracing::warn!(error = %e, "popover panel could not be made non-activating");
        }
        let p = panel.as_panel();
        tracing::info!(
            class = %p.class().name().to_string_lossy(),
            level = p.level(),
            collection = p.collectionBehavior().0,
            nonactivating = p.styleMask().contains(objc2_app_kit::NSWindowStyleMask::NonactivatingPanel),
            "popover is a non-activating panel on all Spaces"
        );
        Ok(())
    }

    /// Orders the panel front and makes it key without activating the app.
    /// Main thread only. Returns false when there is no panel (fall back).
    pub fn show(app: &AppHandle) -> bool {
        match app.get_webview_panel(LABEL) {
            Ok(panel) => {
                panel.show_and_make_key();
                if crate::qa::enabled() {
                    // Key status settles a moment after the request.
                    let app = app.clone();
                    std::thread::spawn(move || {
                        std::thread::sleep(std::time::Duration::from_millis(250));
                        let handle = app.clone();
                        let _ = app.run_on_main_thread(move || {
                            if let Ok(panel) = handle.get_webview_panel(LABEL) {
                                log_state(panel.as_panel());
                            }
                        });
                    });
                }
                true
            }
            Err(_) => false,
        }
    }

    /// QA: proves the popover opened without activating the app and on the
    /// active Space (full-screen or not).
    fn log_state(p: &objc2_app_kit::NSPanel) {
        let app_active = objc2::MainThreadMarker::new()
            .map(|mtm| objc2_app_kit::NSApplication::sharedApplication(mtm).isActive());
        let frontmost = objc2_app_kit::NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .and_then(|a| a.localizedName())
            .map(|n| n.to_string());
        tracing::info!(
            key = p.isKeyWindow(),
            visible = p.isVisible(),
            on_active_space = p.isOnActiveSpace(),
            app_active = ?app_active,
            frontmost = ?frontmost,
            level = p.level(),
            "qa: popover panel shown"
        );
    }
}

/// Converts the popover window into a non-activating panel (macOS only).
/// Needs the `tauri_nspanel` plugin. On failure the popover stays a normal
/// window: it still works, just not over full-screen apps.
pub fn install(app: &AppHandle) {
    #[cfg(target_os = "macos")]
    if let Err(e) = mac::install(app) {
        tracing::error!(error = %e, "popover panel unavailable; using a normal window");
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}

/// Shows the popover and gives it keyboard focus. On macOS this does not
/// activate the app (no Space switch, the frontmost app stays frontmost).
/// Main thread only.
pub fn show(app: &AppHandle, window: &tauri::WebviewWindow) {
    #[cfg(target_os = "macos")]
    if mac::show(app) {
        return;
    }
    let _ = app;
    let _ = window.show();
    let _ = window.set_focus();
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use objc2_app_kit::NSWindowCollectionBehavior as B;

    #[test]
    fn popover_joins_all_spaces_and_full_screen_apps() {
        let b = super::mac::collection_behavior().value();
        assert!(b.contains(B::CanJoinAllSpaces | B::FullScreenAuxiliary | B::Transient | B::IgnoresCycle));
        // Mutually exclusive with CanJoinAllSpaces; AppKit throws on both.
        assert!(!b.contains(B::MoveToActiveSpace));
        assert!(!b.intersects(B::Managed | B::Stationary | B::FullScreenPrimary));
    }
}
