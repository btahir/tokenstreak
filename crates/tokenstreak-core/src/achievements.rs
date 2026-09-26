//! Achievements: deterministic milestones with unlock dates.
//!
//! Each unlock date is the local date on which the condition first became
//! true, computed from the ledger and the streak evaluation. Unlocks are also
//! remembered in app state (sticky), so a tool pruning its old logs never
//! takes an achievement away; the stored and computed dates merge by minimum.

use std::collections::{BTreeMap, BTreeSet};

use jiff::civil::{Date, Weekday};
use rustc_hash::{FxHashMap, FxHashSet};

use crate::aggregate::Ledger;
use crate::api::{Achievement, AchievementCategory as C, AchievementTier as T};
use crate::goals::StreakResult;

struct Def {
    id: &'static str,
    title: &'static str,
    description: &'static str,
    category: C,
    tier: T,
    target: f64,
}

const DEFS: &[Def] = &[
    Def { id: "first-spark", title: "First Spark", description: "Your first tracked day of coding with an agent.", category: C::Volume, tier: T::Bronze, target: 1.0 },
    Def { id: "goal-getter", title: "Goal Getter", description: "Hit your daily goal for the first time.", category: C::Goals, tier: T::Bronze, target: 1.0 },
    Def { id: "streak-3", title: "Warming Up", description: "Meet your daily goal three days in a row.", category: C::Streak, tier: T::Bronze, target: 3.0 },
    Def { id: "streak-7", title: "On a Roll", description: "A seven-day streak.", category: C::Streak, tier: T::Silver, target: 7.0 },
    Def { id: "streak-30", title: "Unstoppable", description: "A thirty-day streak.", category: C::Streak, tier: T::Gold, target: 30.0 },
    Def { id: "streak-100", title: "Centurion", description: "A hundred days without a miss.", category: C::Streak, tier: T::Legendary, target: 100.0 },
    Def { id: "comeback", title: "Comeback", description: "Build a new three-day streak after losing one of a week or more.", category: C::Streak, tier: T::Silver, target: 1.0 },
    Def { id: "overachiever", title: "Overachiever", description: "Double your daily goal in a single day.", category: C::Goals, tier: T::Silver, target: 2.0 },
    Def { id: "weekly-goal", title: "Big Week", description: "Hit your weekly goal.", category: C::Goals, tier: T::Silver, target: 1.0 },
    Def { id: "weekend-warrior", title: "Weekend Warrior", description: "Meet your goal on a Saturday and the Sunday after.", category: C::Habits, tier: T::Silver, target: 2.0 },
    Def { id: "day-1m", title: "Million Token Day", description: "One million tokens in a single day.", category: C::Volume, tier: T::Bronze, target: 1e6 },
    Def { id: "day-10m", title: "Ten Million Day", description: "Ten million tokens in a single day.", category: C::Volume, tier: T::Silver, target: 1e7 },
    Def { id: "day-100m", title: "Hundred Million Day", description: "A hundred million tokens in a single day.", category: C::Volume, tier: T::Gold, target: 1e8 },
    Def { id: "lifetime-100m", title: "Hundred Million Club", description: "A hundred million tokens, all time.", category: C::Volume, tier: T::Bronze, target: 1e8 },
    Def { id: "lifetime-1b", title: "Billionaire", description: "One billion tokens, all time.", category: C::Volume, tier: T::Gold, target: 1e9 },
    Def { id: "lifetime-10b", title: "Ten Billion", description: "Ten billion tokens, all time.", category: C::Volume, tier: T::Legendary, target: 1e10 },
    Def { id: "marathon", title: "Marathon Session", description: "A single session past ten million tokens.", category: C::Volume, tier: T::Silver, target: 1e7 },
    Def { id: "polyglot", title: "Polyglot", description: "Code with two different agents.", category: C::Explorer, tier: T::Silver, target: 2.0 },
    Def { id: "full-house", title: "Full House", description: "Use Claude Code, Codex and Gemini CLI.", category: C::Explorer, tier: T::Gold, target: 3.0 },
    Def { id: "model-collector", title: "Model Collector", description: "Work with five different models.", category: C::Explorer, tier: T::Silver, target: 5.0 },
    Def { id: "project-hopper", title: "Project Hopper", description: "Use agents across ten projects.", category: C::Explorer, tier: T::Bronze, target: 10.0 },
    Def { id: "night-owl", title: "Night Owl", description: "Ship something between midnight and 4 am.", category: C::Habits, tier: T::Bronze, target: 1.0 },
    Def { id: "early-bird", title: "Early Bird", description: "Get going with an agent before 7 am.", category: C::Habits, tier: T::Bronze, target: 1.0 },
    Def { id: "cache-master", title: "Cache Master", description: "A day of 1M+ tokens with 90% served from cache.", category: C::Efficiency, tier: T::Silver, target: 0.9 },
];

