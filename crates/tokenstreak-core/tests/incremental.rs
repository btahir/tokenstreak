//! Incremental parsing, the persistent cache, deleted-log retention and the
//! file watcher.

mod common;

use std::io::Write;
use std::time::{Duration, Instant};

use common::*;
use tokenstreak_core::engine::Engine;
use tokenstreak_core::time::parse_ts;

fn totals(e: &Engine) -> (usize, u64, f64) {
    let evs = &e.ledger().events;
    (evs.len(), evs.iter().map(|x| x.total()).sum(), evs.iter().map(|x| x.cost).sum())
}

fn fresh_totals(src: tokenstreak_core::readers::SourceConfig) -> (usize, u64, f64) {
    totals(&engine(src, "UTC"))
}

#[test]
fn appends_parse_only_new_bytes_and_match_a_full_parse() {
    let logs = tempfile::tempdir().unwrap();
    copy_dir(&fixtures(), logs.path());
    let src = sources(
        Some(logs.path().join("claude/basic")),
        Some(logs.path().join("codex/basic")),
        Some(logs.path().join("gemini/basic")),
    );
    let data = tempfile::tempdir().unwrap();
    let mut e = Engine::open_with(data.path(), src.clone());
    let r1 = e.refresh();
    assert!(r1.reparsed > 0);
    let base = totals(&e);
    assert_eq!(base, fresh_totals(src.clone()));

    // Unchanged files are not read again.
    let r2 = e.refresh();
    assert_eq!((r2.appended, r2.reparsed, r2.bytes_read), (0, 0, 0));

    // Append a Claude entry and a Codex token_count.
    let claude = logs.path().join("claude/basic/projects/-Users-demo-code-beta/22222222-bbbb-4bbb-8bbb-000000000003.jsonl");
    let mut f = std::fs::OpenOptions::new().append(true).open(&claude).unwrap();
    writeln!(f, r#"{{"type":"assistant","sessionId":"22222222-bbbb-4bbb-8bbb-000000000003","version":"2.0.14","timestamp":"2026-09-26T19:00:00.000Z","requestId":"req_new","message":{{"id":"msg_new","model":"claude-haiku-4-5-20251001","usage":{{"input_tokens":1000,"output_tokens":2000}}}}}}"#).unwrap();
    drop(f);
    let codex = logs.path().join("codex/basic/sessions/2026/09/25/rollout-2026-09-25T20-00-00-0199a000-0000-7000-8000-00000000p001.jsonl");
    let mut f = std::fs::OpenOptions::new().append(true).open(&codex).unwrap();
    writeln!(f, r#"{{"timestamp":"2026-09-26T19:30:00.000Z","type":"event_msg","payload":{{"type":"token_count","info":{{"total_token_usage":{{"input_tokens":70000,"cached_input_tokens":50000,"output_tokens":4500,"reasoning_output_tokens":1600,"total_tokens":74500}}}}}}}}"#).unwrap();
    drop(f);
    let r3 = e.refresh();
    assert_eq!(r3.appended, 2, "{r3:?}");
    assert_eq!(r3.reparsed, 0);
    let after = totals(&e);
    assert_eq!(after.1, base.1 + 3000 + (70000 - 60000) + (4500 - 4000), "claude 3000 + codex cumulative delta");
    assert_eq!(after, fresh_totals(src.clone()), "incremental == full parse");

    // Relaunch from the cache: same numbers with no parsing.
    drop(e);
    let mut e2 = Engine::open_with(data.path(), src.clone());
    assert_eq!(totals(&e2), after, "cache restores the ledger before any scan");
    let r4 = e2.refresh();
    assert_eq!((r4.appended, r4.reparsed), (0, 0));

    // Truncating a file forces a reparse of that file only.
    std::fs::write(&claude, "").unwrap();
    let r5 = e2.refresh();
    assert_eq!(r5.reparsed, 1);
    assert_eq!(totals(&e2), fresh_totals(src.clone()));
}

#[test]
fn partial_trailing_line_is_provisional() {
    let logs = tempfile::tempdir().unwrap();
    let dir = logs.path().join("projects/-p");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("s.jsonl");
    let line = r#"{"type":"assistant","sessionId":"s","timestamp":"2026-09-26T10:00:00.000Z","requestId":"r1","message":{"id":"m1","model":"claude-sonnet-4-5-20250929","usage":{"input_tokens":10,"output_tokens":5}}}"#;
    // Half a line (a write in progress).
    std::fs::write(&file, &line[..60]).unwrap();
    let data = tempfile::tempdir().unwrap();
    let mut e = Engine::open_with(data.path(), sources(Some(logs.path().into()), None, None));
    e.refresh();
    assert_eq!(totals(&e).0, 0);
    // The writer finishes the line (still no newline): counted, provisionally.
    std::fs::write(&file, line).unwrap();
    e.refresh();
    assert_eq!(totals(&e).1, 15);
    // Newline arrives with another line: nothing double counted.
    std::fs::write(&file, format!("{line}\n{}\n", line.replace("r1", "r2").replace("m1", "m2"))).unwrap();
    e.refresh();
    assert_eq!(totals(&e).1, 30);
}

#[test]
fn deleted_logs_keep_their_history() {
    let logs = tempfile::tempdir().unwrap();
    copy_dir(&fixtures().join("claude/basic"), logs.path());
    let data = tempfile::tempdir().unwrap();
    let src = sources(Some(logs.path().into()), None, None);
    let mut e = Engine::open_with(data.path(), src.clone());
    e.refresh();
    let before = totals(&e);
    std::fs::remove_dir_all(logs.path().join("projects/-Users-demo-code-beta")).unwrap();
    e.refresh();
    assert_eq!(totals(&e), before, "Claude Code's 30-day cleanup must not erase history");
    e.update_settings(&serde_json::json!({"keepDeletedHistory": false})).unwrap();
    e.refresh();
    assert!(totals(&e).1 < before.1);
}

#[test]
fn watcher_signals_appends_quickly() {
    let logs = tempfile::tempdir().unwrap();
    let dir = logs.path().join("projects/-p");
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join("s.jsonl");
    std::fs::write(&file, "").unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let _w = tokenstreak_core::watch::watch(&[logs.path().to_path_buf()], Duration::from_millis(500), tx).unwrap();
    std::thread::sleep(Duration::from_millis(300));
    let data = tempfile::tempdir().unwrap();
    let mut e = Engine::open_with(data.path(), sources(Some(logs.path().into()), None, None));
    e.set_now(Some(parse_ts("2026-09-26T12:00:00Z").unwrap()));
    e.refresh();
    let t0 = Instant::now();
    let mut f = std::fs::OpenOptions::new().append(true).open(&file).unwrap();
    writeln!(f, r#"{{"type":"assistant","sessionId":"s","timestamp":"2026-09-26T10:00:00.000Z","requestId":"r1","message":{{"id":"m1","model":"claude-sonnet-4-5-20250929","usage":{{"input_tokens":10,"output_tokens":5}}}}}}"#).unwrap();
    drop(f);
    rx.recv_timeout(Duration::from_secs(30)).expect("watcher fired");
    e.refresh();
    let elapsed = t0.elapsed();
    assert_eq!(e.snapshot().today.tokens.total, 15);
    println!("live refresh latency: {} ms", elapsed.as_millis());
    assert!(elapsed < Duration::from_secs(60));
}
