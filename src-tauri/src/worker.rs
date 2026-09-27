//! Background worker: owns refresh scheduling (file watcher, fallback poll,
//! midnight rollover, wake from sleep, clock and time-zone changes), streams
//! the first scan's partial results, sends notifications, and pushes
//! snapshots to the windows and the tray.

use std::sync::mpsc::{channel, Receiver, RecvTimeoutError, Sender};
use std::sync::Arc;
use std::time::{Duration, Instant};

use parking_lot::{Mutex, RwLock};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tokenstreak_core::api::{Achievement, AppSnapshot, Settings};
use tokenstreak_core::engine::{parse_records, Engine};

use crate::system::SystemEvent;
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
    /// Woke from sleep, or the clock / time zone changed.
    System(SystemEvent),
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

/// Fallback poll so updates land within 60 s even if an FS event is missed,
/// and so log folders created after launch are discovered.
const POLL: Duration = Duration::from_secs(45);
const DEBOUNCE: Duration = Duration::from_millis(1500);
/// While an agent is writing continuously, rescan at most this often
/// (each rescan costs ~30 ms; this keeps active-use CPU well under 1%).
const MIN_GAP: Duration = Duration::from_secs(8);

pub fn start(app: &AppHandle, engine: Engine) -> std::io::Result<Core> {
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
    std::thread::Builder::new().name("tokenstreak-worker".into()).spawn(move || run(handle, engine, latest, rx, tx))?;
    Ok(core)
}

