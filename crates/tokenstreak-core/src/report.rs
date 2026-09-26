//! Builds the IPC views (snapshot, breakdowns, share cards, CSV) from the ledger.

use std::collections::{BTreeMap, BTreeSet};

use jiff::civil::Date;
use jiff::ToSpan;
use rustc_hash::{FxHashMap, FxHashSet};

use crate::aggregate::{Ledger, LedgerEvent};
use crate::api::*;
use crate::goals::{self, GoalHistory, StreakResult};
use crate::model::{TokenCounts, Tool, NO_MODEL};
use crate::state::AppState;
use crate::time::Clock;

/// Per-day aggregate.
#[derive(Clone, Debug, Default)]
pub struct DayAgg {
    pub tokens: TokenCounts,
    pub cost: f64,
    pub by_tool: [u64; 3],
    pub cost_by_tool: [f64; 3],
    pub messages: u32,
    pub sessions: u32,
    pub hourly: [u64; 24],
    pub last_ts: i64,
}

fn add(tc: &mut TokenCounts, e: &LedgerEvent) {
    tc.input += e.input;
    tc.output += e.output;
    tc.cache_write += e.cache_write;
    tc.cache_read += e.cache_read;
    tc.reasoning += e.reasoning;
    tc.other += e.other;
    tc.total += e.total();
}

pub fn daily(ledger: &Ledger) -> BTreeMap<Date, DayAgg> {
    let mut out: BTreeMap<Date, DayAgg> = BTreeMap::new();
    let mut sessions: FxHashSet<(Date, u32)> = FxHashSet::default();
    for e in &ledger.events {
        let d = out.entry(e.date).or_default();
        add(&mut d.tokens, e);
        d.cost += e.cost;
        d.by_tool[e.tool.index()] += e.total();
        d.cost_by_tool[e.tool.index()] += e.cost;
        d.messages += 1;
        d.hourly[e.hour as usize] += e.total();
        d.last_ts = d.last_ts.max(e.ts_ms);
        if sessions.insert((e.date, e.session)) {
            d.sessions += 1;
        }
    }
    out
}

/// Everything needed to build a snapshot.
pub struct SnapshotInput<'a> {
    pub ledger: &'a Ledger,
    pub settings: &'a Settings,
    pub state: &'a AppState,
    pub clock: &'a Clock,
    pub now_ms: i64,
    pub sources: Vec<SourceStatus>,
    pub pricing: PricingInfo,
    pub status: EngineStatus,
}

/// Goal history with a virtual first goal when the user has not set one yet.
pub fn effective_goals(state: &AppState, totals: &BTreeMap<Date, u64>, today: Date) -> GoalHistory {
    let h = GoalHistory::from_changes(&state.goal_history);
    if !h.is_empty() {
        return h;
    }
    let (d, w) = goals::suggest(totals, today);
    let from = totals.keys().next().copied().unwrap_or(today);
    GoalHistory(vec![goals::Goal { from, daily: d, weekly: w }])
}

pub struct Computed {
    pub days: BTreeMap<Date, DayAgg>,
    pub totals: BTreeMap<Date, u64>,
    pub goals: GoalHistory,
    pub streaks: StreakResult,
    pub today: Date,
}

pub fn compute(ledger: &Ledger, settings: &Settings, state: &AppState, clock: &Clock, now_ms: i64) -> Computed {
    let days = daily(ledger);
    let totals: BTreeMap<Date, u64> = days.iter().map(|(d, a)| (*d, a.tokens.total)).collect();
    let today = clock.date_of(now_ms);
    let goals = effective_goals(state, &totals, today);
    let streaks = goals::evaluate(&totals, &goals, today, &settings.rest_days, settings.week_starts_on);
    Computed { days, totals, goals, streaks, today }
}

