//! Browser mock presets: rich synthetic scenarios run through the real
//! engine (native-format logs → readers → ledger → views), serialised for the
//! frontend's mock backend. `tokenstreak-cli gen-mock` writes them to
//! `src/api/mock/presets/`.

use std::collections::BTreeMap;
use std::path::Path;

use jiff::civil::Date;
use jiff::tz::TimeZone;
use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::api::*;
use crate::engine::Engine;
use crate::readers::SourceConfig;
use crate::synth::{self, Rng, Scenario};

/// One mock preset as served to the browser.
#[derive(Clone, Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct MockPreset {
    pub id: String,
    pub title: String,
    pub description: String,
    /// The frozen "now" of this preset (RFC 3339).
    pub now: String,
    pub snapshot: AppSnapshot,
    pub settings: Settings,
    /// Breakdowns keyed by `RangeKind` (camelCase), all but `custom`.
    pub breakdowns: BTreeMap<String, Breakdown>,
    pub share_cards: BTreeMap<String, ShareCardData>,
}

struct Def {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    days: i64,
    goal: u64,
    tools: [f64; 3],
    now_hour: i64,
    target: fn(&mut Rng, i64, u64) -> u64,
    onboarded: bool,
    /// Fraction of the daily goal today's usage is capped at.
    today_cap: Option<f64>,
    acknowledge: bool,
}

fn busy(rng: &mut Rng, goal: u64, lo: f64, hi: f64) -> u64 {
    (goal as f64 * (lo + rng.f64() * (hi - lo))) as u64
}

const PROJECTS: &[&str] = &["tokenstreak", "atlas-api", "pixel-garden", "infra", "notes-app", "rustybot", "design-system", "billing", "mobile", "ml-pipeline", "docs-site", "cli-tools"];

fn defs() -> Vec<Def> {
    vec![
        Def {
            id: "new-user",
            title: "New user",
            description: "First launch: a few hours of Claude Code today, no goal set yet.",
            days: 0,
            goal: 2_000_000,
            tools: [1.0, 0.0, 0.0],
            now_hour: 15,
            target: |r, _, g| busy(r, g, 0.3, 0.4),
            onboarded: false,
            today_cap: None,
            acknowledge: false,
        },
        Def {
            id: "first-run-reveal",
            title: "First-run reveal",
            description: "Two months of history found on first launch, before a goal is chosen.",
            days: 70,
            goal: 3_000_000,
            tools: [0.7, 0.3, 0.0],
            now_hour: 11,
            target: |r, off, g| if r.chance(0.2) && off > 0 { 0 } else { busy(r, g, 0.4, 1.8) },
            onboarded: false,
            today_cap: None,
            acknowledge: false,
        },
        Def {
            id: "streak-30",
            title: "30-day streak",
            description: "A month-long streak, today's goal already met.",
            days: 120,
            goal: 5_000_000,
            tools: [0.8, 0.2, 0.0],
            now_hour: 17,
            target: |r, off, g| match off {
                0..=29 => busy(r, g, 1.05, 1.9),
                30 => 0,
                _ => if r.chance(0.35) { 0 } else { busy(r, g, 0.3, 1.6) },
            },
            onboarded: true,
            today_cap: None,
            acknowledge: true,
        },
        Def {
            id: "heavy-multi-tool",
            title: "Heavy multi-tool user",
            description: "A year of Claude Code, Codex and Gemini across many projects; long streak.",
            days: 400,
            goal: 20_000_000,
            tools: [0.55, 0.3, 0.15],
            now_hour: 20,
            target: |r, off, g| match off {
                0..=125 => busy(r, g, 1.02, 3.0),
                126 => 0,
                _ => if r.chance(0.12) { 0 } else { busy(r, g, 0.4, 2.5) },
            },
            onboarded: true,
            today_cap: None,
            acknowledge: true,
        },
        Def {
            id: "goal-hit",
            title: "Goal-hit moment",
            description: "Today sits at 96% of the goal on a 12-day streak; the mock crosses it live.",
            days: 60,
            goal: 4_000_000,
            tools: [0.6, 0.3, 0.1],
            now_hour: 16,
            target: |r, off, g| match off {
                0 => busy(r, g, 1.2, 1.3),
                1..=12 => busy(r, g, 1.05, 1.8),
                13 => 0,
                _ => if r.chance(0.3) { 0 } else { busy(r, g, 0.5, 1.5) },
            },
            onboarded: true,
            today_cap: Some(0.96),
            acknowledge: true,
        },
        Def {
            id: "streak-at-risk",
            title: "Streak at risk",
            description: "9 p.m., a 9-day streak and only 30% of today's goal.",
            days: 45,
            goal: 3_000_000,
            tools: [0.5, 0.5, 0.0],
            now_hour: 21,
            target: |r, off, g| match off {
                0 => busy(r, g, 0.3, 0.32),
                1..=9 => busy(r, g, 1.05, 1.6),
                10 => 0,
                _ => if r.chance(0.3) { 0 } else { busy(r, g, 0.4, 1.4) },
            },
            onboarded: true,
            today_cap: None,
            acknowledge: true,
        },
        // Appended (not inserted) so the seeds of the presets above stay stable.
        Def {
            id: "long-history",
            title: "Long history",
            description: "Three and a half years of use: many past runs, holidays and a 64-day streak.",
            days: 1280,
            goal: 10_000_000,
            tools: [0.6, 0.3, 0.1],
            now_hour: 18,
            target: |r, off, g| match off {
                0..=63 => busy(r, g, 1.02, 2.6),
                64 => 0,
                // two long past runs that stay in the sky as afterglow
                180..=221 | 560..=617 => busy(r, g, 1.05, 2.3),
                // a week or two away roughly twice a year
                _ if off % 181 < 8 => 0,
                // the first year was lighter and patchier
                _ if off > 900 => if r.chance(0.4) { 0 } else { busy(r, g, 0.15, 1.3) },
                _ => if r.chance(0.09) { 0 } else { busy(r, g, 0.45, 2.4) },
            },
            onboarded: true,
            today_cap: None,
            acknowledge: true,
        },
        Def {
            id: "sparse",
            title: "Sparse week",
            description: "Five days of history just after onboarding: a 3-day streak and one quiet day.",
            days: 5,
            goal: 2_000_000,
            tools: [0.75, 0.25, 0.0],
            now_hour: 14,
            target: |r, off, g| match off {
                0 => busy(r, g, 0.55, 0.65),
                1..=3 => busy(r, g, 1.05, 1.7),
                4 => busy(r, g, 0.35, 0.5),
                _ => busy(r, g, 1.1, 1.4),
            },
            onboarded: true,
            today_cap: None,
            acknowledge: true,
        },
    ]
}