fn run(
    app: AppHandle,
    engine: Arc<Mutex<Engine>>,
    latest: Arc<RwLock<Arc<AppSnapshot>>>,
    rx: Receiver<Msg>,
    tx: Sender<Msg>,
) {
    let mut watcher = start_watcher(&engine, &tx);
    if engine.lock().wants_progressive_scan() {
        initial_scan(&app, &engine, &latest);
    }
    // Then a normal incremental scan right away; the cached snapshot is already on screen.
    let mut pending_reply: Vec<Sender<AppSnapshot>> = Vec::new();
    let mut needs_scan = true;
    // Publish after the next scan even if nothing changed (first scan,
    // settings, wake, clock changes).
    let mut force_publish = true;
    // File changes seen since the last scan (rate-limited by MIN_GAP).
    let mut dirty = false;
    let mut last_scan = Instant::now().checked_sub(MIN_GAP).unwrap_or_else(Instant::now);
    loop {
        if dirty && last_scan.elapsed() >= MIN_GAP {
            needs_scan = true;
        }
        if needs_scan {
            needs_scan = false;
            dirty = false;
            last_scan = Instant::now();
            let t = Instant::now();
            let (snap, fresh, settings, roots, changed) = {
                let mut e = engine.lock();
                let report = e.refresh_lazy();
                e.set_watching(watcher.is_some());
                let fresh = e.sync_unlocks();
                e.persist_lazy();
                if report.changed() {
                    tracing::info!(
                        files = report.files,
                        appended = report.appended,
                        reparsed = report.reparsed,
                        ms = t.elapsed().as_millis() as u64,
                        "scan"
                    );
                } else {
                    tracing::debug!(files = report.files, ms = t.elapsed().as_millis() as u64, "scan (no changes)");
                }
                (e.snapshot(), fresh, e.settings().clone(), e.watch_roots(), report.changed())
            };
            // Log folders that appeared (or vanished) since the watcher started.
            let watched = watcher.as_ref().map(|w| w.watched.clone()).unwrap_or_default();
            if roots != watched {
                tracing::info!(roots = roots.len(), "log folders changed; restarting watcher");
                watcher = start_watcher(&engine, &tx);
            }
            // An unchanged poll only re-checks time-based notifications; the
            // windows and the tray are left alone (no work while idle).
            let day_changed = latest.read().today.date != snap.today.date;
            if changed || force_publish || day_changed || !fresh.is_empty() || !pending_reply.is_empty() {
                publish(&app, &engine, &latest, snap.clone(), fresh, &settings);
            } else {
                send_notices(&app, &engine, &snap);
            }
            force_publish = false;
            for r in pending_reply.drain(..) {
                let _ = r.send(snap.clone());
            }
        }
        // Wake at the earliest of: the rate-limited rescan, the poll interval,
        // local midnight, and the streak-at-risk reminder.
        let wait = {
            let e = engine.lock();
            let until_midnight = e.clock().ms_until_next_midnight(e.now_ms()).max(1000) as u64;
            let mut w = POLL.min(Duration::from_millis(until_midnight + 500));
            if let Some(ms) = e.ms_until_reminder(&latest.read()) {
                w = w.min(Duration::from_millis(ms.max(0) as u64 + 500));
            }
            if dirty {
                w = w.min(MIN_GAP.saturating_sub(last_scan.elapsed()));
            }
            w
        };
        let mut handle = |m: Msg, needs_scan: &mut bool, dirty: &mut bool, force: &mut bool, watcher: &mut Option<_>| match m {
            Msg::FilesChanged => *dirty = true,
            Msg::Refresh(reply) => {
                *needs_scan = true;
                *force = true;
                pending_reply.extend(reply);
            }
            Msg::SettingsChanged => {
                *watcher = start_watcher(&engine, &tx);
                *needs_scan = true;
                *force = true;
            }
            Msg::Publish => {
                let (snap, settings) = {
                    let e = engine.lock();
                    (e.snapshot(), e.settings().clone())
                };
                publish(&app, &engine, &latest, snap, Vec::new(), &settings);
            }
            Msg::System(ev) => {
                tracing::info!(event = ?ev, "system event");
                engine.lock().check_system_timezone();
                if ev == SystemEvent::Wake {
                    // FSEvents can drop events across sleep; start clean.
                    *watcher = start_watcher(&engine, &tx);
                }
                *needs_scan = true;
                *force = true;
            }
        };
        match rx.recv_timeout(wait) {
            Ok(m) => handle(m, &mut needs_scan, &mut dirty, &mut force_publish, &mut watcher),
            Err(RecvTimeoutError::Timeout) => {
                // Poll, day rollover or reminder time: rescan (cheap when nothing changed).
                engine.lock().check_system_timezone();
                needs_scan = !dirty || last_scan.elapsed() >= MIN_GAP;
            }
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // Coalesce bursts of messages.
        while let Ok(m) = rx.try_recv() {
            handle(m, &mut needs_scan, &mut dirty, &mut force_publish, &mut watcher);
        }
    }
}

/// First launch (no cache): parse the most recent logs first and publish
/// partial snapshots, so today and recent days appear within a second while
/// older history streams in. The engine lock is released while parsing, so
/// commands (breakdowns, settings) stay responsive.
fn initial_scan(app: &AppHandle, engine: &Arc<Mutex<Engine>>, latest: &Arc<RwLock<Arc<AppSnapshot>>>) {
    let t = Instant::now();
    let mut plan = engine.lock().begin_progressive_scan();
    let _ = app.emit("scan-progress", plan.progress("initial"));
    let mut batches = 0u32;
    while let Some(mut batch) = plan.next_batch() {
        let report = parse_records(&mut batch);
        batches += 1;
        let partial = {
            let mut e = engine.lock();
            e.absorb_batch(&mut plan, batch, report);
            (!plan.is_done()).then(|| (e.snapshot(), e.settings().clone()))
        };
        if let Some((snap, settings)) = partial {
            if batches == 1 {
                tracing::info!(ms = t.elapsed().as_millis() as u64, files = plan.files_done, "first partial snapshot");
            }
            tray::update(app, &snap, &settings);
            emit_snapshot(app, &snap);
            *latest.write() = Arc::new(snap);
            let _ = app.emit("scan-progress", plan.progress("initial"));
        }
    }
    let done = plan.progress("done");
    let report = engine.lock().finish_progressive_scan(plan);
    let _ = app.emit("scan-progress", done);
    tracing::info!(
        files = report.files,
        mb = report.bytes_read / (1024 * 1024),
        batches,
        unreadable = report.unreadable,
        ms = t.elapsed().as_millis() as u64,
        "initial scan"
    );
}

fn start_watcher(engine: &Arc<Mutex<Engine>>, tx: &Sender<Msg>) -> Option<tokenstreak_core::watch::Watcher> {
    let roots = engine.lock().watch_roots();
    if roots.is_empty() {
        return None;
    }
    let (wtx, wrx) = channel::<()>();
    let fwd = tx.clone();
    let spawned = std::thread::Builder::new().name("tokenstreak-watch".into()).spawn(move || {
        while wrx.recv().is_ok() {
            if fwd.send(Msg::FilesChanged).is_err() {
                break;
            }
        }
    });
    if spawned.is_err() {
        tracing::warn!("file watcher thread could not start; relying on the poll");
        return None;
    }
    match tokenstreak_core::watch::watch(&roots, DEBOUNCE, wtx) {
        Ok(w) => Some(w),
        Err(e) => {
            tracing::warn!(error = %e, "file watcher unavailable; relying on the poll");
            None
        }
    }
}

/// Sends a snapshot to the open windows. A hidden popover is skipped (it is
/// brought up to date the moment it opens, see `tray::show_popover`), so its
/// web view doesn't re-render off screen.
fn emit_snapshot(app: &AppHandle, snap: &AppSnapshot) {
    if app.get_webview_window("dashboard").is_some() {
        let _ = app.emit_to("dashboard", "snapshot", snap);
    }
    if tray::popover(app).is_some_and(|w| w.is_visible().unwrap_or(true)) {
        let _ = app.emit_to("popover", "snapshot", snap);
    }
}

fn notify(app: &AppHandle, title: &str, body: &str) {
    if let Err(e) = app.notification().builder().title(title).body(body).show() {
        tracing::warn!(error = %e, "notification failed");
    }
}

/// Emits the snapshot, updates the tray, fires in-app moments and native
/// notifications (rules in `tokenstreak_core::notify`).
fn publish(
    app: &AppHandle,
    engine: &Arc<Mutex<Engine>>,
    latest: &Arc<RwLock<Arc<AppSnapshot>>>,
    snap: AppSnapshot,
    fresh: Vec<Achievement>,
    settings: &Settings,
) {
    let prev = latest.read().clone();
    let crossed = snap.today.met && !(prev.today.met && prev.today.date == snap.today.date);
    tray::update(app, &snap, settings);
    emit_snapshot(app, &snap);
    if crossed {
        if let Some(c) = &snap.celebration {
            let _ = app.emit("goal-reached", c);
        }
    }
    let quiet = send_notices(app, engine, &snap);
    // Only achievements unlocked by live activity notify; the first-run reveal is shown in-app.
    let live: Vec<Achievement> =
        fresh.into_iter().filter(|a| a.unlocked_at.as_deref() == Some(snap.today.date.as_str())).collect();
    if !live.is_empty() && snap.onboarding.completed {
        let _ = app.emit("achievements-unlocked", &live);
        if settings.notifications.achievements && !quiet {
            for a in live.iter().take(2) {
                notify(app, &format!("Achievement unlocked: {}", a.title), &a.description);
            }
        }
    }
    *latest.write() = Arc::new(snap);
}

/// Sends whichever goal, streak-at-risk and weekly-recap notifications are
/// due (each at most once; markers persist). Returns whether quiet hours are on.
fn send_notices(app: &AppHandle, engine: &Arc<Mutex<Engine>>, snap: &AppSnapshot) -> bool {
    let snap = snap.clone();
    let (goal, at_risk, recap, quiet) = {
        let mut e = engine.lock();
        (e.take_goal_notice(&snap), e.take_at_risk_notice(&snap), e.take_recap_notice(&snap), e.in_quiet_hours())
    };
    if let Some(n) = goal {
        let body = if n.streak > 1 {
            format!("{} tokens today. Your streak is now {} days.", human(n.tokens), n.streak)
        } else {
            format!("{} tokens today. Streak started!", human(n.tokens))
        };
        notify(app, "Daily goal reached", &body);
    }
    if let Some(n) = at_risk {
        let title = format!("Your {}-day streak is at risk", n.streak);
        let body = format!("{} more tokens today keeps it alive.", human(n.remaining));
        notify(app, &title, &body);
    }
    if let Some(r) = recap {
        let days = if r.days_met == 1 { "1 goal day".to_string() } else { format!("{} goal days", r.days_met) };
        let body = if r.goal_met {
            format!("{} tokens, {days}, weekly goal met. Streak: {} days.", human(r.tokens), r.streak)
        } else {
            format!("{} tokens over {} active days, {days}. Streak: {} days.", human(r.tokens), r.active_days, r.streak)
        };
        notify(app, "Your week in tokens", &body);
    }
    quiet
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

#[cfg(test)]
mod tests {
    use super::human;

    #[test]
    fn human_numbers() {
        assert_eq!(human(0), "0");
        assert_eq!(human(999), "999");
        assert_eq!(human(12_345), "12K");
        assert_eq!(human(4_200_000), "4.2M");
        assert_eq!(human(6_100_000_000), "6.1B");
    }
}
