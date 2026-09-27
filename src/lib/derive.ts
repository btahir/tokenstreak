// Pure view logic: turns the IPC snapshot into what the screens draw. No DOM,
// no React, so every rule here is unit-tested (derive.test.ts).

import type { AppSnapshot, Breakdown, DayRow, TodayView, TokenCounts, Tool } from "../api/types";
import { tierFor, nextTier } from "../trail/Trail";
import type { ToolShares, TrailData, TrailDay } from "../trail/types";
import { addDays, formatDate, friendlyGoal, parseDate } from "./format";

/* ---------------- per-day helpers ---------------- */

/**
 * Cache share for a day row: cacheRead / (input + cacheRead + cacheWrite) when
 * the row carries the split, else cacheRead / total as an approximation.
 */
export function dayCacheShare(d: Pick<DayRow, "cacheRead" | "total"> & Partial<Pick<DayRow, "input" | "cacheWrite">>): number {
  if (d.input !== undefined && d.cacheWrite !== undefined) {
    const denom = d.input + d.cacheRead + d.cacheWrite;
    return denom > 0 ? Math.min(1, d.cacheRead / denom) : 0;
  }
  return d.total > 0 ? Math.min(1, d.cacheRead / d.total) : 0;
}

export function dayTools(d: Pick<DayRow, "claude" | "codex" | "gemini" | "total">): ToolShares {
  const sum = d.claude + d.codex + d.gemini;
  if (sum <= 0) return {};
  const out: ToolShares = {};
  if (d.claude) out.claude = d.claude / sum;
  if (d.codex) out.codex = d.codex / sum;
  if (d.gemini) out.gemini = d.gemini / sum;
  return out;
}

/** Exact cache-read share (cacheRead / (input + cacheRead + cacheWrite)), as the core defines it. */
export function cacheShareOf(t: TokenCounts): number {
  const denom = t.input + t.cacheRead + t.cacheWrite;
  return denom > 0 ? t.cacheRead / denom : 0;
}

export function todayTools(t: TodayView): ToolShares {
  const out: ToolShares = {};
  for (const s of t.byTool) if (s.tokens > 0) out[s.tool] = s.share;
  return out;
}

/** 0 = Monday. */
export function weekdayIndex(date: string): number {
  return (parseDate(date).getUTCDay() + 6) % 7;
}

/* ---------------- the Trail ---------------- */

export interface TrailBuildOptions {
  restDays?: number[];
  /** Keep at most this many days (including today). */
  maxDays?: number;
  /** Visual goal when none is set yet (first run). */
  goalFallback?: number;
}

/** Maps the snapshot onto the Trail's data contract. */
export function buildTrailData(snap: AppSnapshot, opts: TrailBuildOptions = {}): TrailData {
  const rest = new Set(opts.restDays ?? snap.streak.restDays ?? []);
  const today = snap.today;
  const goal = today.goal > 0 ? today.goal : opts.goalFallback ?? (snap.goals.suggestedDaily || 0);
  let rows = snap.days.filter((d) => d.date < today.date);
  if (opts.maxDays) rows = rows.slice(-(opts.maxDays - 1));
  const history: TrailDay[] = rows.map((d) => {
    const g = d.goal > 0 ? d.goal : goal;
    const met = d.goal > 0 ? d.met : g > 0 && d.total >= g;
    return {
      date: d.date,
      tokens: d.total,
      goalMet: met,
      frozen: d.frozen || (!met && rest.has(weekdayIndex(d.date))),
      freeze: d.frozen,
      tools: dayTools(d),
      cacheShare: dayCacheShare(d),
      goal: g,
    };
  });
  return {
    goal,
    today: { tokens: today.tokens.total, tools: todayTools(today), cacheShare: cacheShareOf(today.tokens), date: today.date },
    streak: { current: snap.streak.current, best: snap.streak.longest, start: snap.streak.currentStart ?? null },
    history,
  };
}

/**
 * Trail data for an arbitrary span of days (share cards). The last day of the
 * span is the comet's head; days before it are history.
 */
