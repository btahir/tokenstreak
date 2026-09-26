//! Turns per-file raw events into one deduplicated, priced ledger.
//!
//! Dedup and replay rules are ports of ccusage (MIT, © ryoppippi):
//! - Claude: message id + request id (session + timestamp when the request id
//!   is missing), preferring non-sidechain entries, then the larger total,
//!   then the higher cost; sidechain replays of a parent message collapse.
//! - Codex: forked / sub-agent sessions skip the parent history they replay,
//!   and identical events copied across files collapse.
//! - Gemini: a message re-appended with the same id replaces the earlier copy.

use rustc_hash::{FxHashMap, FxHashSet};

use crate::model::{flags, hash_parts, RawEvent, Tool, NO_MODEL};
use crate::pricing::{cost_claude_shape, cost_codex, gemini_candidates, PriceTable, Usage};
use crate::readers::codex::CodexRawUsage;
use crate::readers::FileRecord;
use crate::time::Clock;
use jiff::civil::Date;

/// One deduplicated, priced usage event in local time.
#[derive(Clone, Copy, Debug)]
pub struct LedgerEvent {
    pub ts_ms: i64,
    pub date: Date,
    pub hour: u8,
    pub weekday: u8,
    pub tool: Tool,
    /// Global model id or [`NO_MODEL`].
    pub model: u32,
    pub project: u32,
    pub session: u32,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub reasoning: u64,
    pub other: u64,
    pub cost: f64,
    /// Estimated saving from cache reads vs. paying full input price.
    pub cache_savings: f64,
    pub priced: bool,
}

impl LedgerEvent {
    pub fn total(&self) -> u64 {
        self.input + self.output + self.cache_write + self.cache_read + self.other
    }
}

#[derive(Clone, Debug, Default)]
pub struct ProjectInfo {
    pub key: String,
    pub label: String,
}

/// The whole deduplicated history.
#[derive(Clone, Debug, Default)]
pub struct Ledger {
    /// Sorted by timestamp.
    pub events: Vec<LedgerEvent>,
    pub models: Vec<String>,
    pub projects: Vec<ProjectInfo>,
    pub sessions: Vec<String>,
    pub unpriced_models: Vec<String>,
    pub duplicates_removed: u64,
    pub replayed_removed: u64,
}

#[derive(Default)]
struct Interner {
    map: FxHashMap<String, u32>,
    list: Vec<String>,
}

impl Interner {
    fn id(&mut self, s: &str) -> u32 {
        if let Some(i) = self.map.get(s) {
            return *i;
        }
        let i = self.list.len() as u32;
        self.list.push(s.to_string());
        self.map.insert(s.to_string(), i);
        i
    }
}

/// Codex pricing policy for events without a recorded service tier.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Default)]
pub enum CodexDefaultTier {
    #[default]
    Standard,
    Fast,
}

pub struct BuildOptions<'a> {
    pub prices: &'a PriceTable,
    pub clock: &'a Clock,
    pub codex_default_tier: CodexDefaultTier,
}

