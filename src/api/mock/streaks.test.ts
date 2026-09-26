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
      const r = evaluate(totalsOf(s.days), history, s.today.date, p.settings.restDays, p.settings.weekStartsOn);
      expect(r.current).toBe(s.streak.current);
      expect(r.longest).toBe(s.streak.longest);
      expect(r.todayMet).toBe(s.streak.todayMet);
      expect(r.weeklyCurrent).toBe(s.streak.weeklyCurrent);
      expect(r.weeklyLongest).toBe(s.streak.weeklyLongest);
      expect(r.days.map((d) => [d.date, d.goal, d.met, d.streak])).toEqual(s.days.map((d) => [d.date, d.goal, d.met, d.streak]));
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