export function buildTrailRange(snap: AppSnapshot, from: string, to: string, opts: { restDays?: number[] } = {}): TrailData {
  const full = buildTrailData(snap, { restDays: opts.restDays });
  if (to >= snap.today.date) return { ...full, history: full.history.filter((d) => d.date >= from) };
  const byDate = new Map(snap.days.map((d) => [d.date, d]));
  const headRow = byDate.get(to);
  const history = full.history.filter((d) => d.date >= from && d.date < to);
  return {
    ...full,
    today: headRow
      ? { tokens: headRow.total, tools: dayTools(headRow), cacheShare: dayCacheShare(headRow), date: to }
      : { tokens: 0, tools: {}, cacheShare: 0, date: to },
    history,
  };
}

/* ---------------- shared windows (dashboard and share cards agree) ---------------- */

/** The rolling year: the last 365 days including today. */
export function yearWindow(today: string): { from: string; to: string } {
  return { from: addDays(today, -364), to: today };
}

export interface SpanSummary {
  from: string;
  to: string;
  tokens: number;
  daysLit: number;
  activeDays: number;
  cacheShare: number;
  cost: number;
  busiest: { date: string; total: number } | null;
}

/** Totals over [from, to] from the dense day rows. Cache share uses the exact definition when rows carry it. */
export function spanSummary(days: DayRow[], from: string, to: string): SpanSummary {
  const rows = days.filter((d) => d.date >= from && d.date <= to);
  let tokens = 0;
  let cost = 0;
  let cache = 0;
  let denom = 0;
  let busiest: DayRow | null = null;
  for (const d of rows) {
    tokens += d.total;
    cost += d.cost;
    cache += d.cacheRead;
    denom += d.input !== undefined && d.cacheWrite !== undefined ? d.input + d.cacheRead + d.cacheWrite : d.total;
    if (d.total > 0 && (!busiest || d.total > busiest.total)) busiest = d;
  }
  return {
    from,
    to,
    tokens,
    daysLit: rows.filter((d) => d.met).length,
    activeDays: rows.filter((d) => d.total > 0).length,
    cacheShare: denom > 0 ? cache / denom : 0,
    cost,
    busiest: busiest ? { date: busiest.date, total: busiest.total } : null,
  };
}

/** Longest run of lit days inside [from, to] (runs bridged by rest days or freezes continue). */
export function bestRunIn(days: DayRow[], from: string, to: string, restDays: number[] = []): number {
  const rest = new Set(restDays);
  let run = 0;
  let best = 0;
  for (const d of days) {
    if (d.date < from || d.date > to) continue;
    if (d.met) best = Math.max(best, ++run);
    else if (d.frozen || rest.has(weekdayIndex(d.date)) || d.date === to) continue;
    else run = 0;
  }
  return best;
}

/** Accessible one-line summary of the Trail. */
export function trailSummary(snap: AppSnapshot): string {
  const pct = Math.round(snap.today.progress * 100);
  const s = snap.streak.current;
  const best = snap.streak.longest;
  const lead = s > 0 ? `${s}-day streak` : best > 0 ? `No current streak, best run ${best} days` : "Your trail starts today";
  return s > 0 ? `${lead}, today ${pct}% of goal, best ${best} days` : `${lead}, today ${pct}% of goal`;
}

/* ---------------- tiers ---------------- */

export function tierInfo(streak: number): { name: string; id: string; next: string | null; daysToNext: number | null } {
  const t = tierFor(streak);
  const n = nextTier(streak);
  return { name: t.name, id: t.id, next: n?.name ?? null, daysToNext: n ? n.min - streak : null };
}

/* ---------------- week row ---------------- */

export type OrbState = "lit" | "frozen" | "today" | "missed" | "future" | "rest";
export interface Orb {
  date: string;
  label: string;
  state: OrbState;
  progress: number;
}