/// Builds the ledger from file records (in discovery order).
pub fn build_ledger(files: &[&FileRecord], opts: &BuildOptions<'_>) -> Ledger {
    let mut models = Interner::default();
    let mut projects = Interner::default();
    let mut project_labels: Vec<String> = Vec::new();
    let mut sessions = Interner::default();
    let mut unpriced: FxHashSet<String> = FxHashSet::default();
    let mut out: Vec<LedgerEvent> = Vec::new();
    let mut ledger = Ledger::default();

    let project_id = |rec: &FileRecord, projects: &mut Interner, labels: &mut Vec<String>| {
        let key = if rec.project.is_empty() { rec.tool().as_str().to_string() } else { rec.project.clone() };
        let id = projects.id(&key);
        if labels.len() <= id as usize {
            labels.push(if rec.project_label.is_empty() { key.clone() } else { rec.project_label.clone() });
        }
        id
    };

    // ---------------- Claude ----------------
    {
        let claude: Vec<&FileRecord> = files.iter().copied().filter(|f| f.tool() == Tool::Claude).collect();
        let mut cands: Vec<ClaudeCand> = Vec::new();
        for (fi, rec) in claude.iter().enumerate() {
            let pid = project_id(rec, &mut projects, &mut project_labels);
            for ev in rec.all_events() {
                let session_name = rec.sessions.get(ev.session as usize).map(String::as_str).unwrap_or("");
                let model_name = rec.model_name(ev.model);
                let (cost, priced) = claude_cost(ev, model_name, opts.prices);
                if !priced {
                    if let Some(m) = model_name.filter(|_| ev.total() > 0 && ev.recorded_cost.is_none()) {
                        unpriced.insert(m.to_string());
                    }
                }
                cands.push(ClaudeCand {
                    ev: ev.clone(),
                    file: fi as u32,
                    session: sessions.id(&format!("claude:{session_name}")),
                    project: pid,
                    cost,
                    priced,
                });
            }
        }
        let before = cands.len();
        let kept = dedup_claude(cands);
        ledger.duplicates_removed += (before - kept.len()) as u64;
        for c in kept {
            let rec = claude[c.file as usize];
            let ev = &c.ev;
            let model = if ev.has(flags::SYNTHETIC) || ev.model == NO_MODEL {
                NO_MODEL
            } else {
                let name = rec.model_name(ev.model).unwrap_or("unknown");
                if ev.has(flags::FAST) {
                    models.id(&format!("{name}-fast"))
                } else {
                    models.id(name)
                }
            };
            let savings = rec
                .model_name(ev.model)
                .and_then(|m| opts.prices.find(m))
                .map(|p| ev.cache_read as f64 * (p.input - p.cache_read).max(0.0))
                .unwrap_or(0.0);
            out.push(ledger_event(opts.clock, Tool::Claude, ev, model, c.project, c.session, c.cost, savings, c.priced));
        }
    }

    // ---------------- Codex ----------------
    {
        let codex: Vec<&FileRecord> = files.iter().copied().filter(|f| f.tool() == Tool::Codex).collect();
        // Session id → files (discovery order), for parent lookup.
        let mut by_session: FxHashMap<&str, Vec<usize>> = FxHashMap::default();
        for (i, rec) in codex.iter().enumerate() {
            if let Some(id) = rec.codex.session_id.as_deref() {
                by_session.entry(id).or_default().push(i);
            }
        }
        let mut seen: FxHashMap<(i64, u32, [u64; 6]), usize> = FxHashMap::default();
        let start = out.len();
        for (i, rec) in codex.iter().enumerate() {
            let pid = project_id(rec, &mut projects, &mut project_labels);
            let events: Vec<&RawEvent> = rec.all_events().collect();
            let keep = codex_replay_filter(i, rec, &events, &codex, &by_session);
            for (ev, keep) in events.iter().zip(keep) {
                if !keep {
                    ledger.replayed_removed += 1;
                    continue;
                }
                let model_name = rec.model_name(ev.model).unwrap_or("gpt-5");
                let model = models.id(model_name);
                let raw = CodexRawUsage::of_event(ev);
                let key = (ev.ts_ms, model, [raw.input, raw.cached, raw.cache_creation, raw.output, raw.reasoning, raw.total]);
                if seen.contains_key(&key) {
                    ledger.duplicates_removed += 1;
                    continue;
                }
                let (cost, priced, savings) = match opts.prices.find(model_name) {
                    Some(p) => {
                        let base = cost_codex(ev.input, ev.cache_read, ev.cache_create_5m, ev.output, &p);
                        let fast = ev.has(flags::TIER_FAST)
                            || (opts.codex_default_tier == CodexDefaultTier::Fast && !ev.has(flags::TIER_STANDARD));
                        let mult = if fast { p.fast_multiplier } else { 1.0 };
                        let cr = if p.cache_read_explicit { p.cache_read } else { p.input };
                        (base * mult, true, ev.cache_read as f64 * (p.input - cr).max(0.0))
                    }
                    None => {
                        if ev.total() > 0 {
                            unpriced.insert(model_name.to_string());
                        }
                        (0.0, false, 0.0)
                    }
                };
                let session_name = rec.sessions.get(ev.session as usize).map(String::as_str).unwrap_or("");
                let session = sessions.id(&format!("codex:{session_name}"));
                seen.insert(key, out.len());
                out.push(ledger_event(opts.clock, Tool::Codex, ev, model, pid, session, cost, savings, priced));
            }
        }
        let _ = start;
    }

    // ---------------- Gemini ----------------
    {
        for rec in files.iter().copied().filter(|f| f.tool() == Tool::Gemini) {
            let pid = project_id(rec, &mut projects, &mut project_labels);
            let events: Vec<&RawEvent> = rec.all_events().collect();
            // Replace-by-id: the last copy wins, at the first copy's position.
            let mut slot: FxHashMap<u64, usize> = FxHashMap::default();
            let mut kept: Vec<&RawEvent> = Vec::with_capacity(events.len());
            for ev in events {
                match ev.msg_id {
                    Some(id) => match slot.get(&id) {
                        Some(&i) => {
                            kept[i] = ev;
                            ledger.duplicates_removed += 1;
                        }
                        None => {
                            slot.insert(id, kept.len());
                            kept.push(ev);
                        }
                    },
                    None => kept.push(ev),
                }
            }
            for ev in kept {
                let model_name = rec.model_name(ev.model).unwrap_or("unknown");
                let model = models.id(model_name);
                let usage = Usage {
                    input: ev.input,
                    output: ev.output + ev.extra,
                    cache_read: ev.cache_read,
                    ..Default::default()
                };
                let found = gemini_candidates(model_name).into_iter().find_map(|c| opts.prices.find(&c));
                let (cost, priced, savings) = match found {
                    Some(p) => (cost_claude_shape(usage, &p), true, ev.cache_read as f64 * (p.input - p.cache_read).max(0.0)),
                    None => {
                        if ev.total() > 0 {
                            unpriced.insert(model_name.to_string());
                        }
                        (0.0, false, 0.0)
                    }
                };
                let session_name = rec.sessions.get(ev.session as usize).map(String::as_str).unwrap_or("");
                let session = sessions.id(&format!("gemini:{session_name}"));
                out.push(ledger_event(opts.clock, Tool::Gemini, ev, model, pid, session, cost, savings, priced));
            }
        }
    }

    out.sort_by_key(|e| e.ts_ms);
    ledger.events = out;
    ledger.models = models.list;
    ledger.projects = projects
        .list
        .into_iter()
        .zip(project_labels)
        .map(|(key, label)| ProjectInfo { key, label })
        .collect();
    ledger.sessions = sessions.list;
    let mut u: Vec<String> = unpriced.into_iter().collect();
    u.sort();
    ledger.unpriced_models = u;
    ledger
}

