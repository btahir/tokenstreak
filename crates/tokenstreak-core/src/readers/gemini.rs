//! Gemini CLI chats: `~/.gemini/tmp/<project>/chats/session-*.jsonl`.
//!
//! Verified against gemini-cli `chatRecordingService.ts` (Sep 2026): sessions
//! are JSONL files whose first line holds metadata (`sessionId`,
//! `projectHash`, `startTime`) followed by message records; a message is
//! re-appended with the same `id` when it is updated, and `$set` lines update
//! metadata. Older releases wrote one JSON document with a `messages` array;
//! both are supported. Token counts live in `tokens` on `type: "gemini"`
//! messages. Semantics follow ccusage's Gemini adapter (MIT).

use serde::{Deserialize, Serialize};

use super::{lines, FileRecord, ReaderState};
use crate::model::{hash_str, RawEvent};
use crate::time::parse_ts;

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GeminiState {
    pub session: Option<String>,
    pub current_model: Option<String>,
}

/// One record: a JSONL line, a whole legacy document, or a message in it.
/// Only usage-related fields are declared; `content`, `thoughts`,
/// `toolCalls` and everything else are skipped by serde.
#[derive(Deserialize, Default)]
struct Record {
    #[serde(rename = "type", default, deserialize_with = "lenient_str")]
    kind: Option<String>,
    #[serde(rename = "sessionId", default, deserialize_with = "non_empty")]
    session_id_camel: Option<String>,
    #[serde(default, deserialize_with = "non_empty")]
    session_id: Option<String>,
    #[serde(default, deserialize_with = "non_empty")]
    model: Option<String>,
    #[serde(default, deserialize_with = "non_empty")]
    id: Option<String>,
    #[serde(default, deserialize_with = "lenient_str")]
    timestamp: Option<String>,
    #[serde(default, deserialize_with = "lenient_str")]
    created_at: Option<String>,
    #[serde(rename = "startTime", default, deserialize_with = "lenient_str")]
    start_time: Option<String>,
    #[serde(rename = "lastUpdated", default, deserialize_with = "lenient_str")]
    last_updated: Option<String>,
    #[serde(default)]
    messages: Option<Vec<Record>>,
    #[serde(default)]
    tokens: Option<Tokens>,
    #[serde(default)]
    stats: Option<Stats>,
    #[serde(default)]
    result: Option<ResultWrap>,
}

impl Record {
    fn session(&self) -> Option<String> {
        self.session_id_camel.clone().or_else(|| self.session_id.clone())
    }
    fn stats(&self) -> Option<&Stats> {
        self.stats.as_ref().or_else(|| self.result.as_ref().and_then(|r| r.stats.as_ref()))
    }
}

#[derive(Deserialize, Default)]
struct ResultWrap {
    #[serde(default)]
    stats: Option<Stats>,
}

#[derive(Deserialize, Default)]
struct Stats {
    #[serde(default)]
    models: Option<std::collections::BTreeMap<String, ModelStats>>,
    #[serde(flatten)]
    tokens: Tokens,
}

#[derive(Deserialize, Default)]
struct ModelStats {
    #[serde(default)]
    tokens: Option<Tokens>,
}

/// Token counts with the aliases ccusage accepts; floats are truncated.
#[derive(Deserialize, Default, Clone, Copy)]
struct Tokens {
    #[serde(default, deserialize_with = "num")]
    input: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    prompt: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    input_tokens: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    prompt_tokens: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    output: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    candidates: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    output_tokens: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    candidates_tokens: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    cached: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    cached_tokens: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    thoughts: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    reasoning: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    thoughts_tokens: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    reasoning_tokens: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    tool: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    tool_tokens: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    total: Option<u64>,
    #[serde(default, deserialize_with = "num")]
    total_tokens: Option<u64>,
}

#[derive(Clone, Copy, Default)]
struct Parsed {
    input: u64,
    output: u64,
    cached: u64,
    thoughts: u64,
    tool: u64,
    total: Option<u64>,
}

