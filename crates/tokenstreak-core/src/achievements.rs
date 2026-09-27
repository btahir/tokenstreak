//! Achievements ("Afterglow" set): deterministic milestones with unlock dates.
//!
//! Five families (consistency, care, craft, explorer, scale) and four metals.
//! Streak badges are earned by showing up, craft badges by working well; only
//! three reward raw volume, none rewards money spent or working at 2 am.
//!
//! Each unlock date is the local date on which the condition first became
//! true, computed from the ledger and the streak evaluation. Unlocks are also
//! remembered in app state (sticky), so a tool pruning its old logs never
//! takes an achievement away; the stored and computed dates merge by minimum.

use std::collections::{BTreeMap, BTreeSet};

use jiff::civil::Date;
use jiff::ToSpan;
use rustc_hash::FxHashMap;

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
    // consistency: showing up
    Def { id: "first-light", title: "First Light", description: "Light your trail for the first time: meet your daily goal once.", category: C::Consistency, tier: T::Bronze, target: 1.0 },
    Def { id: "seven-sparks", title: "Seven Sparks", description: "A seven-day streak.", category: C::Consistency, tier: T::Bronze, target: 7.0 },
    Def { id: "full-moon", title: "Full Moon", description: "A thirty-day streak, a whole lunar cycle of light.", category: C::Consistency, tier: T::Silver, target: 30.0 },
    Def { id: "aurora", title: "Aurora", description: "A hundred-day streak.", category: C::Consistency, tier: T::Gold, target: 100.0 },
    Def { id: "halo", title: "Halo", description: "A full year without a dark day.", category: C::Consistency, tier: T::Legendary, target: 365.0 },
    Def { id: "steady-hand", title: "Steady Hand", description: "Four weeks in a row with at least five lit days each.", category: C::Consistency, tier: T::Gold, target: 4.0 },
    Def { id: "high-tide", title: "High Tide", description: "Reach your weekly goal.", category: C::Consistency, tier: T::Bronze, target: 1.0 },
    // care: coming back, resting well
    Def { id: "rekindled", title: "Rekindled", description: "Build a new three-day streak after a week or more away.", category: C::Care, tier: T::Silver, target: 1.0 },
    Def { id: "safety-net", title: "Safety Net", description: "A streak freeze caught a missed day and kept your streak alive.", category: C::Care, tier: T::Bronze, target: 1.0 },
    // craft: working well
    Def { id: "deep-memory", title: "Deep Memory", description: "A day of 1M+ tokens with at least 80% of context served from cache.", category: C::Craft, tier: T::Silver, target: 0.8 },
    Def { id: "echo", title: "Echo", description: "A day of 1M+ tokens whose cache reads repaid its cache writes ten times over.", category: C::Craft, tier: T::Bronze, target: 10.0 },
    Def { id: "featherweight", title: "Featherweight", description: "A week at least 20% cheaper per token than the 30 days before it.", category: C::Craft, tier: T::Gold, target: 0.2 },
    // explorer
    Def { id: "trio", title: "Trio", description: "Claude Code, Codex and Gemini CLI, all on the same day.", category: C::Explorer, tier: T::Silver, target: 3.0 },
    // scale: the only volume badges
    Def { id: "megawatt", title: "Megawatt", description: "Ten million tokens in a single day.", category: C::Scale, tier: T::Bronze, target: 1e7 },
    Def { id: "constellation", title: "Constellation", description: "A hundred million tokens, all time.", category: C::Scale, tier: T::Silver, target: 1e8 },
    Def { id: "galaxy", title: "Galaxy", description: "A billion tokens, all time.", category: C::Scale, tier: T::Gold, target: 1e9 },
];

pub fn count() -> usize {
    DEFS.len()
}

#[derive(Default, Clone, Copy)]
struct DayAcc {
    tokens: u64,
    cost: f64,
    cache_read: u64,
    cache_write: u64,
    prompt: u64,
    tools: u8,
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

    // Scale: day totals and lifetime crossings.
    let mut lifetime = 0u64;
    let mut best_day = 0u64;
    for (&d, &t) in totals {
        best_day = best_day.max(t);
        if t >= 10_000_000 {
            set("megawatt", d, &mut unlock);
        }
        lifetime += t;
        if lifetime >= 100_000_000 {
            set("constellation", d, &mut unlock);
        }
        if lifetime >= 1_000_000_000 {
            set("galaxy", d, &mut unlock);
        }
    }
    progress.insert("megawatt", best_day as f64);
    progress.insert("constellation", lifetime as f64);
    progress.insert("galaxy", lifetime as f64);