#[allow(clippy::too_many_arguments)]
fn ledger_event(
    clock: &Clock,
    tool: Tool,
    ev: &RawEvent,
    model: u32,
    project: u32,
    session: u32,
    cost: f64,
    cache_savings: f64,
    priced: bool,
) -> LedgerEvent {
    let (hour, weekday) = clock.hour_and_weekday(ev.ts_ms);
    LedgerEvent {
        ts_ms: ev.ts_ms,
        date: clock.date_of(ev.ts_ms),
        hour,
        weekday,
        tool,
        model,
        project,
        session,
        input: ev.input,
        output: ev.output,
        cache_write: ev.cache_create(),
        cache_read: ev.cache_read,
        reasoning: ev.reasoning,
        other: ev.extra,
        cost,
        cache_savings,
        priced,
    }
}

/// ccusage auto cost mode: a recorded `costUSD` wins, else price the tokens.
fn claude_cost(ev: &RawEvent, model: Option<&str>, prices: &PriceTable) -> (f64, bool) {
    if let Some(c) = ev.recorded_cost {
        return (c, true);
    }
    let Some(model) = model else { return (0.0, false) };
    let Some(p) = prices.find(model) else { return (0.0, false) };
    let usage = Usage {
        input: ev.input,
        output: ev.output,
        cache_create_5m: ev.cache_create_5m,
        cache_create_1h: ev.cache_create_1h,
        cache_read: ev.cache_read,
    };
    let mult = if ev.has(flags::FAST) { p.fast_multiplier } else { 1.0 };
    (cost_claude_shape(usage, &p) * mult, true)
}

