//! Synthetic log generation in each tool's native format.
//!
//! Used by the 1 GB performance test, the browser mock presets and demos.
//! Content fields are filled with neutral filler text (never real logs).

use std::fs::{self, File};
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};

use jiff::civil::Date;
use jiff::tz::TimeZone;
use jiff::ToSpan;

use crate::model::Tool;

/// Deterministic SplitMix64.
#[derive(Clone)]
pub struct Rng(u64);

impl Rng {
    pub fn new(seed: u64) -> Self {
        Self(seed ^ 0x9E3779B97F4A7C15)
    }
    pub fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E3779B97F4A7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
        z ^ (z >> 31)
    }
    pub fn f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
    pub fn range(&mut self, lo: u64, hi: u64) -> u64 {
        if hi <= lo {
            lo
        } else {
            lo + self.next_u64() % (hi - lo)
        }
    }
    pub fn pick<'a, T>(&mut self, v: &'a [T]) -> &'a T {
        &v[(self.next_u64() % v.len() as u64) as usize]
    }
    pub fn chance(&mut self, p: f64) -> bool {
        self.f64() < p
    }
    pub fn hex(&mut self, n: usize) -> String {
        let mut s = String::with_capacity(n);
        while s.len() < n {
            s.push_str(&format!("{:016x}", self.next_u64()));
        }
        s.truncate(n);
        s
    }
    pub fn uuid(&mut self) -> String {
        let h = self.hex(32);
        format!("{}-{}-{}-{}-{}", &h[0..8], &h[8..12], &h[12..16], &h[16..20], &h[20..32])
    }
}

const FILLER: &str = "The quick brown fox jumps over the lazy dog while the agent refactors the parser, \
adds tests, and explains its plan step by step. ";

pub fn filler(rng: &mut Rng, bytes: usize) -> String {
    let mut s = String::with_capacity(bytes + FILLER.len());
    let start = (rng.next_u64() % 20) as usize;
    s.push_str(&FILLER[start..]);
    while s.len() < bytes {
        s.push_str(FILLER);
    }
    s.truncate(bytes);
    s
}

/// One synthetic request.
#[derive(Clone, Debug)]
pub struct Req {
    pub ts_ms: i64,
    pub tool: Tool,
    pub model: String,
    pub project: String,
    pub session: String,
    pub input: u64,
    pub output: u64,
    pub cache_write: u64,
    pub cache_read: u64,
    pub reasoning: u64,
    /// Bytes of filler content to write alongside (prompt + response).
    pub content_bytes: usize,
}

pub fn ts_string(ms: i64) -> String {
    crate::time::format_rfc3339_ms(ms)
}

/// Writes requests as native log files under `root` (`claude/projects`,
/// `codex/sessions`, `gemini/tmp`). Returns the three roots.
pub fn write_logs(root: &Path, reqs: &[Req], rng: &mut Rng) -> std::io::Result<[PathBuf; 3]> {
    let claude = root.join("claude").join("projects");
    let codex = root.join("codex").join("sessions");
    let gemini = root.join("gemini").join("tmp");
    for d in [&claude, &codex, &gemini] {
        fs::create_dir_all(d)?;
    }
    // Group by (tool, session) preserving order.
    let mut sessions: Vec<(Tool, String, Vec<&Req>)> = Vec::new();
    let mut index: std::collections::HashMap<(Tool, String), usize> = Default::default();
    for r in reqs {
        let key = (r.tool, r.session.clone());
        let i = *index.entry(key).or_insert_with(|| {
            sessions.push((r.tool, r.session.clone(), Vec::new()));
            sessions.len() - 1
        });
        sessions[i].2.push(r);
    }
    for (tool, session, rs) in sessions {
        match tool {
            Tool::Claude => write_claude(&claude, &session, &rs, rng)?,
            Tool::Codex => write_codex(&codex, &session, &rs, rng)?,
            Tool::Gemini => write_gemini(&gemini, &session, &rs, rng)?,
        }
    }
    Ok([root.join("claude"), root.join("codex"), gemini])
}

