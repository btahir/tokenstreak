//! Debounced file watching (FSEvents on macOS via `notify`).
//!
//! The watcher only signals "something under a log root changed"; the engine
//! then does an incremental scan, which stats files and reads appended bytes.

use std::path::PathBuf;
use std::sync::mpsc::Sender;
use std::time::Duration;

use notify::RecursiveMode;
use notify_debouncer_full::{new_debouncer, DebounceEventResult, Debouncer, RecommendedCache};

pub struct Watcher {
    _inner: Debouncer<notify::RecommendedWatcher, RecommendedCache>,
    pub watched: Vec<PathBuf>,
}

/// Starts watching `roots`. Each debounced batch of relevant events sends one
/// `()` on `tx`. Only `.jsonl` / `.json` changes are relevant.
pub fn watch(roots: &[PathBuf], debounce: Duration, tx: Sender<()>) -> notify::Result<Watcher> {
    let mut deb = new_debouncer(debounce, None, move |res: DebounceEventResult| {
        if let Ok(events) = res {
            let relevant = events.iter().any(|e| {
                e.paths.iter().any(|p| {
                    matches!(p.extension().and_then(|x| x.to_str()), Some("jsonl") | Some("json"))
                        || p.extension().is_none()
                })
            });
            if relevant {
                let _ = tx.send(());
            }
        }
    })?;
    let mut watched = Vec::new();
    for r in roots {
        if r.is_dir() && deb.watch(r, RecursiveMode::Recursive).is_ok() {
            watched.push(r.clone());
        }
    }
    Ok(Watcher { _inner: deb, watched })
}
