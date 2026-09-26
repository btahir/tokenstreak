//! Oracle test: our daily totals must equal ccusage's exactly (every token
//! bucket, every day) and costs must agree within 1%, on every fixture set
//! and several time zones, plus a larger synthetic history.
//!
//! Runs `npx -y ccusage@latest <tool> daily --json --offline --timezone TZ`
//! with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` / `GEMINI_DATA_DIR` pointing at the
//! fixture. Skipped (with a message) when `npx` is unavailable or
//! `TOKENSTREAK_SKIP_ORACLE=1`.

mod common;

use std::collections::BTreeMap;
use std::path::Path;
use std::process::Command;

use common::*;
use tokenstreak_core::engine::Engine;
use tokenstreak_core::synth::{self, Rng, Scenario};
use tokenstreak_core::Tool;

#[derive(Debug, Default, Clone, Copy, PartialEq)]
struct Day {
    input: u64,
    output: u64,
    cache_write: u64,
    cache_read: u64,
    total: u64,
    cost: f64,
}

fn ours(e: &Engine) -> BTreeMap<String, Day> {
    let mut m: BTreeMap<String, Day> = BTreeMap::new();
    for ev in &e.ledger().events {
        let d = m.entry(ev.date.to_string()).or_default();
        d.input += ev.input;
        d.output += ev.output;
        d.cache_write += ev.cache_write;
        d.cache_read += ev.cache_read;
        d.total += ev.total();
        d.cost += ev.cost;
    }
    m
}

fn ccusage(tool: Tool, root: &Path, tz: &str) -> Option<BTreeMap<String, Day>> {
    if std::env::var("TOKENSTREAK_SKIP_ORACLE").is_ok_and(|v| v == "1") {
        return None;
    }
    let nowhere = "/nonexistent/tokenstreak";
    let (claude, codex, gemini) = match tool {
        Tool::Claude => (root.to_str().unwrap(), nowhere, nowhere),
        Tool::Codex => (nowhere, root.to_str().unwrap(), nowhere),
        Tool::Gemini => (nowhere, nowhere, root.to_str().unwrap()),
    };
    let out = Command::new("npx")
        .args(["-y", "ccusage@latest", tool.as_str(), "daily", "--json", "--offline", "--timezone", tz])
        .env("CLAUDE_CONFIG_DIR", claude)
        .env("CODEX_HOME", codex)
        .env("GEMINI_DATA_DIR", gemini)
        .env("NO_COLOR", "1")
        .output()
        .ok()?;
    if !out.status.success() && out.stdout.is_empty() {
        eprintln!("ccusage failed: {}", String::from_utf8_lossy(&out.stderr));
        return None;
    }
    let v: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let mut m = BTreeMap::new();
    for d in v["daily"].as_array()? {
        let n = |k: &str| d[k].as_u64().unwrap_or(0);
        m.insert(
            d["date"].as_str()?.to_string(),
            Day {
                input: n("inputTokens"),
                output: n("outputTokens"),
                cache_write: n("cacheCreationTokens"),
                cache_read: n("cacheReadTokens"),
                total: n("totalTokens"),
                cost: d["totalCost"].as_f64().or(d["costUSD"].as_f64()).unwrap_or(0.0),
            },
        );
    }
    Some(m)
}

fn npx_available() -> bool {
    Command::new("npx").arg("--version").output().is_ok_and(|o| o.status.success())
}

fn check(tool: Tool, root: &Path, tz: &str, label: &str) -> Option<usize> {
    let src = match tool {
        Tool::Claude => sources(Some(root.into()), None, None),
        Tool::Codex => sources(None, Some(root.into()), None),
        Tool::Gemini => sources(None, None, Some(root.into())),
    };
    let e = engine(src, tz);
    let mine = ours(&e);
    let theirs = ccusage(tool, root, tz)?;
    assert!(!theirs.is_empty(), "{label}: ccusage returned no days");
    assert_eq!(
        mine.keys().collect::<Vec<_>>(),
        theirs.keys().collect::<Vec<_>>(),
        "{label} [{tz}]: different set of days"
    );
    for (date, t) in &theirs {
        let o = mine[date];
        assert_eq!(
            (o.input, o.output, o.cache_write, o.cache_read, o.total),
            (t.input, t.output, t.cache_write, t.cache_read, t.total),
            "{label} [{tz}] {date}: token totals differ (ours vs ccusage)"
        );
        let tol = (t.cost.abs() * 0.01).max(1e-6);
        assert!((o.cost - t.cost).abs() <= tol, "{label} [{tz}] {date}: cost {} vs ccusage {}", o.cost, t.cost);
    }
    Some(theirs.len())
}

const ZONES: [&str; 5] = ["UTC", "America/New_York", "Asia/Kolkata", "Pacific/Auckland", "America/Los_Angeles"];

#[test]
fn fixtures_match_ccusage_in_every_zone() {
    if !npx_available() {
        eprintln!("SKIPPED: npx not available");
        return;
    }
    let mut handles = Vec::new();
    for tool in Tool::ALL {
        for tz in ZONES {
            handles.push(std::thread::spawn(move || {
                let n = check(tool, &tool_root(tool), tz, &format!("fixture {}", tool.as_str()));
                (tool, tz, n)
            }));
        }
    }
    let mut checked = 0;
    for h in handles {
        let (tool, tz, n) = h.join().expect("oracle thread panicked");
        match n {
            Some(n) => {
                println!("oracle ok: {} {tz}: {n} days", tool.as_str());
                checked += 1;
            }
            None => eprintln!("SKIPPED: {} {tz} (ccusage unavailable)", tool.as_str()),
        }
    }
    println!("oracle fixture checks passed: {checked}");
}

#[test]
fn synthetic_history_matches_ccusage() {
    if !npx_available() {
        eprintln!("SKIPPED: npx not available");
        return;
    }
    let dir = tempfile::tempdir().unwrap();
    let s = Scenario {
        seed: 42,
        today: "2026-09-26".parse().unwrap(),
        tz: jiff::tz::TimeZone::get("Europe/Berlin").unwrap(),
        days: 45,
        daily_goal: 2_000_000,
        target: |r, _, g| if r.chance(0.15) { 0 } else { (g as f64 * (0.3 + r.f64() * 1.5)) as u64 },
        tools: [0.5, 0.3, 0.2],
        projects: vec!["one", "two", "three"],
        now_hour: 23,
        content_bytes: (50, 200),
    };
    let reqs = synth::requests(&s);
    let roots = synth::write_logs(dir.path(), &reqs, &mut Rng::new(9)).unwrap();
    for (i, tool) in Tool::ALL.iter().enumerate() {
        for tz in ["Europe/Berlin", "America/Los_Angeles"] {
            if let Some(n) = check(*tool, &roots[i], tz, &format!("synthetic {}", tool.as_str())) {
                println!("oracle ok: synthetic {} {tz}: {n} days", tool.as_str());
            }
        }
    }
}
