//! Background worker: owns refresh scheduling (file watcher, fallback poll,
//! midnight rollover), detects goal-reached and achievement moments, and
//! pushes snapshots to the windows and the tray.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;
use tokenstreak_core::api::{Achievement, AppSnapshot};
use tokenstreak_core::engine::Engine;

use crate::tray;

/// Messages for the worker thread.
pub enum Msg {
    /// Something under a log folder changed (debounced).
    FilesChanged,
    /// Manual refresh; the sender gets the new snapshot.
    Refresh(Option<Sender<AppSnapshot>>),
    /// Settings changed (sources, time zone...): rescan and re-emit.
    SettingsChanged,
    /// Re-emit the snapshot without scanning (after acknowledgements).
    Publish,
}

/// Shared state managed by Tauri.
pub struct Core {
    pub engine: Arc<Mutex<Engine>>,
    pub latest: Arc<RwLock<Arc<AppSnapshot>>>,
    pub tx: Mutex<Sender<Msg>>,
}

impl Core {
    pub fn send(&self, m: Msg) {
        let _ = self.tx.lock().send(m);
    }

    pub fn snapshot(&self) -> Arc<AppSnapshot> {
        self.latest.read().clone()
    }
}

/// Fallback poll so updates land within 60 s even if an FS event is missed.
const POLL: Duration = Duration::from_secs(45);
const DEBOUNCE: Duration = Duration::from_millis(1500);
/// While an agent is writing continuously, rescan at most this often
/// (each rescan costs ~30 ms; this keeps active-use CPU well under 1%).
const MIN_GAP: Duration = Duration::from_secs(8);

pub fn start(app: &AppHandle, engine: Engine) -> Core {
    let (tx, rx) = channel::<Msg>();
    let first = Arc::new(engine.snapshot());
    let core = Core {
        engine: Arc::new(Mutex::new(engine)),
        latest: Arc::new(RwLock::new(first)),
        tx: Mutex::new(tx.clone()),
    };
    let engine = core.engine.clone();
    let latest = core.latest.clone();
    let handle = app.clone();
    std::thread::Builder::new()
        .name("tokenstreak-worker".into())
        .spawn(move || run(handle, engine, latest, rx, tx))
        .expect("spawn worker");
    core
}

