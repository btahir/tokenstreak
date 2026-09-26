//! Codex CLI rollouts: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (and
//! `archived_sessions/`).
//!
//! Codex writes `token_count` events carrying both `last_token_usage` and a
//! cumulative `total_token_usage`. Following ccusage (MIT), an event counts its
//! `last_token_usage` only when the cumulative total advanced; otherwise (or
//! when `last` is missing) the delta of the cumulative totals is used, so
//! repeated or replayed cumulative snapshots are never double counted.
//! Forked and sub-agent sessions replay their parent's history; that replay
//! is removed during aggregation (see `aggregate::codex_replay`).
//!
//! Headless `codex exec --json` output (checked against openai/codex
//! `codex-rs/exec/src/exec_events.rs` @ `b8d5e3f`, Sep 2026) goes to stdout
//! only: `thread.started`, `turn.started`, `item.*` and `turn.completed`
//! with `usage {input_tokens, cached_input_tokens, cache_write_input_tokens,
//! output_tokens, reasoning_output_tokens}` and no timestamp or model. Codex
//! itself also records every exec run as a normal rollout under `sessions/`
//! (unless `--ephemeral`), which is what we read. When a user saves the
//! `--json` stream as a `.jsonl` file under a Codex folder, its usage lines are
//! read like ccusage does ("headless" lines): usage from the top level or
//! `data` / `result` / `response`, timestamp from `timestamp` / `created_at` /
//! `createdAt` or else the file's modification time, model from the line or
//! the current/fallback model.

use std::borrow::Cow;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::value::RawValue;

use super::{lines, FileRecord, ReaderState};
use crate::model::{flags, RawEvent};
use crate::time::{format_rfc3339_ms, parse_ts};

/// Raw usage exactly as Codex reports it (input includes cached input).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct CodexRawUsage {
    pub input: u64,
    pub cached: u64,
    pub cache_creation: u64,
    pub output: u64,
    pub reasoning: u64,
    pub total: u64,
}

impl CodexRawUsage {
    fn normalized(mut self) -> Self {
        self.cached = self.cached.min(self.input);
        self.cache_creation = self.cache_creation.min(self.input.saturating_sub(self.cached));
        self
    }

    fn minus(&self, prev: Option<&CodexRawUsage>) -> Self {
        let p = prev.copied().unwrap_or_default();
        CodexRawUsage {
            input: self.input.saturating_sub(p.input),
            cached: self.cached.saturating_sub(p.cached),
            cache_creation: self.cache_creation.saturating_sub(p.cache_creation),
            output: self.output.saturating_sub(p.output),
            reasoning: self.reasoning.saturating_sub(p.reasoning),
            total: self.total.saturating_sub(p.total),
        }
        .normalized()
    }

    fn is_zero(&self) -> bool {
        self.input == 0
            && self.cached == 0
            && self.cache_creation == 0
            && self.output == 0
            && self.reasoning == 0
    }

    /// Reconstructs the raw usage of a stored event (for replay matching).
    pub fn of_event(e: &RawEvent) -> Self {
        CodexRawUsage {
            input: e.input + e.cache_read + e.cache_create_5m,
            cached: e.cache_read,
            cache_creation: e.cache_create_5m,
            output: e.output,
            reasoning: e.reasoning,
            total: e.total_raw,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum ServiceTier {
    Standard,
    Fast,
}

/// Cross-line parser state (kept in the cache for incremental appends).
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct CodexState {
    pub previous_totals: Option<CodexRawUsage>,
    pub current_model: Option<String>,
    pub current_model_is_fallback: bool,
    pub service_tier: Option<ServiceTier>,
    pub lines_seen: u64,
}

// --- typed partial structs -------------------------------------------------

#[derive(Deserialize)]
struct Line<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    timestamp: Option<Timestamp<'a>>,
    #[serde(borrow, default)]
    payload: Option<&'a RawValue>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum Timestamp<'a> {
    Str(#[serde(borrow)] Cow<'a, str>),
    Num(u64),
    Other(serde::de::IgnoredAny),
}

#[derive(Deserialize, Default)]
struct Payload<'a> {
    #[serde(rename = "type", borrow, default)]
    kind: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    info: Option<&'a RawValue>,
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    model_name: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    metadata: Option<&'a RawValue>,
    #[serde(borrow, default)]
    thread_settings: Option<&'a RawValue>,
}

#[derive(Deserialize, Default)]
struct Info<'a> {
    #[serde(borrow, default)]
    last_token_usage: Option<&'a RawValue>,
    #[serde(borrow, default)]
    total_token_usage: Option<&'a RawValue>,
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    model_name: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    metadata: Option<&'a RawValue>,
}

#[derive(Deserialize, Default)]
struct ModelMetadata<'a> {
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
}

#[derive(Deserialize, Default)]
struct ThreadSettings<'a> {
    #[serde(borrow, default)]
    service_tier: Option<Cow<'a, str>>,
}

