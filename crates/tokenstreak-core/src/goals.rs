//! Goals and streaks.
//!
//! Rules (tested in `tests/streaks.rs` and below):
//! 1. A day is *met* when its total tokens reach the daily goal in effect that
//!    day. Goals are versioned: a change applies from its `effective_from`
//!    date onward and never rewrites earlier days. Days before the first goal
//!    was set (history found at first run) use that first goal, so the
//!    first-run reveal shows the streaks the user already had.
//! 2. The current streak counts consecutive met days ending today when today
//!    is met, otherwise ending yesterday: today is "in progress" and never
//!    breaks a streak before it is over.
//! 3. A day with no usage (or below goal) breaks the streak, except on
//!    configured rest days, which neither break nor extend it (a met rest day
//!    still counts).
//! 4. The first day of history can start a streak of 1. With no goal set
//!    (goal 0) nothing is met.
//! 5. Weekly streaks count consecutive weeks meeting the weekly goal in
//!    effect at the end of that week (or today for the current week).

use std::collections::BTreeMap;

use jiff::civil::{Date, Weekday};
use jiff::ToSpan;

use crate::api::{GoalChange, WeekStart};

/// A goal version with a parsed date.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Goal {
    pub from: Date,
    pub daily: u64,
    pub weekly: u64,
}

/// Versioned goals, sorted by `from`.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct GoalHistory(pub Vec<Goal>);

impl GoalHistory {
    pub fn from_changes(changes: &[GoalChange]) -> Self {
        let mut v: Vec<Goal> = changes
            .iter()
            .filter_map(|c| {
                Some(Goal { from: c.effective_from.parse().ok()?, daily: c.daily, weekly: c.weekly })
            })
            .collect();
        v.sort_by_key(|g| g.from);
        Self(v)
    }

    pub fn to_changes(&self) -> Vec<GoalChange> {
        self.0
            .iter()
            .map(|g| GoalChange { effective_from: g.from.to_string(), daily: g.daily, weekly: g.weekly })
            .collect()
    }

    /// Records a new goal effective `from` (replacing a change on the same day).
    pub fn set(&mut self, from: Date, daily: u64, weekly: u64) {
        self.0.retain(|g| g.from < from);
        if self.0.last().is_some_and(|g| g.daily == daily && g.weekly == weekly) {
            return;
        }
        self.0.push(Goal { from, daily, weekly });
    }

    /// The goal in effect on `d` (the first goal applies retroactively).
    pub fn at(&self, d: Date) -> Option<Goal> {
        self.0.iter().rev().find(|g| g.from <= d).or_else(|| self.0.first()).copied()
    }