pub fn snapshot(input: SnapshotInput<'_>) -> AppSnapshot {
    let SnapshotInput { ledger, settings, state, clock, now_ms, sources, pricing, status } = input;
    let c = compute(ledger, settings, state, clock, now_ms);
    let today = c.today;
    let tagg = c.days.get(&today).cloned().unwrap_or_default();
    let goal_now = c.goals.at(today).unwrap_or(goals::Goal { from: today, daily: 0, weekly: 0 });

    // Today.
    let by_tool = tool_slices(&tagg.by_tool, &tagg.cost_by_tool);
    let recent: Vec<u64> = c
        .totals
        .range(today.checked_sub(30.days()).unwrap_or(today)..today)
        .map(|(_, t)| *t)
        .filter(|t| *t > 0)
        .collect();
    let avg = if recent.is_empty() { None } else { Some(recent.iter().sum::<u64>() as f64 / recent.len() as f64) };
    let today_view = TodayView {
        date: today.to_string(),
        tokens: tagg.tokens,
        cost: tagg.cost,
        goal: goal_now.daily,
        progress: ratio(tagg.tokens.total, goal_now.daily),
        met: goal_now.daily > 0 && tagg.tokens.total >= goal_now.daily,
        remaining: goal_now.daily.saturating_sub(tagg.tokens.total),
        by_tool,
        hourly: tagg.hourly.to_vec(),
        sessions: tagg.sessions,
        messages: tagg.messages,
        last_activity_at: ledger.events.last().map(|e| crate::time::format_rfc3339_ms(e.ts_ms)),
        vs_recent_average: avg.filter(|a| *a > 0.0).map(|a| tagg.tokens.total as f64 / a),
    };

    // Days (dense).
    let mut days = Vec::new();
    if let Some(first) = c.totals.keys().next().copied() {
        let mut d = first.min(today);
        while d <= today {
            days.push(day_row(d, c.days.get(&d), &c.streaks));
            match d.tomorrow() {
                Ok(n) => d = n,
                Err(_) => break,
            }
        }
    }

    // Weeks and months.
    let weeks = c
        .streaks
        .weeks
        .iter()
        .map(|&(start, _, goal, met)| {
            let end = start.checked_add(6.days()).unwrap_or(start);
            let mut row = period(&c.days, start, end, start.to_string());
            row.goal = Some(goal);
            row.met = Some(met);
            row
        })
        .collect();
    let mut months = Vec::new();
    if let Some(first) = c.totals.keys().next().copied() {
        let mut m = first.first_of_month();
        while m <= today {
            let end = m.last_of_month();
            months.push(period(&c.days, m, end, m.strftime("%Y-%m").to_string()));
            match m.checked_add(1.month()) {
                Ok(n) => m = n,
                Err(_) => break,
            }
        }
    }

    // This week.
    let ws = goals::week_start(today, settings.week_starts_on);
    let we = ws.checked_add(6.days()).unwrap_or(ws);
    let week_tokens: u64 = c.totals.range(ws..=we).map(|(_, t)| *t).sum();
    let this_week = WeekProgress {
        start: ws.to_string(),
        end: we.to_string(),
        tokens: week_tokens,
        goal: goal_now.weekly,
        progress: ratio(week_tokens, goal_now.weekly),
        met: goal_now.weekly > 0 && week_tokens >= goal_now.weekly,
        days_left: (we.since(today).map(|s| s.get_days()).unwrap_or(0)).max(0) as u32,
    };
    let (sd, sw) = goals::suggest(&c.totals, today);
    let goals_view = GoalsView {
        daily: goal_now.daily,
        weekly: goal_now.weekly,
        week_starts_on: settings.week_starts_on,
        this_week,
        history: GoalHistory::from_changes(&state.goal_history).to_changes(),
        suggested_daily: sd,
        suggested_weekly: sw,
    };

    let streak = StreakView {
        current: c.streaks.current,
        longest: c.streaks.longest,
        longest_start: c.streaks.longest_start.map(|d| d.to_string()),
        longest_end: c.streaks.longest_end.map(|d| d.to_string()),
        current_start: c.streaks.current_start.map(|d| d.to_string()),
        today_met: c.streaks.today_met,
        at_risk: !c.streaks.today_met && c.streaks.current > 0,
        weekly_current: c.streaks.weekly_current,
        weekly_longest: c.streaks.weekly_longest,
        rest_days: settings.rest_days.clone(),
    };

    let lifetime = lifetime(ledger, &c);
    let achievements =
        crate::achievements::compute(ledger, &c.totals, &c.streaks, &state.unlocked, &state.seen_achievements);

    let celebration = if c.streaks.today_met && !state.celebrated_dates.iter().any(|d| d == &today.to_string()) {
        Some(Celebration {
            date: today.to_string(),
            tokens: tagg.tokens.total,
            goal: goal_now.daily,
            streak: c.streaks.current,
            new_record: c.streaks.current >= c.streaks.longest && c.streaks.current > 1,
        })
    } else {
        None
    };

    let tools_found: Vec<Tool> = sources.iter().filter(|s| s.found).map(|s| s.tool).collect();
    let onboarding = OnboardingView {
        completed: state.onboarding_completed_at.is_some(),
        tools_found,
        first_activity: c.totals.keys().next().map(|d| d.to_string()),
        active_days: c.totals.values().filter(|t| **t > 0).count() as u32,
    };

    AppSnapshot {
        schema_version: SCHEMA_VERSION,
        generated_at: crate::time::format_rfc3339_ms(now_ms),
        timezone: clock.name(),
        today: today_view,
        streak,
        goals: goals_view,
        days,
        weeks,
        months,
        lifetime,
        achievements,
        sources,
        pricing,
        status,
        onboarding,
        celebration,
    }
}

