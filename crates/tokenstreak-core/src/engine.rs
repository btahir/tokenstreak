//! The engine ties discovery, incremental parsing, the cache, pricing,
//! aggregation, goals and persisted state together behind one small API
//! used by the Tauri commands, the CLI and the tests.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use rayon::prelude::*;
use rustc_hash::FxHashMap;

use crate::aggregate::{build_ledger, BuildOptions, CodexDefaultTier, Ledger};
use crate::api::*;
use crate::goals::GoalHistory;
use crate::model::Tool;
use crate::pricing::PriceTable;
use crate::readers::{self, FileRecord, SourceConfig, SourceRoot, UpdateKind};
use crate::report;
use crate::state::{self, AppState, Store};
use crate::time::Clock;

/// Result of one scan.
#[derive(Clone, Debug, Default)]
pub struct ScanReport {
    pub files: usize,
    pub appended: usize,
    pub reparsed: usize,
    pub removed: usize,
    pub bytes_read: u64,
    /// Files that exist but could not be read (permissions, races).
    pub unreadable: usize,
    pub elapsed_ms: u128,
    /// The scan used a thread pool (big scans only).
    pub parallel: bool,
}

impl ScanReport {
    pub fn changed(&self) -> bool {
        self.appended + self.reparsed + self.removed > 0
    }
}

pub struct Engine {
    store: Store,
    files: Vec<FileRecord>,
    settings: Settings,
    state: AppState,
    prices: PriceTable,
    clock: Clock,
    ledger: Ledger,
    status: EngineStatus,
    base_sources: SourceConfig,
    roots: Vec<SourceRoot>,
    cache_dirty: bool,
    persist_enabled: bool,
    now_override: Option<i64>,
    /// A progressive first scan is running (see [`ScanPlan`]).
    progressive: bool,
    /// Follow system time-zone changes (app engines without a pinned zone).
    follow_system_tz: bool,
    last_unreadable: usize,
    /// When the parse cache was last written (see [`Engine::persist_lazy`]).
    last_cache_write: Option<Instant>,
    /// Hash of the state last written, so unchanged state isn't rewritten.
    last_state_hash: Option<u64>,
}

/// A first scan split into batches, most recently modified files first, so
/// the UI can show today and recent days while older history is still being
/// parsed. Records are parsed without the engine (and its lock); each batch
/// is then absorbed and the ledger rebuilt.
pub struct ScanPlan {
    order: FxHashMap<PathBuf, usize>,
    /// Pending records, least recent first (batches pop from the end).
    pending: Vec<(u64, FileRecord)>,
    budget: u64,
    pub files_total: u32,
    pub files_done: u32,
    pub bytes_total: u64,
    pub bytes_done: u64,
    report: ScanReport,
    t0: Instant,
}

impl ScanPlan {
    /// The next batch: the most recent pending files up to the current byte
    /// budget (at least one file). The budget grows 4x per batch, so a
    /// 17 GB history takes about seven batches.
    pub fn next_batch(&mut self) -> Option<Vec<FileRecord>> {
        if self.pending.is_empty() {
            return None;
        }
        let mut batch = Vec::new();
        let mut bytes = 0u64;
        while let Some((size, _)) = self.pending.last() {
            if !batch.is_empty() && bytes + size > self.budget {
                break;
            }
            bytes += size;
            if let Some((_, rec)) = self.pending.pop() {
                batch.push(rec);
            }
        }
        self.budget = self.budget.saturating_mul(4);
        self.files_done += batch.len() as u32;
        self.bytes_done += bytes;
        Some(batch)
    }

    pub fn is_done(&self) -> bool {
        self.pending.is_empty()
    }

    /// Overrides the first batch's byte budget (tests use tiny batches).
    pub fn set_initial_budget(&mut self, bytes: u64) {
        self.budget = bytes.max(1);
    }

    pub fn progress(&self, phase: &str) -> ScanProgress {
        ScanProgress {
            phase: phase.into(),
            files_done: self.files_done,
            files_total: self.files_total,
            bytes_done: self.bytes_done,
            bytes_total: self.bytes_total,
        }
    }
}

/// Minimum time between parse-cache writes during continuous activity.
pub const CACHE_WRITE_GAP: Duration = Duration::from_secs(60);

/// Scans with more changed files or bytes than this use a thread pool.
const PARALLEL_MIN_FILES: usize = 16;
const PARALLEL_MIN_BYTES: u64 = 32 * 1024 * 1024;

