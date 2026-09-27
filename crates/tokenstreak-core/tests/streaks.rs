//! Goal, streak and achievement behaviour, end to end through the engine.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use common::*;
use jiff::civil::Date;
use tokenstreak_core::api::*;
use tokenstreak_core::engine::Engine;
use tokenstreak_core::goals::{self, Goal, GoalHistory};
use tokenstreak_core::time::parse_ts;

/// Writes a Claude transcript with one request per (timestamp, tokens).
fn claude_logs(root: &Path, entries: &[(&str, u64)]) {
    let dir = root.join("projects/-Users-demo-code-app");
    std::fs::create_dir_all(&dir).unwrap();
    let mut s = String::new();
    for (i, (ts, tokens)) in entries.iter().enumerate() {
        s.push_str(&serde_json::json!({
            "type": "assistant", "sessionId": "s1", "version": "2.0.14", "cwd": "/Users/demo/code/app",
            "timestamp": ts, "requestId": format!("r{i}"),
            "message": {"id": format!("m{i}"), "model": "claude-sonnet-4-5-20250929",
                        "usage": {"input_tokens": tokens, "output_tokens": 0}}
        }).to_string());
        s.push('\n');
    }
    std::fs::write(dir.join("s1.jsonl"), s).unwrap();
}

fn engine_at(root: &Path, tz: &str, now: &str) -> (tempfile::TempDir, Engine) {
    let data = tempfile::tempdir().unwrap();
    let mut e = Engine::open_with(data.path(), sources(Some(root.into()), None, None));
    e.set_now(Some(parse_ts(now).unwrap()));
    e.update_settings(&serde_json::json!({"timezone": tz})).unwrap();
    e.refresh();
    (data, e)
}

#[test]
fn day_boundaries_follow_the_local_time_zone() {
    let logs = tempfile::tempdir().unwrap();
    // 03:30Z on the 26th is still the 25th in New York, already the 26th in Tokyo.
    claude_logs(logs.path(), &[("2026-09-25T12:00:00.000Z", 100), ("2026-09-26T03:30:00.000Z", 100)]);
    let (_d1, mut ny) = engine_at(logs.path(), "America/New_York", "2026-09-26T15:00:00.000Z");
    ny.complete_onboarding(&GoalsInput { daily: 150, weekly: 1000 }).unwrap();
    let s = ny.snapshot();
    assert_eq!(s.days.iter().map(|d| (d.date.as_str(), d.total)).collect::<Vec<_>>(), vec![("2026-09-25", 200), ("2026-09-26", 0)]);
    assert_eq!(s.streak.current, 1, "the 25th met the goal; today is in progress");
    assert!(s.streak.at_risk);

    let (_d2, mut tokyo) = engine_at(logs.path(), "Asia/Tokyo", "2026-09-26T15:00:00.000Z");
    tokyo.complete_onboarding(&GoalsInput { daily: 150, weekly: 1000 }).unwrap();
    let s = tokyo.snapshot();
    assert_eq!(s.today.date, "2026-09-27");
    assert_eq!(s.days.iter().map(|d| d.total).collect::<Vec<_>>(), vec![100, 100, 0]);
    assert_eq!(s.streak.current, 0, "neither day reached 150 in Tokyo");
}

#[test]
fn missed_days_first_day_and_goal_changes() {
    let logs = tempfile::tempdir().unwrap();
    claude_logs(
        logs.path(),
        &[
            ("2026-09-20T12:00:00.000Z", 500), // first day
            ("2026-09-21T12:00:00.000Z", 500),
            // 22nd missed
            ("2026-09-23T12:00:00.000Z", 500),
            ("2026-09-24T12:00:00.000Z", 500),
            ("2026-09-25T12:00:00.000Z", 500),
            ("2026-09-26T12:00:00.000Z", 300),
        ],
    );
    let (_d, mut e) = engine_at(logs.path(), "UTC", "2026-09-26T18:00:00.000Z");
    e.complete_onboarding(&GoalsInput { daily: 400, weekly: 1500 }).unwrap();
    let s = e.snapshot();
    assert_eq!(s.days[0].streak, 1, "first day starts a streak");
    assert_eq!(s.streak.longest, 3);
    assert_eq!(s.streak.current, 3);
    assert!(!s.streak.today_met && s.streak.at_risk);
    assert_eq!(s.streak.current_start.as_deref(), Some("2026-09-23"));

    // Adjusting the goal on the same day replaces that day's version; being the
    // first goal it still applies to the history found at first run.
    e.set_goals(&GoalsInput { daily: 250, weekly: 1500 }).unwrap();
    let s = e.snapshot();
    assert!(s.streak.today_met);
    assert_eq!(s.streak.current, 4);
    assert_eq!(s.goals.history.len(), 1, "same-day changes replace each other");
    assert_eq!(s.days.iter().find(|d| d.date == "2026-09-25").unwrap().goal, 250);
    let c = s.celebration.expect("goal reached today is celebrated");
    assert_eq!((c.tokens, c.goal, c.streak, c.new_record), (300, 250, 4, true));
    e.acknowledge_celebration(&c.date);
    assert!(e.snapshot().celebration.is_none());

    // Raising it the next day does not rewrite the 26th.
    e.set_now(Some(parse_ts("2026-09-27T09:00:00.000Z").unwrap()));
    e.set_goals(&GoalsInput { daily: 10_000, weekly: 50_000 }).unwrap();
    let s = e.snapshot();
    assert_eq!(s.streak.current, 4, "yesterday stays met; today in progress");
    assert_eq!(s.goals.history.len(), 2);
    assert_eq!(s.days.last().unwrap().goal, 10_000);
    assert_eq!(s.days.iter().find(|d| d.date == "2026-09-26").unwrap().goal, 250, "past days keep their goal");
    assert!(s.days.iter().find(|d| d.date == "2026-09-26").unwrap().met);
}

