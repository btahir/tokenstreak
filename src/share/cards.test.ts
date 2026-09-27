import { describe, expect, it } from "vitest";
import type { AppSnapshot, MockPreset, ShareCardData } from "../api/types";
import heavy from "../api/mock/presets/heavy-multi-tool.json";
import streak30 from "../api/mock/presets/streak-30.json";
import { buildCardModel, cardFileName, leanestWeek, type CardOptions } from "./cards";

const snap = (p: unknown) => structuredClone((p as MockPreset).snapshot) as AppSnapshot;
const base: CardOptions = { template: "streak", format: "square", theme: "dark", showMix: true, showCost: false, showProjects: false };
const shareWithProjects = { ...(heavy as unknown as MockPreset).shareCards["square"]!, topProjects: ["secret-client", "atlas", "dotfiles"] } as ShareCardData;

describe("share card models", () => {
  it("streak card: the current run is the hero", () => {
    const s = snap(streak30);
    const m = buildCardModel(s, base, null);
    expect(m.headline).toBe(`${s.streak.current} days`);
    expect(m.subline).toBe("of unbroken light");
    expect(m.stats).toHaveLength(3);
    expect(m.maxDays).toBe(48);
  });
  it("story format shows four stats", () => {
    expect(buildCardModel(snap(heavy), { ...base, format: "story" }, null).stats).toHaveLength(4);
  });
  it("year card uses the year and 365 days", () => {
    const m = buildCardModel(snap(heavy), { ...base, template: "year" }, null);
    expect(m.headline).toBe("2026");
    expect(m.subline).toMatch(/^in light · .+ tokens$/);
    expect(m.maxDays).toBe(365);
  });
  it("lean card shows the cheapest week", () => {
    const s = snap(heavy);
    const lw = leanestWeek(s.days, s.today.date)!;
    expect(lw).not.toBeNull();
    const m = buildCardModel(s, { ...base, template: "lean" }, null);
    expect(m.headline).toBe(`$${lw.perM.toFixed(2)}`);
    expect(m.chip).toContain("Personal best");
  });
  it("hides project names unless allowed, and cost unless asked", () => {
    const s = snap(heavy);
    expect(buildCardModel(s, base, shareWithProjects).projects).toBeNull();
    expect(buildCardModel(s, { ...base, showProjects: true }, shareWithProjects).projects).toEqual(["secret-client", "atlas", "dotfiles"]);
    expect(buildCardModel(s, { ...base, showProjects: true }, { ...shareWithProjects, topProjects: null }).projects).toBeNull();
    expect(buildCardModel(s, base, null).stats.some(([l]) => l === "Est. cost")).toBe(false);
    expect(buildCardModel(s, { ...base, showCost: true, format: "story" }, null).stats.some(([l]) => l === "Est. cost")).toBe(true);
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