/// Parses (or incrementally updates) records, in parallel for big scans. Needs no engine,
/// so callers can run it without holding the engine lock.
pub fn parse_records(records: &mut [FileRecord]) -> ScanReport {
    let before: u64 = records.iter().map(|r| r.offset).sum();
    let mut report = ScanReport { files: records.len(), ..Default::default() };
    // Stat everything first (about 4 µs a file) and keep only the files
    // that changed: while an agent writes, that is one or two.
    let mut work: Vec<(&mut FileRecord, readers::Stamp)> = Vec::new();
    let mut pending_bytes = 0u64;
    for rec in records.iter_mut() {
        let Some(st) = readers::stamp(&rec.path) else {
            report.unreadable += 1;
            continue;
        };
        if rec.parsed && rec.size == st.size && rec.mtime_ns == st.mtime_ns && rec.inode == st.inode {
            continue;
        }
        pending_bytes += if rec.parsed && rec.inode == st.inode && st.size >= rec.size {
            st.size - rec.offset
        } else {
            st.size
        };
        work.push((rec, st));
    }
    let update = |(rec, st): &mut (&mut FileRecord, readers::Stamp)| -> Option<UpdateKind> {
        match readers::update_record(rec, *st) {
            Ok(k) => Some(k),
            Err(e) => {
                tracing::debug!(kind = ?e.kind(), "log file unreadable");
                None
            }
        }
    };
    report.parallel = work.len() > PARALLEL_MIN_FILES || pending_bytes > PARALLEL_MIN_BYTES;
    let results: Vec<Option<UpdateKind>> = if !report.parallel {
        // Incremental rescans run on the calling thread. Spawning a pool for
        // them left each exited thread's allocator pages abandoned (and
        // counted against the app) every few seconds while an agent wrote.
        work.iter_mut().map(update).collect()
    } else {
        // A short-lived pool for big scans: its threads exit afterwards, and
        // the caller hands their memory back (`release_memory`).
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
        match rayon::ThreadPoolBuilder::new()
            .num_threads(threads)
            .thread_name(|i| format!("tokenstreak-scan-{i}"))
            .build()
        {
            Ok(pool) => pool.install(|| work.par_iter_mut().map(update).collect()),
            Err(_) => work.iter_mut().map(update).collect(),
        }
    };
    drop(work);
    for r in &results {
        match r {
            Some(UpdateKind::Appended) => report.appended += 1,
            Some(UpdateKind::Reparsed) => report.reparsed += 1,
            Some(UpdateKind::Unchanged) => {}
            None => report.unreadable += 1,
        }
    }
    let after: u64 = records.iter().map(|r| r.offset).sum();
    report.bytes_read = after.saturating_sub(before);
    report
}

impl Engine {
    /// Opens the engine with data in `data_dir`, reading logs from the
    /// default locations (honouring `CLAUDE_CONFIG_DIR`, `CODEX_HOME`,
    /// `GEMINI_DATA_DIR`).
    pub fn open(data_dir: impl Into<PathBuf>) -> Self {
        Self::open_with(data_dir, SourceConfig::from_env())
    }

    pub fn open_with(data_dir: impl Into<PathBuf>, base_sources: SourceConfig) -> Self {
        let store = Store::new(data_dir);
        let settings = store.load_settings();
        let mut state = store.load_state();
        if state.installed_at.is_none() {
            state.installed_at = Some(crate::time::format_rfc3339_ms(Clock::system().now_ms()));
        }
        let prices = state::read_json::<serde_json::Value>(&store.path(state::PRICES_FILE))
            .and_then(|v| PriceTable::from_compact(&v.to_string()).ok())
            .unwrap_or_else(PriceTable::embedded);
        let files = crate::cache::load(&store.path(state::CACHE_FILE)).unwrap_or_default();
        let clock = Clock::named(settings.timezone.as_deref());
        let mut e = Self {
            store,
            files,
            settings,
            state,
            prices,
            clock,
            ledger: Ledger::default(),
            status: EngineStatus::default(),
            base_sources,
            roots: Vec::new(),
            cache_dirty: false,
            persist_enabled: true,
            now_override: None,
            progressive: false,
            follow_system_tz: true,
            last_unreadable: 0,
            last_cache_write: None,
            last_state_hash: None,
        };
        e.roots = e.source_config().roots();
        e.status.initial_scan = e.files.is_empty();
        e.rebuild();
        e
    }