export function weekOrbs(snap: AppSnapshot): Orb[] {
  const start = snap.goals.thisWeek.start;
  const today = snap.today.date;
  const rest = new Set(snap.streak.restDays);
  const byDate = new Map(snap.days.map((d) => [d.date, d]));
  const letters = snap.goals.weekStartsOn === "sunday" ? ["S", "M", "T", "W", "T", "F", "S"] : ["M", "T", "W", "T", "F", "S", "S"];
  return letters.map((label, i) => {
    const date = addDays(start, i);
    const row = byDate.get(date);
    let state: OrbState;
    let progress = 0;
    if (date > today) state = rest.has(weekdayIndex(date)) ? "rest" : "future";
    else if (date === today) {
      progress = snap.today.progress;
      state = snap.today.met ? "lit" : "today";
    } else if (row?.met) state = "lit";
    else if (row?.frozen || rest.has(weekdayIndex(date))) state = "frozen";
    else state = "missed";
    return { date, label, state, progress };
  });
}

/* ---------------- baselines and deltas ---------------- */

export interface Baseline {
  activeDays: number;
  cacheShare: number;
  /** cacheShare uses the exact definition (rows carry input/cacheWrite). */
  exactCache: boolean;
  costPerMillion: number;
  /** Average estimated cost per active day. */
  costPerDay: number;
  medianTokens: number;
  sessionLow: number;
  sessionHigh: number;
  sessionMedian: number;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/** Your own recent normal: the last `n` active days before today. */
export function baseline(days: DayRow[], today: string, n = 30): Baseline {
  const act = days.filter((d) => d.date < today && d.total > 0).slice(-n);
  const tokens = act.reduce((a, d) => a + d.total, 0);
  const cost = act.reduce((a, d) => a + d.cost, 0);
  const cache = act.reduce((a, d) => a + d.cacheRead, 0);
  const split = act.length > 0 && act.every((d) => d.input !== undefined && d.cacheWrite !== undefined);
  const cacheDenom = split ? act.reduce((a, d) => a + d.input + d.cacheRead + d.cacheWrite, 0) : tokens;
  const perSession = act.filter((d) => d.sessions > 0).map((d) => d.total / d.sessions).sort((a, b) => a - b);
  const totals = act.map((d) => d.total).sort((a, b) => a - b);
  return {
    activeDays: act.length,
    cacheShare: cacheDenom > 0 ? cache / cacheDenom : 0,
    exactCache: split,
    costPerMillion: tokens > 0 ? cost / (tokens / 1e6) : 0,
    costPerDay: act.length ? cost / act.length : 0,
    medianTokens: quantile(totals, 0.5),
    sessionLow: quantile(perSession, 0.25),
    sessionHigh: quantile(perSession, 0.75),
    sessionMedian: quantile(perSession, 0.5),
  };
}

export interface TodayTiles {
  cost: number;
  cacheShare: number;
  /** Percentage points vs usual (approximate shares on both sides); null without history. */
  cacheDeltaPts: number | null;
  perMillion: number;
  /** Fraction leaner than usual (positive = cheaper per token); null without history. */
  leaner: number | null;
  /** Your usual cost on an active day; null without history. */
  usualCost: number | null;
}

export function todayTiles(snap: AppSnapshot): TodayTiles {
  const t = snap.today;
  const total = t.tokens.total;
  const base = baseline(snap.days, t.date);
  const approxToday = base.exactCache ? cacheShareOf(t.tokens) : total > 0 ? t.tokens.cacheRead / total : 0;
  const perMillion = total > 0 ? t.cost / (total / 1e6) : 0;
  const hasBase = base.activeDays >= 3 && total > 0;
  return {
    cost: t.cost,
    cacheShare: cacheShareOf(t.tokens),
    cacheDeltaPts: hasBase ? Math.round((approxToday - base.cacheShare) * 100) : null,
    perMillion,
    leaner: hasBase && base.costPerMillion > 0 ? (base.costPerMillion - perMillion) / base.costPerMillion : null,
    usualCost: base.activeDays >= 3 ? base.costPerDay : null,
  };
}

/** Delta chip copy for today's cache share vs usual (null hides the chip below 2 points). */
export function cacheDeltaCopy(pts: number | null): string | null {
  if (pts === null || Math.abs(pts) < 2) return null;
  return `${Math.abs(pts)} pts ${pts > 0 ? "above" : "under"} usual`;
}

/** Delta chip copy for cost per token vs usual: "12% leaner than usual", "17% pricier than usual". */
export function leanCopy(leaner: number | null, fmtChange: (f: number) => string): string | null {
  if (leaner === null || Math.abs(leaner) < 0.02) return null;
  if (leaner > 0) return `${fmtChange(-leaner)} leaner than usual`;
  // pricier: (perM - usual) / usual = -leaner
  return `${fmtChange(-leaner)} pricier than usual`;
}

/* ---------------- progress copy ---------------- */

/** "82%", or "15×" once far past the goal. */
export function progressLabel(progress: number): string {
  if (progress >= 3) return `${progress >= 10 ? Math.round(progress).toLocaleString("en-US") : Number(progress.toFixed(1))}×`;
  const pct = Math.round(progress * 100);
  // never claim 100% while the goal is unmet
  return `${progress < 1 && pct >= 100 ? 99 : pct}%`;
}

export function progressCopy(t: TodayView): { lead: string; rest: string; pct: string } {
  const pct = progressLabel(t.progress);
  if (t.goal <= 0) return { lead: "", rest: "No daily goal yet", pct: "" };
  if (t.met) {
    const over = t.tokens.total - t.goal;
    return over >= t.goal * 0.01 ? { lead: `+${fmt(over)}`, rest: "past your goal · nicely done", pct } : { lead: "Goal lit", rest: "right on the mark · nicely done", pct };
  }
  if (t.tokens.total === 0) return { lead: fmt(t.goal), rest: "to light today’s trail", pct };
  // the last few hundred tokens read as "Under 1K", never "2 to light"
  return { lead: t.remaining < 1000 ? "Under 1K" : fmt(t.remaining), rest: "to light today’s trail", pct };
}

// local import-free copy of formatTokens to keep this module light for tests
function fmt(n: number): string {
  const abs = Math.abs(n);
  const u = (v: number, s: string) => `${v >= 100 ? Math.round(v) : String(Number(v.toFixed(1)))}${s}`;
  if (abs >= 1e9) return u(abs / 1e9, "B");
  if (abs >= 1e6) return u(abs / 1e6, "M");
  if (abs >= 1e4) return `${Math.round(abs / 1e3)}K`;
  if (abs >= 1e3) return `${Number((abs / 1e3).toFixed(1))}K`;
  return String(Math.round(abs));
}

export type StreakMood = "lit" | "risk" | "idle" | "broken" | "none";

export function streakMood(snap: AppSnapshot): StreakMood {
  const s = snap.streak;
  if (s.todayMet) return "lit";
  if (s.atRisk) return "risk";
  if (s.current > 0) return "idle";
  return s.longest > 0 ? "broken" : "none";
}

export function celebrationLine(streak: number, newRecord: boolean): string {
  if (newRecord && streak > 1) return `Goal lit. A new record: ${streak} days.`;
  if (streak <= 1) return "Goal lit. Your trail begins.";
  return `Goal lit. ${streak} days and counting.`;
}

/* ---------------- efficiency ---------------- */

export interface Contributor {
  key: "cache" | "cost" | "payoff" | "focus";
  label: string;
  value: string;
  score: number;
}

export interface EfficiencyView {
  score: number;
  word: string;
  line: string;
  contributors: Contributor[];
}

export function efficiencyWord(score: number): string {
  if (score >= 90) return "Brilliant";
  if (score >= 80) return "Sharp";
  if (score >= 60) return "Smooth";
  if (score >= 40) return "Steady";
  return "Warming up";
}

const c01 = (v: number) => Math.max(0, Math.min(1, v));

/**
 * 0–100 score for a period against your own baseline. Each contributor blends an
 * absolute reading (what "good" looks like for anyone) with a relative one (you
 * vs your last 30 active days), so steady habits score well and improvements
 * score better.
 */
export function efficiency(period: { tokens: TokenCounts; cost: number; sessions: number }, base: Baseline, fmtUsd: (n: number) => string): EfficiencyView {
  const t = period.tokens;
  const total = t.total;
  const share = cacheShareOf(t);
  const approxShare = base.exactCache ? share : total > 0 ? t.cacheRead / total : 0;
  const perM = total > 0 ? period.cost / (total / 1e6) : 0;
  const payoff = t.cacheWrite > 0 ? t.cacheRead / t.cacheWrite : t.cacheRead > 0 ? 50 : 0;
  const perSession = period.sessions > 0 ? total / period.sessions : 0;
  const hasBase = base.activeDays >= 3;

  const cacheAbs = c01(share);
  const cacheRel = hasBase ? c01(0.6 + (approxShare - base.cacheShare) * 4) : cacheAbs;
  const costAbs = c01(1 - Math.log10(Math.max(perM, 0.05) / 0.25) / Math.log10(40));
  const costRel = hasBase && base.costPerMillion > 0 ? c01(0.6 + ((base.costPerMillion - perM) / base.costPerMillion) * 1.5) : costAbs;
  const payoffAbs = c01(Math.log10(Math.max(payoff, 1)) / Math.log10(30));
  const lo = base.sessionLow;
  const hi = base.sessionHigh;
  let focus = 0.7;
  if (hasBase && perSession > 0 && hi > 0) {
    if (perSession >= lo && perSession <= hi) focus = 1;
    else {
      const d = perSession < lo ? (lo - perSession) / Math.max(lo, 1) : (perSession - hi) / hi;
      focus = c01(1 - d * 0.8);
    }
  }
  const cs = total > 0 ? (cacheAbs + cacheRel) / 2 : 0;
  const ks = total > 0 ? (costAbs + costRel) / 2 : 0;
  const contributors: Contributor[] = [
    { key: "cache", label: "Cache reuse", value: `${Math.round(share * 100)}%`, score: cs },
    { key: "cost", label: "Cost per 1M", value: fmtUsd(perM), score: ks },
    { key: "payoff", label: "Cache payoff", value: payoff >= 50 && t.cacheWrite === 0 ? "—" : `${payoff >= 100 ? Math.round(payoff) : Number(payoff.toFixed(1))}×`, score: total > 0 ? payoffAbs : 0 },
    { key: "focus", label: "Session focus", value: perSession > 0 ? fmt(perSession) : "—", score: total > 0 ? focus : 0 },
  ];
  const score = total > 0 ? Math.round((cs * 0.34 + ks * 0.26 + payoffAbs * 0.2 + focus * 0.2) * 100) : 0;
  const word = total > 0 ? efficiencyWord(score) : "Resting";
  let line: string;
  if (total === 0) line = "No tokens yet today. The score wakes up with your first session.";
  else if (score >= 80) line = `Lean and warm. ${Math.round(share * 100)}% of context came from cache, not re-sent.`;
  else if (score >= 60) line = `A smooth day. ${Math.round(share * 100)}% of context came from cache.`;
  else if (score >= 40) line = `Steady. Longer sessions reuse more cache and cost less per token.`;
  else line = `Warming up. Fresh sessions re-send context; staying in one reuses it.`;
  return { score, word, line, contributors };
}

/* ---------------- heatmap ---------------- */

/** 0 = none, 1 = under half, 2 = under goal, 3 = lit, 4 = blazing (≥1.8×). */
export function heatLevel(total: number, goal: number): 0 | 1 | 2 | 3 | 4 {
  if (total <= 0) return 0;
  if (goal <= 0) return total > 0 ? 2 : 0;
  const r = total / goal;
  return r < 0.5 ? 1 : r < 1 ? 2 : r < 1.8 ? 3 : 4;
}

export interface HeatCell {
  date: string;
  total: number;
  level: 0 | 1 | 2 | 3 | 4;
  met: boolean;
  /** Bridged: a rest day or a spent streak freeze. */
  frozen: boolean;
  /** A streak freeze was spent on this day. */
  freeze: boolean;
  today: boolean;
  future: boolean;
  pad: boolean;
}

/** A year of columns (weeks) × 7 rows, ending with the week that contains today. */
export function heatmapColumns(days: DayRow[], today: string, weeks = 53, weekStartsOn: "monday" | "sunday" = "monday", restDays: number[] = []): HeatCell[][] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const rest = new Set(restDays);
  const dow = parseDate(today).getUTCDay();
  const offset = weekStartsOn === "monday" ? (dow + 6) % 7 : dow;
  const lastWeekStart = addDays(today, -offset);
  const firstStart = addDays(lastWeekStart, -(weeks - 1) * 7);
  const firstData = days.length ? days[0]!.date : today;
  const cols: HeatCell[][] = [];
  for (let w = 0; w < weeks; w++) {
    const col: HeatCell[] = [];
    for (let r = 0; r < 7; r++) {
      const date = addDays(firstStart, w * 7 + r);
      const row = byDate.get(date);
      const total = row?.total ?? 0;
      const goal = row?.goal ?? 0;
      const met = !!row?.met;
      col.push({
        date,
        total,
        level: heatLevel(total, goal),
        met,
        frozen: !!row?.frozen || (!met && date <= today && date >= firstData && rest.has(weekdayIndex(date)) && total < goal),
        freeze: !!row?.frozen,
        today: date === today,
        future: date > today,
        pad: date < firstData,
      });
    }
    cols.push(col);
  }
  return cols;
}