impl Tokens {
    fn parsed(&self) -> Parsed {
        Parsed {
            input: self.input.or(self.prompt).or(self.input_tokens).or(self.prompt_tokens).unwrap_or(0),
            output: self
                .output
                .or(self.candidates)
                .or(self.output_tokens)
                .or(self.candidates_tokens)
                .unwrap_or(0),
            cached: self.cached.or(self.cached_tokens).unwrap_or(0),
            thoughts: self
                .thoughts
                .or(self.reasoning)
                .or(self.thoughts_tokens)
                .or(self.reasoning_tokens)
                .unwrap_or(0),
            tool: self.tool.or(self.tool_tokens).unwrap_or(0),
            total: self.total.or(self.total_tokens),
        }
    }
}

fn num<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<u64>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum N {
        Num(serde_json::Number),
        Other(serde::de::IgnoredAny),
    }
    Ok(match Option::<N>::deserialize(d)? {
        Some(N::Num(n)) => n.as_f64().filter(|f| f.is_finite()).map(|f| f.max(0.0).trunc() as u64),
        _ => None,
    })
}

fn lenient_str<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    #[derive(Deserialize)]
    #[serde(untagged)]
    enum S {
        Str(String),
        Other(serde::de::IgnoredAny),
    }
    Ok(match Option::<S>::deserialize(d)? {
        Some(S::Str(s)) => Some(s),
        _ => None,
    })
}

fn non_empty<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<String>, D::Error> {
    Ok(lenient_str(d)?.map(|s| s.trim().to_string()).filter(|s| !s.is_empty()))
}

enum Normalize {
    /// Direct message records: cached may or may not be included in input.
    Session,
    /// Aggregate stats: cached is included in input.
    SubtractCached,
}

fn build(model: Option<&str>, ts_ms: i64, p: Parsed, how: Normalize) -> Option<(String, RawEvent)> {
    let model = model.filter(|m| !m.trim().is_empty())?;
    let subtract = |p: Parsed| (p.input.saturating_sub(p.input.min(p.cached)), p.cached);
    let (input_nc, cache_read) = match how {
        Normalize::SubtractCached => subtract(p),
        Normalize::Session => {
            let inclusive = p.input + p.output + p.thoughts + p.tool;
            let exclusive = inclusive + p.cached;
            if p.cached > 0 && p.total == Some(inclusive) && p.total != Some(exclusive) {
                subtract(p)
            } else {
                (p.input, p.cached)
            }
        }
    };
    let input = input_nc + p.tool;
    let total = p.total.unwrap_or(input + p.output + cache_read + p.thoughts);
    let mut output = p.output;
    let mut extra = p.thoughts;
    // ccusage `apply_total_token_fallback`.
    let known = input + output + cache_read + extra;
    let missing = total.saturating_sub(known);
    if missing > 0 {
        if output == 0 {
            output = missing;
        } else {
            extra += missing;
        }
    }
    if input == 0 && output == 0 && cache_read == 0 && extra == 0 {
        return None;
    }
    let ev = RawEvent {
        ts_ms,
        input,
        output,
        cache_read,
        extra,
        reasoning: extra,
        total_raw: total,
        ..Default::default()
    };
    Some((model.to_string(), ev))
}

fn push(rec: &mut FileRecord, session: &str, built: Option<(String, RawEvent)>, id: Option<&str>, provisional: bool) {
    let Some((model, mut ev)) = built else { return };
    ev.model = rec.intern_model(&model);
    ev.session = rec.intern_session(session);
    ev.msg_id = id.map(hash_str);
    if provisional {
        rec.provisional.push(ev);
    } else {
        rec.events.push(ev);
    }
}

fn mtime_ms(mtime_ns: i128) -> i64 {
    (mtime_ns / 1_000_000) as i64
}

fn stats_events(stats: Option<&Stats>, hint: Option<&str>, ts_ms: i64) -> Vec<(String, RawEvent)> {
    let Some(stats) = stats else { return Vec::new() };
    if let Some(models) = &stats.models {
        let v: Vec<_> = models
            .iter()
            .filter_map(|(m, d)| {
                d.tokens.map(|t| build(Some(m), ts_ms, t.parsed(), Normalize::SubtractCached)).flatten()
            })
            .collect();
        if !v.is_empty() {
            return v;
        }
    }
    build(hint.or(Some("unknown")), ts_ms, stats.tokens.parsed(), Normalize::SubtractCached)
        .into_iter()
        .collect()
}