// ---------------------------------------------------------------------------
// Claude dedup (port of ccusage `push_deduped_daily_entry`).

struct ClaudeCand {
    ev: RawEvent,
    file: u32,
    session: u32,
    project: u32,
    cost: f64,
    priced: bool,
}

impl ClaudeCand {
    fn sidechain(&self) -> bool {
        self.ev.has(flags::SIDECHAIN)
    }
}

#[derive(Clone, Copy)]
struct Slot {
    index: usize,
    alias: Option<u32>,
}

fn h_exact(msg: u64, req: Option<u64>, session: u32, ts: i64) -> u64 {
    match req {
        Some(r) => hash_parts(&[b"x", &msg.to_le_bytes(), &[1], &r.to_le_bytes()]),
        None => hash_parts(&[b"x", &msg.to_le_bytes(), &[0], &session.to_le_bytes(), &ts.to_le_bytes()]),
    }
}

fn h_replay(msg: u64, session: u32) -> u64 {
    hash_parts(&[b"sidechain-replay", &msg.to_le_bytes(), &session.to_le_bytes()])
}

fn h_replay_entry(msg: u64, session: u32) -> u64 {
    hash_parts(&[b"sidechain-replay-entry", &msg.to_le_bytes(), &session.to_le_bytes()])
}

fn push_slot(idx: &mut FxHashMap<u64, Vec<Slot>>, h: u64, index: usize) {
    let v = idx.entry(h).or_default();
    if !v.iter().any(|s| s.index == index && s.alias.is_none()) {
        v.push(Slot { index, alias: None });
    }
}

fn push_alias(idx: &mut FxHashMap<u64, Vec<Slot>>, h: u64, index: usize, session: u32) {
    let v = idx.entry(h).or_default();
    if !v.iter().any(|s| s.index == index && s.alias == Some(session)) {
        v.push(Slot { index, alias: Some(session) });
    }
}

fn should_replace(c: &ClaudeCand, e: &ClaudeCand) -> bool {
    if c.sidechain() != e.sidechain() {
        return e.sidechain();
    }
    let (ct, et) = (c.ev.total(), e.ev.total());
    if ct != et {
        return ct > et;
    }
    if c.cost != e.cost {
        return c.cost > e.cost;
    }
    c.ev.has(flags::HAS_SPEED) && !e.ev.has(flags::HAS_SPEED)
}