    /// An engine that never writes to disk (tests, CLI one-shots, oracle runs).
    pub fn ephemeral(sources: SourceConfig, clock: Clock) -> Self {
        let dir = std::env::temp_dir().join(format!("tokenstreak-ephemeral-{}", std::process::id()));
        let mut e = Self {
            store: Store::new(dir),
            files: Vec::new(),
            settings: Settings::default(),
            state: AppState::default(),
            prices: PriceTable::embedded(),
            clock,
            ledger: Ledger::default(),
            status: EngineStatus::default(),
            base_sources: sources,
            roots: Vec::new(),
            cache_dirty: false,
            persist_enabled: false,
            now_override: None,
            progressive: false,
            follow_system_tz: false,
            last_unreadable: 0,
            last_cache_write: None,
            last_state_hash: None,
        };
        e.roots = e.source_config().roots();
        e
    }

    pub fn set_now(&mut self, ms: Option<i64>) {
        self.now_override = ms;
    }

    pub fn set_prices(&mut self, prices: PriceTable) {
        self.prices = prices;
        self.rebuild();
    }

    pub fn now_ms(&self) -> i64 {
        self.now_override.unwrap_or_else(|| self.clock.now_ms())
    }

    pub fn clock(&self) -> &Clock {
        &self.clock
    }

    pub fn ledger(&self) -> &Ledger {
        &self.ledger
    }

    pub fn files(&self) -> &[FileRecord] {
        &self.files
    }

    pub fn settings(&self) -> &Settings {
        &self.settings
    }

    pub fn state(&self) -> &AppState {
        &self.state
    }

    pub fn data_dir(&self) -> &Path {
        self.store.dir()
    }

    fn source_config(&self) -> SourceConfig {
        let mut c = self.base_sources.clone();
        let t = &self.settings.tools;
        c.enabled = [
            c.enabled[0] && t.claude.enabled,
            c.enabled[1] && t.codex.enabled,
            c.enabled[2] && t.gemini.enabled,
        ];
        let custom = |v: &Vec<String>| -> Option<Vec<PathBuf>> {
            (!v.is_empty()).then(|| v.iter().map(|s| readers::expand_home(s)).collect())
        };
        if let Some(p) = custom(&t.claude.custom_paths) {
            c.claude_dirs = Some(p);
        }
        if let Some(p) = custom(&t.codex.custom_paths) {
            c.codex_homes = Some(p);
        }
        if let Some(p) = custom(&t.gemini.custom_paths) {
            c.gemini_dirs = Some(p);
        }
        c
    }

    /// Directories to watch for changes (existing roots).
    pub fn watch_roots(&self) -> Vec<PathBuf> {
        self.roots.iter().map(|r| r.dir.clone()).collect()
    }

    /// Discovers files and parses whatever changed since the last scan.
    pub fn scan(&mut self) -> ScanReport {
        if self.progressive {
            // The running first scan owns the file list; the worker rescans after it.
            return ScanReport::default();
        }
        let t0 = Instant::now();
        self.roots = self.source_config().roots();
        let discovered = readers::discover(&self.roots);
        let mut by_path: FxHashMap<PathBuf, FileRecord> =
            std::mem::take(&mut self.files).into_iter().map(|f| (f.path.clone(), f)).collect();
        let mut next: Vec<FileRecord> = Vec::with_capacity(discovered.len());
        for d in &discovered {
            let mut rec = by_path
                .remove(&d.path)
                .unwrap_or_else(|| FileRecord::new(d.tool, d.path.clone(), d.rel.clone(), d.root));
            rec.root = d.root;
            rec.rel = d.rel.clone();
            next.push(rec);
        }
        let mut report = parse_records(&mut next);
        if report.unreadable != self.last_unreadable {
            self.last_unreadable = report.unreadable;
            if report.unreadable > 0 {
                tracing::warn!(files = report.unreadable, "some log files could not be read");
            }
        }
        // Files that disappeared: keep their history unless told otherwise.
        let mut missing: Vec<FileRecord> = by_path.into_values().collect();
        missing.sort_by(|a, b| a.path.cmp(&b.path));
        if self.settings.keep_deleted_history {
            next.extend(missing);
        } else {
            report.removed = missing.len();
        }
        self.files = next;
        report.elapsed_ms = t0.elapsed().as_millis();
        if report.parallel || report.bytes_read > 64 * 1024 * 1024 {
            // Let the scan pool's threads exit, then hand their memory back.
            std::thread::sleep(std::time::Duration::from_millis(50));
            release_memory();
        }
        if report.changed() {
            self.cache_dirty = true;
        }
        self.status.last_scan_at = Some(crate::time::format_rfc3339_ms(self.now_ms()));
        self.status.last_scan_ms = report.elapsed_ms as u32;
        report
    }