fn ratio(a: u64, b: u64) -> f64 {
    if b == 0 {
        0.0
    } else {
        a as f64 / b as f64
    }
}

fn tool_slices(by: &[u64; 3], cost: &[f64; 3]) -> Vec<ToolSlice> {
    let total: u64 = by.iter().sum();
    Tool::ALL
        .iter()
        .map(|t| ToolSlice { tool: *t, tokens: by[t.index()], cost: cost[t.index()], share: ratio(by[t.index()], total) })
        .collect()
}

fn day_row(d: Date, a: Option<&DayAgg>, s: &StreakResult) -> DayRow {
    let ev = s.days.get(&d).copied().unwrap_or_default();
    let a = a.cloned().unwrap_or_default();
    DayRow {
        date: d.to_string(),
        total: a.tokens.total,
        cost: a.cost,
        claude: a.by_tool[0],
        codex: a.by_tool[1],
        gemini: a.by_tool[2],
        cache_read: a.tokens.cache_read,
        messages: a.messages,
        sessions: a.sessions,
        goal: ev.goal,
        met: ev.met,
        streak: ev.streak,
    }
}

fn period(days: &BTreeMap<Date, DayAgg>, start: Date, end: Date, key: String) -> PeriodRow {
    let mut r = PeriodRow { key, start: start.to_string(), end: end.to_string(), ..Default::default() };
    for (_, a) in days.range(start..=end) {
        r.total += a.tokens.total;
        r.cost += a.cost;
        r.claude += a.by_tool[0];
        r.codex += a.by_tool[1];
        r.gemini += a.by_tool[2];
        if a.tokens.total > 0 {
            r.active_days += 1;
        }
    }
    r
}

