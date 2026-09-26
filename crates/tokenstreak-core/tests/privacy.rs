//! Privacy sentinel test: prompt, response, thinking and tool text in the
//! fixtures carry sentinel strings. None may appear in app state, the
//! persisted cache, settings, exports (share cards, CSV, breakdowns), mock
//! presets, debug dumps of in-memory records, or logs.

mod common;

use std::io::Write;
use std::sync::{Arc, Mutex};

use common::*;
use tokenstreak_core::api::*;
use tokenstreak_core::engine::Engine;

#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[test]
fn sentinels_never_leak() {
    // Sanity: the fixtures really contain the sentinels.
    let raw = std::fs::read(tool_root(tokenstreak_core::Tool::Claude).join("projects/-Users-demo-code-alpha/11111111-aaaa-4aaa-8aaa-000000000001.jsonl")).unwrap();
    assert!(memchr::memmem::find(&raw, SENTINELS[0].as_bytes()).is_some());

    // Capture every log line the engine emits, at the most verbose level.
    let cap = Capture::default();
    let writer = cap.clone();
    let subscriber = tracing_subscriber::fmt()
        .with_max_level(tracing::Level::TRACE)
        .with_writer(move || writer.clone())
        .finish();
    let _guard = tracing::subscriber::set_default(subscriber);

    let data = tempfile::tempdir().unwrap();
    let mut e = Engine::open_with(data.path(), fixture_sources());
    e.set_now(Some(tokenstreak_core::time::parse_ts("2026-09-26T20:00:00Z").unwrap()));
    e.refresh();
    e.complete_onboarding(&GoalsInput { daily: 50_000, weekly: 200_000 }).unwrap();
    e.update_settings(&serde_json::json!({"share": {"showProjectNames": true, "showCost": true}})).unwrap();

    let mut outputs: Vec<(String, Vec<u8>)> = Vec::new();
    outputs.push(("snapshot".into(), serde_json::to_vec(&e.snapshot()).unwrap()));
    for kind in [RangeKind::Today, RangeKind::Last7, RangeKind::Last30, RangeKind::All] {
        let q = RangeQuery { kind, from: None, to: None };
        outputs.push((format!("breakdown {kind:?}"), serde_json::to_vec(&e.breakdown(&q)).unwrap()));
        outputs.push((format!("csv {kind:?}"), e.csv(&q).into_bytes()));
        for format in [ShareFormat::Square, ShareFormat::Story] {
            let card = e.share_card(&ShareOptions { range: q.clone(), format, include_project_names: Some(true) });
            outputs.push((format!("share card {kind:?}"), serde_json::to_vec(&card).unwrap()));
        }
    }
    outputs.push(("in-memory file records".into(), format!("{:?}", e.files()).into_bytes()));
    outputs.push(("in-memory ledger".into(), format!("{:?}", e.ledger()).into_bytes()));
    e.persist();
    drop(e);
    for entry in walk(data.path()) {
        outputs.push((format!("persisted {}", entry.display()), std::fs::read(&entry).unwrap()));
    }
    // Relaunch from cache and check again.
    let e2 = Engine::open_with(data.path(), fixture_sources());
    outputs.push(("snapshot after relaunch".into(), serde_json::to_vec(&e2.snapshot()).unwrap()));
    outputs.push(("logs".into(), cap.0.lock().unwrap().clone()));

    assert!(outputs.iter().any(|(l, _)| l.contains("usage-cache.bin")), "cache file was written");
    for (label, bytes) in &outputs {
        assert_clean(label, bytes);
    }
    // And the data itself is there (the test would be vacuous otherwise).
    let snap = e2.snapshot();
    assert!(snap.lifetime.tokens.total > 0);
    println!("privacy: {} outputs checked, {} bytes", outputs.len(), outputs.iter().map(|o| o.1.len()).sum::<usize>());
}

#[test]
fn mock_presets_are_clean() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/api/mock/presets");
    if !dir.exists() {
        return;
    }
    for p in walk(&dir) {
        assert_clean(&p.display().to_string(), &std::fs::read(&p).unwrap());
    }
}

fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
    let mut v = Vec::new();
    if let Ok(rd) = std::fs::read_dir(dir) {
        for e in rd.flatten() {
            let p = e.path();
            if p.is_dir() {
                v.extend(walk(&p));
            } else {
                v.push(p);
            }
        }
    }
    v
}