#[derive(Deserialize, Default)]
struct UsageFields {
    #[serde(default, deserialize_with = "lossy_u64")]
    input_tokens: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    prompt_tokens: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    input: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    cached_input_tokens: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    cache_read_input_tokens: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    cache_creation_input_tokens: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    cache_write_input_tokens: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    cached_tokens: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    output_tokens: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    completion_tokens: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    output: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    reasoning_output_tokens: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    reasoning_tokens: Option<u64>,
    #[serde(default, deserialize_with = "lossy_u64")]
    total_tokens: Option<u64>,
}

impl UsageFields {
    fn into_raw(self) -> CodexRawUsage {
        let input = self.input_tokens.or(self.prompt_tokens).or(self.input).unwrap_or(0);
        let output = self.output_tokens.or(self.completion_tokens).or(self.output).unwrap_or(0);
        let reasoning = self.reasoning_output_tokens.or(self.reasoning_tokens).unwrap_or(0);
        let cached = self
            .cached_input_tokens
            .or(self.cache_read_input_tokens)
            .or(self.cached_tokens)
            .unwrap_or(0)
            .min(input);
        let cache_creation = self
            .cache_write_input_tokens
            .or(self.cache_creation_input_tokens)
            .unwrap_or(0)
            .min(input.saturating_sub(cached));
        CodexRawUsage {
            input,
            cached,
            cache_creation,
            output,
            reasoning,
            total: self.total_tokens.filter(|t| *t > 0).unwrap_or(input.saturating_add(output)),
        }
    }
}

fn lossy_u64<'de, D: Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum N {
        U(u64),
        S(String),
        Other(serde::de::IgnoredAny),
    }
    Ok(match Option::<N>::deserialize(d)? {
        Some(N::U(v)) => Some(v),
        Some(N::S(s)) => s.trim().parse().ok(),
        _ => None,
    })
}

/// Parses an object-valued raw field, treating non-objects as absent.
fn object<'a, T: Deserialize<'a> + Default>(raw: Option<&'a RawValue>) -> Option<T> {
    let raw = raw?;
    if !raw.get().trim_start().starts_with('{') {
        return None;
    }
    serde_json::from_str(raw.get()).ok()
}

fn non_empty(v: Option<&Cow<'_, str>>) -> Option<String> {
    v.map(|s| s.trim()).filter(|s| !s.is_empty()).map(str::to_string)
}

fn model_from(
    model: Option<&Cow<'_, str>>,
    model_name: Option<&Cow<'_, str>>,
    metadata: Option<&RawValue>,
) -> Option<String> {
    non_empty(model).or_else(|| non_empty(model_name)).or_else(|| {
        object::<ModelMetadata>(metadata).and_then(|m| non_empty(m.model.as_ref()))
    })
}

fn timestamp_string(ts: Option<&Timestamp<'_>>) -> Option<String> {
    match ts? {
        Timestamp::Str(s) => {
            let t = s.trim();
            (!t.is_empty()).then(|| t.to_string())
        }
        Timestamp::Num(raw) => {
            let ms = if *raw > 10_000_000_000 { *raw } else { raw.checked_mul(1000)? };
            Some(format_rfc3339_ms(ms.min(i64::MAX as u64) as i64))
        }
        Timestamp::Other(_) => None,
    }
}

// --- headless `codex exec --json` lines ----------------------------------