pub fn preset_ids() -> Vec<&'static str> {
    defs().iter().map(|d| d.id).collect()
}

/// Generates every preset. `work` is a scratch directory.
pub fn generate_all(today: Date, tz: &TimeZone, work: &Path) -> std::io::Result<Vec<MockPreset>> {
    defs().into_iter().enumerate().map(|(i, d)| generate(&d, i as u64 + 1, today, tz, work)).collect()
}

fn generate(d: &Def, seed: u64, today: Date, tz: &TimeZone, work: &Path) -> std::io::Result<MockPreset> {
    let dir = work.join(d.id);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir)?;
    let scenario = Scenario {
        seed: seed * 7919,
        today,
        tz: tz.clone(),
        days: d.days,
        daily_goal: d.goal,
        target: d.target,
        tools: d.tools,
        projects: PROJECTS.to_vec(),
        now_hour: d.now_hour,
        content_bytes: (40, 120),
    };
    let mut reqs = synth::requests(&scenario);
    if let Some(cap) = d.today_cap {
        let start = today.to_zoned(tz.clone()).map(|z| z.timestamp().as_millisecond()).unwrap_or(0);
        let limit = (d.goal as f64 * cap) as u64;
        let mut total: u64 = reqs.iter().filter(|r| r.ts_ms >= start).map(|r| r.input + r.output + r.cache_write + r.cache_read).sum();
        while total > limit {
            let Some(pos) = reqs.iter().rposition(|r| r.ts_ms >= start) else { break };
            let r = reqs.remove(pos);
            total -= r.input + r.output + r.cache_write + r.cache_read;
        }
    }
    let mut rng = Rng::new(seed);
    let roots = synth::write_logs(&dir.join("logs"), &reqs, &mut rng)?;
    let now_ms = today
        .at(d.now_hour as i8, 5, 0, 0)
        .to_zoned(tz.clone())
        .map(|z| z.timestamp().as_millisecond())
        .unwrap_or(0);
    let sources = SourceConfig {
        home: Some(dir.clone()),
        claude_dirs: Some(vec![roots[0].clone()]),
        codex_homes: Some(vec![roots[1].clone()]),
        gemini_dirs: Some(vec![roots[2].clone()]),
        gemini_cli_home: None,
        enabled: [true; 3],
    };
    let data = dir.join("data");
    let mut engine = Engine::open_with(&data, sources);
    engine.set_now(Some(now_ms));
    let _ = engine.update_settings(&serde_json::json!({ "timezone": tz.iana_name() }));
    engine.refresh();
    if d.onboarded {
        // Goals set before the history window so the whole history uses them.
        let _ = engine.complete_onboarding(&GoalsInput { daily: d.goal, weekly: d.goal * 5 });
    }
    if d.acknowledge {
        let snap = engine.snapshot();
        let ids: Vec<String> = snap.achievements.iter().filter(|a| a.unlocked_at.is_some()).map(|a| a.id.clone()).collect();
        // Keep the most recent unlock "new" so the UI can show the badge moment.
        let newest = snap
            .achievements
            .iter()
            .filter_map(|a| a.unlocked_at.as_ref().map(|u| (u.clone(), a.id.clone())))
            .max();
        let seen: Vec<String> = ids.into_iter().filter(|i| Some(i) != newest.as_ref().map(|n| &n.1)).collect();
        engine.acknowledge_achievements(&seen);
        if let Some(c) = snap.celebration.as_ref() {
            engine.acknowledge_celebration(&c.date);
        }
    }
    let snapshot = engine.snapshot();
    let mut breakdowns = BTreeMap::new();
    for kind in [
        RangeKind::Today,
        RangeKind::Yesterday,
        RangeKind::Last7,
        RangeKind::Last30,
        RangeKind::Last90,
        RangeKind::ThisWeek,
        RangeKind::ThisMonth,
        RangeKind::ThisYear,
        RangeKind::All,
    ] {
        let key = serde_json::to_value(kind).ok().and_then(|v| v.as_str().map(str::to_string)).unwrap_or_default();
        breakdowns.insert(key, engine.breakdown(&RangeQuery { kind, from: None, to: None }));
    }
    let mut share_cards = BTreeMap::new();
    for (k, f) in [("square", ShareFormat::Square), ("story", ShareFormat::Story)] {
        share_cards.insert(
            k.to_string(),
            engine.share_card(&ShareOptions {
                range: RangeQuery { kind: RangeKind::Last30, from: None, to: None },
                format: f,
                include_project_names: None,
            }),
        );
    }
    Ok(MockPreset {
        id: d.id.into(),
        title: d.title.into(),
        description: d.description.into(),
        now: crate::time::format_rfc3339_ms(now_ms),
        settings: engine.settings().clone(),
        snapshot,
        breakdowns,
        share_cards,
    })
}