#[test]
fn weekly_goal_and_suggestions() {
    let mut totals: BTreeMap<Date, u64> = BTreeMap::new();
    for (d, t) in [("2026-09-14", 400), ("2026-09-15", 400), ("2026-09-21", 100), ("2026-09-22", 900)] {
        totals.insert(d.parse().unwrap(), t);
    }
    let h = GoalHistory(vec![Goal { from: "2026-09-01".parse().unwrap(), daily: 300, weekly: 800 }]);
    let r = goals::evaluate(&totals, &h, "2026-09-23".parse().unwrap(), &[], WeekStart::Monday);
    assert_eq!(r.weeks.len(), 2);
    assert!(r.weeks[0].3 && r.weeks[1].3);
    assert_eq!(r.weekly_current, 2);
    let (d, w) = goals::suggest(&totals, "2026-09-23".parse().unwrap());
    assert!(d >= 10_000 && w == goals::friendly_round(d * 6));
}

#[test]
fn achievements_are_deterministic_with_unlock_dates() {
    let run = || {
        let (_d, mut e) = {
            let logs = tempfile::tempdir().unwrap();
            let entries: Vec<(String, u64)> = (1..=9)
                .map(|d| (format!("2026-09-{:02}T02:30:00.000Z", d + 10), 1_200_000u64))
                .collect();
            let refs: Vec<(&str, u64)> = entries.iter().map(|(a, b)| (a.as_str(), *b)).collect();
            claude_logs(logs.path(), &refs);
            let r = engine_at(logs.path(), "UTC", "2026-09-19T12:00:00.000Z");
            std::mem::forget(logs);
            r
        };
        e.complete_onboarding(&GoalsInput { daily: 1_000_000, weekly: 5_000_000 }).unwrap();
        e.snapshot().achievements
    };
    let a = run();
    let b = run();
    assert!(a.len() >= 12, "at least 12 achievements are defined");
    let unlocked: BTreeMap<String, Option<String>> = a.iter().map(|x| (x.id.clone(), x.unlocked_at.clone())).collect();
    assert_eq!(unlocked, b.iter().map(|x| (x.id.clone(), x.unlocked_at.clone())).collect());
    assert_eq!(unlocked["first-light"].as_deref(), Some("2026-09-11"));
    assert_eq!(unlocked["seven-sparks"].as_deref(), Some("2026-09-17"));
    assert_eq!(unlocked["full-moon"], None);
    assert_eq!(unlocked["megawatt"], None, "1.2M a day is not a 10M day");
    assert_eq!(unlocked["constellation"], None);
    assert_eq!(unlocked["rekindled"], None);
    assert_eq!(unlocked["safety-net"], None);
    assert_eq!(unlocked["high-tide"].as_deref(), Some("2026-09-18"), "week of Mon 14th crosses 5M on its 5th day");
    assert!(a.iter().all(|x| !x.id.contains("owl")), "nothing rewards working at 2 am");
    let volume = a.iter().filter(|x| x.category == tokenstreak_core::api::AchievementCategory::Scale).count();
    assert!(volume <= 3, "at most three volume badges");
    let ids: BTreeSet<&str> = a.iter().map(|x| x.id.as_str()).collect();
    assert_eq!(ids.len(), a.len(), "ids are unique");
}