#[derive(Deserialize, Default)]
struct Headless<'a> {
    #[serde(borrow, default)]
    timestamp: Option<Timestamp<'a>>,
    #[serde(borrow, default)]
    created_at: Option<Timestamp<'a>>,
    #[serde(rename = "createdAt", borrow, default)]
    created_at_camel: Option<Timestamp<'a>>,
    #[serde(borrow, default)]
    data: Option<&'a RawValue>,
    #[serde(borrow, default)]
    result: Option<&'a RawValue>,
    #[serde(borrow, default)]
    response: Option<&'a RawValue>,
    #[serde(borrow, default)]
    usage: Option<&'a RawValue>,
    #[serde(borrow, default)]
    model: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    model_name: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    metadata: Option<&'a RawValue>,
}

impl Headless<'_> {
    fn usage(&self) -> Option<CodexRawUsage> {
        object::<UsageFields>(self.usage).map(UsageFields::into_raw)
    }
    fn model(&self) -> Option<String> {
        model_from(self.model.as_ref(), self.model_name.as_ref(), self.metadata)
    }
    fn timestamp(&self) -> Option<String> {
        [&self.timestamp, &self.created_at, &self.created_at_camel]
            .into_iter()
            .find_map(|t| normalized_timestamp(t.as_ref()))
    }
}

/// ccusage `normalize_codex_timestamp`: strings must parse; numbers are
/// seconds or milliseconds.
fn normalized_timestamp(ts: Option<&Timestamp<'_>>) -> Option<String> {
    match ts? {
        Timestamp::Str(s) => parse_ts(s.trim()).map(format_rfc3339_ms),
        other => timestamp_string(Some(other)),
    }
}

/// A headless usage record: (raw usage, model, timestamp) with ccusage's
/// top-level → `data` → `result` → `response` precedence.
fn headless_usage(line: &[u8]) -> Option<(CodexRawUsage, Option<String>, Option<String>)> {
    let top: Headless = serde_json::from_slice(line).ok()?;
    let nested: Vec<Headless> =
        [top.data, top.result, top.response].into_iter().filter_map(object::<Headless>).collect();
    let usage = top.usage().or_else(|| nested.iter().find_map(Headless::usage))?.normalized();
    if usage.is_zero() && usage.total == 0 {
        return None;
    }
    let model = top.model().or_else(|| nested.iter().find_map(Headless::model));
    let ts = top.timestamp().or_else(|| nested.iter().find_map(Headless::timestamp));
    Some((usage, model, ts))
}

fn is_headless_line(line: &[u8]) -> bool {
    use memchr::memmem::find;
    find(line, br#""usage":"#).is_some()
        || find(line, br#""input_tokens":"#).is_some()
        || find(line, br#""prompt_tokens":"#).is_some()
}

// --- session metadata (first line) ----------------------------------------

#[derive(Deserialize, Default)]
struct MetaPayload<'a> {
    #[serde(borrow, default)]
    id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    forked_from_id: Option<Cow<'a, str>>,
    #[serde(borrow, default)]
    source: Option<&'a RawValue>,
    #[serde(borrow, default)]
    cwd: Option<Cow<'a, str>>,
}
#[derive(Deserialize, Default)]
struct Source<'a> {
    #[serde(borrow, default)]
    subagent: Option<&'a RawValue>,
}
#[derive(Deserialize, Default)]
struct Subagent<'a> {
    #[serde(borrow, default)]
    thread_spawn: Option<&'a RawValue>,
}
#[derive(Deserialize, Default)]
struct ThreadSpawn<'a> {
    #[serde(borrow, default)]
    parent_thread_id: Option<Cow<'a, str>>,
}