/* ---------------- goals ---------------- */

export interface GoalPreset {
  key: "gentle" | "steady" | "ambitious";
  label: string;
  value: number;
}

export function goalPresets(suggested: number): GoalPreset[] {
  const s = friendlyGoal(suggested > 0 ? suggested : 500_000);
  return [
    { key: "gentle", label: "Gentle", value: friendlyGoal(s / 2) },
    { key: "steady", label: "Steady", value: s },
    { key: "ambitious", label: "Ambitious", value: friendlyGoal(s * 2) },
  ];
}

/** How a goal sits against your typical day, for copy that matches the number. */
export function goalDirection(goal: number, median: number): "below" | "near" | "above" | "none" {
  if (!(median > 0) || !(goal > 0)) return "none";
  const r = goal / median;
  return r < 0.95 ? "below" : r <= 1.05 ? "near" : "above";
}

/** The weekly goal that goes with a daily goal: six good days. */
export function weeklyFor(daily: number): number {
  return friendlyGoal(daily * 6);
}

/** What your history would look like with `goal` applied to every past day
 * (with streak freezes when `freezes` is on: same rules as goals.rs). */
export function simulateGoal(
  days: DayRow[],
  today: string,
  goal: number,
  restDays: number[] = [],
  freezes = false,
): { lit: number; current: number; best: number; litSet: Set<string> } {
  const rest = new Set(restDays);
  let run = 0;
  let best = 0;
  let lit = 0;
  let held = 0;
  let sinceEarn = 0;
  const litSet = new Set<string>();
  let current = 0;
  const sorted = [...days].sort((a, b) => a.date.localeCompare(b.date));
  for (const d of sorted) {
    const met = goal > 0 && d.total >= goal;
    if (met) {
      lit++;
      litSet.add(d.date);
      run++;
      best = Math.max(best, run);
      if (freezes && ++sinceEarn === 7) {
        sinceEarn = 0;
        held = Math.min(2, held + 1);
      }
    } else if (d.date === today) {
      // today in progress never breaks a streak
    } else if (!rest.has(weekdayIndex(d.date))) {
      if (freezes && run > 0 && held > 0) held--;
      else run = 0;
      sinceEarn = 0;
    }
    if (d.date <= today) current = run;
  }
  return { lit, current, best, litSet };
}