    /// Rebuilds the ledger from the file records.
    pub fn rebuild(&mut self) {
        let enabled = self.source_config().enabled;
        let files: Vec<&FileRecord> = self.files.iter().filter(|f| enabled[f.tool().index()]).collect();
        let tier = match self.settings.codex_fast_tier {
            Some(true) => CodexDefaultTier::Fast,
            Some(false) => CodexDefaultTier::Standard,
            None => detect_codex_fast_tier(&self.base_sources),
        };
        self.ledger = build_ledger(&files, &BuildOptions { prices: &self.prices, clock: &self.clock, codex_default_tier: tier });
        self.status.files = self.files.len() as u32;
        self.status.events = self.ledger.events.len() as u32;
        self.status.duplicates_removed = (self.ledger.duplicates_removed + self.ledger.replayed_removed) as u32;
        self.status.malformed_lines = self.files.iter().map(|f| f.malformed_lines).sum();
    }

    /// Scan + rebuild + persist. Returns whether anything changed.
    pub fn refresh(&mut self) -> ScanReport {
        self.refresh_with(Duration::ZERO)
    }

    /// Scan + rebuild + [`Engine::persist_lazy`]: for the app's frequent
    /// rescans while agents write.
    pub fn refresh_lazy(&mut self) -> ScanReport {
        self.refresh_with(CACHE_WRITE_GAP)
    }

    fn refresh_with(&mut self, cache_gap: Duration) -> ScanReport {
        let r = self.scan();
        if r.changed() || self.status.initial_scan {
            self.rebuild();
        }
        self.status.initial_scan = false;
        self.persist_with(cache_gap);
        r
    }

    /// Follows a change of the system time zone (travel, manual change) when
    /// no zone is pinned in settings: dates are re-bucketed in the new zone.
    /// Returns true when the zone changed.
    pub fn check_system_timezone(&mut self) -> bool {
        if !self.follow_system_tz || self.settings.timezone.is_some() {
            return false;
        }
        let now = Clock::system_fresh();
        if now.tz == self.clock.tz {
            return false;
        }
        tracing::info!(from = %self.clock.name(), to = %now.name(), "system time zone changed");
        self.clock = now;
        self.rebuild();
        true
    }

    /// Test hook: pretend the engine was built for another zone.
    #[doc(hidden)]
    pub fn set_clock_for_test(&mut self, clock: Clock, follow_system: bool) {
        self.clock = clock;
        self.follow_system_tz = follow_system;
        self.rebuild();
    }

    /// True when there is no cached history, so the next scan reads
    /// everything and should run progressively.
    pub fn wants_progressive_scan(&self) -> bool {
        self.files.is_empty() && !self.progressive
    }

    /// Starts a progressive first scan (see [`ScanPlan`]).
    pub fn begin_progressive_scan(&mut self) -> ScanPlan {
        let t0 = Instant::now();
        self.roots = self.source_config().roots();
        let discovered = readers::discover(&self.roots);
        let mut order = FxHashMap::default();
        let mut pending = Vec::with_capacity(discovered.len());
        for (i, d) in discovered.iter().enumerate() {
            order.insert(d.path.clone(), i);
            let st = readers::stamp(&d.path);
            let size = st.map(|s| s.size).unwrap_or(0);
            let mtime = st.map(|s| s.mtime_ns).unwrap_or(0);
            pending.push((mtime, size, FileRecord::new(d.tool, d.path.clone(), d.rel.clone(), d.root)));
        }
        pending.sort_by_key(|(mtime, _, _)| *mtime);
        let bytes_total = pending.iter().map(|(_, s, _)| *s).sum();
        // Keep whatever is already known (normally nothing).
        self.progressive = true;
        self.status.initial_scan = true;
        ScanPlan {
            order,
            files_total: pending.len() as u32,
            pending: pending.into_iter().map(|(_, s, r)| (s, r)).collect(),
            budget: 32 * 1024 * 1024,
            files_done: 0,
            bytes_total,
            bytes_done: 0,
            report: ScanReport::default(),
            t0,
        }
    }

    /// Adds a parsed batch and rebuilds the ledger (a partial view).
    pub fn absorb_batch(&mut self, plan: &mut ScanPlan, batch: Vec<FileRecord>, report: ScanReport) {
        plan.report.files += report.files;
        plan.report.reparsed += report.reparsed + report.appended;
        plan.report.bytes_read += report.bytes_read;
        plan.report.unreadable += report.unreadable;
        self.files.extend(batch);
        self.rebuild();
    }

