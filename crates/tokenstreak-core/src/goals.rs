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
//! 6. Streak freezes (setting, on by default): every 7 goal days in a row
//!    earn a freeze, holding at most 2 (a 7th day at the cap earns nothing).
//!    A missed day that is not a rest day and not today spends one, if a
//!    streak is alive and a freeze is held: that day is *frozen*, the streak
//!    survives but isn't extended, and the count towards the next freeze
//!    restarts (the 7 goal days must be consecutive; rest days pause the
//!    count). Without a freeze the miss breaks the streak. Freezes replay
//!    deterministically over history, like goals.

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
    /// A missed day bridged by a streak freeze.
    pub frozen: bool,
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
    /// Streak freezes held after today, earned and spent over the history.
    pub freezes_held: u32,
    pub freezes_earned: u32,
    pub freezes_used: u32,
    /// Goal days in the current streak since the last freeze was earned.
    pub freeze_progress: u32,
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
/// Days of goal-meeting (in one streak) that earn a freeze.
pub const FREEZE_EVERY: u32 = 7;
/// Most freezes held at once.
pub const FREEZE_CAP: u32 = 2;

/// Evaluates streaks without freezes (rules 1-5).
pub fn evaluate(
    totals: &BTreeMap<Date, u64>,
    goals: &GoalHistory,
    today: Date,
    rest_days: &[u8],
    ws: WeekStart,
) -> StreakResult {
    evaluate_with(totals, goals, today, rest_days, ws, false)
}

/// Evaluates streaks, with streak freezes when `freezes` is true (rule 6).
pub fn evaluate_with(
    totals: &BTreeMap<Date, u64>,
    goals: &GoalHistory,
    today: Date,
    rest_days: &[u8],
    ws: WeekStart,
    freezes: bool,
) -> StreakResult {
    let mut r = StreakResult::default();
    let Some(&first) = totals.keys().next() else {
        return r;
    };
    let first = first.min(today);
    let mut run: u32 = 0;
    let mut run_start: Option<Date> = None;
    let mut since_earn: u32 = 0;
    let mut d = first;
    while d <= today {
        let tokens = totals.get(&d).copied().unwrap_or(0);
        let goal = goals.at(d).map(|g| g.daily).unwrap_or(0);
        let met = goal > 0 && tokens >= goal;
        let rest = rest_days.contains(&weekday_index(d));
        let mut frozen = false;
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
            if freezes {
                since_earn += 1;
                if since_earn == FREEZE_EVERY {
                    since_earn = 0;
                    if r.freezes_held < FREEZE_CAP {
                        r.freezes_held += 1;
                        r.freezes_earned += 1;
                    }
                }
            }
        } else if !(rest || d == today) {
            if freezes && run > 0 && r.freezes_held > 0 {
                r.freezes_held -= 1;
                r.freezes_used += 1;
                frozen = true;
                since_earn = 0;
            } else {
                run = 0;
                run_start = None;
                since_earn = 0;
            }
        }
        r.days.insert(d, DayEval { goal, met, streak: if met { run } else { 0 }, frozen });
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
    r.freeze_progress = since_earn;

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
    // A touch below the typical day, so most days light; the weekly goal is
    // six good days, so a quiet day is forgiven but the week still means something.
    let daily = friendly_round((median as f64 * 0.9) as u64).max(10_000);
    (daily, friendly_round(daily * 6))
}

/// Friendly goal steps: 1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6 or 8 × 10^n.
const STEPS_X10: [u64; 10] = [10, 12, 15, 20, 25, 30, 40, 50, 60, 80];