/* ---------------- first-run facts ---------------- */

export interface RevealFacts {
  since: string | null;
  total: number;
  daysShowedUp: number;
  longestRun: number;
  busiest: { date: string; total: number } | null;
  cacheShare: number;
}

export function revealFacts(snap: AppSnapshot, goal: number): RevealFacts {
  const days = snap.days;
  const active = days.filter((d) => d.total > 0);
  const busiest = active.reduce<DayRow | null>((b, d) => (!b || d.total > b.total ? d : b), null);
  const sim = simulateGoal(days, snap.today.date, goal, snap.streak.restDays, snap.streak.freezesEnabled);
  const total = snap.lifetime.tokens.total;
  return {
    since: snap.lifetime.firstDate ?? snap.onboarding.firstActivity,
    total,
    daysShowedUp: active.length,
    longestRun: Math.max(sim.best, snap.streak.longest),
    busiest: busiest ? { date: busiest.date, total: busiest.total } : null,
    cacheShare: cacheShareOf(snap.lifetime.tokens),
  };
}

/* ---------------- charts ---------------- */

export interface BarRow {
  key: string;
  label: string;
  claude: number;
  codex: number;
  gemini: number;
  total: number;
  goal: number | null;
  met: boolean;
  isCurrent: boolean;
}

export function dailyBars(days: DayRow[], today: string, n = 30): BarRow[] {
  const byDate = new Map(days.map((d) => [d.date, d]));
  const out: BarRow[] = [];
  for (let i = n - 1; i >= 0; i--) {
    const date = addDays(today, -i);
    const d = byDate.get(date);
    out.push({
      key: date,
      label: formatDate(date),
      claude: d?.claude ?? 0,
      codex: d?.codex ?? 0,
      gemini: d?.gemini ?? 0,
      total: d?.total ?? 0,
      goal: d?.goal ?? null,
      met: !!d?.met,
      isCurrent: date === today,
    });
  }
  return out;
}