    /// Finishes a progressive scan: restores discovery order (dedup is
    /// order-sensitive, like ccusage), rebuilds and persists.
    pub fn finish_progressive_scan(&mut self, plan: ScanPlan) -> ScanReport {
        let order = plan.order;
        self.files.sort_by_key(|f| order.get(&f.path).copied().unwrap_or(usize::MAX));
        self.progressive = false;
        self.status.initial_scan = false;
        self.rebuild();
        let mut report = plan.report;
        report.elapsed_ms = plan.t0.elapsed().as_millis();
        if report.unreadable > 0 {
            tracing::warn!(files = report.unreadable, "some log files could not be read");
        }
        if report.bytes_read > 64 * 1024 * 1024 {
            release_memory();
        }
        self.cache_dirty = true;
        self.status.last_scan_at = Some(crate::time::format_rfc3339_ms(self.now_ms()));
        self.status.last_scan_ms = report.elapsed_ms as u32;
        self.persist();
        report
    }

    /// Runs a whole progressive scan in place (CLI and tests); `on_batch`
    /// sees the engine after each partial rebuild.
    pub fn refresh_progressive(&mut self, mut on_batch: impl FnMut(&Engine, &ScanProgress)) -> ScanReport {
        let mut plan = self.begin_progressive_scan();
        while let Some(mut batch) = plan.next_batch() {
            let r = parse_records(&mut batch);
            self.absorb_batch(&mut plan, batch, r);
            if !plan.is_done() {
                let p = plan.progress("initial");
                on_batch(self, &p);
            }
        }
        self.finish_progressive_scan(plan)
    }

    pub fn set_watching(&mut self, on: bool) {
        self.status.watching = on;
    }

    pub fn set_error(&mut self, e: Option<String>) {
        self.status.error = e;
    }

    /// Writes the cache (if changed) and state.
    pub fn persist(&mut self) {
        self.persist_with(Duration::ZERO);
    }

    /// Like [`Engine::persist`], but writes the parse cache at most once per
    /// [`CACHE_WRITE_GAP`]. While an agent writes, the app rescans every few
    /// seconds, and rewriting the whole cache (MBs) each time cost memory,
    /// CPU and disk writes for nothing: the cache only speeds up relaunch,
    /// and a relaunch re-reads whatever it missed. Call [`Engine::persist`]
    /// to flush (quit, idle poll).
    pub fn persist_lazy(&mut self) {
        self.persist_with(CACHE_WRITE_GAP);
    }

    /// Whether the parse cache has changes not yet on disk.
    pub fn cache_dirty(&self) -> bool {
        self.cache_dirty
    }

    fn persist_with(&mut self, gap: Duration) {
        if !self.persist_enabled {
            return;
        }
        let due = self.last_cache_write.is_none_or(|t| t.elapsed() >= gap);
        if self.cache_dirty && due {
            if let Err(e) = crate::cache::save(&self.store.path(state::CACHE_FILE), &self.files) {
                tracing::warn!("could not write cache: {e}");
            } else {
                self.cache_dirty = false;
                self.last_cache_write = Some(Instant::now());
            }
        }
        let hash = serde_json::to_vec(&self.state).ok().map(|b| {
            use std::hash::{Hash, Hasher};
            let mut h = rustc_hash::FxHasher::default();
            b.hash(&mut h);
            h.finish()
        });
        if (hash.is_none() || hash != self.last_state_hash) && self.store.save_state(&self.state).is_ok() {
            self.last_state_hash = hash;
        }
    }

    fn computed(&self) -> report::Computed {
        report::compute(&self.ledger, &self.settings, &self.state, &self.clock, self.now_ms())
    }

    pub fn snapshot(&self) -> AppSnapshot {
        report::snapshot(report::SnapshotInput {
            ledger: &self.ledger,
            settings: &self.settings,
            state: &self.state,
            clock: &self.clock,
            now_ms: self.now_ms(),
            sources: self.sources(),
            pricing: self.pricing_info(),
            status: self.status.clone(),
        })
    }

    pub fn breakdown(&self, q: &RangeQuery) -> Breakdown {
        report::breakdown(&self.ledger, &self.computed(), q, self.settings.week_starts_on)
    }

    pub fn share_card(&self, opts: &ShareOptions) -> ShareCardData {
        let snap_ach = self.snapshot().achievements.iter().filter(|a| a.unlocked_at.is_some()).count() as u32;
        report::share_card(&self.ledger, &self.computed(), opts, &self.settings, snap_ach)
    }

