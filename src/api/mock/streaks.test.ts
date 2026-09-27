// Parity: the TypeScript streak mirror must agree with the Rust engine on
// every generated preset, and the mock must serve the full API surface.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { MockPreset } from "../types";
import { evaluate, setGoal, totalsOf } from "./streaks";

const dir = join(__dirname, "presets");
const presets: MockPreset[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as MockPreset);

describe("mock presets", () => {
  it("exist for every documented scenario", () => {
    expect(presets.map((p) => p.id).sort()).toEqual(
      ["first-run-reveal", "goal-hit", "heavy-multi-tool", "new-user", "streak-30", "streak-at-risk"].sort(),
    );
  });

  for (const p of presets) {
    it(`${p.id}: TS streaks match Rust`, () => {
      const s = p.snapshot;
      const history = s.goals.history.length
        ? s.goals.history
        : [{ effectiveFrom: s.days[0]?.date ?? s.today.date, daily: s.goals.daily, weekly: s.goals.weekly }];
      const r = evaluate(
        totalsOf(s.days),
        history,
        s.today.date,
        p.settings.restDays,
        p.settings.weekStartsOn,
        p.settings.streakFreezes,
      );
      expect(r.current).toBe(s.streak.current);
      expect(r.freezesHeld).toBe(s.streak.freezesHeld);
      expect(r.freezesEarned).toBe(s.streak.freezesEarned);
      expect(r.freezesUsed).toBe(s.streak.freezesUsed);
      expect(r.longest).toBe(s.streak.longest);
      expect(r.todayMet).toBe(s.streak.todayMet);
      expect(r.weeklyCurrent).toBe(s.streak.weeklyCurrent);
      expect(r.weeklyLongest).toBe(s.streak.weeklyLongest);
      expect(r.days.map((d) => [d.date, d.goal, d.met, d.streak, d.frozen])).toEqual(
        s.days.map((d) => [d.date, d.goal, d.met, d.streak, d.frozen]),
      );
    });

    it(`${p.id}: has breakdowns for every named range and both share formats`, () => {
      for (const k of ["today", "yesterday", "last7", "last30", "last90", "thisWeek", "thisMonth", "thisYear", "all"]) {
        expect(p.breakdowns[k], k).toBeDefined();
      }
      expect(p.shareCards["square"]?.format).toBe("square");
      expect(p.shareCards["story"]?.format).toBe("story");
      expect(p.snapshot.achievements.length).toBeGreaterThanOrEqual(12);
    });
  }

  it("some preset exercises freezes (earned and spent)", () => {
    expect(presets.some((p) => p.snapshot.streak.freezesUsed > 0)).toBe(true);
    expect(presets.some((p) => p.snapshot.streak.freezesHeld === 2)).toBe(true);
  });

  it("freezes: earn every 7 goal days, cap at 2, spend on a miss, rest days are free", () => {
    const h = [{ effectiveFrom: "2026-08-01", daily: 50, weekly: 250 }];
    const days = (from: string, n: number) =>
      Array.from({ length: n }, (_, i) => [new Date(Date.parse(from) + i * 86_400_000).toISOString().slice(0, 10), 100] as const);
    const m = (v: (readonly [string, number])[]) => new Map(v.map(([d, t]) => [d, t]));
    // Earn and cap.
    let r = evaluate(m(days("2026-08-01", 30)), h, "2026-08-30", [], "monday", true);
    expect([r.freezesHeld, r.freezesEarned]).toEqual([2, 2]);
    // Spend on a miss (Sep 8), streak survives.
    r = evaluate(m([...days("2026-09-01", 7), ...days("2026-09-09", 2)]), h, "2026-09-10", [], "monday", true);
    expect([r.current, r.freezesHeld, r.freezesUsed]).toEqual([9, 0, 1]);
    expect(r.days.find((d) => d.date === "2026-09-08")?.frozen).toBe(true);
    // No freeze left: the second miss breaks.
    r = evaluate(m([...days("2026-09-01", 7), ...days("2026-09-10", 1)]), h, "2026-09-10", [], "monday", true);
    expect(r.current).toBe(1);
    // Rest days (Sat/Sun) don't consume one.
    r = evaluate(m([...days("2026-09-05", 7), ...days("2026-09-14", 1)]), h, "2026-09-14", [5, 6], "monday", true);
    expect([r.current, r.freezesHeld, r.freezesUsed]).toEqual([8, 1, 0]);
    // Off: identical to the plain rules.
    r = evaluate(m([...days("2026-09-01", 7), ...days("2026-09-09", 2)]), h, "2026-09-10", [], "monday", false);
    expect([r.current, r.freezesHeld]).toEqual([2, 0]);
  });

  it("goal versions replace same-day changes", () => {
    let h = setGoal([], "2026-09-01", 100, 500);
    h = setGoal(h, "2026-09-10", 200, 900);
    h = setGoal(h, "2026-09-10", 300, 900);
    expect(h).toEqual([
      { effectiveFrom: "2026-09-01", daily: 100, weekly: 500 },
      { effectiveFrom: "2026-09-10", daily: 300, weekly: 900 },
    ]);
  });
});