fn lifetime(ledger: &Ledger, c: &Computed) -> LifetimeView {
    let mut tokens = TokenCounts::default();
    let mut cost = 0.0;
    let mut savings = 0.0;
    let mut by_tool = [0u64; 3];
    let mut by_model: FxHashMap<u32, u64> = FxHashMap::default();
    let mut sessions: FxHashSet<u32> = FxHashSet::default();
    let mut projects: FxHashSet<u32> = FxHashSet::default();
    for e in &ledger.events {
        add(&mut tokens, e);
        cost += e.cost;
        savings += e.cache_savings;
        by_tool[e.tool.index()] += e.total();
        if e.model != NO_MODEL {
            *by_model.entry(e.model).or_default() += e.total();
        }
        sessions.insert(e.session);
        projects.insert(e.project);
    }
    let best = c.totals.iter().max_by_key(|(_, t)| **t).filter(|(_, t)| **t > 0);
    LifetimeView {
        tokens,
        cost,
        active_days: c.totals.values().filter(|t| **t > 0).count() as u32,
        first_date: c.totals.keys().next().map(|d| d.to_string()),
        sessions: sessions.len() as u32,
        messages: ledger.events.len() as u32,
        best_day: best.map(|(d, t)| BestDay { date: d.to_string(), tokens: *t }),
        favorite_tool: Tool::ALL.iter().copied().filter(|t| by_tool[t.index()] > 0).max_by_key(|t| by_tool[t.index()]),
        favorite_model: by_model.iter().max_by_key(|(_, v)| **v).map(|(m, _)| ledger.models[*m as usize].clone()),
        models_used: by_model.len() as u32,
        projects: projects.len() as u32,
        cache_savings: savings,
    }
}

/// Resolves a range query to inclusive local dates.
pub fn resolve_range(q: &RangeQuery, today: Date, first: Option<Date>, ws: WeekStart) -> (Date, Date) {
    let back = |n: i64| today.checked_sub(n.days()).unwrap_or(today);
    match q.kind {
        RangeKind::Today => (today, today),
        RangeKind::Yesterday => (back(1), back(1)),
        RangeKind::Last7 => (back(6), today),
        RangeKind::Last30 => (back(29), today),
        RangeKind::Last90 => (back(89), today),
        RangeKind::ThisWeek => (goals::week_start(today, ws), today),
        RangeKind::ThisMonth => (today.first_of_month(), today),
        RangeKind::ThisYear => (today.first_of_year(), today),
        RangeKind::All => (first.unwrap_or(today).min(today), today),
        RangeKind::Custom => {
            let f = q.from.as_deref().and_then(|s| s.parse().ok()).unwrap_or(today);
            let t = q.to.as_deref().and_then(|s| s.parse().ok()).unwrap_or(today);
            if f <= t {
                (f, t)
            } else {
                (t, f)
            }
        }
    }
}

pub fn range_label(q: &RangeQuery, from: Date, to: Date) -> String {
    match q.kind {
        RangeKind::Today => "Today".into(),
        RangeKind::Yesterday => "Yesterday".into(),
        RangeKind::Last7 => "Last 7 days".into(),
        RangeKind::Last30 => "Last 30 days".into(),
        RangeKind::Last90 => "Last 90 days".into(),
        RangeKind::ThisWeek => "This week".into(),
        RangeKind::ThisMonth => from.strftime("%B %Y").to_string(),
        RangeKind::ThisYear => from.strftime("%Y").to_string(),
        RangeKind::All => "All time".into(),
        RangeKind::Custom => format!("{from} – {to}"),
    }
}

#[derive(Default)]
struct SliceAcc {
    tokens: TokenCounts,
    cost: f64,
    messages: u32,
    sessions: FxHashSet<u32>,
    tool: Option<Tool>,
}