    pub fn csv(&self, q: &RangeQuery) -> String {
        let c = self.computed();
        let (from, to) =
            report::resolve_range(q, c.today, c.totals.keys().next().copied(), self.settings.week_starts_on);
        report::csv(&c, from, to)
    }

    pub fn pricing_info(&self) -> PricingInfo {
        PricingInfo {
            source: "LiteLLM model_prices_and_context_window.json".into(),
            license: "MIT".into(),
            updated_at: self.state.prices_updated_at.clone().unwrap_or_else(|| self.prices.meta.fetched_at.clone()),
            model_count: self.prices.len() as u32,
            unpriced_models: self.ledger.unpriced_models.clone(),
            is_estimate: true,
        }
    }

    pub fn sources(&self) -> Vec<SourceStatus> {
        let cfg = self.source_config();
        let mut all = cfg.clone();
        all.enabled = [true; 3];
        let roots = all.roots();
        Tool::ALL
            .iter()
            .map(|&tool| {
                let paths: Vec<String> =
                    roots.iter().filter(|r| r.tool == tool).map(|r| r.dir.display().to_string()).collect();
                let files: Vec<&FileRecord> = self.files.iter().filter(|f| f.tool() == tool).collect();
                let evs = self.ledger.events.iter().filter(|e| e.tool == tool);
                let (mut first, mut last, mut n, mut total) = (None, None, 0u32, 0u64);
                for e in evs {
                    first = first.or(Some(e.date));
                    last = Some(e.date);
                    n += 1;
                    total += e.total();
                }
                SourceStatus {
                    tool,
                    name: tool.display_name().into(),
                    enabled: cfg.enabled[tool.index()],
                    found: !paths.is_empty(),
                    paths,
                    files: files.len() as u32,
                    events: n,
                    first_activity: first.map(|d| d.to_string()),
                    last_activity: last.map(|d| d.to_string()),
                    total_tokens: total,
                }
            })
            .collect()
    }

    // ---- mutations -------------------------------------------------------

    pub fn update_settings(&mut self, patch: &serde_json::Value) -> Result<Settings, String> {
        let next = state::merge_settings(&self.settings, patch)?;
        let goals_changed = next.daily_goal != self.settings.daily_goal || next.weekly_goal != self.settings.weekly_goal;
        let sources_changed = next.tools != self.settings.tools;
        let tz_changed = next.timezone != self.settings.timezone;
        let recompute = sources_changed
            || tz_changed
            || next.codex_fast_tier != self.settings.codex_fast_tier
            || next.keep_deleted_history != self.settings.keep_deleted_history;
        self.settings = next;
        if goals_changed && self.settings.daily_goal > 0 {
            self.record_goal(self.settings.daily_goal, self.settings.weekly_goal);
        }
        if tz_changed {
            self.clock = Clock::named(self.settings.timezone.as_deref());
        }
        if self.persist_enabled {
            self.store.save_settings(&self.settings).map_err(|e| e.to_string())?;
        }
        if recompute {
            if sources_changed {
                self.scan();
            }
            self.rebuild();
        }
        self.persist();
        Ok(self.settings.clone())
    }

    fn record_goal(&mut self, daily: u64, weekly: u64) {
        let today = self.clock.date_of(self.now_ms());
        let mut h = GoalHistory::from_changes(&self.state.goal_history);
        h.set(today, daily, weekly);
        self.state.goal_history = h.to_changes();
    }

    pub fn set_goals(&mut self, g: &GoalsInput) -> Result<(), String> {
        if g.daily == 0 {
            return Err("daily goal must be greater than zero".into());
        }
        let weekly = if g.weekly == 0 { g.daily * 5 } else { g.weekly };
        self.update_settings(&serde_json::json!({ "dailyGoal": g.daily, "weeklyGoal": weekly }))?;
        Ok(())
    }

    /// Finishes onboarding. The first goal applies retroactively to history
    /// found at first run (see `goals.rs`).
    pub fn complete_onboarding(&mut self, g: &GoalsInput) -> Result<(), String> {
        self.set_goals(g)?;
        if self.state.onboarding_completed_at.is_none() {
            self.state.onboarding_completed_at = Some(crate::time::format_rfc3339_ms(self.now_ms()));
        }
        // Everything already unlocked by history is part of the reveal, not "new".
        self.sync_unlocks();
        // A goal already met today is part of the reveal too: no notification.
        let snap = self.snapshot();
        if snap.today.met {
            self.state.goal_notified_on = Some(snap.today.date.clone());
        }
        self.persist();
        Ok(())
    }

