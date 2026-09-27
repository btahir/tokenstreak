import { beforeAll, describe, expect, it } from "vitest";
import type { AppSnapshot, MockPreset, ShareCardData } from "../api/types";
import heavy from "../api/mock/presets/heavy-multi-tool.json";
import streak30 from "../api/mock/presets/streak-30.json";
import atRisk from "../api/mock/presets/streak-at-risk.json";
import reveal from "../api/mock/presets/first-run-reveal.json";
import { bestRunIn, spanSummary, yearWindow } from "../lib/derive";
import { addDays, formatDayRange, formatInt, formatPercent, formatTokens, setFormatLocale, setReferenceDate } from "../lib/format";
import { buildCardModel, cardFileName, leanestWeek, STREAK_LEAD_IN, streakSpan, type CardOptions } from "./cards";

const snap = (p: unknown) => structuredClone((p as MockPreset).snapshot) as AppSnapshot;
const base: CardOptions = { template: "streak", format: "square", theme: "dark", showMix: true, showCost: false, showProjects: false };
const shareWithProjects = { ...(heavy as unknown as MockPreset).shareCards["square"]!, topProjects: ["secret-client", "atlas", "dotfiles"] } as ShareCardData;
const stat = (m: { stats: [string, string][] }, label: string) => m.stats.find(([l]) => l === label)?.[1];

beforeAll(() => {
  setFormatLocale("en-US");
  setReferenceDate("2026-09-26");
});

describe("streak card: every number is about the streak", () => {
  for (const [name, preset] of [["streak-30", streak30], ["heavy", heavy], ["at-risk", atRisk]] as const) {
    it(`${name}: headline, stats, dates and Trail share one window`, () => {
      const s = snap(preset);
      const m = buildCardModel(s, { ...base, format: "story" }, null);
      const from = s.streak.currentStart!;
      const today = s.today.date;
      expect(m.headline).toBe(`${s.streak.current} days`);
      // days lit inside the window equal the streak the dashboard shows
      expect(stat(m, "Days lit")).toBe(formatInt(s.streak.current));
      const st = spanSummary(s.days, from, today);
      expect(st.daysLit).toBe(s.streak.current);
      expect(stat(m, "Tokens")).toBe(formatTokens(st.tokens));
      expect(stat(m, "From cache")).toBe(formatPercent(st.cacheShare));
      expect(stat(m, "Best day")).toBe(formatTokens(st.busiest!.total));
      expect(m.rangeLabel).toBe(formatDayRange(from, today));
      // the Trail draws exactly the streak plus the lead-in
      expect(m.trailRange).toEqual({ from: addDays(from, -STREAK_LEAD_IN), to: today });
      expect(m.trail.history[0]!.date).toBe(addDays(from, -STREAK_LEAD_IN));
      expect(m.trail.history.at(-1)!.date).toBe(addDays(today, -1));
      // today is drawn as the head even before it lights
      expect(m.maxDays).toBe(s.streak.current + STREAK_LEAD_IN + (s.today.met ? 0 : 1));
    });
  }
  it("square format drops the repeated day count", () => {
    const m = buildCardModel(snap(streak30), base, null);
    expect(m.stats.map(([l]) => l)).toEqual(["Tokens", "Best day", "From cache"]);
  });
  it("a broken streak shows the longest run and its dates", () => {
    const s = snap(reveal);
    s.streak.current = 0;
    s.streak.currentStart = null;
    const sp = streakSpan(s)!;
    const m = buildCardModel(s, base, null);
    expect(m.subline).toBe("my longest run of light");
    expect(m.headline).toBe(`${s.streak.longest} days`);
    expect(m.rangeLabel).toBe(formatDayRange(sp.from, sp.to));
  });
});