fn init_project(rec: &mut FileRecord) {
    if rec.project.is_empty() {
        // `<project>/chats/...` relative to tmp: the project folder name.
        let p = rec.rel.split('/').next().unwrap_or("gemini").to_string();
        rec.project_label = p.clone();
        rec.project = format!("gemini:{p}");
    }
}

fn file_stem(rec: &FileRecord) -> String {
    rec.path.file_stem().and_then(|s| s.to_str()).unwrap_or("unknown").to_string()
}

pub fn parse_lines(rec: &mut FileRecord, buf: &[u8], provisional: bool, mtime_ns: i128) {
    init_project(rec);
    let mut st = match &rec.state {
        ReaderState::Gemini(s) => s.clone(),
        _ => GeminiState::default(),
    };
    let fallback_ts = mtime_ms(mtime_ns);
    let mut session = st.session.clone().unwrap_or_else(|| file_stem(rec));
    for line in lines(buf) {
        let Ok(r) = serde_json::from_slice::<Record>(line) else {
            rec.malformed_lines += 1;
            continue;
        };
        if let Some(s) = r.session() {
            session = s;
        }
        if let Some(m) = r.model.clone() {
            st.current_model = Some(m);
        }
        if r.kind.as_deref() == Some("gemini") {
            let ts = r
                .timestamp
                .as_deref()
                .and_then(parse_ts)
                .or_else(|| r.created_at.as_deref().and_then(parse_ts))
                .unwrap_or(fallback_ts);
            let built = r
                .tokens
                .map(|t| build(r.model.as_deref().or(st.current_model.as_deref()), ts, t.parsed(), Normalize::Session))
                .flatten();
            push(rec, &session, built, r.id.as_deref(), provisional);
            continue;
        }
        if r.stats().is_some() {
            let ts = r.timestamp.as_deref().and_then(parse_ts).unwrap_or(fallback_ts);
            for b in stats_events(r.stats(), st.current_model.as_deref(), ts) {
                push(rec, &session, Some(b), None, provisional);
            }
        }
    }
    if !provisional {
        st.session = Some(session);
        rec.state = ReaderState::Gemini(st);
    }
}

/// Legacy whole-document sessions (`session-*.json`).
pub fn parse_json_document(rec: &mut FileRecord, buf: &[u8], mtime_ns: i128) {
    init_project(rec);
    let fallback_ts = mtime_ms(mtime_ns);
    let Ok(doc) = serde_json::from_slice::<Record>(buf) else {
        rec.malformed_lines += 1;
        return;
    };
    let session = doc.session().unwrap_or_else(|| file_stem(rec));
    let session_ts = doc
        .start_time
        .as_deref()
        .and_then(parse_ts)
        .or_else(|| doc.last_updated.as_deref().and_then(parse_ts))
        .unwrap_or(fallback_ts);
    if let Some(messages) = &doc.messages {
        for m in messages.iter().filter(|m| m.kind.as_deref() == Some("gemini")) {
            let ts = m
                .timestamp
                .as_deref()
                .and_then(parse_ts)
                .or_else(|| m.created_at.as_deref().and_then(parse_ts))
                .unwrap_or(session_ts);
            let built = m.tokens.map(|t| build(m.model.as_deref(), ts, t.parsed(), Normalize::Session)).flatten();
            // Legacy documents are not deduplicated by id (ccusage).
            push(rec, &session, built, None, false);
        }
        return;
    }
    if doc.kind.as_deref() == Some("gemini") {
        let ts = doc
            .timestamp
            .as_deref()
            .and_then(parse_ts)
            .or_else(|| doc.created_at.as_deref().and_then(parse_ts))
            .unwrap_or(fallback_ts);
        let built = doc.tokens.map(|t| build(doc.model.as_deref(), ts, t.parsed(), Normalize::Session)).flatten();
        push(rec, &session, built, None, false);
        return;
    }
    let ts = doc.timestamp.as_deref().and_then(parse_ts).unwrap_or(fallback_ts);
    for b in stats_events(doc.stats(), doc.model.as_deref(), ts) {
        push(rec, &session, Some(b), None, false);
    }
}