    pub fn acknowledge_celebration(&mut self, date: &str) {
        if !self.state.celebrated_dates.iter().any(|d| d == date) {
            self.state.celebrated_dates.push(date.to_string());
            let n = self.state.celebrated_dates.len();
            if n > 120 {
                self.state.celebrated_dates.drain(..n - 120);
            }
        }
        self.persist_lazy();
    }

    pub fn acknowledge_achievements(&mut self, ids: &[String]) {
        for id in ids {
            self.state.seen_achievements.insert(id.clone());
        }
        self.persist_lazy();
    }

    /// Stores newly computed unlocks (sticky) and returns achievements that
    /// were not unlocked before this call.
    pub fn sync_unlocks(&mut self) -> Vec<Achievement> {
        let snap = self.snapshot();
        let mut fresh = Vec::new();
        for a in snap.achievements {
            if let Some(d) = &a.unlocked_at {
                if !self.state.unlocked.contains_key(&a.id) {
                    self.state.unlocked.insert(a.id.clone(), d.clone());
                    fresh.push(a);
                }
            }
        }
        fresh
    }

    /// A goal-reached notification that is due now; marks it as sent.
    pub fn take_goal_notice(&mut self, snap: &AppSnapshot) -> Option<crate::notify::GoalNotice> {
        let now = crate::notify::Now::at(&self.clock, self.now_ms());
        let n = crate::notify::goal_notice(snap, &self.settings, &self.state, now)?;
        self.state.goal_notified_on = Some(snap.today.date.clone());
        self.persist_lazy();
        Some(n)
    }

    /// A streak-at-risk reminder that is due now; marks it as sent.
    pub fn take_at_risk_notice(&mut self, snap: &AppSnapshot) -> Option<crate::notify::AtRiskNotice> {
        let now = crate::notify::Now::at(&self.clock, self.now_ms());
        let n = crate::notify::at_risk_notice(snap, &self.settings, &self.state, now)?;
        self.state.at_risk_notified_on = Some(snap.today.date.clone());
        self.persist_lazy();
        Some(n)
    }

    /// A weekly recap that is due now; marks it as sent.
    pub fn take_recap_notice(&mut self, snap: &AppSnapshot) -> Option<crate::notify::RecapNotice> {
        let now = crate::notify::Now::at(&self.clock, self.now_ms());
        let n = crate::notify::recap_notice(snap, &self.settings, &self.state, now)?;
        self.state.recap_sent_for = Some(n.week_start.clone());
        self.persist_lazy();
        Some(n)
    }

    /// Whether notifications are muted right now (quiet hours).
    pub fn in_quiet_hours(&self) -> bool {
        let now = crate::notify::Now::at(&self.clock, self.now_ms());
        crate::notify::in_quiet_hours(&self.settings.notifications.quiet_hours, now.minute)
    }

    /// Milliseconds until the streak-at-risk reminder should be evaluated.
    pub fn ms_until_reminder(&self, snap: &AppSnapshot) -> Option<i64> {
        crate::notify::ms_until_reminder(snap, &self.settings, &self.state, &self.clock, self.now_ms())
    }

    /// Replaces the price list with a fresh download (the only network call).
    #[cfg(feature = "net")]
    pub fn refresh_prices(&mut self) -> PriceRefreshResult {
        let now = crate::time::format_rfc3339_ms(self.now_ms());
        match crate::pricing::fetch_litellm().and_then(|json| PriceTable::from_litellm(&json, &now)) {
            Ok(table) => {
                let compact = table.to_compact_json();
                if self.persist_enabled {
                    let _ = state::write_atomic(&self.store.path(state::PRICES_FILE), compact.as_bytes());
                }
                self.prices = table;
                self.state.prices_updated_at = Some(now);
                self.rebuild();
                self.persist();
                PriceRefreshResult { ok: true, pricing: self.pricing_info(), error: None }
            }
            Err(e) => PriceRefreshResult { ok: false, pricing: self.pricing_info(), error: Some(e) },
        }
    }
}

/// Tags the allocator's memory as application memory. mimalloc's default VM
/// tag (100) is `VM_MEMORY_IOACCELERATOR`, so `footprint`, `vmmap` and
/// Instruments reported the Rust heap as GPU memory. Call before the first
/// allocation (a static initializer); later calls only affect new mappings.
pub fn label_heap_memory() {
    const VM_MEMORY_APPLICATION_SPECIFIC_1: std::os::raw::c_long = 240;
    // SAFETY: plain FFI call that sets an integer option.
    unsafe {
        libmimalloc_sys::mi_option_set(libmimalloc_sys::mi_option_os_tag, VM_MEMORY_APPLICATION_SPECIFIC_1);
    }
}