fn slug(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '-' }).collect()
}

fn write_claude(root: &Path, session: &str, rs: &[&Req], rng: &mut Rng) -> std::io::Result<()> {
    let cwd = format!("/Users/demo/code/{}", rs[0].project);
    let dir = root.join(slug(&cwd));
    fs::create_dir_all(&dir)?;
    let mut w = BufWriter::new(File::options().create(true).append(true).open(dir.join(format!("{session}.jsonl")))?);
    for r in rs {
        let user_ts = ts_string(r.ts_ms - 1500);
        let prompt = filler(rng, r.content_bytes / 4);
        let user = serde_json::json!({
            "parentUuid": null, "isSidechain": false, "userType": "external", "cwd": cwd,
            "sessionId": session, "version": "2.0.14", "gitBranch": "main", "type": "user",
            "message": {"role": "user", "content": prompt},
            "uuid": rng.uuid(), "timestamp": user_ts
        });
        writeln!(w, "{}", serde_json::to_string(&user)?)?;
        let text = filler(rng, r.content_bytes - r.content_bytes / 4);
        let line = serde_json::json!({
            "parentUuid": rng.uuid(), "isSidechain": false, "userType": "external", "cwd": cwd,
            "sessionId": session, "version": "2.0.14", "gitBranch": "main",
            "message": {
                "id": format!("msg_{}", rng.hex(24)), "type": "message", "role": "assistant",
                "model": r.model,
                "content": [{"type": "text", "text": text}],
                "stop_reason": "end_turn", "stop_sequence": null,
                "usage": {
                    "input_tokens": r.input, "cache_creation_input_tokens": r.cache_write,
                    "cache_read_input_tokens": r.cache_read,
                    "cache_creation": {"ephemeral_5m_input_tokens": r.cache_write, "ephemeral_1h_input_tokens": 0},
                    "output_tokens": r.output, "service_tier": "standard"
                }
            },
            "requestId": format!("req_{}", rng.hex(24)), "type": "assistant", "uuid": rng.uuid(),
            "timestamp": ts_string(r.ts_ms)
        });
        writeln!(w, "{}", serde_json::to_string(&line)?)?;
    }
    w.flush()
}

fn write_codex(root: &Path, session: &str, rs: &[&Req], rng: &mut Rng) -> std::io::Result<()> {
    let first = rs[0].ts_ms;
    let d = TimeZone::UTC.to_datetime(jiff::Timestamp::from_millisecond(first).unwrap_or_default());
    let dir = root.join(format!("{:04}/{:02}/{:02}", d.year(), d.month(), d.day()));
    fs::create_dir_all(&dir)?;
    let name = format!("rollout-{}-{}.jsonl", d.strftime("%Y-%m-%dT%H-%M-%S"), session);
    let mut w = BufWriter::new(File::create(dir.join(name))?);
    let cwd = format!("/Users/demo/code/{}", rs[0].project);
    let meta = serde_json::json!({"timestamp": ts_string(first - 5000), "type": "session_meta",
        "payload": {"id": session, "timestamp": ts_string(first - 5000), "cwd": cwd, "originator": "codex_cli_rs",
        "cli_version": "0.46.0", "instructions": filler(rng, 400)}});
    writeln!(w, "{}", serde_json::to_string(&meta)?)?;
    let (mut ti, mut tc, mut to, mut tr) = (0u64, 0u64, 0u64, 0u64);
    for r in rs {
        let ctx = serde_json::json!({"timestamp": ts_string(r.ts_ms - 2000), "type": "turn_context",
            "payload": {"cwd": cwd, "approval_policy": "on-request", "model": r.model, "summary": "auto"}});
        writeln!(w, "{}", serde_json::to_string(&ctx)?)?;
        let um = serde_json::json!({"timestamp": ts_string(r.ts_ms - 1900), "type": "event_msg",
            "payload": {"type": "user_message", "message": filler(rng, r.content_bytes / 4), "kind": "plain"}});
        writeln!(w, "{}", serde_json::to_string(&um)?)?;
        let item = serde_json::json!({"timestamp": ts_string(r.ts_ms - 100), "type": "response_item",
            "payload": {"type": "message", "role": "assistant",
            "content": [{"type": "output_text", "text": filler(rng, r.content_bytes - r.content_bytes / 4)}]}});
        writeln!(w, "{}", serde_json::to_string(&item)?)?;
        let input_raw = r.input + r.cache_read;
        ti += input_raw;
        tc += r.cache_read;
        to += r.output;
        tr += r.reasoning;
        let tok = serde_json::json!({"timestamp": ts_string(r.ts_ms), "type": "event_msg",
            "payload": {"type": "token_count", "info": {
                "total_token_usage": {"input_tokens": ti, "cached_input_tokens": tc, "output_tokens": to,
                    "reasoning_output_tokens": tr, "total_tokens": ti + to},
                "last_token_usage": {"input_tokens": input_raw, "cached_input_tokens": r.cache_read,
                    "output_tokens": r.output, "reasoning_output_tokens": r.reasoning, "total_tokens": input_raw + r.output},
                "model_context_window": 272000}}});
        writeln!(w, "{}", serde_json::to_string(&tok)?)?;
    }
    w.flush()
}

