//! Optional global keyboard shortcut that toggles the popover (off by default;
//! `settings.popoverShortcut`).

use std::str::FromStr;

use parking_lot::Mutex;
use tauri::AppHandle;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};

use crate::tray;

/// The currently registered shortcut, if any.
static CURRENT: Mutex<Option<Shortcut>> = Mutex::new(None);

pub fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri_plugin_global_shortcut::Builder::new()
        .with_handler(|app, _shortcut, event| {
            if event.state() == ShortcutState::Pressed {
                tray::toggle_popover(app);
            }
        })
        .build()
}

/// Parses an accelerator such as `"Alt+Shift+T"` or `"CmdOrCtrl+Shift+K"`.
pub fn parse(accelerator: &str) -> Result<Shortcut, String> {
    let s = accelerator.trim();
    if s.is_empty() {
        return Err("the shortcut is empty".into());
    }
    let sc = Shortcut::from_str(s).map_err(|e| format!("“{s}” is not a valid shortcut ({e})"))?;
    if sc.mods.is_empty() {
        return Err("a global shortcut needs at least one modifier (⌘, ⌥, ⌃ or ⇧)".into());
    }
    Ok(sc)
}

/// Registers `accelerator` (replacing any previous one), or unregisters when
/// `None`. On failure the previous shortcut stays registered.
pub fn apply(app: &AppHandle, accelerator: Option<&str>) -> Result<(), String> {
    let next = accelerator.map(parse).transpose()?;
    let gs = app.global_shortcut();
    let mut current = CURRENT.lock();
    if *current == next {
        return Ok(());
    }
    if let Some(sc) = next {
        gs.register(sc).map_err(|e| format!("the shortcut could not be registered ({e}); another app may use it"))?;
    }
    if let Some(old) = current.take() {
        let _ = gs.unregister(old);
    }
    *current = next;
    tracing::info!(enabled = next.is_some(), "popover shortcut updated");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_validates_accelerators() {
        assert!(parse("Alt+Shift+T").is_ok());
        assert!(parse("CmdOrCtrl+Shift+K").is_ok());
        assert!(parse("T").is_err(), "needs a modifier");
        assert!(parse("").is_err());
        assert!(parse("Hyper+Nope+?").is_err());
    }
}
