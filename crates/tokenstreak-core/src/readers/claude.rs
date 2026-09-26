//! Claude Code transcripts: `~/.claude/projects/<project>/<session>.jsonl`.
//!
//! Semantics mirror ccusage's daily loader (MIT): only lines containing
//! `"usage":{` are considered; assistant entries and agent-progress entries
//! both carry usage; `<synthetic>` models count tokens without a model; fast
//! mode adds a `-fast` model suffix; advisor iterations become extra entries.

use serde::Deserialize;
use serde_json::value::RawValue;

use super::{lines, Field, FileRecord};
use crate::model::{flags, hash_str, RawEvent, NO_MODEL};
use crate::time::parse_ts;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Line<'a> {
    #[serde(borrow, default)]
    timestamp: Option<std::borrow::Cow<'a, str>>,
    #[serde(default)]
    message: Option<Message>,
    #[serde(default)]
    version: Field<String>,
    #[serde(default)]
    session_id: Field<String>,
    #[serde(default, rename = "costUSD")]
    cost_usd: Field<f64>,
    #[serde(default)]
    request_id: Field<String>,
    #[serde(default)]
    is_sidechain: Option<bool>,
    #[serde(default)]
    is_api_error_message: Field<bool>,
    #[serde(default)]
    cwd: Field<String>,
    /// Agent-progress payload, kept as borrowed raw JSON and only parsed when
    /// the line is not a direct assistant entry.
    #[serde(borrow, default)]
    data: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct Message {
    #[serde(default)]
    usage: Option<Usage>,
    #[serde(default)]
    model: Field<String>,
    #[serde(default)]
    id: Field<String>,
}

#[derive(Deserialize, Clone, Copy)]
struct Usage {
    input_tokens: u64,
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: Field<u64>,
    #[serde(default)]
    cache_read_input_tokens: Field<u64>,
    #[serde(default)]
    speed: Field<Speed>,
    #[serde(default)]
    cache_creation: Option<CacheCreation>,
}