fn dedup_claude(cands: Vec<ClaudeCand>) -> Vec<ClaudeCand> {
    let mut idx: FxHashMap<u64, Vec<Slot>> = FxHashMap::default();
    let mut kept: Vec<ClaudeCand> = Vec::with_capacity(cands.len());
    for c in cands {
        let Some(msg) = c.ev.msg_id else {
            kept.push(c);
            continue;
        };
        let req = c.ev.req_id;
        let exact = h_exact(msg, req, c.session, c.ev.ts_ms);
        let mut found = idx.get(&exact).and_then(|v| {
            v.iter().find_map(|s| {
                let e = &kept[s.index];
                (e.ev.msg_id == Some(msg)
                    && e.ev.req_id == req
                    && (req.is_some() || (e.session == c.session && e.ev.ts_ms == c.ev.ts_ms)))
                    .then_some(s.index)
            })
        });
        if found.is_none() {
            let cand_sc = c.sidechain();
            let route = if cand_sc { h_replay(msg, c.session) } else { h_replay_entry(msg, c.session) };
            found = idx.get(&route).and_then(|v| {
                v.iter().find_map(|s| {
                    let e = &kept[s.index];
                    let indexed_session = s.alias.unwrap_or(e.session);
                    (e.ev.msg_id == Some(msg) && indexed_session == c.session && (cand_sc || e.sidechain()))
                        .then_some(s.index)
                })
            });
        }
        match found {
            Some(i) => {
                if kept[i].session != c.session {
                    let existing_session = kept[i].session;
                    for s in [c.session, existing_session] {
                        push_alias(&mut idx, h_replay(msg, s), i, s);
                        push_alias(&mut idx, h_replay_entry(msg, s), i, s);
                    }
                }
                if should_replace(&c, &kept[i]) {
                    let prev = std::mem::replace(&mut kept[i], c);
                    let prev_exact = prev.ev.msg_id.map(|m| h_exact(m, prev.ev.req_id, prev.session, prev.ev.ts_ms));
                    if prev_exact != Some(exact) {
                        push_slot(&mut idx, exact, i);
                    }
                    let now = &kept[i];
                    let route_changed = prev.session != now.session
                        || prev.sidechain() != now.sidechain()
                        || prev.ev.msg_id != now.ev.msg_id;
                    if route_changed {
                        if let Some(m) = now.ev.msg_id {
                            let (s, sc) = (now.session, now.sidechain());
                            push_slot(&mut idx, h_replay(m, s), i);
                            if sc {
                                push_slot(&mut idx, h_replay_entry(m, s), i);
                            }
                        }
                    }
                }
            }
            None => {
                let i = kept.len();
                let (s, sc) = (c.session, c.sidechain());
                kept.push(c);
                idx.entry(exact).or_default().push(Slot { index: i, alias: None });
                idx.entry(h_replay(msg, s)).or_default().push(Slot { index: i, alias: None });
                if sc {
                    idx.entry(h_replay_entry(msg, s)).or_default().push(Slot { index: i, alias: None });
                }
            }
        }
    }
    kept
}

// ---------------------------------------------------------------------------
// Codex fork / sub-agent replay (port of ccusage `CodexReplayPlan`).

const BURST_PAUSE_MS: i64 = 1_000;

fn codex_replay_filter(
    me: usize,
    rec: &FileRecord,
    events: &[&RawEvent],
    all: &[&FileRecord],
    by_session: &FxHashMap<&str, Vec<usize>>,
) -> Vec<bool> {
    let mut keep = vec![true; events.len()];
    let Some(parent_id) = rec.codex.parent_id.as_deref() else { return keep };
    let parent = by_session.get(parent_id).and_then(|v| v.iter().copied().find(|&i| i != me));
    let prefix: Vec<CodexRawUsage> = match parent {
        Some(pi) => {
            let p = all[pi];
            let forked_at = rec.codex.forked_at_ms;
            p.all_events()
                .take_while(|e| forked_at.is_none_or(|f| e.ts_ms <= f))
                .map(CodexRawUsage::of_event)
                .collect()
        }
        None => Vec::new(),
    };
    enum St {
        Matching(usize),
        Burst(i64),
        Done,
    }
    let mut st = St::Matching(0);
    for (k, ev) in events.iter().enumerate() {
        loop {
            match st {
                St::Matching(i) => {
                    if prefix.get(i) == Some(&CodexRawUsage::of_event(ev)) {
                        st = St::Matching(i + 1);
                        keep[k] = false;
                        break;
                    }
                    st = if i == 0 {
                        match rewritten_burst(&rec.codex.first_usage_ts) {
                            Some(first) => St::Burst(first),
                            None => St::Done,
                        }
                    } else {
                        St::Done
                    };
                }
                St::Burst(prev) => {
                    let d = ev.ts_ms - prev;
                    if (0..=BURST_PAUSE_MS).contains(&d) {
                        st = St::Burst(ev.ts_ms);
                        keep[k] = false;
                        break;
                    }
                    st = St::Done;
                }
                St::Done => break,
            }
        }
    }
    keep
}

fn rewritten_burst(first_two: &[i64]) -> Option<i64> {
    match first_two {
        [a, b, ..] if (0..=BURST_PAUSE_MS).contains(&(b - a)) => Some(*a),
        _ => None,
    }
}
