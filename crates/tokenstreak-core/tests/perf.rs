//! Performance: 1 GB of synthetic logs must parse in under 10 s (release).
//!
//! `cargo test --release -p tokenstreak-core --test perf -- --ignored --nocapture`
//! Logs are generated once into `target/perf-logs` (override with
//! `TOKENSTREAK_PERF_DIR`) and reused.

mod common;

use std::path::PathBuf;
use std::time::Instant;

use common::*;
use tokenstreak_core::synth::{self, Rng, Scenario};

const TARGET: u64 = 1024 * 1024 * 1024;

fn dir_size(p: &std::path::Path) -> u64 {
    let mut n = 0;
    if let Ok(rd) = std::fs::read_dir(p) {
        for e in rd.flatten() {
            let path = e.path();
            n += if path.is_dir() { dir_size(&path) } else { e.metadata().map(|m| m.len()).unwrap_or(0) };
        }
    }
    n
}

fn ensure_logs() -> PathBuf {
    let dir = std::env::var_os("TOKENSTREAK_PERF_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/perf-logs"));
    let mut round = 0u64;
    while dir_size(&dir) < TARGET {
        let s = Scenario {
            seed: 1000 + round,
            today: "2026-09-26".parse().unwrap(),
            tz: jiff::tz::TimeZone::UTC,
            days: 365,
            daily_goal: 8_000_000,
            target: |r, _, g| (g as f64 * (0.4 + r.f64())) as u64,
            tools: [0.5, 0.35, 0.15],
            projects: vec!["alpha", "beta", "gamma", "delta", "epsilon"],
            now_hour: 23,
            content_bytes: (3_000, 14_000),
        };
        let reqs = synth::requests(&s);
        synth::write_logs(&dir.join(format!("batch-{round:03}")), &reqs, &mut Rng::new(round)).unwrap();
        round += 1;
    }
    dir
}

#[test]
#[ignore = "generates 1 GB; run explicitly in release mode"]
fn one_gigabyte_under_ten_seconds() {
    let dir = ensure_logs();
    let size = dir_size(&dir);
    let batches: Vec<PathBuf> = std::fs::read_dir(&dir).unwrap().flatten().map(|e| e.path()).collect();
    let mut src = sources(None, None, None);
    src.enabled = [true; 3];
    src.claude_dirs = Some(batches.iter().map(|b| b.join("claude")).collect());
    src.codex_homes = Some(batches.iter().map(|b| b.join("codex")).collect());
    src.gemini_dirs = Some(batches.iter().map(|b| b.join("gemini/tmp")).collect());
    let t = Instant::now();
    let e = engine(src, "UTC");
    let elapsed = t.elapsed();
    let events = e.ledger().events.len();
    let snap_t = Instant::now();
    let snap = e.snapshot();
    println!(
        "perf: {:.2} GB, {} files, {} events parsed in {:.2} s ({:.0} MB/s); snapshot in {} ms; {} days",
        size as f64 / 1e9,
        e.files().len(),
        events,
        elapsed.as_secs_f64(),
        size as f64 / 1e6 / elapsed.as_secs_f64(),
        snap_t.elapsed().as_millis(),
        snap.days.len()
    );
    assert!(size >= TARGET);
    assert!(events > 100_000);
    assert!(elapsed.as_secs_f64() < 10.0, "parse took {:?}", elapsed);
}