    // Consistency and care, from the streak evaluation.
    let mut last_lit: Option<Date> = None;
    let mut run_after_gap = false;
    for (&d, ev) in &streaks.days {
        if ev.met {
            set("first-light", d, &mut unlock);
            // Rekindled: a run that starts after 7+ days without a lit day reaches 3.
            if ev.streak == 1 {
                run_after_gap = last_lit.map(|p| (d - p).get_days() > 7).unwrap_or(false);
            }
            if ev.streak == 3 && run_after_gap {
                set("rekindled", d, &mut unlock);
            }
            last_lit = Some(d);
        }
        if ev.frozen {
            set("safety-net", d, &mut unlock);
        }
        for (id, n) in [("seven-sparks", 7), ("full-moon", 30), ("aurora", 100), ("halo", 365)] {
            if ev.streak >= n {
                set(id, d, &mut unlock);
            }
        }
    }
    let max_streak = streaks.longest as f64;
    for id in ["seven-sparks", "full-moon", "aurora", "halo"] {
        progress.insert(id, max_streak);
    }
    progress.insert("first-light", if streaks.longest > 0 { 1.0 } else { 0.0 });

    // High tide: the day a week's running total crossed its goal.
    // Steady hand: four consecutive weeks with 5+ lit days (the 5th lit day of the 4th week).
    let mut steady_run = 0u32;
    let mut best_steady = 0u32;
    for &(start, _sum, goal, met) in &streaks.weeks {
        let end = start.checked_add(6.days()).unwrap_or(start);
        if met && goal > 0 {
            let mut acc = 0u64;
            for (&d, &t) in totals.range(start..=end) {
                acc += t;
                if acc >= goal {
                    set("high-tide", d, &mut unlock);
                    break;
                }
            }
        }
        let lit: Vec<Date> = streaks.days.range(start..=end).filter(|(_, e)| e.met).map(|(d, _)| *d).collect();
        if lit.len() >= 5 {
            steady_run += 1;
            if steady_run >= 4 {
                set("steady-hand", lit[4], &mut unlock);
            }
        } else if end < streaks.days.keys().next_back().copied().unwrap_or(end) {
            // a finished week that fell short resets the run; the current week can still make it
            steady_run = 0;
        }
        best_steady = best_steady.max(steady_run);
    }
    progress.insert("steady-hand", best_steady as f64);
    progress.insert("high-tide", if unlock.contains_key("high-tide") { 1.0 } else { 0.0 });

    // Craft and explorer, per day from the ledger.
    let mut days: BTreeMap<Date, DayAcc> = BTreeMap::new();
    for e in &ledger.events {
        let a = days.entry(e.date).or_default();
        a.tokens += e.total();
        a.cost += e.cost;
        a.cache_read += e.cache_read;
        a.cache_write += e.cache_write;
        a.prompt += e.input + e.cache_read + e.cache_write;
        a.tools |= 1 << e.tool.index();
    }
    let mut best_share: f64 = 0.0;
    let mut best_payoff: f64 = 0.0;
    let mut best_tools = 0u32;
    for (&d, a) in &days {
        best_tools = best_tools.max(a.tools.count_ones());
        if a.tools.count_ones() >= 3 {
            set("trio", d, &mut unlock);
        }
        if a.tokens < 1_000_000 || a.prompt == 0 {
            continue;
        }
        let share = a.cache_read as f64 / a.prompt as f64;
        best_share = best_share.max(share);
        if share >= 0.8 {
            set("deep-memory", d, &mut unlock);
        }
        let payoff = if a.cache_write > 0 { a.cache_read as f64 / a.cache_write as f64 } else if a.cache_read > 0 { f64::INFINITY } else { 0.0 };
        best_payoff = best_payoff.max(payoff.min(10.0));
        if payoff >= 10.0 {
            set("echo", d, &mut unlock);
        }
    }
    progress.insert("trio", best_tools as f64);
    progress.insert("deep-memory", best_share);
    progress.insert("echo", best_payoff);

    // Featherweight: a 7-day window (3+ active days) at least 20% cheaper per
    // token than the 30 days before it (10+ active days).
    let mut best_lean: f64 = 0.0;
    if let (Some(&first), Some(&last)) = (days.keys().next(), days.keys().next_back()) {
        let mut d = first.checked_add(36.days()).unwrap_or(last);
        while d <= last {
            let w_from = d.checked_sub(6.days()).unwrap_or(d);
            let t_from = d.checked_sub(36.days()).unwrap_or(d);
            let t_to = d.checked_sub(7.days()).unwrap_or(d);
            let sum = |from: Date, to: Date| {
                days.range(from..=to).fold((0u64, 0.0f64, 0u32), |(t, c, n), (_, a)| (t + a.tokens, c + a.cost, n + u32::from(a.tokens > 0)))
            };
            let (wt, wc, wn) = sum(w_from, d);
            let (tt, tc, tn) = sum(t_from, t_to);
            if wn >= 3 && tn >= 10 && wt > 0 && tt > 0 && tc > 0.0 && wc > 0.0 {
                let lean = 1.0 - (wc / wt as f64) / (tc / tt as f64);
                best_lean = best_lean.max(lean);
                if lean >= 0.2 {
                    set("featherweight", d, &mut unlock);
                    break;
                }
            }
            match d.checked_add(1.day()) {
                Ok(n) => d = n,
                Err(_) => break,
            }
        }
    }
    progress.insert("featherweight", best_lean.max(0.0));

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