fn run(
    app: AppHandle,
    engine: Arc<Mutex<Engine>>,
    latest: Arc<RwLock<Arc<AppSnapshot>>>,
    rx: Receiver<Msg>,
    tx: Sender<Msg>,
) {
    let mut watcher = start_watcher(&engine, &tx);
    // First full (incremental) scan right away; the cached snapshot is already on screen.
    let mut pending_reply: Vec<Sender<AppSnapshot>> = Vec::new();
    let mut needs_scan = true;
    // File changes seen since the last scan (rate-limited by MIN_GAP).
    let mut dirty = false;
    let mut last_scan = Instant::now() - MIN_GAP;
    let mut last_day = latest.read().today.date.clone();
    loop {
        if dirty && last_scan.elapsed() >= MIN_GAP {
            needs_scan = true;
        }
        if needs_scan {
            needs_scan = false;
            dirty = false;
            last_scan = Instant::now();
            let t = Instant::now();
            let (snap, fresh) = {
                let mut e = engine.lock();
                let report = e.refresh();
                e.set_watching(watcher.is_some());
                let fresh = e.sync_unlocks();
                e.persist();
                tracing::info!(
                    files = report.files,
                    appended = report.appended,
                    reparsed = report.reparsed,
                    ms = t.elapsed().as_millis() as u64,
                    "scan"
                );
                (e.snapshot(), fresh)
            };
            let settings = engine.lock().settings().clone();
            publish(&app, &latest, snap.clone(), fresh, &settings);
            for r in pending_reply.drain(..) {
                let _ = r.send(snap.clone());
            }
            last_day = snap.today.date.clone();
        }
        // Wake at the earliest of: the rate-limited rescan, the poll interval, local midnight.
        let wait = {
            let e = engine.lock();
            let until_midnight = e.clock().ms_until_next_midnight(e.now_ms()).max(1000) as u64;
            let mut w = POLL.min(Duration::from_millis(until_midnight + 500));
            if dirty {
                w = w.min(MIN_GAP.saturating_sub(last_scan.elapsed()));
            }
            w
        };
        match rx.recv_timeout(wait) {
            Ok(Msg::FilesChanged) => dirty = true,
            Ok(Msg::Refresh(reply)) => {
                needs_scan = true;
                if let Some(r) = reply {
                    pending_reply.push(r);
                }
            }
            Ok(Msg::SettingsChanged) => {
                watcher = start_watcher(&engine, &tx);
                needs_scan = true;
            }
            Ok(Msg::Publish) => {
                let (snap, settings) = {
                    let e = engine.lock();
                    (e.snapshot(), e.settings().clone())
                };
                publish(&app, &latest, snap, Vec::new(), &settings);
            }
            Err(RecvTimeoutError::Timeout) => {
                needs_scan = !dirty || last_scan.elapsed() >= MIN_GAP;
                let today = {
                    let e = engine.lock();
                    e.clock().date_of(e.now_ms()).to_string()
                };
                if today != last_day {
                    tracing::info!("day rollover");
                }
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // Coalesce bursts of messages.
        while let Ok(m) = rx.try_recv() {
            match m {
                Msg::FilesChanged => dirty = true,
                Msg::Refresh(r) => {
                    needs_scan = true;
                    pending_reply.extend(r);
                }
                Msg::SettingsChanged => {
                    watcher = start_watcher(&engine, &tx);
                    needs_scan = true;
                }
                Msg::Publish => {}
            }
        }
    }
}

fn start_watcher(engine: &Arc<Mutex<Engine>>, tx: &Sender<Msg>) -> Option<tokenstreak_core::watch::Watcher> {
    let roots = engine.lock().watch_roots();
    let (wtx, wrx) = channel::<()>();
    let fwd = tx.clone();
    std::thread::spawn(move || {
        while wrx.recv().is_ok() {
            if fwd.send(Msg::FilesChanged).is_err() {
                break;
            }
        }
    });
    match tokenstreak_core::watch::watch(&roots, DEBOUNCE, wtx) {
        Ok(w) => Some(w),
        Err(e) => {
            tracing::warn!("file watcher unavailable: {e}");
            None
        }
    }
}

/// Emits the snapshot, updates the tray and fires goal / achievement moments.
fn publish(
    app: &AppHandle,
    latest: &Arc<RwLock<Arc<AppSnapshot>>>,
    snap: AppSnapshot,
    fresh: Vec<Achievement>,
    settings: &tokenstreak_core::api::Settings,
) {
    let prev = latest.read().clone();
    let crossed = snap.today.met && !(prev.today.met && prev.today.date == snap.today.date);
    tray::update(app, &snap, settings);
    let _ = app.emit("snapshot", &snap);
    if crossed {
        if let Some(c) = &snap.celebration {
            let _ = app.emit("goal-reached", c);
            if settings.notifications.goal_reached && snap.onboarding.completed {
                let body = if c.streak > 1 {
                    format!("{} tokens today. Your streak is now {} days.", human(c.tokens), c.streak)
                } else {
                    format!("{} tokens today. Streak started!", human(c.tokens))
                };
                let _ = app.notification().builder().title("Daily goal reached").body(body).show();
            }
        }
    }
    // Only achievements unlocked by live activity notify; the first-run reveal is shown in-app.
    let live: Vec<Achievement> = fresh.into_iter().filter(|a| a.unlocked_at.as_deref() == Some(snap.today.date.as_str())).collect();
    if !live.is_empty() && snap.onboarding.completed {
        let _ = app.emit("achievements-unlocked", &live);
        if settings.notifications.achievements {
            for a in live.iter().take(2) {
                let _ = app.notification().builder().title(format!("Achievement unlocked: {}", a.title)).body(&a.description).show();
            }
        }
    }
    *latest.write() = Arc::new(snap);
}

pub fn human(n: u64) -> String {
    let f = n as f64;
    if f >= 1e9 {
        format!("{:.1}B", f / 1e9)
    } else if f >= 1e6 {
        format!("{:.1}M", f / 1e6)
    } else if f >= 1e3 {
        format!("{:.0}K", f / 1e3)
    } else {
        n.to_string()
    }
}