pub fn breakdown(ledger: &Ledger, c: &Computed, q: &RangeQuery, ws: WeekStart) -> Breakdown {
    let first = c.totals.keys().next().copied();
    let (from, to) = resolve_range(q, c.today, first, ws);
    let mut totals = TokenCounts::default();
    let mut cost = 0.0;
    let mut savings = 0.0;
    let mut by_tool: BTreeMap<Tool, SliceAcc> = BTreeMap::new();
    let mut by_model: FxHashMap<(u32, Tool), SliceAcc> = FxHashMap::default();
    let mut by_project: FxHashMap<u32, SliceAcc> = FxHashMap::default();
    let mut sess: FxHashMap<u32, (Tool, u32, i64, i64, u64, f64, u32, BTreeSet<u32>)> = FxHashMap::default();
    let mut hourly = vec![0u64; 24];
    let mut weekday = vec![0u64; 7];
    let mut active: BTreeSet<Date> = BTreeSet::new();
    let mut messages = 0u32;
    let lo = ledger.events.partition_point(|e| e.date < from);
    for e in ledger.events[lo..].iter().filter(|e| e.date >= from && e.date <= to) {
        add(&mut totals, e);
        cost += e.cost;
        savings += e.cache_savings;
        messages += 1;
        active.insert(e.date);
        hourly[e.hour as usize] += e.total();
        weekday[e.weekday as usize] += e.total();
        for acc in [
            by_tool.entry(e.tool).or_default(),
            by_model.entry((e.model, e.tool)).or_default(),
            by_project.entry(e.project).or_default(),
        ] {
            add(&mut acc.tokens, e);
            acc.cost += e.cost;
            acc.messages += 1;
            acc.sessions.insert(e.session);
            acc.tool = Some(e.tool);
        }
        let s = sess.entry(e.session).or_insert((e.tool, e.project, e.ts_ms, e.ts_ms, 0, 0.0, 0, BTreeSet::new()));
        s.2 = s.2.min(e.ts_ms);
        s.3 = s.3.max(e.ts_ms);
        s.4 += e.total();
        s.5 += e.cost;
        s.6 += 1;
        if e.model != NO_MODEL {
            s.7.insert(e.model);
        }
    }
    let total = totals.total;
    let slice = |key: String, label: String, a: SliceAcc, tool: Option<Tool>| Slice {
        key,
        label,
        tool,
        share: ratio(a.tokens.total, total),
        tokens: a.tokens,
        cost: a.cost,
        messages: a.messages,
        sessions: a.sessions.len() as u32,
    };
    let mut tools: Vec<Slice> = by_tool
        .into_iter()
        .map(|(t, a)| slice(t.as_str().into(), t.display_name().into(), a, Some(t)))
        .collect();
    tools.sort_by(|a, b| b.tokens.total.cmp(&a.tokens.total));
    let mut models: Vec<Slice> = by_model
        .into_iter()
        .map(|((m, t), a)| {
            let name = if m == NO_MODEL { "(no model)".to_string() } else { ledger.models[m as usize].clone() };
            slice(format!("{}:{}", t.as_str(), name), name, a, Some(t))
        })
        .collect();
    models.sort_by(|a, b| b.tokens.total.cmp(&a.tokens.total).then(a.key.cmp(&b.key)));
    let mut projects: Vec<Slice> = by_project
        .into_iter()
        .map(|(p, a)| {
            let info = &ledger.projects[p as usize];
            slice(info.key.clone(), info.label.clone(), a, None)
        })
        .collect();
    projects.sort_by(|a, b| b.tokens.total.cmp(&a.tokens.total).then(a.key.cmp(&b.key)));
    let session_count = sess.len() as u32;
    let mut top: Vec<SessionRow> = sess
        .into_iter()
        .map(|(id, (tool, project, start, end, tokens, cost, msgs, ms))| SessionRow {
            id: format!("s{id}"),
            tool,
            project: ledger.projects[project as usize].label.clone(),
            started_at: crate::time::format_rfc3339_ms(start),
            ended_at: crate::time::format_rfc3339_ms(end),
            tokens,
            cost,
            messages: msgs,
            models: ms.into_iter().map(|m| ledger.models[m as usize].clone()).collect(),
        })
        .collect();
    top.sort_by(|a, b| b.tokens.cmp(&a.tokens).then(a.id.cmp(&b.id)));
    top.truncate(20);

    let mut series = Vec::new();
    let mut d = from;
    while d <= to {
        series.push(day_row(d, c.days.get(&d), &c.streaks));
        match d.tomorrow() {
            Ok(n) => d = n,
            Err(_) => break,
        }
    }
    let prompt = totals.input + totals.cache_read + totals.cache_write;
    let active_days = active.len() as u32;
    Breakdown {
        from: from.to_string(),
        to: to.to_string(),
        cost,
        active_days,
        sessions: session_count,
        messages,
        by_tool: tools,
        by_model: models,
        by_project: projects,
        top_sessions: top,
        hourly,
        weekday,
        efficiency: Efficiency {
            cache_read_share: ratio(totals.cache_read, prompt),
            cache_write_share: ratio(totals.cache_write, prompt),
            output_share: ratio(totals.output, total),
            cost_per_active_day: if active_days == 0 { 0.0 } else { cost / active_days as f64 },
            cost_per_million: if total == 0 { 0.0 } else { cost / (total as f64 / 1e6) },
            tokens_per_session: if session_count == 0 { 0.0 } else { total as f64 / session_count as f64 },
            tokens_per_message: if messages == 0 { 0.0 } else { total as f64 / messages as f64 },
            cache_savings: savings,
        },
        totals,
        series,
    }
}