fn read_meta(rec: &mut FileRecord, line: &Line<'_>) {
    if line.kind.as_deref() != Some("session_meta") {
        return;
    }
    let Some(p) = object::<MetaPayload>(line.payload) else { return };
    rec.codex.forked_at_ms = timestamp_string(line.timestamp.as_ref()).and_then(|s| parse_ts(&s));
    rec.codex.session_id = p.id.map(|s| s.to_string());
    let parent = p
        .forked_from_id
        .map(|s| s.to_string())
        .or_else(|| {
            object::<Source>(p.source)
                .and_then(|s| object::<Subagent>(s.subagent))
                .and_then(|s| object::<ThreadSpawn>(s.thread_spawn))
                .and_then(|t| t.parent_thread_id.map(|s| s.to_string()))
        })
        .filter(|s| !s.is_empty());
    rec.codex.parent_id = parent;
    if let Some(cwd) = p.cwd.as_deref().map(|c| c.trim_end_matches('/')).filter(|c| !c.is_empty()) {
        rec.project = cwd.to_string();
        rec.project_label = cwd.rsplit('/').next().unwrap_or(cwd).to_string();
    }
}

// --- line classification (mirrors ccusage's cheap prefilter) --------------

fn is_session_line(line: &[u8]) -> bool {
    use memchr::memmem::find;
    if find(line, br#""type":"turn_context""#).is_some() {
        return true;
    }
    if find(line, br#""type":"event_msg""#).is_some() {
        return find(line, br#""type":"token_count""#).is_some()
            || find(line, br#""type":"thread_settings_applied""#).is_some();
    }
    // Spaced JSON (`"type": "x"`) is rare; fall back to a tolerant scan.
    if find(line, br#""type""#).is_some() && find(line, br#""type":"#).is_none() {
        let s = String::from_utf8_lossy(line);
        let compact: String = s.split_whitespace().collect();
        return compact.contains(r#""type":"turn_context""#)
            || (compact.contains(r#""type":"event_msg""#)
                && (compact.contains(r#""type":"token_count""#)
                    || compact.contains(r#""type":"thread_settings_applied""#)));
    }
    false
}

const AUTO_REVIEW_FALLBACKS: &[(&str, &str)] = &[
    ("2026-07-30", "gpt-5.6-luna"),
    ("2026-03-05", "gpt-5.4"),
    ("2026-02-05", "gpt-5.3-codex"),
    ("2025-12-11", "gpt-5.2-codex"),
    ("2025-11-13", "gpt-5.1-codex"),
    ("2025-09-15", "gpt-5-codex"),
    ("2025-08-07", "gpt-5"),
];

fn auto_review_fallback(model: &str, timestamp: &str) -> Option<&'static str> {
    if model != "codex-auto-review" {
        return None;
    }
    let date = timestamp.get(..10).filter(|d| crate::time::parse_date(d).is_some());
    let Some(date) = date else { return Some("gpt-5") };
    Some(AUTO_REVIEW_FALLBACKS.iter().find(|(d, _)| date >= *d).map(|(_, m)| *m).unwrap_or("gpt-5"))
}

pub fn parse_lines(rec: &mut FileRecord, buf: &[u8], provisional: bool, mtime_ns: i128) {
    let mut state = match &rec.state {
        ReaderState::Codex(s) => s.clone(),
        _ => CodexState::default(),
    };
    let saved_meta = provisional.then(|| rec.codex.clone());
    let saved_project = provisional.then(|| (rec.project.clone(), rec.project_label.clone()));
    if rec.project.is_empty() {
        rec.project = "codex".into();
        rec.project_label = "Codex".into();
    }
    let session_idx = rec.intern_session(&session_id_from_rel(&rec.rel));

    for line in lines(buf) {
        let first_line = state.lines_seen == 0;
        state.lines_seen += 1;
        if first_line && memchr::memmem::find(line, b"session_meta").is_some() {
            if let Ok(l) = serde_json::from_slice::<Line>(line) {
                read_meta(rec, &l);
            }
            continue;
        }
        if !is_session_line(line) {
            if is_headless_line(line) {
                if let Some((raw, parsed_model, ts)) = headless_usage(line) {
                    let timestamp = ts.unwrap_or_else(|| format_rfc3339_ms((mtime_ns / 1_000_000) as i64));
                    let (model, is_fallback) = resolve_model(parsed_model, &timestamp, &mut state);
                    if let Some(ts_ms) = parse_ts(&timestamp) {
                        let fl = if is_fallback { flags::FALLBACK_MODEL } else { 0 };
                        let ev = event(rec, ts_ms, session_idx, &model, raw, fl);
                        if provisional {
                            rec.provisional.push(ev);
                        } else {
                            rec.events.push(ev);
                        }
                    }
                }
            }
            continue;
        }
        let Ok(l) = serde_json::from_slice::<Line>(line) else {
            rec.malformed_lines += 1;
            continue;
        };
        let payload: Option<Payload> = object(l.payload);
        match l.kind.as_deref() {
            Some("turn_context") => {
                if let Some(m) = payload
                    .as_ref()
                    .and_then(|p| model_from(p.model.as_ref(), p.model_name.as_ref(), p.metadata))
                {
                    state.current_model = Some(m);
                    state.current_model_is_fallback = false;
                }
                continue;
            }
            Some("event_msg") => {}
            _ => continue,
        }
        let Some(timestamp) = timestamp_string(l.timestamp.as_ref()) else { continue };
        let Some(p) = payload else { continue };
        match p.kind.as_deref() {
            Some("thread_settings_applied") => {
                if let Some(tier) =
                    object::<ThreadSettings>(p.thread_settings).and_then(|t| t.service_tier)
                {
                    state.service_tier = match tier.as_ref() {
                        "default" | "standard" => Some(ServiceTier::Standard),
                        "fast" | "priority" => Some(ServiceTier::Fast),
                        _ => None,
                    };
                }
                continue;
            }
            Some("token_count") => {}
            _ => continue,
        }
        let info: Option<Info> = object(p.info);
        let total = info
            .as_ref()
            .and_then(|i| object::<UsageFields>(i.total_token_usage))
            .map(UsageFields::into_raw);
        let last = info
            .as_ref()
            .and_then(|i| object::<UsageFields>(i.last_token_usage))
            .map(UsageFields::into_raw);
        if first_usage_probe(&rec.codex.first_usage_ts) && (last.is_some() || total.is_some()) {
            if let Some(ms) = parse_ts(&timestamp) {
                rec.codex.first_usage_ts.push(ms);
            }
        }
        let advanced = total.is_none_or(|t| state.previous_totals.as_ref() != Some(&t));
        let raw = last
            .filter(|_| advanced)
            .or_else(|| total.map(|t| t.minus(state.previous_totals.as_ref())));
        if let Some(t) = total {
            state.previous_totals = Some(t);
        }
        let Some(raw) = raw.map(CodexRawUsage::normalized) else { continue };
        if raw.is_zero() {
            continue;
        }
        let parsed_model = model_from(p.model.as_ref(), p.model_name.as_ref(), p.metadata).or_else(
            || info.as_ref().and_then(|i| model_from(i.model.as_ref(), i.model_name.as_ref(), i.metadata)),
        );
        let (model, is_fallback) = resolve_model(parsed_model, &timestamp, &mut state);
        let Some(ts_ms) = parse_ts(&timestamp) else { continue };
        let mut fl = if is_fallback { flags::FALLBACK_MODEL } else { 0 };
        match state.service_tier {
            Some(ServiceTier::Standard) => fl |= flags::TIER_STANDARD,
            Some(ServiceTier::Fast) => fl |= flags::TIER_FAST,
            None => {}
        }
        let ev = event(rec, ts_ms, session_idx, &model, raw, fl);
        if provisional {
            rec.provisional.push(ev);
        } else {
            rec.events.push(ev);
        }
    }
    if provisional {
        // A provisional tail must not advance the committed state.
        if let Some(m) = saved_meta {
            rec.codex = m;
        }
        if let Some((p, l)) = saved_project {
            if !p.is_empty() {
                rec.project = p;
                rec.project_label = l;
            }
        }
    } else {
        rec.state = ReaderState::Codex(state);
    }
}

fn event(rec: &mut FileRecord, ts_ms: i64, session: u32, model: &str, raw: CodexRawUsage, fl: u8) -> RawEvent {
    RawEvent {
        ts_ms,
        model: rec.intern_model(model),
        session,
        input: raw.input - raw.cached - raw.cache_creation,
        output: raw.output,
        cache_create_5m: raw.cache_creation,
        cache_create_1h: 0,
        cache_read: raw.cached,
        reasoning: raw.reasoning,
        extra: 0,
        total_raw: raw.total,
        recorded_cost: None,
        msg_id: None,
        req_id: None,
        flags: fl,
    }
}

fn first_usage_probe(v: &[i64]) -> bool {
    v.len() < 2
}

fn resolve_model(parsed: Option<String>, timestamp: &str, st: &mut CodexState) -> (String, bool) {
    if let Some(m) = parsed.as_ref() {
        st.current_model = Some(m.clone());
        st.current_model_is_fallback = false;
    }
    let mut is_fallback = false;
    let model = match parsed.or_else(|| st.current_model.clone()) {
        Some(m) => m,
        None => {
            is_fallback = true;
            st.current_model_is_fallback = true;
            st.current_model = Some("gpt-5".into());
            "gpt-5".into()
        }
    };
    if st.current_model_is_fallback {
        is_fallback = true;
    }
    match auto_review_fallback(&model, timestamp) {
        Some(f) => (f.to_string(), true),
        None => (model, is_fallback),
    }
}

/// ccusage's Codex session id: the path relative to the sessions dir, without extension.
pub fn session_id_from_rel(rel: &str) -> String {
    let s = rel.strip_suffix(".jsonl").unwrap_or(rel);
    if s.is_empty() {
        "unknown".into()
    } else {
        s.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::Tool;

    fn rec() -> FileRecord {
        FileRecord::new(Tool::Codex, "/x/exec.jsonl".into(), "exec.jsonl".into(), 0)
    }

    /// The exact shape `codex exec --json` prints (exec_events.rs): no
    /// timestamp and no model, so the file time and the fallback model apply.
    #[test]
    fn reads_saved_exec_json_stream() {
        let mtime_ms = crate::time::parse_ts("2026-09-26T12:00:00Z").unwrap();
        let buf = br#"{"type":"thread.started","thread_id":"0199a000-0000-7000-8000-00000000e001"}
{"type":"turn.started"}
{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"SECRET_TEXT"}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"cache_write_input_tokens":0,"output_tokens":122,"reasoning_output_tokens":64}}
{"type":"turn.completed","timestamp":"2026-09-25T10:00:00.000Z","model":"gpt-5.4","usage":{"input_tokens":100,"output_tokens":10}}
{"result":{"created_at":1758794400,"usage":{"prompt_tokens":50,"completion_tokens":5},"model_name":"gpt-5-mini"}}
{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}
"#;
        let mut r = rec();
        parse_lines(&mut r, buf, false, mtime_ms as i128 * 1_000_000);
        assert_eq!(r.events.len(), 3);
        let e = &r.events[0];
        assert_eq!(e.ts_ms, mtime_ms);
        assert_eq!((e.input, e.cache_read, e.output, e.reasoning, e.total_raw), (315, 24448, 122, 64, 24885));
        assert_eq!(r.model_name(e.model), Some("gpt-5"));
        assert!(e.flags & flags::FALLBACK_MODEL != 0);
        let e = &r.events[1];
        assert_eq!(e.ts_ms, crate::time::parse_ts("2026-09-25T10:00:00Z").unwrap());
        assert_eq!(r.model_name(e.model), Some("gpt-5.4"));
        assert_eq!(e.flags & flags::FALLBACK_MODEL, 0);
        let e = &r.events[2];
        assert_eq!(e.ts_ms, 1_758_794_400_000);
        assert_eq!((e.input, e.output), (50, 5));
        assert_eq!(r.model_name(e.model), Some("gpt-5-mini"));
        assert!(!r.models.iter().any(|m| m.contains("SECRET")));
    }

    /// Rollout lines never count twice through the headless path.
    #[test]
    fn rollout_lines_are_not_headless() {
        let buf = br#"{"timestamp":"2026-09-26T10:00:00.000Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11},"last_token_usage":{"input_tokens":10,"output_tokens":1,"total_tokens":11}}}}
{"timestamp":"2026-09-26T10:00:01.000Z","type":"response_item","payload":{"type":"message","content":[{"type":"output_text","text":"{\"usage\":{\"input_tokens\":999}}"}]}}
"#;
        let mut r = rec();
        parse_lines(&mut r, buf, false, 0);
        assert_eq!(r.events.len(), 1);
        assert_eq!(r.events[0].input, 10);
    }
}
