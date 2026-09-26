//! Developer CLI for tokenstreak-core.
//!
//! ```text
//! tokenstreak-cli daily [--tz ZONE] [--tool claude|codex|gemini]   ccusage-shaped daily JSON
//! tokenstreak-cli compare [--tz ZONE] [--tool T]                   numbers-only diff vs `npx ccusage`
//! tokenstreak-cli snapshot                                         AppSnapshot JSON for this machine
//! tokenstreak-cli bench [--root DIR]                               cold parse timing
//! tokenstreak-cli gen-logs --out DIR --mb N [--seed S]             synthetic native logs
//! tokenstreak-cli gen-mock --out DIR [--today YYYY-MM-DD] [--tz Z] browser mock presets
//! tokenstreak-cli prices import FILE                               compact a LiteLLM price file
//! ```
//! Output never includes log content: only numbers, dates and model names.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::time::Instant;

use tokenstreak_core::engine::Engine;
use tokenstreak_core::readers::SourceConfig;
use tokenstreak_core::time::Clock;
use tokenstreak_core::Tool;

fn arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|a| a == name).and_then(|i| args.get(i + 1).cloned())
}

fn tool_arg(args: &[String]) -> Option<Tool> {
    match arg(args, "--tool").as_deref() {
        Some("claude") => Some(Tool::Claude),
        Some("codex") => Some(Tool::Codex),
        Some("gemini") => Some(Tool::Gemini),
        _ => None,
    }
}

fn engine_for(args: &[String]) -> Engine {
    let clock = Clock::named(arg(args, "--tz").as_deref());
    let mut src = SourceConfig::from_env();
    if let Some(t) = tool_arg(args) {
        src.enabled = [t == Tool::Claude, t == Tool::Codex, t == Tool::Gemini];
    }
    if let Some(root) = arg(args, "--root") {
        let r = PathBuf::from(root);
        src.claude_dirs = Some(vec![r.join("claude")]);
        src.codex_homes = Some(vec![r.join("codex")]);
        src.gemini_dirs = Some(vec![r.join("gemini").join("tmp")]);
    }
    let mut e = Engine::ephemeral(src, clock);
    e.scan();
    e.rebuild();
    e
}

/// Per-day totals in ccusage's JSON shape.
fn daily_json(e: &Engine) -> serde_json::Value {
    #[derive(Default)]
    struct D {
        input: u64,
        output: u64,
        cw: u64,
        cr: u64,
        total: u64,
        cost: f64,
    }
    let mut days: BTreeMap<String, D> = BTreeMap::new();
    for ev in &e.ledger().events {
        let d = days.entry(ev.date.to_string()).or_default();
        d.input += ev.input;
        d.output += ev.output;
        d.cw += ev.cache_write;
        d.cr += ev.cache_read;
        d.total += ev.total();
        d.cost += ev.cost;
    }
    serde_json::json!({
        "daily": days.iter().map(|(k, d)| serde_json::json!({
            "date": k, "inputTokens": d.input, "outputTokens": d.output,
            "cacheCreationTokens": d.cw, "cacheReadTokens": d.cr,
            "totalTokens": d.total, "totalCost": d.cost,
        })).collect::<Vec<_>>()
    })
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cmd = args.first().map(String::as_str).unwrap_or("help");
    match cmd {
        "daily" => {
            let e = engine_for(&args);
            println!("{}", serde_json::to_string_pretty(&daily_json(&e)).unwrap());
        }
        "compare" => compare(&args),
        "snapshot" => {
            let e = engine_for(&args);
            println!("{}", serde_json::to_string_pretty(&e.snapshot()).unwrap());
        }
        "bench" => {
            let t = Instant::now();
            let e = engine_for(&args);
            let bytes: u64 = e.files().iter().map(|f| f.size).sum();
            println!(
                "files={} bytes={} events={} elapsed_ms={}",
                e.files().len(),
                bytes,
                e.ledger().events.len(),
                t.elapsed().as_millis()
            );
        }
        "gen-logs" => {
            let out = PathBuf::from(arg(&args, "--out").expect("--out DIR"));
            let mb: u64 = arg(&args, "--mb").and_then(|s| s.parse().ok()).unwrap_or(100);
            let seed: u64 = arg(&args, "--seed").and_then(|s| s.parse().ok()).unwrap_or(1);
            let written = gen_logs(&out, mb * 1024 * 1024, seed);
            println!("wrote {written} bytes to {}", out.display());
        }
        "gen-mock" => {
            let out = PathBuf::from(arg(&args, "--out").expect("--out DIR"));
            let tz_name = arg(&args, "--tz").unwrap_or_else(|| "America/Los_Angeles".into());
            let tz = jiff::tz::TimeZone::get(&tz_name).expect("valid --tz");
            let today: jiff::civil::Date =
                arg(&args, "--today").map(|s| s.parse().expect("YYYY-MM-DD")).unwrap_or_else(|| "2026-09-26".parse().unwrap());
            let work = std::env::temp_dir().join("tokenstreak-mock-work");
            std::fs::create_dir_all(&out).unwrap();
            let presets = tokenstreak_core::mock::generate_all(today, &tz, &work).expect("generate presets");
            let mut index = Vec::new();
            for p in &presets {
                let path = out.join(format!("{}.json", p.id));
                std::fs::write(&path, serde_json::to_string(p).unwrap()).unwrap();
                index.push(serde_json::json!({"id": p.id, "title": p.title, "description": p.description}));
                println!("{} -> {}", p.id, path.display());
            }
            std::fs::write(out.join("index.json"), serde_json::to_string_pretty(&index).unwrap()).unwrap();
            let _ = std::fs::remove_dir_all(&work);
        }
        "prices" => {
            let file = args.get(2).expect("prices import FILE");
            let json = std::fs::read_to_string(file).expect("read price file");
            let date = arg(&args, "--date").unwrap_or_else(|| {
                tokenstreak_core::time::format_rfc3339_ms(Clock::utc().now_ms())[..10].to_string()
            });
            let t = tokenstreak_core::pricing::PriceTable::from_litellm(&json, &date).expect("parse");
            println!("{}", t.to_compact_json());
        }
        _ => {
            eprintln!("usage: tokenstreak-cli <daily|compare|snapshot|bench|gen-logs|gen-mock|prices import FILE> [--tz ZONE] [--tool T]");
        }
    }
}