#[derive(Deserialize, Clone, Copy, Default)]
struct CacheCreation {
    #[serde(default)]
    ephemeral_5m_input_tokens: u64,
    #[serde(default)]
    ephemeral_1h_input_tokens: u64,
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Speed {
    Standard,
    Fast,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressData {
    message: ProgressMessage,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProgressMessage {
    timestamp: String,
    message: Message,
    #[serde(default, rename = "costUSD")]
    cost_usd: Field<f64>,
    #[serde(default)]
    request_id: Field<String>,
    #[serde(default)]
    is_sidechain: Option<bool>,
}

// Advisor iterations (`message.usage.iterations[type == "advisor_message"]`).
#[derive(Deserialize)]
struct AdvisorEnvelope {
    message: AdvisorMessage,
}
#[derive(Deserialize)]
struct AdvisorMessage {
    usage: AdvisorUsage,
}
#[derive(Deserialize)]
struct AdvisorUsage {
    #[serde(default)]
    iterations: Vec<Iteration>,
}
#[derive(Deserialize)]
struct Iteration {
    #[serde(rename = "type")]
    kind: String,
    model: Option<String>,
    input_tokens: u64,
    output_tokens: u64,
    #[serde(default)]
    cache_creation_input_tokens: u64,
    #[serde(default)]
    cache_read_input_tokens: u64,
    #[serde(default)]
    speed: Option<Speed>,
    #[serde(default)]
    cache_creation: Option<CacheCreation>,
}

/// A normalised usage entry, independent of which line shape carried it.
struct Entry {
    timestamp: String,
    usage: Usage,
    model: Option<String>,
    id: Option<String>,
    version: Option<String>,
    session_id: Option<String>,
    cost_usd: Option<f64>,
    request_id: Option<String>,
    is_sidechain: bool,
}

const USAGE_MARKER: &[u8] = br#""usage":{"#;

pub fn parse_lines(rec: &mut FileRecord, buf: &[u8], provisional: bool) {
    if rec.project.is_empty() {
        init_project(rec);
    }
    let finder = memchr::memmem::Finder::new(USAGE_MARKER);
    let path_session = path_session_id(&rec.rel);
    for line in lines(buf) {
        // Record the working directory once for the project label. `cwd` is a
        // project identifier, never content.
        if rec.project_label.is_empty() || rec.project_label == rec.project {
            if let Some(cwd) = cheap_cwd(line) {
                set_label_from_cwd(rec, &cwd);
            }
        }
        if finder.find(line).is_none() {
            continue;
        }
        let Some(entry) = parse_entry(line) else {
            continue;
        };
        let Some(ts_ms) = parse_ts(&entry.timestamp) else {
            continue;
        };
        if !valid(&entry) {
            continue;
        }
        let session = entry.session_id.clone().unwrap_or_else(|| path_session.clone());
        let session_idx = rec.intern_session(&session);
        let base_flags = if entry.is_sidechain { flags::SIDECHAIN } else { 0 };
        let event = make_event(rec, ts_ms, session_idx, &entry, base_flags);
        push(rec, event, provisional);

        if memchr::memmem::find(line, br#""advisor_message""#).is_some() {
            if let Ok(env) = serde_json::from_slice::<AdvisorEnvelope>(line) {
                let advisors = env
                    .message
                    .usage
                    .iterations
                    .into_iter()
                    .filter(|it| it.kind == "advisor_message")
                    .filter_map(|it| it.model.clone().filter(|m| !m.is_empty()).map(|m| (m, it)));
                for (i, (model, it)) in advisors.enumerate() {
                    let usage = Usage {
                        input_tokens: it.input_tokens,
                        output_tokens: it.output_tokens,
                        cache_creation_input_tokens: Field::Value(it.cache_creation_input_tokens),
                        cache_read_input_tokens: Field::Value(it.cache_read_input_tokens),
                        speed: it.speed.map(Field::Value).unwrap_or(Field::Absent),
                        cache_creation: it.cache_creation,
                    };
                    let adv = Entry {
                        timestamp: entry.timestamp.clone(),
                        usage,
                        model: Some(model),
                        id: entry.id.as_ref().map(|id| format!("{id}:advisor:{i}")),
                        version: None,
                        session_id: entry.session_id.clone(),
                        cost_usd: None,
                        request_id: entry.request_id.clone(),
                        is_sidechain: entry.is_sidechain,
                    };
                    let ev = make_event(rec, ts_ms, session_idx, &adv, base_flags);
                    push(rec, ev, provisional);
                }
            }
        }
    }
}

fn push(rec: &mut FileRecord, ev: RawEvent, provisional: bool) {
    if provisional {
        rec.provisional.push(ev);
    } else {
        rec.events.push(ev);
    }
}

fn make_event(rec: &mut FileRecord, ts_ms: i64, session: u32, e: &Entry, base: u8) -> RawEvent {
    let u = e.usage;
    let (cc5, cc1h) = match u.cache_creation {
        Some(b) => (b.ephemeral_5m_input_tokens, b.ephemeral_1h_input_tokens),
        None => (u.cache_creation_input_tokens.value().copied().unwrap_or(0), 0),
    };
    let mut fl = base;
    match u.speed {
        Field::Value(Speed::Fast) => fl |= flags::FAST | flags::HAS_SPEED,
        Field::Value(Speed::Standard) => fl |= flags::HAS_SPEED,
        _ => {}
    }
    let model = match &e.model {
        Some(m) => {
            if m == "<synthetic>" {
                fl |= flags::SYNTHETIC;
            }
            rec.intern_model(m)
        }
        None => NO_MODEL,
    };
    RawEvent {
        ts_ms,
        model,
        session,
        input: u.input_tokens,
        output: u.output_tokens,
        cache_create_5m: cc5,
        cache_create_1h: cc1h,
        cache_read: u.cache_read_input_tokens.value().copied().unwrap_or(0),
        reasoning: 0,
        extra: 0,
        total_raw: 0,
        recorded_cost: e.cost_usd,
        msg_id: e.id.as_deref().map(hash_str),
        req_id: e.request_id.as_deref().map(hash_str),
        flags: fl,
    }
}

fn message_has_null(m: &Message) -> bool {
    m.model.is_null()
        || m.id.is_null()
        || m.usage.as_ref().is_some_and(|u| {
            u.speed.is_null()
                || u.cache_read_input_tokens.is_null()
                || u.cache_creation_input_tokens.is_null()
        })
}

fn parse_entry(line: &[u8]) -> Option<Entry> {
    let l: Line = serde_json::from_slice(line).ok()?;
    // ccusage rejects lines whose non-nullable fields are explicitly null.
    if l.version.is_null()
        || l.session_id.is_null()
        || l.cost_usd.is_null()
        || l.request_id.is_null()
        || l.is_api_error_message.is_null()
        || l.cwd.is_null()
        || l.message.as_ref().is_some_and(message_has_null)
    {
        return None;
    }
    if let (Some(ts), Some(msg)) = (l.timestamp.as_ref(), l.message.as_ref()) {
        if let Some(usage) = msg.usage {
            return Some(Entry {
                timestamp: ts.to_string(),
                usage,
                model: msg.model.value().cloned(),
                id: msg.id.value().cloned(),
                version: l.version.value().cloned(),
                session_id: l.session_id.value().cloned(),
                cost_usd: l.cost_usd.value().copied(),
                request_id: l.request_id.value().cloned(),
                is_sidechain: l.is_sidechain == Some(true),
            });
        }
    }
    // Agent progress entry: usage nested under data.message.message.
    let data: ProgressData = serde_json::from_str(l.data?.get()).ok()?;
    let pm = data.message;
    if message_has_null(&pm.message) || pm.cost_usd.is_null() || pm.request_id.is_null() {
        return None;
    }
    let usage = pm.message.usage?;
    Some(Entry {
        timestamp: pm.timestamp,
        usage,
        model: pm.message.model.value().cloned(),
        id: pm.message.id.value().cloned(),
        version: None,
        session_id: l.session_id.value().cloned(),
        cost_usd: pm.cost_usd.value().copied(),
        request_id: pm.request_id.value().cloned(),
        is_sidechain: pm.is_sidechain == Some(true),
    })
}

fn valid(e: &Entry) -> bool {
    if e.version.as_deref().is_some_and(|v| !is_semver_prefix(v)) {
        return false;
    }
    let empty = |s: &Option<String>| s.as_deref().is_some_and(str::is_empty);
    !(empty(&e.session_id) || empty(&e.request_id) || empty(&e.id) || empty(&e.model))
}

fn is_semver_prefix(v: &str) -> bool {
    let b = v.as_bytes();
    let mut i = 0;
    let digits = |i: &mut usize| {
        let s = *i;
        while b.get(*i).is_some_and(u8::is_ascii_digit) {
            *i += 1;
        }
        *i > s
    };
    if !digits(&mut i) || b.get(i) != Some(&b'.') {
        return false;
    }
    i += 1;
    if !digits(&mut i) || b.get(i) != Some(&b'.') {
        return false;
    }
    i += 1;
    b.get(i).is_some_and(u8::is_ascii_digit)
}

/// Session id from the path, relative to `projects/` (ccusage `extract_session_parts`).
pub fn path_session_id(rel: &str) -> String {
    let parts: Vec<&str> = rel.split('/').collect();
    let file_session = parts.last().and_then(|f| f.strip_suffix(".jsonl")).filter(|s| !s.is_empty());
    if parts.len() == 2 {
        if let Some(s) = file_session {
            return s.to_string();
        }
    }
    if parts.len() >= 4 && parts[parts.len() - 2] == "subagents" {
        return parts[parts.len() - 3].to_string();
    }
    if parts.len() >= 3 {
        return parts[parts.len() - 2].to_string();
    }
    file_session.unwrap_or("unknown").to_string()
}

fn init_project(rec: &mut FileRecord) {
    let slug = rec.rel.split('/').next().filter(|s| !s.trim().is_empty()).unwrap_or("unknown");
    rec.project = slug.to_string();
    rec.project_label = slug.to_string();
}

fn set_label_from_cwd(rec: &mut FileRecord, cwd: &str) {
    let cwd = cwd.trim_end_matches('/');
    if cwd.is_empty() {
        return;
    }
    // Claude names the project folder after the launch directory with `/` and
    // `.` replaced by `-`; only a cwd that maps to this folder names it.
    let slug: String =
        cwd.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect();
    if slug == rec.project || rec.project == "unknown" {
        rec.project = cwd.to_string();
        rec.project_label = cwd.rsplit('/').next().unwrap_or(cwd).to_string();
    }
}

/// Extracts the top-level `"cwd":"..."` value without parsing the line.
fn cheap_cwd(line: &[u8]) -> Option<String> {
    let at = memchr::memmem::find(line, br#""cwd":""#)?;
    let start = at + 7;
    let end = start + memchr::memchr(b'"', &line[start..])?;
    let raw = std::str::from_utf8(&line[start..end]).ok()?;
    if raw.contains('\\') {
        return None;
    }
    Some(raw.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_ids_follow_ccusage() {
        assert_eq!(path_session_id("proj/abc.jsonl"), "abc");
        assert_eq!(path_session_id("proj/sess/chat.jsonl"), "sess");
        assert_eq!(path_session_id("proj/sess/subagents/agent-1.jsonl"), "sess");
    }

    #[test]
    fn semver() {
        assert!(is_semver_prefix("2.0.14"));
        assert!(is_semver_prefix("1.2.3-beta"));
        assert!(!is_semver_prefix("v1.2.3"));
        assert!(!is_semver_prefix("1.2"));
    }
}
