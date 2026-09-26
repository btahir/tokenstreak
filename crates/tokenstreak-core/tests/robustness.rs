//! Robustness: progressive first scans, folders that appear later, time-zone
//! changes mid-run, Gemini layouts from current gemini-cli, and notification
//! markers around onboarding.

mod common;

use std::collections::BTreeMap;

use common::*;
use tokenstreak_core::api::{GoalsInput, RangeKind, RangeQuery};
use tokenstreak_core::engine::{parse_records, Engine};
use tokenstreak_core::synth::{self, Rng, Scenario};
use tokenstreak_core::time::Clock;

fn daily(e: &Engine) -> BTreeMap<String, (u64, u64)> {
    let mut m = BTreeMap::new();
    for ev in &e.ledger().events {
        let d = m.entry(ev.date.to_string()).or_insert((0u64, 0u64));
        d.0 += ev.total();
        d.1 += (ev.cost * 1e6) as u64;
    }
    m
}

fn synthetic_logs(dir: &std::path::Path) -> tokenstreak_core::readers::SourceConfig {
    let s = Scenario {
        seed: 7,
        today: "2026-09-26".parse().unwrap(),
        tz: jiff::tz::TimeZone::get("America/Los_Angeles").unwrap(),
        days: 40,
        daily_goal: 1_000_000,
        target: |r, _, g| if r.chance(0.2) { 0 } else { (g as f64 * (0.2 + r.f64() * 1.6)) as u64 },
        tools: [0.5, 0.3, 0.2],
        projects: vec!["one", "two", "three"],
        now_hour: 22,
        content_bytes: (50, 400),
    };
    let reqs = synth::requests(&s);
    let roots = synth::write_logs(dir, &reqs, &mut Rng::new(3)).unwrap();
    sources(Some(roots[0].clone()), Some(roots[1].clone()), Some(roots[2].clone()))
}

#[test]
fn progressive_first_scan_streams_partials_and_ends_exact() {
    let logs = tempfile::tempdir().unwrap();
    let src = synthetic_logs(logs.path());
    // Reference: one regular scan.
    let reference = engine(src.clone(), "America/Los_Angeles");

    let mut e = Engine::ephemeral(src.clone(), Clock::named(Some("America/Los_Angeles")));
    assert!(e.wants_progressive_scan());
    let mut plan = e.begin_progressive_scan();
    plan.set_initial_budget(1);
    let total_files = plan.files_total;
    assert!(total_files > 3);
    let mut partials = Vec::new();
    let mut newest_first = None;
    while let Some(mut batch) = plan.next_batch() {
        let r = parse_records(&mut batch);
        e.absorb_batch(&mut plan, batch, r);
        // A regular scan requested meanwhile (e.g. a settings change) must not
        // disturb the plan.
        assert_eq!(e.scan().files, 0);
        if newest_first.is_none() {
            newest_first = e.ledger().events.iter().map(|ev| ev.date).max();
        }
        let snap = e.snapshot();
        assert!(snap.status.initial_scan, "partial snapshots are marked as initial");
        partials.push((plan.files_done, e.ledger().events.len()));
    }
    let report = e.finish_progressive_scan(plan);
    assert_eq!(report.files, total_files as usize);
    assert!(partials.len() >= 3, "{partials:?}");
    assert!(partials.windows(2).all(|w| w[0].0 < w[1].0));
    // The first batch holds the most recently modified files.
    assert!(newest_first.is_some());
    assert!(!e.snapshot().status.initial_scan);
    assert_eq!(daily(&e), daily(&reference), "progressive result equals a regular scan");
    // Afterwards, scans are incremental again.
    assert!(!e.wants_progressive_scan());
    assert!(!e.scan().changed());
}

#[test]
fn refresh_progressive_reports_batches() {
    let logs = tempfile::tempdir().unwrap();
    let src = synthetic_logs(logs.path());
    let mut e = Engine::ephemeral(src, Clock::named(Some("UTC")));
    let mut seen = 0;
    e.refresh_progressive(|_, _| seen += 1);
    // A small history fits in the first 32 MB batch: no partials needed.
    assert_eq!(seen, 0);
    assert!(!e.ledger().events.is_empty());
}