fn write_gemini(root: &Path, session: &str, rs: &[&Req], rng: &mut Rng) -> std::io::Result<()> {
    let dir = root.join(&rs[0].project).join("chats");
    fs::create_dir_all(&dir)?;
    let mut w = BufWriter::new(File::create(dir.join(format!("session-{session}.jsonl")))?);
    let meta = serde_json::json!({"sessionId": session, "projectHash": rng.hex(64),
        "startTime": ts_string(rs[0].ts_ms - 3000), "lastUpdated": ts_string(rs[rs.len() - 1].ts_ms), "kind": "main"});
    writeln!(w, "{}", serde_json::to_string(&meta)?)?;
    for r in rs {
        let user = serde_json::json!({"id": rng.uuid(), "timestamp": ts_string(r.ts_ms - 2000), "type": "user",
            "content": [{"text": filler(rng, r.content_bytes / 4)}]});
        writeln!(w, "{}", serde_json::to_string(&user)?)?;
        let input_total = r.input + r.cache_read;
        let msg = serde_json::json!({"id": rng.uuid(), "timestamp": ts_string(r.ts_ms), "type": "gemini",
            "content": filler(rng, r.content_bytes - r.content_bytes / 4),
            "thoughts": [{"subject": "Planning", "description": filler(rng, 120), "timestamp": ts_string(r.ts_ms)}],
            "tokens": {"input": input_total, "output": r.output, "cached": r.cache_read, "thoughts": r.reasoning,
                "tool": 0, "total": input_total + r.output + r.reasoning},
            "model": r.model});
        writeln!(w, "{}", serde_json::to_string(&msg)?)?;
    }
    w.flush()
}

// ---------------------------------------------------------------------------
// Scenarios

/// Shape of a synthetic history.
#[derive(Clone, Debug)]
pub struct Scenario {
    pub seed: u64,
    pub today: Date,
    pub tz: TimeZone,
    /// Days of history before today.
    pub days: i64,
    pub daily_goal: u64,
    /// Per-day activity: returns target tokens for the day offset (0 = today).
    pub target: fn(&mut Rng, i64, u64) -> u64,
    /// Tool weights (claude, codex, gemini).
    pub tools: [f64; 3],
    pub projects: Vec<&'static str>,
    /// Local hour of "now" (today's requests stop here).
    pub now_hour: i64,
    pub content_bytes: (usize, usize),
}

