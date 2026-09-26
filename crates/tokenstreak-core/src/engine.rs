//! The engine ties discovery, incremental parsing, the cache, pricing,
//! aggregation, goals and persisted state together behind one small API
//! used by the Tauri commands, the CLI and the tests.

use std::path::{Path, PathBuf};
use std::time::Instant;

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
    pub elapsed_ms: u128,
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
        let before_bytes: u64 = next.iter().map(|r| r.offset).sum();
        let results: Vec<Option<UpdateKind>> = next
            .par_iter_mut()
            .map(|rec| {
                let st = readers::stamp(&rec.path)?;
                readers::update_record(rec, st).ok()
            })
            .collect();
        let mut report = ScanReport { files: next.len(), ..Default::default() };
        for r in results.into_iter().flatten() {
            match r {
                UpdateKind::Appended => report.appended += 1,
                UpdateKind::Reparsed => report.reparsed += 1,
                UpdateKind::Unchanged => {}
            }
        }
        let after_bytes: u64 = next.iter().map(|r| r.offset).sum();
        report.bytes_read = after_bytes.saturating_sub(before_bytes);
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
        let r = self.scan();
        if r.changed() || self.status.initial_scan {
            self.rebuild();
        }
        self.status.initial_scan = false;
        self.persist();
        r
    }

    pub fn set_watching(&mut self, on: bool) {
        self.status.watching = on;
    }

    pub fn set_error(&mut self, e: Option<String>) {
        self.status.error = e;
    }

    /// Writes the cache (if changed) and state.
    pub fn persist(&mut self) {
        if !self.persist_enabled {
            return;
        }
        if self.cache_dirty {
            if let Err(e) = crate::cache::save(&self.store.path(state::CACHE_FILE), &self.files) {
                tracing::warn!("could not write cache: {e}");
            } else {
                self.cache_dirty = false;
            }
        }
        let _ = self.store.save_state(&self.state);
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
        self.persist();
    }

    pub fn acknowledge_achievements(&mut self, ids: &[String]) {
        for id in ids {
            self.state.seen_achievements.insert(id.clone());
        }
        self.persist();
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