describe("year card: the same rolling year as the heatmap", () => {
  it("is labelled as the last 365 days and its lit days match the heatmap card", () => {
    const s = snap(heavy);
    const m = buildCardModel(s, { ...base, template: "year", format: "story" }, null);
    const w = yearWindow(s.today.date);
    const y = spanSummary(s.days, w.from, w.to);
    expect(`${m.headline} ${m.subline}`).toMatch(/^My year in light · /);
    expect(m.rangeLabel).toBe("Last 365 days");
    expect(stat(m, "Days lit")).toBe(formatInt(y.daysLit));
    expect(m.subline).toBe(`in light · ${formatTokens(y.tokens)} tokens`);
    expect(stat(m, "Best streak")).toBe(formatInt(bestRunIn(s.days, w.from, w.to, s.streak.restDays)));
    expect(m.trailRange).toEqual(w);
    expect(m.maxDays).toBe(365);
    // the heatmap card counts the same window
    expect(y.daysLit).toBe(s.days.filter((d) => d.date >= w.from && d.met).length);
  });
});

describe("lean card: the leanest week, no dollars unless cost is on", () => {
  it("headlines leanness, not money, by default", () => {
    const s = snap(heavy);
    const lw = leanestWeek(s.days, s.today.date)!;
    const m = buildCardModel(s, { ...base, template: "lean", format: "story" }, null);
    expect(m.headline).not.toContain("$");
    expect(m.stats.some(([, v]) => v.includes("$"))).toBe(false);
    expect(m.headline).toBe(`${Math.round(-lw.vsUsual * 100)}% leaner`);
    expect(m.rangeLabel).toBe(formatDayRange(lw.from, lw.to));
    expect(m.trailRange).toEqual({ from: lw.from, to: lw.to });
    expect(m.maxDays).toBe(7);
    expect(m.trail.today.date).toBe(lw.to);
    expect(m.trail.history.map((d) => d.date)).toEqual(Array.from({ length: 6 }, (_, i) => addDays(lw.from, i)));
    expect(stat(m, "Tokens")).toBe(formatTokens(spanSummary(s.days, lw.from, lw.to).tokens));
    expect(m.chip).toContain("Personal best");
  });
  it("shows cost per 1M only when cost sharing is on", () => {
    const s = snap(heavy);
    const lw = leanestWeek(s.days, s.today.date)!;
    const m = buildCardModel(s, { ...base, template: "lean", showCost: true }, null);
    expect(m.headline).toBe(`$${lw.perM.toFixed(2)}`);
  });
});

describe("share card options", () => {
  it("story format shows four stats", () => {
    expect(buildCardModel(snap(heavy), { ...base, format: "story" }, null).stats).toHaveLength(4);
  });
  it("hides project names unless allowed, and cost unless asked", () => {
    const s = snap(heavy);
    expect(buildCardModel(s, base, shareWithProjects).projects).toBeNull();
    expect(buildCardModel(s, { ...base, showProjects: true }, shareWithProjects).projects).toEqual(["secret-client", "atlas", "dotfiles"]);
    expect(buildCardModel(s, { ...base, showProjects: true }, { ...shareWithProjects, topProjects: null }).projects).toBeNull();
    for (const template of ["streak", "year", "lean"] as const) {
      expect(buildCardModel(s, { ...base, template, format: "story" }, null).stats.some(([l]) => l === "Est. cost")).toBe(false);
      expect(buildCardModel(s, { ...base, template, showCost: true, format: "story" }, null).stats.some(([l]) => l === "Est. cost")).toBe(true);
    }
  });
  it("can drop the agent mix", () => {
    expect(buildCardModel(snap(heavy), { ...base, showMix: false }, null).mix).toEqual([]);
    const mix = buildCardModel(snap(heavy), base, null).mix;
    expect(mix.reduce((a, m) => a + m.share, 0)).toBeCloseTo(1, 1);
  });
  it("names files by template, size and theme", () => {
    expect(cardFileName({ ...base, format: "story", theme: "light", template: "year" })).toBe("tokenstreak-year-1080x1920-light.png");
  });
});