    pub fn current(&self) -> Option<Goal> {
        self.0.last().copied()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// Per-day evaluation.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct DayEval {
    pub goal: u64,
    pub met: bool,
    /// Streak length after this day (0 when not met).
    pub streak: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct StreakResult {
    pub days: BTreeMap<Date, DayEval>,
    pub current: u32,
    pub current_start: Option<Date>,
    pub longest: u32,
    pub longest_start: Option<Date>,
    pub longest_end: Option<Date>,
    pub today_met: bool,
    pub weekly_current: u32,
    pub weekly_longest: u32,
    /// (week start, tokens, goal, met) for every week in range.
    pub weeks: Vec<(Date, u64, u64, bool)>,
}

pub fn weekday_index(d: Date) -> u8 {
    d.weekday().to_monday_zero_offset() as u8
}

pub fn week_start(d: Date, ws: WeekStart) -> Date {
    let off = match ws {
        WeekStart::Monday => d.weekday().to_monday_zero_offset(),
        WeekStart::Sunday => d.weekday().to_sunday_zero_offset(),
    };
    d.checked_sub((off as i64).days()).unwrap_or(d)
}

/// Evaluates streaks over `[first, today]` where `first` is the earliest day
/// in `totals` (or today when empty).
pub fn evaluate(
    totals: &BTreeMap<Date, u64>,
    goals: &GoalHistory,
    today: Date,
    rest_days: &[u8],
    ws: WeekStart,
) -> StreakResult {
    let mut r = StreakResult::default();
    let Some(&first) = totals.keys().next() else {
        return r;
    };
    let first = first.min(today);
    let mut run: u32 = 0;
    let mut run_start: Option<Date> = None;
    let mut d = first;
    while d <= today {
        let tokens = totals.get(&d).copied().unwrap_or(0);
        let goal = goals.at(d).map(|g| g.daily).unwrap_or(0);
        let met = goal > 0 && tokens >= goal;
        let rest = rest_days.contains(&weekday_index(d));
        if met {
            if run == 0 {
                run_start = Some(d);
            }
            run += 1;
            if run > r.longest {
                r.longest = run;
                r.longest_start = run_start;
                r.longest_end = Some(d);
            }
        } else if !(rest || d == today) {
            run = 0;
            run_start = None;
        }
        r.days.insert(d, DayEval { goal, met, streak: if met { run } else { 0 } });
        if d == today {
            r.today_met = met;
        }
        match d.tomorrow() {
            Ok(n) => d = n,
            Err(_) => break,
        }
    }
    r.current = run;
    r.current_start = if run > 0 { run_start } else { None };

    // Weekly.
    let mut wk = week_start(first, ws);
    let this_week = week_start(today, ws);
    let mut wrun = 0u32;
    while wk <= this_week {
        let end = wk.checked_add(6.days()).unwrap_or(wk);
        let mut sum = 0u64;
        for (_, t) in totals.range(wk..=end) {
            sum += t;
        }
        let goal = goals.at(end.min(today)).map(|g| g.weekly).unwrap_or(0);
        let met = goal > 0 && sum >= goal;
        if met {
            wrun += 1;
            r.weekly_longest = r.weekly_longest.max(wrun);
        } else if wk != this_week {
            wrun = 0;
        }
        r.weeks.push((wk, sum, goal, met));
        match wk.checked_add(7.days()) {
            Ok(n) => wk = n,
            Err(_) => break,
        }
    }
    r.weekly_current = wrun;
    r
}

/// Suggests goals from recent history: the median of the last 30 active days,
/// rounded to a friendly number, so a typical day meets it.
pub fn suggest(totals: &BTreeMap<Date, u64>, today: Date) -> (u64, u64) {
    let from = today.checked_sub(30.days()).unwrap_or(today);
    let mut v: Vec<u64> = totals.range(from..=today).map(|(_, t)| *t).filter(|t| *t > 0).collect();
    if v.is_empty() {
        return (1_000_000, 5_000_000);
    }
    v.sort_unstable();
    let median = v[v.len() / 2];
    let daily = friendly_round((median as f64 * 0.8) as u64).max(10_000);
    (daily, friendly_round(daily * 5))
}

/// Rounds to 1, 2 or 5 × 10^n (at or below the value).
pub fn friendly_round(v: u64) -> u64 {
    if v < 10 {
        return v.max(1);
    }
    let mag = 10u64.pow((v as f64).log10().floor() as u32);
    let lead = v / mag;
    let step = if lead >= 5 {
        5
    } else if lead >= 2 {
        2
    } else {
        1
    };
    step * mag
}

pub fn is_weekend(d: Date) -> bool {
    matches!(d.weekday(), Weekday::Saturday | Weekday::Sunday)
}

#[cfg(test)]
mod tests {
    use super::*;
    use jiff::civil::date;

    fn hist(g: &[(&str, u64)]) -> GoalHistory {
        GoalHistory(g.iter().map(|(d, v)| Goal { from: d.parse().unwrap(), daily: *v, weekly: *v * 5 }).collect())
    }

    fn totals(v: &[(&str, u64)]) -> BTreeMap<Date, u64> {
        v.iter().map(|(d, t)| (d.parse().unwrap(), *t)).collect()
    }

    #[test]
    fn today_in_progress_does_not_break() {
        let t = totals(&[("2026-09-24", 100), ("2026-09-25", 100), ("2026-09-26", 10)]);
        let r = evaluate(&t, &hist(&[("2026-09-01", 50)]), date(2026, 9, 26), &[], WeekStart::Monday);
        assert_eq!(r.current, 2);
        assert!(!r.today_met);
    }

    #[test]
    fn missed_day_breaks() {
        let t = totals(&[("2026-09-23", 100), ("2026-09-25", 100), ("2026-09-26", 100)]);
        let r = evaluate(&t, &hist(&[("2026-09-01", 50)]), date(2026, 9, 26), &[], WeekStart::Monday);
        assert_eq!(r.current, 2);
        assert_eq!(r.longest, 2);
        assert_eq!(r.current_start, Some(date(2026, 9, 25)));
    }

    #[test]
    fn first_day_counts() {
        let t = totals(&[("2026-09-26", 100)]);
        let r = evaluate(&t, &hist(&[("2026-09-26", 50)]), date(2026, 9, 26), &[], WeekStart::Monday);
        assert_eq!(r.current, 1);
        assert!(r.today_met);
    }

    #[test]
    fn goal_change_applies_forward_only() {
        let t = totals(&[("2026-09-24", 100), ("2026-09-25", 100), ("2026-09-26", 100)]);
        let g = hist(&[("2026-09-01", 50), ("2026-09-26", 500)]);
        let r = evaluate(&t, &g, date(2026, 9, 26), &[], WeekStart::Monday);
        assert_eq!(r.current, 2, "yesterday's streak survives a harder goal set today");
        assert!(!r.today_met);
        assert_eq!(r.days[&date(2026, 9, 25)].goal, 50);
        assert_eq!(r.days[&date(2026, 9, 26)].goal, 500);
    }

    #[test]
    fn rest_days_bridge() {
        // 2026-09-19/20 are Sat/Sun.
        let t = totals(&[("2026-09-18", 100), ("2026-09-21", 100)]);
        let r = evaluate(&t, &hist(&[("2026-09-01", 50)]), date(2026, 9, 21), &[5, 6], WeekStart::Monday);
        assert_eq!(r.current, 2);
    }

    #[test]
    fn friendly() {
        assert_eq!(friendly_round(4_321_000), 2_000_000);
        assert_eq!(friendly_round(7_900_000), 5_000_000);
        assert_eq!(friendly_round(1_500), 1_000);
    }
}