pub fn count() -> usize {
    DEFS.len()
}

/// Computes all achievements. `stored` holds sticky unlock dates from app state;
/// `seen` holds ids the UI has already acknowledged.
pub fn compute(
    ledger: &Ledger,
    totals: &BTreeMap<Date, u64>,
    streaks: &StreakResult,
    stored: &BTreeMap<String, String>,
    seen: &BTreeSet<String>,
) -> Vec<Achievement> {
    let mut unlock: FxHashMap<&'static str, Date> = FxHashMap::default();
    let mut progress: FxHashMap<&'static str, f64> = FxHashMap::default();
    let set = |id: &'static str, d: Date, unlock: &mut FxHashMap<&'static str, Date>| {
        unlock.entry(id).and_modify(|x| *x = (*x).min(d)).or_insert(d);
    };

    // Day totals / lifetime crossings.
    let mut lifetime = 0u64;
    let mut best_day = 0u64;
    for (&d, &t) in totals {
        if t > 0 {
            set("first-spark", d, &mut unlock);
        }
        best_day = best_day.max(t);
        for (id, th) in [("day-1m", 1e6), ("day-10m", 1e7), ("day-100m", 1e8)] {
            if t as f64 >= th {
                set(id, d, &mut unlock);
            }
        }
        lifetime += t;
        for (id, th) in [("lifetime-100m", 1e8), ("lifetime-1b", 1e9), ("lifetime-10b", 1e10)] {
            if lifetime as f64 >= th {
                set(id, d, &mut unlock);
            }
        }
    }
    for id in ["day-1m", "day-10m", "day-100m"] {
        progress.insert(id, best_day as f64);
    }
    for id in ["lifetime-100m", "lifetime-1b", "lifetime-10b"] {
        progress.insert(id, lifetime as f64);
    }
    progress.insert("first-spark", if lifetime > 0 { 1.0 } else { 0.0 });

    // Streak-based.
    let mut prev_run_len = 0u32;
    let mut last_len = 0u32;
    let mut best_ratio: f64 = 0.0;
    let mut prev: Option<(Date, bool)> = None;
    for (&d, ev) in &streaks.days {
        if ev.met {
            set("goal-getter", d, &mut unlock);
        }
        for (id, n) in [("streak-3", 3), ("streak-7", 7), ("streak-30", 30), ("streak-100", 100)] {
            if ev.streak >= n {
                set(id, d, &mut unlock);
            }
        }
        if ev.goal > 0 {
            let t = totals.get(&d).copied().unwrap_or(0);
            let ratio = t as f64 / ev.goal as f64;
            best_ratio = best_ratio.max(ratio);
            if ratio >= 2.0 {
                set("overachiever", d, &mut unlock);
            }
        }
        // Comeback: a run of >=7 ended, then a new run reached 3.
        if ev.met {
            if ev.streak == 1 {
                prev_run_len = last_len;
            }
            last_len = ev.streak;
            if ev.streak == 3 && prev_run_len >= 7 {
                set("comeback", d, &mut unlock);
            }
        }
        // Weekend warrior.
        if d.weekday() == Weekday::Sunday && ev.met {
            if let Some((pd, pmet)) = prev {
                if pmet && pd.weekday() == Weekday::Saturday {
                    set("weekend-warrior", d, &mut unlock);
                }
            }
        }
        prev = Some((d, ev.met));
    }
    let max_streak = streaks.longest as f64;
    for id in ["streak-3", "streak-7", "streak-30", "streak-100"] {
        progress.insert(id, max_streak);
    }
    progress.insert("goal-getter", if streaks.longest > 0 { 1.0 } else { 0.0 });
    progress.insert("overachiever", best_ratio);

    // Weekly goal: the day the week's running total crossed its goal.
    for &(start, sum, goal, met) in &streaks.weeks {
        if met && goal > 0 {
            let end = start.checked_add(jiff::ToSpan::days(6)).unwrap_or(start);
            let mut acc = 0u64;
            for (&d, &t) in totals.range(start..=end) {
                acc += t;
                if acc >= goal {
                    set("weekly-goal", d, &mut unlock);
                    break;
                }
            }
        }
        let _ = sum;
    }

    // Ledger-driven: tools, models, projects, hours, sessions, cache.
    let mut tools_seen: FxHashSet<u8> = FxHashSet::default();
    let mut models_seen: FxHashSet<u32> = FxHashSet::default();
    let mut projects_seen: FxHashSet<u32> = FxHashSet::default();
    let mut session_tot: FxHashMap<u32, u64> = FxHashMap::default();
    let mut best_session = 0u64;
    let mut day_cache: BTreeMap<Date, (u64, u64)> = BTreeMap::new();
    for e in &ledger.events {
        if tools_seen.insert(e.tool as u8) {
            if tools_seen.len() >= 2 {
                set("polyglot", e.date, &mut unlock);
            }
            if tools_seen.len() >= 3 {
                set("full-house", e.date, &mut unlock);
            }
        }
        if e.model != crate::model::NO_MODEL && models_seen.insert(e.model) && models_seen.len() >= 5 {
            set("model-collector", e.date, &mut unlock);
        }
        if projects_seen.insert(e.project) && projects_seen.len() >= 10 {
            set("project-hopper", e.date, &mut unlock);
        }
        if e.hour < 4 {
            set("night-owl", e.date, &mut unlock);
        }
        if (4..7).contains(&e.hour) {
            set("early-bird", e.date, &mut unlock);
        }
        let s = session_tot.entry(e.session).or_default();
        *s += e.total();
        best_session = best_session.max(*s);
        if *s >= 10_000_000 {
            set("marathon", e.date, &mut unlock);
        }
        let c = day_cache.entry(e.date).or_default();
        c.0 += e.cache_read;
        c.1 += e.input + e.cache_read + e.cache_write;
    }
    let mut best_cache: f64 = 0.0;
    for (&d, &(read, prompt)) in &day_cache {
        let total = totals.get(&d).copied().unwrap_or(0);
        if prompt > 0 && total >= 1_000_000 {
            let share = read as f64 / prompt as f64;
            best_cache = best_cache.max(share);
            if share >= 0.9 {
                set("cache-master", d, &mut unlock);
            }
        }
    }
    progress.insert("polyglot", tools_seen.len() as f64);
    progress.insert("full-house", tools_seen.len() as f64);
    progress.insert("model-collector", models_seen.len() as f64);
    progress.insert("project-hopper", projects_seen.len() as f64);
    progress.insert("marathon", best_session as f64);
    progress.insert("cache-master", best_cache);

    DEFS.iter()
        .map(|def| {
            let computed = unlock.get(def.id).copied();
            let stored = stored.get(def.id).and_then(|s| s.parse::<Date>().ok());
            let at = match (computed, stored) {
                (Some(a), Some(b)) => Some(a.min(b)),
                (a, b) => a.or(b),
            };
            let p = if at.is_some() {
                def.target
            } else {
                progress.get(def.id).copied().unwrap_or(0.0).min(def.target)
            };
            Achievement {
                id: def.id.to_string(),
                title: def.title.to_string(),
                description: def.description.to_string(),
                category: def.category,
                tier: def.tier,
                unlocked_at: at.map(|d| d.to_string()),
                progress: p,
                target: def.target,
                is_new: at.is_some() && !seen.contains(def.id),
            }
        })
        .collect()
}
