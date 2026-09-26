//! When to send native notifications. Pure decisions over the snapshot,
//! settings and persisted markers, so the rules are unit tested here and the
//! app only delivers them.
//!
//! Rules:
//! - Nothing is sent before onboarding is complete, or during quiet hours.
//! - Goal reached: once per local day, when today's goal is met. The first-run
//!   reveal marks the day as notified, so finishing onboarding on a day that
//!   already met the goal stays silent. A crossing inside quiet hours is sent
//!   when they end, if it is still the same day.
//! - Streak at risk (opt-in): once per local day, at or after the reminder
//!   time, while a streak of at least one day is alive and today's goal is not
//!   met yet; never on a rest day (a rest day cannot break the streak).

use crate::api::{AppSnapshot, NotificationSettings, QuietHours, Settings};
use crate::state::AppState;
use crate::time::{parse_date, Clock};

/// Parses `HH:MM` (24 h) into minutes since midnight.
pub fn parse_hhmm(s: &str) -> Option<u16> {
    let (h, m) = s.trim().split_once(':')?;
    let (h, m): (u16, u16) = (h.parse().ok()?, m.parse().ok()?);
    (h < 24 && m < 60).then_some(h * 60 + m)
}

/// Whether `minute` (minutes since local midnight) falls in quiet hours.
pub fn in_quiet_hours(q: &QuietHours, minute: u16) -> bool {
    if !q.enabled {
        return false;
    }
    let (Some(start), Some(end)) = (parse_hhmm(&q.start), parse_hhmm(&q.end)) else { return false };
    match start.cmp(&end) {
        std::cmp::Ordering::Less => minute >= start && minute < end,
        std::cmp::Ordering::Greater => minute >= start || minute < end,
        std::cmp::Ordering::Equal => false,
    }
}

fn reminder_minute(n: &NotificationSettings) -> u16 {
    parse_hhmm(&n.reminder_time).unwrap_or(20 * 60)
}

/// Local context for a decision.
#[derive(Clone, Copy, Debug)]
pub struct Now {
    /// Minutes since local midnight.
    pub minute: u16,
    /// Weekday, 0 = Monday.
    pub weekday: u8,
}

impl Now {
    pub fn at(clock: &Clock, ms: i64) -> Self {
        Self { minute: clock.minute_of_day(ms), weekday: clock.hour_and_weekday(ms).1 }
    }
}

/// A goal-reached notification to send now.
#[derive(Clone, Debug, PartialEq)]
pub struct GoalNotice {
    pub tokens: u64,
    pub streak: u32,
}

/// A streak-at-risk reminder to send now.
#[derive(Clone, Debug, PartialEq)]
pub struct AtRiskNotice {
    pub streak: u32,
    pub remaining: u64,
}

pub fn goal_notice(snap: &AppSnapshot, settings: &Settings, state: &AppState, now: Now) -> Option<GoalNotice> {
    let n = &settings.notifications;
    let due = n.goal_reached
        && snap.onboarding.completed
        && snap.today.met
        && state.goal_notified_on.as_deref() != Some(snap.today.date.as_str())
        && !in_quiet_hours(&n.quiet_hours, now.minute);
    due.then_some(GoalNotice { tokens: snap.today.tokens.total, streak: snap.streak.current })
}

pub fn at_risk_notice(snap: &AppSnapshot, settings: &Settings, state: &AppState, now: Now) -> Option<AtRiskNotice> {
    let n = &settings.notifications;
    let due = n.streak_at_risk
        && snap.onboarding.completed
        && snap.goals.daily > 0
        && snap.streak.at_risk
        && snap.streak.current > 0
        && !snap.today.met
        && !settings.rest_days.contains(&now.weekday)
        && now.minute >= reminder_minute(n)
        && !in_quiet_hours(&n.quiet_hours, now.minute)
        && state.at_risk_notified_on.as_deref() != Some(snap.today.date.as_str());
    due.then_some(AtRiskNotice { streak: snap.streak.current, remaining: snap.today.remaining })
}

