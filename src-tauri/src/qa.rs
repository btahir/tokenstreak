//! QA mode (`TOKENSTREAK_QA=1`): a test instance that leaves no trace on the
//! Mac and can be driven from scripts.
//!
//! - Nothing registers or prompts: launch at login, notifications and the
//!   global shortcut are skipped (and logged).
//! - Data lives in `TOKENSTREAK_DATA_DIR`, or a temporary folder, never in
//!   the real app data folder.
//! - Debug flags, on the first launch or a second launch of the same app:
//!   `--popover` (toggle), `--goal-moment` (play the goal-reached moment in
//!   the popover), `--snapshot <path.png> [--window popover|dashboard]`
//!   (save that window's web view as a PNG with WKWebView's own
//!   `takeSnapshot`, so no Screen Recording permission is needed).

use std::path::PathBuf;
use std::sync::OnceLock;
use std::time::Duration;

use tauri::{AppHandle, Emitter, Manager};
use tokenstreak_core::api::Celebration;

use crate::{tray, worker};

/// Whether this instance runs in QA mode.
pub fn enabled() -> bool {
    static QA: OnceLock<bool> = OnceLock::new();
    *QA.get_or_init(|| std::env::var("TOKENSTREAK_QA").is_ok_and(|v| v == "1"))
}

/// The data folder for a QA instance.
pub fn data_dir() -> PathBuf {
    match std::env::var_os("TOKENSTREAK_DATA_DIR").filter(|v| !v.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => std::env::temp_dir().join("tokenstreak-qa"),
    }
}

/// A debug action from the command line.
#[derive(Debug, PartialEq)]
pub enum Debug {
    GoalMoment,
    Snapshot { path: PathBuf, window: String },
}

/// Debug flags in `args` (the program name first).
pub fn parse(args: &[String]) -> Vec<Debug> {
    let mut out = Vec::new();
    let value = |name: &str| args.iter().position(|a| a == name).and_then(|i| args.get(i + 1)).cloned();
    if args.iter().any(|a| a == "--goal-moment") {
        out.push(Debug::GoalMoment);
    }
    if let Some(path) = value("--snapshot") {
        let window = value("--window").unwrap_or_else(|| "popover".into());
        out.push(Debug::Snapshot { path: PathBuf::from(path), window });
    }
    out
}

/// Runs debug actions (QA mode only; ignored otherwise).
pub fn run(app: &AppHandle, actions: Vec<Debug>) {
    if actions.is_empty() {
        return;
    }
    if !enabled() {
        tracing::warn!("debug flags need TOKENSTREAK_QA=1; ignored");
        return;
    }
    for a in actions {
        match a {
            Debug::GoalMoment => goal_moment(app),
            Debug::Snapshot { path, window } => snapshot(app, &window, path),
        }
    }
}

/// Opens the popover and plays the goal-reached moment with today's numbers
/// (as if the goal had just been crossed).
fn goal_moment(app: &AppHandle) {
    let snap = app.state::<worker::Core>().snapshot();
    let c = snap.celebration.clone().unwrap_or_else(|| Celebration {
        date: snap.today.date.clone(),
        tokens: snap.today.tokens.total.max(snap.today.goal),
        goal: snap.today.goal,
        streak: snap.streak.current + u32::from(!snap.today.met),
        new_record: false,
    });
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        if !tray::popover(&handle).is_some_and(|w| w.is_visible().unwrap_or(false)) {
            tray::show_popover(&handle);
        }
        let _ = handle.emit("goal-reached", &c);
        tracing::info!("qa: goal moment");
    });
}

/// Saves `window`'s web view to `path` as a PNG. A hidden popover is opened
/// first and captured once its entry motion has settled.
fn snapshot(app: &AppHandle, window: &str, path: PathBuf) {
    let handle = app.clone();
    let window = window.to_string();
    std::thread::spawn(move || {
        let Some(w) = handle.get_webview_window(&window) else {
            tracing::warn!(%window, "qa: no such window to snapshot");
            return;
        };
        if window == "popover" && !w.is_visible().unwrap_or(false) {
            tray::toggle_popover(&handle);
        }
        std::thread::sleep(Duration::from_millis(900));
        let r = w.with_webview(move |view| {
            #[cfg(target_os = "macos")]
            save_wkwebview(view.inner(), path);
        });
        if let Err(e) = r {
            tracing::warn!(error = %e, "qa: snapshot failed");
        }
    });
}

#[cfg(target_os = "macos")]
fn save_wkwebview(webview: *mut std::ffi::c_void, path: PathBuf) {
    use block2::RcBlock;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    use objc2_foundation::NSString;

    const NS_BITMAP_IMAGE_FILE_TYPE_PNG: usize = 4;
    let target = NSString::from_str(&path.to_string_lossy());
    let done = RcBlock::new(move |image: *mut AnyObject, _error: *mut AnyObject| {
        if image.is_null() {
            tracing::warn!("qa: snapshot returned no image");
            return;
        }
        // SAFETY: standard AppKit/Foundation messages on live objects; every
        // result is checked for nil before use.
        let ok: bool = unsafe {
            let tiff: *mut AnyObject = msg_send![image, TIFFRepresentation];
            if tiff.is_null() {
                return;
            }
            let rep: *mut AnyObject = msg_send![class!(NSBitmapImageRep), imageRepWithData: tiff];
            if rep.is_null() {
                return;
            }
            let props: *mut AnyObject = msg_send![class!(NSDictionary), dictionary];
            let png: *mut AnyObject =
                msg_send![rep, representationUsingType: NS_BITMAP_IMAGE_FILE_TYPE_PNG, properties: props];
            if png.is_null() {
                return;
            }
            msg_send![png, writeToFile: &*target, atomically: true]
        };
        tracing::info!(ok, path = %target, "qa: snapshot saved");
    });
    let nil: *mut AnyObject = std::ptr::null_mut();
    // QA only: keep painting while the window is occluded (another Space, a
    // full-screen app), so the snapshot isn't blank. WebKit SPI; checked.
    // SAFETY: selector availability is checked before sending.
    unsafe {
        let view = webview as *mut AnyObject;
        let sel = objc2::sel!(_setWindowOcclusionDetectionEnabled:);
        let responds: bool = msg_send![view, respondsToSelector: sel];
        if responds {
            let _: () = msg_send![view, _setWindowOcclusionDetectionEnabled: false];
        }
    }
    // SAFETY: `webview` is the WKWebView Tauri hands to `with_webview` on the
    // main thread; a nil configuration captures the visible bounds.
    unsafe {
        let _: () = msg_send![webview as *mut AnyObject, takeSnapshotWithConfiguration: nil, completionHandler: &*done];
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn parses_debug_flags() {
        assert!(parse(&args(&["tokenstreak"])).is_empty());
        assert_eq!(parse(&args(&["tokenstreak", "--goal-moment"])), vec![Debug::GoalMoment]);
        assert_eq!(
            parse(&args(&["tokenstreak", "--snapshot", "/tmp/a.png"])),
            vec![Debug::Snapshot { path: "/tmp/a.png".into(), window: "popover".into() }]
        );
        assert_eq!(
            parse(&args(&["tokenstreak", "--window", "dashboard", "--snapshot", "/tmp/b.png"])),
            vec![Debug::Snapshot { path: "/tmp/b.png".into(), window: "dashboard".into() }]
        );
    }
}