pub fn share_card(
    ledger: &Ledger,
    c: &Computed,
    opts: &ShareOptions,
    settings: &Settings,
    achievements_unlocked: u32,
) -> ShareCardData {
    let b = breakdown(ledger, c, &opts.range, settings.week_starts_on);
    let from: Date = b.from.parse().unwrap_or(c.today);
    let to: Date = b.to.parse().unwrap_or(c.today);
    let show_projects = opts.include_project_names.unwrap_or(settings.share.show_project_names);
    let by_tool = {
        let mut arr = [0u64; 3];
        let mut costs = [0.0; 3];
        for s in &b.by_tool {
            if let Some(t) = s.tool {
                arr[t.index()] = s.tokens.total;
                costs[t.index()] = s.cost;
            }
        }
        tool_slices(&arr, &costs)
    };
    let mut top_models: Vec<String> = Vec::new();
    for m in &b.by_model {
        if m.label != "(no model)" && !top_models.contains(&m.label) {
            top_models.push(m.label.clone());
        }
        if top_models.len() == 3 {
            break;
        }
    }
    ShareCardData {
        format: opts.format,
        range_label: range_label(&opts.range, from, to),
        from: b.from.clone(),
        to: b.to.clone(),
        total_tokens: b.totals.total,
        cost: settings.share.show_cost.then_some(b.cost),
        streak: c.streaks.current,
        longest_streak: c.streaks.longest,
        active_days: b.active_days,
        goal_days_met: b.series.iter().filter(|d| d.met).count() as u32,
        by_tool,
        top_models,
        top_projects: show_projects.then(|| b.by_project.iter().take(3).map(|p| p.label.clone()).collect()),
        daily: b.series.iter().map(|d| d.total).collect(),
        achievements_unlocked,
        cache_read_share: b.efficiency.cache_read_share,
    }
}

/// Daily CSV export (numbers only; no project names, paths or content).
pub fn csv(c: &Computed, from: Date, to: Date) -> String {
    let mut s = String::from("date,total_tokens,input,output,cache_write,cache_read,claude,codex,gemini,cost_usd_estimate,goal,goal_met,streak\n");
    let mut d = from;
    while d <= to {
        let a = c.days.get(&d).cloned().unwrap_or_default();
        let ev = c.streaks.days.get(&d).copied().unwrap_or_default();
        s.push_str(&format!(
            "{d},{},{},{},{},{},{},{},{},{:.4},{},{},{}\n",
            a.tokens.total,
            a.tokens.input,
            a.tokens.output,
            a.tokens.cache_write,
            a.tokens.cache_read,
            a.by_tool[0],
            a.by_tool[1],
            a.by_tool[2],
            a.cost,
            ev.goal,
            ev.met,
            ev.streak
        ));
        match d.tomorrow() {
            Ok(n) => d = n,
            Err(_) => break,
        }
    }
    s
}