export function periodBars(rows: AppSnapshot["weeks"], kind: "week" | "month", n: number, currentKey?: string): BarRow[] {
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return rows.slice(-n).map((r) => {
    const d = parseDate(r.start);
    const label = kind === "month" ? (d.getUTCMonth() === 0 ? `${MONTHS[0]} ${d.getUTCFullYear()}` : MONTHS[d.getUTCMonth()]!) : formatDate(r.start);
    return {
      key: r.key,
      label,
      claude: r.claude,
      codex: r.codex,
      gemini: r.gemini,
      total: r.total,
      goal: r.goal,
      met: !!r.met,
      isCurrent: currentKey ? r.key === currentKey : false,
    };
  });
}

/** Sum of consecutive windows (e.g. weekly sums for a sparkline). */
export function windowSums(values: number[], size: number): number[] {
  const out: number[] = [];
  for (let i = 0; i + size <= values.length; i += size) out.push(values.slice(i, i + size).reduce((a, b) => a + b, 0));
  return out;
}

/* ---------------- breakdown helpers ---------------- */

export function toolShareLine(b: Breakdown): { tool: Tool; share: number }[] {
  return b.byTool.filter((s) => s.tool).map((s) => ({ tool: s.tool as Tool, share: s.share }));
}

/** Days with any usage in the snapshot (for "days lit" counts). */
export function litDays(days: DayRow[]): number {
  return days.filter((d) => d.met).length;
}

/* ---------------- chart scales ---------------- */

/**
 * "Nice" axis ticks (1, 2, 2.5 or 5 × 10^n steps) covering `max` with about
 * `count` gridlines: 63.7M -> [25M, 50M, 75M], $39.38 -> [$20, $40].
 * Returns the ticks and the domain top.
 */
export function niceTicks(max: number, count = 3): { ticks: number[]; top: number } {
  if (!(max > 0)) return { ticks: [1], top: 1 };
  const raw = max / count;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw * 0.999) ?? 10 * p;
  const n = Math.max(1, Math.ceil(max / step - 1e-9));
  return { ticks: Array.from({ length: n }, (_, i) => +(step * (i + 1)).toPrecision(12)), top: step * n };
}