pub const CLAUDE_MODELS: &[&str] = &["claude-sonnet-4-5-20250929", "claude-opus-4-5-20251101", "claude-haiku-4-5-20251001"];
pub const CODEX_MODELS: &[&str] = &["gpt-5-codex", "gpt-5", "gpt-5.1-codex"];
pub const GEMINI_MODELS: &[&str] = &["gemini-2.5-pro", "gemini-2.5-flash"];

/// Generates requests for a scenario (deterministic).
pub fn requests(s: &Scenario) -> Vec<Req> {
    let mut rng = Rng::new(s.seed);
    let mut out = Vec::new();
    let mut session_n = 0u64;
    for off in (0..=s.days).rev() {
        let day = s.today.checked_sub(off.days()).unwrap_or(s.today);
        let target = (s.target)(&mut rng, off, s.daily_goal);
        if target == 0 {
            continue;
        }
        let mut produced = 0u64;
        // Sessions within the day.
        let tool_total: f64 = s.tools.iter().sum();
        while produced < target {
            session_n += 1;
            let x = rng.f64() * tool_total;
            let tool = if x < s.tools[0] {
                Tool::Claude
            } else if x < s.tools[0] + s.tools[1] {
                Tool::Codex
            } else {
                Tool::Gemini
            };
            let models: &[&str] = match tool {
                Tool::Claude => CLAUDE_MODELS,
                Tool::Codex => CODEX_MODELS,
                Tool::Gemini => GEMINI_MODELS,
            };
            let model = if rng.chance(0.7) { models[0] } else { *rng.pick(models) };
            let project = *rng.pick(&s.projects);
            let session = format!("{}{:06}", &rng.hex(8), session_n);
            let last_hour = if off == 0 { (s.now_hour - 1).max(1) } else { 23 };
            let start_hour = rng.range(if off == 0 { 0.min(last_hour as u64) } else { 8 }, (last_hour as u64).max(1)) as i64;
            let start_hour = if off == 0 {
                rng.range((last_hour as u64).saturating_sub(8), last_hour as u64 + 1) as i64
            } else if rng.chance(0.05) {
                rng.range(0, 4) as i64
            } else {
                start_hour
            };
            let mut t = day
                .at(start_hour as i8, rng.range(0, 60) as i8, rng.range(0, 60) as i8, 0)
                .to_zoned(s.tz.clone())
                .map(|z| z.timestamp().as_millisecond())
                .unwrap_or(0);
            let turns = rng.range(4, 40);
            let mut context = rng.range(8_000, 30_000);
            for _ in 0..turns {
                if produced >= target {
                    break;
                }
                let input = rng.range(3, 400);
                let cache_write = rng.range(200, 6_000);
                let cache_read = context;
                let output = rng.range(80, 2_500);
                let reasoning = if tool == Tool::Claude { 0 } else { output / 3 };
                context += cache_write + output / 2;
                let total = input + cache_write + cache_read + output;
                out.push(Req {
                    ts_ms: t,
                    tool,
                    model: model.to_string(),
                    project: project.to_string(),
                    session: session.clone(),
                    input,
                    output,
                    cache_write: if tool == Tool::Claude { cache_write } else { 0 },
                    cache_read,
                    reasoning,
                    content_bytes: rng.range(s.content_bytes.0 as u64, s.content_bytes.1 as u64 + 1) as usize,
                });
                produced += total;
                t += if off == 0 { rng.range(5_000, 45_000) as i64 } else { rng.range(20_000, 240_000) as i64 };
            }
        }
    }
    // Drop anything after "now".
    let now = s
        .today
        .at(s.now_hour as i8, 0, 0, 0)
        .to_zoned(s.tz.clone())
        .map(|z| z.timestamp().as_millisecond())
        .unwrap_or(i64::MAX);
    out.retain(|r| r.ts_ms <= now);
    out.sort_by_key(|r| r.ts_ms);
    out
}
