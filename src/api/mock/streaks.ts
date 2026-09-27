// TypeScript mirror of crates/tokenstreak-core/src/goals.rs, used only by the
// browser mock so goal changes and the live "goal-hit" simulation recompute
// streaks the same way the app does. `streaks.test.ts` checks parity against
// the Rust-generated presets.

import type { DayRow, GoalChange, WeekStart } from "../types";

export interface StreakEval {
  days: { date: string; goal: number; met: boolean; streak: number; frozen: boolean }[];
  current: number;
  currentStart: string | null;
  longest: number;
  longestStart: string | null;
  longestEnd: string | null;
  todayMet: boolean;
  weeklyCurrent: number;
  weeklyLongest: number;
  freezesHeld: number;
  freezesEarned: number;
  freezesUsed: number;
  /** Goal days in the current streak since the last freeze was earned. */
  freezeProgress: number;
}

/** Goal days in a row that earn a streak freeze, and the most held at once (goals.rs rule 6). */
export const FREEZE_EVERY = 7;
export const FREEZE_CAP = 2;

const DAY = 86_400_000;

function toUtc(d: string): number {
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, dd);
}

export function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** 0 = Monday. */
export function weekdayIndex(d: string): number {
  return (new Date(toUtc(d)).getUTCDay() + 6) % 7;
}

export function weekStart(d: string, ws: WeekStart): string {
  const off = ws === "monday" ? weekdayIndex(d) : new Date(toUtc(d)).getUTCDay();
  return fromUtc(toUtc(d) - off * DAY);
}

export function goalAt(history: GoalChange[], d: string): GoalChange | undefined {
  const sorted = [...history].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  let found: GoalChange | undefined;
  for (const g of sorted) if (g.effectiveFrom <= d) found = g;
  return found ?? sorted[0];
}

export function evaluate(
  totals: Map<string, number>,
  history: GoalChange[],
  today: string,
  restDays: number[],
  ws: WeekStart,
  freezes = false,
): StreakEval {
  const r: StreakEval = {
    days: [],
    current: 0,
    currentStart: null,
    longest: 0,
    longestStart: null,
    longestEnd: null,
    todayMet: false,
    weeklyCurrent: 0,
    weeklyLongest: 0,
    freezesHeld: 0,
    freezesEarned: 0,
    freezesUsed: 0,
    freezeProgress: 0,
  };
  const keys = [...totals.keys()].sort();
  if (keys.length === 0) return r;
  const first = keys[0]! < today ? keys[0]! : today;
  let run = 0;
  let runStart: string | null = null;
  let sinceEarn = 0;
  for (let t = toUtc(first); t <= toUtc(today); t += DAY) {
    const d = fromUtc(t);
    const tokens = totals.get(d) ?? 0;
    const goal = goalAt(history, d)?.daily ?? 0;
    const met = goal > 0 && tokens >= goal;
    const rest = restDays.includes(weekdayIndex(d));
    let frozen = false;
    if (met) {
      if (run === 0) runStart = d;
      run += 1;
      if (run > r.longest) {
        r.longest = run;
        r.longestStart = runStart;
        r.longestEnd = d;
      }
      if (freezes) {
        sinceEarn += 1;
        if (sinceEarn === FREEZE_EVERY) {
          sinceEarn = 0;
          if (r.freezesHeld < FREEZE_CAP) {
            r.freezesHeld += 1;
            r.freezesEarned += 1;
          }
        }
      }
    } else if (!(rest || d === today)) {
      if (freezes && run > 0 && r.freezesHeld > 0) {
        r.freezesHeld -= 1;
        r.freezesUsed += 1;
        frozen = true;
        sinceEarn = 0;
      } else {
        run = 0;
        runStart = null;
        sinceEarn = 0;
      }
    }
    r.days.push({ date: d, goal, met, streak: met ? run : 0, frozen });
    if (d === today) r.todayMet = met;
  }
  r.current = run;
  r.currentStart = run > 0 ? runStart : null;
  r.freezeProgress = sinceEarn;

  const thisWeek = weekStart(today, ws);
  let wrun = 0;
  for (let w = toUtc(weekStart(first, ws)); w <= toUtc(thisWeek); w += 7 * DAY) {
    const end = w + 6 * DAY;
    let sum = 0;
    for (let t = w; t <= end; t += DAY) sum += totals.get(fromUtc(t)) ?? 0;
    const goal = goalAt(history, fromUtc(Math.min(end, toUtc(today))))?.weekly ?? 0;
    const met = goal > 0 && sum >= goal;
    if (met) {
      wrun += 1;
      r.weeklyLongest = Math.max(r.weeklyLongest, wrun);
    } else if (fromUtc(w) !== thisWeek) {
      wrun = 0;
    }
  }
  r.weeklyCurrent = wrun;
  return r;
}

export function totalsOf(days: DayRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const d of days) m.set(d.date, d.total);
  return m;
}

/** Replaces the goal version effective `from` (same rule as GoalHistory::set). */
export function setGoal(history: GoalChange[], from: string, daily: number, weekly: number): GoalChange[] {
  const kept = history.filter((g) => g.effectiveFrom < from).sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const last = kept[kept.length - 1];
  if (last && last.daily === daily && last.weekly === weekly) return kept;
  return [...kept, { effectiveFrom: from, daily, weekly }];
}