#[test]
fn log_folders_that_appear_later_are_found() {
    let base = tempfile::tempdir().unwrap();
    let gem = base.path().join("gemini-tmp");
    let mut e = Engine::ephemeral(sources(None, None, Some(gem.clone())), Clock::named(Some("UTC")));
    e.scan();
    assert!(e.watch_roots().is_empty());
    assert_eq!(e.files().len(), 0);
    // The tool is installed and writes its first chat.
    copy_dir(&fixtures().join("gemini/basic"), &gem);
    let r = e.scan();
    e.rebuild();
    assert!(r.files >= 2);
    assert_eq!(e.watch_roots(), vec![gem]);
    assert!(!e.ledger().events.is_empty());
}

#[test]
fn follows_system_time_zone_changes() {
    let mut e = engine(fixture_sources(), "UTC");
    // Not following the system zone (tests, pinned zones): nothing happens.
    assert!(!e.check_system_timezone());
    // An app engine built in another zone notices the system zone differs.
    let odd = if Clock::system().name() == "Pacific/Kiritimati" { "Pacific/Pago_Pago" } else { "Pacific/Kiritimati" };
    e.set_clock_for_test(Clock::named(Some(odd)), true);
    let before = daily(&e);
    assert!(e.check_system_timezone());
    assert_eq!(e.clock().name(), Clock::system().name());
    assert!(!e.check_system_timezone(), "only once");
    let after = daily(&e);
    let sum = |m: &BTreeMap<String, (u64, u64)>| m.values().map(|v| v.0).sum::<u64>();
    assert_eq!(sum(&before), sum(&after), "re-bucketing keeps every token");
    // A pinned zone in settings wins over the system zone.
    e.set_clock_for_test(Clock::named(Some(odd)), true);
    e.update_settings(&serde_json::json!({ "timezone": odd })).unwrap();
    assert!(!e.check_system_timezone());
}

#[test]
fn gemini_projects_and_subagents_follow_gemini_cli_layout() {
    let e = engine(sources(None, None, Some(tool_root(tokenstreak_core::Tool::Gemini))), "UTC");
    let b = e.breakdown(&RangeQuery { kind: RangeKind::All, from: None, to: None });
    let labels: Vec<&str> = b.by_project.iter().map(|p| p.label.as_str()).collect();
    assert!(labels.contains(&"alpha"), "{labels:?}");
    assert!(labels.contains(&"Gemini project 9c1d9c1d"), "{labels:?}");
    assert!(!labels.iter().any(|l| l.len() == 64));
    // Main session (m2, m3, m4) + subagent (s2) + legacy (l2); logs.json and
    // checkpoints are ignored.
    let total: u64 = e.ledger().events.iter().map(|ev| ev.total()).sum();
    assert_eq!(total, 16373 + 2350 + 5100 + 4700 + 9200);
    assert_eq!(b.sessions, 3);
}

#[test]
fn onboarding_on_a_met_day_does_not_notify_goal_reached() {
    let dir = tempfile::tempdir().unwrap();
    let mut e = Engine::open_with(dir.path(), fixture_sources());
    e.refresh();
    let total = e.snapshot().today.tokens.total;
    if total == 0 {
        // Fixture dates are in the past relative to the wall clock: pin "now".
        let ms = tokenstreak_core::time::parse_ts("2026-09-26T12:00:00Z").unwrap();
        e.set_now(Some(ms));
    }
    e.complete_onboarding(&GoalsInput { daily: 1, weekly: 5 }).unwrap();
    let snap = e.snapshot();
    assert!(snap.today.met);
    assert!(e.take_goal_notice(&snap).is_none(), "the reveal already covers today");
    // A later day that crosses the goal notifies exactly once.
    let mut next = snap.clone();
    next.today.date = "2099-01-01".into();
    assert!(e.take_goal_notice(&next).is_some());
    assert!(e.take_goal_notice(&next).is_none());
    // The marker survives a relaunch.
    drop(e);
    let e2 = Engine::open_with(dir.path(), fixture_sources());
    assert_eq!(e2.state().goal_notified_on.as_deref(), Some("2099-01-01"));
}