/// Milliseconds until the reminder should next be evaluated today (the
/// reminder time, or the end of quiet hours after it), or `None` when it
/// already went out today, is off, or its time has passed.
pub fn ms_until_reminder(
    snap: &AppSnapshot,
    settings: &Settings,
    state: &AppState,
    clock: &Clock,
    now_ms: i64,
) -> Option<i64> {
    let n = &settings.notifications;
    if !n.streak_at_risk || state.at_risk_notified_on.as_deref() == Some(snap.today.date.as_str()) {
        return None;
    }
    let today = parse_date(&snap.today.date)?;
    let mut target = reminder_minute(n);
    if in_quiet_hours(&n.quiet_hours, target) {
        let end = parse_hhmm(&n.quiet_hours.end)?;
        if end <= target {
            return None; // quiet until after midnight
        }
        target = end;
    }
    let at = clock.instant_at(today, target)?;
    (at > now_ms).then_some(at - now_ms)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::*;

    fn snap(met: bool, streak: u32) -> AppSnapshot {
        AppSnapshot {
            schema_version: 1,
            generated_at: String::new(),
            timezone: "UTC".into(),
            today: TodayView {
                date: "2026-09-26".into(),
                met,
                goal: 1000,
                remaining: if met { 0 } else { 400 },
                ..Default::default()
            },
            streak: StreakView { current: streak, today_met: met, at_risk: streak > 0 && !met, ..Default::default() },
            goals: GoalsView { daily: 1000, ..Default::default() },
            days: vec![],
            weeks: vec![],
            months: vec![],
            lifetime: LifetimeView::default(),
            achievements: vec![],
            sources: vec![],
            pricing: PricingInfo::default(),
            status: EngineStatus::default(),
            onboarding: OnboardingView { completed: true, ..Default::default() },
            celebration: None,
        }
    }

    fn at(h: u16, m: u16) -> Now {
        Now { minute: h * 60 + m, weekday: 5 } // Saturday
    }

    fn on() -> Settings {
        let mut s = Settings::default();
        s.notifications.streak_at_risk = true;
        s
    }

    #[test]
    fn hhmm_and_quiet_hours() {
        assert_eq!(parse_hhmm("20:00"), Some(1200));
        assert_eq!(parse_hhmm("7:05"), Some(425));
        assert_eq!(parse_hhmm("24:00"), None);
        assert_eq!(parse_hhmm("nope"), None);
        let q = QuietHours { enabled: true, start: "22:00".into(), end: "08:00".into() };
        assert!(in_quiet_hours(&q, 23 * 60));
        assert!(in_quiet_hours(&q, 7 * 60 + 59));
        assert!(!in_quiet_hours(&q, 8 * 60));
        assert!(!in_quiet_hours(&q, 21 * 60 + 59));
        let day = QuietHours { enabled: true, start: "12:00".into(), end: "13:00".into() };
        assert!(in_quiet_hours(&day, 12 * 60 + 30));
        assert!(!in_quiet_hours(&day, 13 * 60));
        assert!(!in_quiet_hours(&QuietHours { enabled: false, ..q }, 23 * 60));
    }

    #[test]
    fn at_risk_fires_once_after_reminder_time() {
        let s = on();
        let mut st = AppState::default();
        let sn = snap(false, 5);
        assert_eq!(at_risk_notice(&sn, &s, &st, at(19, 59)), None);
        assert_eq!(at_risk_notice(&sn, &s, &st, at(20, 0)), Some(AtRiskNotice { streak: 5, remaining: 400 }));
        st.at_risk_notified_on = Some("2026-09-26".into());
        assert_eq!(at_risk_notice(&sn, &s, &st, at(21, 0)), None);
        // A new day resets it.
        let mut next = sn.clone();
        next.today.date = "2026-09-27".into();
        assert!(at_risk_notice(&next, &s, &st, at(21, 0)).is_some());
    }

    #[test]
    fn at_risk_respects_opt_in_goal_rest_days_and_quiet_hours() {
        let st = AppState::default();
        let sn = snap(false, 5);
        assert!(at_risk_notice(&sn, &Settings::default(), &st, at(21, 0)).is_none(), "off by default");
        assert!(at_risk_notice(&snap(true, 5), &on(), &st, at(21, 0)).is_none(), "goal met");
        assert!(at_risk_notice(&snap(false, 0), &on(), &st, at(21, 0)).is_none(), "no streak");
        let mut rest = on();
        rest.rest_days = vec![5];
        assert!(at_risk_notice(&sn, &rest, &st, at(21, 0)).is_none(), "rest day");
        let mut quiet = on();
        quiet.notifications.quiet_hours = QuietHours { enabled: true, start: "20:30".into(), end: "07:00".into() };
        assert!(at_risk_notice(&sn, &quiet, &st, at(20, 10)).is_some());
        assert!(at_risk_notice(&sn, &quiet, &st, at(21, 0)).is_none(), "quiet hours");
        let mut not_onboarded = sn.clone();
        not_onboarded.onboarding.completed = false;
        assert!(at_risk_notice(&not_onboarded, &on(), &st, at(21, 0)).is_none());
    }

    #[test]
    fn goal_notice_once_per_day_and_deferred_by_quiet_hours() {
        let s = Settings::default();
        let mut st = AppState::default();
        let sn = snap(true, 3);
        assert_eq!(goal_notice(&sn, &s, &st, at(15, 0)), Some(GoalNotice { tokens: 0, streak: 3 }));
        assert!(goal_notice(&snap(false, 3), &s, &st, at(15, 0)).is_none());
        let mut quiet = s.clone();
        quiet.notifications.quiet_hours = QuietHours { enabled: true, start: "00:00".into(), end: "08:00".into() };
        assert!(goal_notice(&sn, &quiet, &st, at(7, 0)).is_none());
        assert!(goal_notice(&sn, &quiet, &st, at(8, 0)).is_some(), "sent when quiet hours end");
        st.goal_notified_on = Some("2026-09-26".into());
        assert!(goal_notice(&sn, &s, &st, at(15, 0)).is_none());
        let mut off = s.clone();
        off.notifications.goal_reached = false;
        assert!(goal_notice(&sn, &off, &AppState::default(), at(15, 0)).is_none());
    }

    #[test]
    fn reminder_wakeup() {
        let clock = Clock::named(Some("America/New_York"));
        let s = on();
        let st = AppState::default();
        let sn = snap(false, 2);
        let noon = crate::time::parse_ts("2026-09-26T16:00:00Z").unwrap(); // 12:00 EDT
        assert_eq!(ms_until_reminder(&sn, &s, &st, &clock, noon), Some(8 * 3_600_000));
        let late = crate::time::parse_ts("2026-09-27T01:00:00Z").unwrap(); // 21:00 EDT
        assert_eq!(ms_until_reminder(&sn, &s, &st, &clock, late), None);
        let mut q = s.clone();
        q.notifications.quiet_hours = QuietHours { enabled: true, start: "19:00".into(), end: "20:30".into() };
        assert_eq!(ms_until_reminder(&sn, &q, &st, &clock, noon), Some(8 * 3_600_000 + 30 * 60_000));
        q.notifications.quiet_hours = QuietHours { enabled: true, start: "19:00".into(), end: "07:00".into() };
        assert_eq!(ms_until_reminder(&sn, &q, &st, &clock, noon), None);
    }
}