fn gen_logs(out: &std::path::Path, target_bytes: u64, seed: u64) -> u64 {
    use tokenstreak_core::synth::{self, Rng, Scenario};
    let today: jiff::civil::Date = "2026-09-26".parse().unwrap();
    // Large content per request, like real transcripts with tool output.
    let mut total = 0u64;
    let mut round = 0u64;
    while total < target_bytes {
        let s = Scenario {
            seed: seed + round,
            today,
            tz: jiff::tz::TimeZone::UTC,
            days: 365,
            daily_goal: 10_000_000,
            target: |r, _, g| (g as f64 * (0.5 + r.f64())) as u64,
            tools: [0.5, 0.35, 0.15],
            projects: vec!["alpha", "beta", "gamma", "delta", "epsilon", "zeta"],
            now_hour: 23,
            content_bytes: (2_000, 12_000),
        };
        let reqs = synth::requests(&s);
        let mut rng = Rng::new(seed + round);
        let dir = out.join(format!("batch-{round:03}"));
        synth::write_logs(&dir, &reqs, &mut rng).expect("write logs");
        total = dir_size(out);
        round += 1;
    }
    total
}

fn dir_size(p: &std::path::Path) -> u64 {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            if path.is_dir() {
                n += dir_size(&path);
            } else if let Ok(m) = e.metadata() {
                n += m.len();
            }
        }
    }
    n
}

/// Runs `npx ccusage@latest <tool> daily --json --offline` with the same
/// environment and prints per-day numeric differences (no log content).
fn compare(args: &[String]) {
    let tz = arg(args, "--tz").unwrap_or_else(|| Clock::system().name());
    let tools = match tool_arg(args) {
        Some(t) => vec![t],
        None => vec![Tool::Claude, Tool::Codex, Tool::Gemini],
    };
    for tool in tools {
        let mut a = vec!["daily".to_string(), "--tool".into(), tool.as_str().into(), "--tz".into(), tz.clone()];
        if let Some(r) = arg(args, "--root") {
            a.push("--root".into());
            a.push(r);
        }
        let e = engine_for(&a);
        let ours = daily_json(&e);
        let online = args.iter().any(|x| x == "--online");
        let mut cmd = std::process::Command::new("npx");
        cmd.args(["-y", "ccusage@latest", tool.as_str(), "daily", "--json", "--timezone", &tz]);
        if !online {
            cmd.arg("--offline");
        }
        let out = match cmd.output() {
            Ok(o) => o,
            Err(err) => {
                eprintln!("could not run npx ccusage: {err}");
                return;
            }
        };
        let theirs: serde_json::Value = serde_json::from_slice(&out.stdout).unwrap_or(serde_json::json!({"daily": []}));
        let map = |v: &serde_json::Value, cost_key: &str| -> BTreeMap<String, (u64, f64)> {
            v["daily"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|d| {
                    (
                        d["date"].as_str().unwrap_or("").to_string(),
                        (d["totalTokens"].as_u64().unwrap_or(0), d[cost_key].as_f64().or(d["costUSD"].as_f64()).unwrap_or(0.0)),
                    )
                })
                .collect()
        };
        let o = map(&ours, "totalCost");
        let t = map(&theirs, "totalCost");
        let mut days: Vec<&String> = o.keys().chain(t.keys()).collect();
        days.sort();
        days.dedup();
        let (mut tok_eq, mut cost_ok, mut n) = (0, 0, 0);
        let (mut sum_o, mut sum_t, mut cost_o, mut cost_t) = (0u64, 0u64, 0.0, 0.0);
        for d in days {
            n += 1;
            let (a, ac) = o.get(d).copied().unwrap_or_default();
            let (b, bc) = t.get(d).copied().unwrap_or_default();
            sum_o += a;
            sum_t += b;
            cost_o += ac;
            cost_t += bc;
            if a == b {
                tok_eq += 1;
            } else {
                println!("  {} {d}: tokens ours={a} ccusage={b} diff={}", tool.as_str(), a as i64 - b as i64);
            }
            let ok = (ac - bc).abs() <= 0.01 * bc.abs().max(1e-9) || (ac - bc).abs() < 1e-6;
            if ok {
                cost_ok += 1;
            }
        }
        println!(
            "{}: days={n} token-exact={tok_eq} cost-within-1%={cost_ok} total ours={sum_o} ccusage={sum_t} cost ours={cost_o:.2} ccusage={cost_t:.2}",
            tool.as_str()
        );
    }
}