/// Rounds down to the nearest friendly step (at most about 20% below the value).
pub fn friendly_round(v: u64) -> u64 {
    if v < 10 {
        return v.max(1);
    }
    let mag = 10u64.pow((v as f64).log10().floor() as u32);
    // compare in tenths of the magnitude so 1.5, 2.5 etc. work for any size
    let lead_x10 = (v as u128 * 10 / mag as u128) as u64;
    let step = STEPS_X10.iter().rev().copied().find(|s| *s <= lead_x10).unwrap_or(10);
    (step as u128 * mag as u128 / 10) as u64
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

    fn run(days: &[(&str, u64)], today: (i16, i8, i8), rest: &[u8]) -> StreakResult {
        let t = totals(days);
        evaluate_with(&t, &hist(&[("2026-08-01", 50)]), date(today.0, today.1, today.2), rest, WeekStart::Monday, true)
    }

    /// `n` consecutive met days starting at `from` (a Date).
    fn met_days(from: Date, n: i64) -> Vec<(String, u64)> {
        (0..n).map(|i| (from.checked_add(i.days()).unwrap().to_string(), 100)).collect()
    }

    fn as_refs(v: &[(String, u64)]) -> Vec<(&str, u64)> {
        v.iter().map(|(d, t)| (d.as_str(), *t)).collect()
    }

    #[test]
    fn freeze_earned_after_seven_goal_days() {
        let v = met_days(date(2026, 9, 1), 6);
        let r = run(&as_refs(&v), (2026, 9, 6), &[]);
        assert_eq!((r.freezes_held, r.freezes_earned), (0, 0));
        let v = met_days(date(2026, 9, 1), 7);
        let r = run(&as_refs(&v), (2026, 9, 7), &[]);
        assert_eq!((r.freezes_held, r.freezes_earned, r.current), (1, 1, 7));
    }

    #[test]
    fn a_frozen_day_restarts_the_count_to_the_next_freeze() {
        // Earn on Sep 14 (days 1-14 met gives 2); spend one on Sep 15; the
        // next freeze needs 7 more consecutive goal days (Sep 16-22).
        let mut v = met_days(date(2026, 9, 1), 14);
        v.extend(met_days(date(2026, 9, 16), 6));
        let r = run(&as_refs(&v), (2026, 9, 21), &[]);
        assert_eq!((r.freezes_held, r.freezes_used, r.freeze_progress), (1, 1, 6));
        v.extend(met_days(date(2026, 9, 22), 1));
        let r = run(&as_refs(&v), (2026, 9, 22), &[]);
        assert_eq!((r.freezes_held, r.freezes_earned), (2, 3));
    }

    #[test]
    fn freezes_cap_at_two() {
        let v = met_days(date(2026, 8, 1), 30);
        let r = run(&as_refs(&v), (2026, 8, 30), &[]);
        assert_eq!((r.freezes_held, r.freezes_earned), (2, 2), "days 7 and 14 earn; 21 and 28 are at the cap");
    }

    #[test]
    fn freeze_spent_on_a_miss_keeps_the_streak() {
        // 7 met days (Sep 1-7), miss Sep 8, met Sep 9-10.
        let mut v = met_days(date(2026, 9, 1), 7);
        v.extend(met_days(date(2026, 9, 9), 2));
        let r = run(&as_refs(&v), (2026, 9, 10), &[]);
        assert_eq!(r.current, 9, "the frozen day bridges but doesn't count");
        assert_eq!((r.freezes_held, r.freezes_used), (0, 1));
        assert!(r.days[&date(2026, 9, 8)].frozen);
        assert_eq!(r.days[&date(2026, 9, 8)].streak, 0);
        assert_eq!(r.current_start, Some(date(2026, 9, 1)));
        // Without freezes the same history breaks.
        let t = totals(&as_refs(&v));
        let plain = evaluate(&t, &hist(&[("2026-08-01", 50)]), date(2026, 9, 10), &[], WeekStart::Monday);
        assert_eq!(plain.current, 2);
        assert_eq!(plain.freezes_held, 0);
    }

    #[test]
    fn rest_day_does_not_consume_a_freeze() {
        // Sep 7 2026 is a Monday; Sep 12/13 are Sat/Sun rest days.
        let mut v = met_days(date(2026, 9, 5), 7); // Sat 5 .. Fri 11
        v.extend(met_days(date(2026, 9, 14), 1));
        let r = run(&as_refs(&v), (2026, 9, 14), &[5, 6]);
        assert_eq!((r.freezes_held, r.freezes_used, r.current), (1, 0, 8));
        assert!(!r.days[&date(2026, 9, 12)].frozen);
    }

    #[test]
    fn a_miss_without_a_freeze_breaks() {
        let mut v = met_days(date(2026, 9, 1), 7);
        v.extend(met_days(date(2026, 9, 10), 1)); // miss Sep 8 (frozen) and Sep 9 (no freeze left)
        let r = run(&as_refs(&v), (2026, 9, 10), &[]);
        assert!(r.days[&date(2026, 9, 8)].frozen);
        assert!(!r.days[&date(2026, 9, 9)].frozen);
        assert_eq!(r.current, 1);
        assert_eq!(r.longest, 7);
    }

    #[test]
    fn first_day_and_today_never_spend() {
        let r = run(&[("2026-09-26", 100)], (2026, 9, 26), &[]);
        assert_eq!((r.current, r.freezes_held, r.freezes_used), (1, 0, 0));
        // Today below goal is in progress: no freeze is spent on it.
        let mut v = met_days(date(2026, 9, 1), 7);
        v.push(("2026-09-08".into(), 10));
        let r = run(&as_refs(&v), (2026, 9, 8), &[]);
        assert_eq!((r.current, r.freezes_held, r.freezes_used), (7, 1, 0));
        assert!(!r.days[&date(2026, 9, 8)].frozen);
    }

    #[test]
    fn goal_changes_never_rewrite_frozen_history() {
        let mut v = met_days(date(2026, 9, 1), 7);
        v.extend(met_days(date(2026, 9, 9), 2));
        let t = totals(&as_refs(&v));
        // A much harder goal from Sep 10 on leaves Sep 1-9 as they were.
        let g = hist(&[("2026-08-01", 50), ("2026-09-10", 500)]);
        let r = evaluate_with(&t, &g, date(2026, 9, 10), &[], WeekStart::Monday, true);
        assert!(r.days[&date(2026, 9, 8)].frozen);
        assert_eq!(r.current, 8);
        assert!(!r.today_met);
    }

    #[test]
    fn friendly() {
        assert_eq!(friendly_round(4_321_000), 4_000_000);
        assert_eq!(friendly_round(7_900_000), 6_000_000);
        assert_eq!(friendly_round(1_500), 1_500);
        assert_eq!(friendly_round(32_040_000), 30_000_000);
        assert_eq!(friendly_round(2_880_000), 2_500_000);
        for v in [12_345u64, 99_999, 1_999_999, 35_600_000, 812_000_000] {
            let r = friendly_round(v);
            assert!(r <= v && r as f64 >= v as f64 * 0.74, "{v} -> {r}");
        }
    }
}
