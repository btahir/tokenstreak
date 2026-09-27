import { describe, expect, it } from "vitest";
import type { AppSnapshot, DayRow, MockPreset } from "../api/types";
import heavy from "../api/mock/presets/heavy-multi-tool.json";
import streak30 from "../api/mock/presets/streak-30.json";
import atRisk from "../api/mock/presets/streak-at-risk.json";
import reveal from "../api/mock/presets/first-run-reveal.json";
import {
  baseline,
  buildTrailData,
  cacheShareOf,
  celebrationLine,
  dailyBars,
  efficiency,
  efficiencyWord,
  goalPresets,
  heatLevel,
  heatmapColumns,
  progressCopy,
  revealFacts,
  simulateGoal,
  streakMood,
  tierInfo,
  todayTiles,
  weekOrbs,
  windowSums,
} from "./derive";

const snap = (p: unknown) => structuredClone((p as MockPreset).snapshot) as AppSnapshot;

function row(date: string, total: number, extra: Partial<DayRow> = {}): DayRow {
  return { date, total, cost: total / 1e6, claude: total, codex: 0, gemini: 0, cacheRead: total * 0.9, messages: 1, sessions: 1, goal: 100, met: total >= 100, streak: 0, ...extra };
}

describe("buildTrailData", () => {
  it("maps the snapshot onto the Trail contract, excluding today", () => {
    const s = snap(streak30);
    const d = buildTrailData(s, { maxDays: 42 });
    expect(d.history.length).toBe(41);
    expect(d.history.every((h) => h.date < s.today.date)).toBe(true);
    expect(d.today.tokens).toBe(s.today.tokens.total);
    expect(d.goal).toBe(s.today.goal);
    expect(d.streak.current).toBe(s.streak.current);
    const shares = Object.values(d.today.tools).reduce((a, b) => a + (b ?? 0), 0);
    expect(shares).toBeCloseTo(1, 5);
  });
  it("bridges rest days that were not met", () => {
    const s = snap(streak30);
    s.days = [row("2026-09-21", 10), row("2026-09-26", 5)]; // 21st is a Monday
    s.today = { ...s.today, date: "2026-09-26" };
    const d = buildTrailData(s, { restDays: [0] });
    expect(d.history[0]!.frozen).toBe(true);
  });
  it("judges history by a fallback goal before onboarding", () => {
    const s = snap(reveal);
    const d = buildTrailData(s, { goalFallback: 1 });
    expect(d.goal).toBeGreaterThan(0);
    expect(d.history.some((h) => h.goalMet)).toBe(true);
  });
});

describe("week orbs and moods", () => {
  it("shows lit days, today's ring and future days", () => {
    const s = snap(atRisk);
    const orbs = weekOrbs(s);
    expect(orbs).toHaveLength(7);
    const today = orbs.find((o) => o.date === s.today.date)!;
    expect(today.state).toBe("today");
    expect(today.progress).toBeCloseTo(s.today.progress, 5);
    expect(orbs.filter((o) => o.date > s.today.date).every((o) => o.state === "future")).toBe(true);
  });
  it("reads the streak mood", () => {
    expect(streakMood(snap(atRisk))).toBe("risk");
    expect(streakMood(snap(streak30))).toBe("lit");
    const broken = snap(atRisk);
    broken.streak = { ...broken.streak, current: 0, atRisk: false, todayMet: false };
    expect(streakMood(broken)).toBe("broken");
  });
  it("writes the celebration line", () => {
    expect(celebrationLine(24, false)).toBe("Goal lit. 24 days and counting.");
    expect(celebrationLine(13, true)).toBe("Goal lit. A new record: 13 days.");
    expect(celebrationLine(1, false)).toBe("Goal lit. Your trail begins.");
  });
});

describe("progress copy", () => {
  it("counts down, then celebrates the overshoot", () => {
    const t = snap(atRisk).today;
    expect(progressCopy(t).rest).toBe("to light today’s trail");
    expect(progressCopy(t).pct).toBe(`${Math.round(t.progress * 100)}%`);
    const lit = snap(heavy).today;
    expect(progressCopy(lit).lead.startsWith("+")).toBe(true);
    expect(progressCopy({ ...lit, goal: 0 }).rest).toBe("No daily goal yet");
  });
});

describe("tiles and baselines", () => {
  it("compares today with the last 30 active days", () => {
    const s = snap(heavy);
    const b = baseline(s.days, s.today.date);
    expect(b.activeDays).toBe(30);
    expect(b.sessionLow).toBeLessThanOrEqual(b.sessionHigh);
    const t = todayTiles(s);
    expect(t.cacheShare).toBeCloseTo(cacheShareOf(s.today.tokens), 8);
    expect(t.cacheDeltaPts).not.toBeNull();
    expect(t.leaner).not.toBeNull();
  });
  it("has no deltas without history", () => {
    const s = snap(heavy);
    s.days = s.days.slice(-1);
    const t = todayTiles(s);
    expect(t.cacheDeltaPts).toBeNull();
    expect(t.leaner).toBeNull();
  });
});