/// Returns memory freed after a large scan to the OS. Parsing streams files
/// through per-thread buffers; without this, macOS's allocator keeps those
/// pages resident long after they are freed.
pub fn release_memory() {
    // SAFETY: plain FFI call; harmless when mimalloc is not the global allocator.
    unsafe {
        libmimalloc_sys::mi_collect(true);
    }
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn malloc_zone_pressure_relief(zone: *mut std::ffi::c_void, goal: usize) -> usize;
        }
        // SAFETY: a null zone means "all zones"; goal 0 means "as much as possible".
        unsafe {
            malloc_zone_pressure_relief(std::ptr::null_mut(), 0);
        }
    }
}

/// ccusage `--speed auto`: Codex's `config.toml` may request the fast tier.
fn detect_codex_fast_tier(cfg: &SourceConfig) -> CodexDefaultTier {
    let homes = cfg.codex_homes.clone().unwrap_or_else(|| {
        cfg.home.clone().map(|h| vec![h.join(".codex")]).unwrap_or_default()
    });
    for h in homes {
        if let Ok(text) = std::fs::read_to_string(h.join("config.toml")) {
            for line in text.lines() {
                let setting = line.split('#').next().unwrap_or("").trim();
                if let Some((k, v)) = setting.split_once('=') {
                    if k.trim() == "service_tier" {
                        let v = v.trim().trim_matches(['"', '\'']);
                        if matches!(v, "fast" | "priority") {
                            return CodexDefaultTier::Fast;
                        }
                    }
                }
            }
        }
    }
    CodexDefaultTier::Standard
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::synth::{self, Rng, Scenario};

    fn write_day(root: &Path, seed: u64, days: u32) {
        let s = Scenario {
            seed,
            today: "2026-09-26".parse().unwrap(),
            tz: jiff::tz::TimeZone::UTC,
            days: days as _,
            daily_goal: 2_000_000,
            target: |r, _, g| (g as f64 * (0.5 + r.f64())) as u64,
            tools: [0.6, 0.3, 0.1],
            projects: vec!["alpha", "beta"],
            now_hour: 20,
            content_bytes: (200, 2_000),
        };
        let reqs = synth::requests(&s);
        synth::write_logs(root, &reqs, &mut Rng::new(seed)).unwrap();
    }

    fn sources(root: &Path) -> SourceConfig {
        let mut src = SourceConfig::from_env();
        src.claude_dirs = Some(vec![root.join("claude")]);
        src.codex_homes = Some(vec![root.join("codex")]);
        src.gemini_dirs = Some(vec![root.join("gemini").join("tmp")]);
        src
    }

    fn totals(e: &Engine) -> (usize, u64) {
        (e.ledger().events.len(), e.ledger().events.iter().map(|ev| ev.total()).sum())
    }

    #[test]
    fn small_rescans_run_inline_and_match_a_full_scan() {
        let logs = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write_day(logs.path(), 1, 60);
        let mut e = Engine::open_with(data.path(), sources(logs.path()));
        let first = e.refresh();
        assert!(first.parallel, "a first scan of many files uses the pool");
        write_day(logs.path(), 2, 1);
        let next = e.refresh_lazy();
        assert!(next.changed());
        assert!(!next.parallel, "an incremental rescan runs on the calling thread");
        let mut full = Engine::ephemeral(sources(logs.path()), Clock::utc());
        full.scan();
        full.rebuild();
        assert_eq!(totals(&e), totals(&full));
    }

    #[test]
    fn lazy_persist_throttles_cache_writes_and_persist_flushes() {
        let logs = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        write_day(logs.path(), 1, 5);
        let mut e = Engine::open_with(data.path(), sources(logs.path()));
        e.refresh_lazy();
        let cache = data.path().join(state::CACHE_FILE);
        let written = std::fs::metadata(&cache).unwrap().len();
        assert!(!e.cache_dirty(), "the first write is not delayed");
        write_day(logs.path(), 2, 1);
        assert!(e.refresh_lazy().changed());
        assert!(e.cache_dirty(), "a second write within the gap waits");
        assert_eq!(std::fs::metadata(&cache).unwrap().len(), written);
        e.persist();
        assert!(!e.cache_dirty());
        assert!(std::fs::metadata(&cache).unwrap().len() > written);
        // The flushed cache restores the same history on relaunch.
        let reopened = Engine::open_with(data.path(), sources(logs.path()));
        assert_eq!(totals(&reopened), totals(&e));
    }
}