describe("efficiency score", () => {
  it("names each band", () => {
    expect(efficiencyWord(20)).toBe("Warming up");
    expect(efficiencyWord(45)).toBe("Steady");
    expect(efficiencyWord(65)).toBe("Smooth");
    expect(efficiencyWord(84)).toBe("Sharp");
    expect(efficiencyWord(95)).toBe("Brilliant");
  });
  it("scores 0..100 and rewards cache reuse", () => {
    const s = snap(heavy);
    const base = baseline(s.days, s.today.date);
    const usd = (n: number) => `$${n.toFixed(2)}`;
    const good = efficiency({ tokens: s.today.tokens, cost: s.today.cost, sessions: s.today.sessions }, base, usd);
    expect(good.score).toBeGreaterThanOrEqual(0);
    expect(good.score).toBeLessThanOrEqual(100);
    expect(good.contributors).toHaveLength(4);
    const t = s.today.tokens;
    const wasteful = efficiency({ tokens: { ...t, cacheRead: 0, input: t.total, cacheWrite: 0 }, cost: s.today.cost * 8, sessions: s.today.sessions }, base, usd);
    expect(wasteful.score).toBeLessThan(good.score);
  });
  it("rests on an empty day", () => {
    const s = snap(heavy);
    const e = efficiency({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, other: 0, total: 0 }, cost: 0, sessions: 0 }, baseline(s.days, s.today.date), String);
    expect(e.score).toBe(0);
    expect(e.word).toBe("Resting");
  });
});

describe("heatmap", () => {
  it("grades days against the goal in force", () => {
    expect(heatLevel(0, 100)).toBe(0);
    expect(heatLevel(40, 100)).toBe(1);
    expect(heatLevel(90, 100)).toBe(2);
    expect(heatLevel(120, 100)).toBe(3);
    expect(heatLevel(200, 100)).toBe(4);
  });
  it("lays out 53 weeks ending with today's week", () => {
    const s = snap(heavy);
    const cols = heatmapColumns(s.days, s.today.date, 53, "monday");
    expect(cols).toHaveLength(53);
    expect(cols.every((c) => c.length === 7)).toBe(true);
    const flat = cols.flat();
    expect(flat.filter((c) => c.today)).toHaveLength(1);
    expect(flat[0]!.date < s.today.date).toBe(true);
    // weeks start on Monday
    expect(new Date(`${cols[5]![0]!.date}T12:00:00Z`).getUTCDay()).toBe(1);
  });
});

describe("goals", () => {
  it("offers gentle, steady and ambitious presets around the suggestion", () => {
    const p = goalPresets(480_000);
    expect(p.map((x) => x.value)).toEqual([200_000, 500_000, 1_000_000]);
  });
  it("simulates a goal over history, with today never breaking the run", () => {
    const days = [row("2026-09-20", 150), row("2026-09-21", 150), row("2026-09-22", 10), row("2026-09-23", 150), row("2026-09-24", 150), row("2026-09-25", 150), row("2026-09-26", 20)];
    const sim = simulateGoal(days, "2026-09-26", 100);
    expect(sim.lit).toBe(5);
    expect(sim.best).toBe(3);
    expect(sim.current).toBe(3);
  });
  it("lets rest days bridge a streak", () => {
    const days = [row("2026-09-19", 150), row("2026-09-20", 0), row("2026-09-21", 150)]; // 20th is a Sunday
    expect(simulateGoal(days, "2026-09-21", 100, [6]).current).toBe(2);
    expect(simulateGoal(days, "2026-09-21", 100, []).current).toBe(1);
  });
  it("collects first-run facts", () => {
    const s = snap(reveal);
    const f = revealFacts(s, s.goals.suggestedDaily);
    expect(f.total).toBe(s.lifetime.tokens.total);
    expect(f.daysShowedUp).toBeGreaterThan(0);
    expect(f.busiest!.total).toBe(Math.max(...s.days.map((d) => d.total)));
  });
});

describe("charts and tiers", () => {
  it("builds 30 daily bars ending today", () => {
    const s = snap(heavy);
    const bars = dailyBars(s.days, s.today.date, 30);
    expect(bars).toHaveLength(30);
    expect(bars[29]!.isCurrent).toBe(true);
    expect(bars[29]!.total).toBe(s.today.tokens.total);
  });
  it("sums windows", () => {
    expect(windowSums([1, 2, 3, 4, 5, 6, 7], 3)).toEqual([6, 15]);
  });
  it("names tiers and the next one", () => {
    expect(tierInfo(0)).toMatchObject({ name: "Kindling", next: "Ember", daysToNext: 1 });
    expect(tierInfo(23)).toMatchObject({ name: "Glow", next: "Comet", daysToNext: 7 });
    expect(tierInfo(400)).toMatchObject({ name: "Halo", next: null, daysToNext: null });
  });
});
