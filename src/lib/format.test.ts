import { beforeAll, describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  formatAgo,
  formatChange,
  formatDate,
  formatDayRange,
  formatInt,
  formatLongDate,
  formatTowardGoal,
  percentValue,
  prettyModel,
  setFormatLocale,
  setReferenceDate,
  formatPercent,
  formatRange,
  formatTimes,
  formatTokens,
  formatUsd,
  friendlyGoal,
  parseTokens,
  plural,
  prettyPath,
  splitUnit,
} from "./format";

beforeAll(() => {
  setFormatLocale("en-US");
  setReferenceDate("2026-09-26");
});

describe("formatTokens", () => {
  it("uses compact units with one decimal below 100", () => {
    expect(formatTokens(0)).toBe("0");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(8_500)).toBe("8.5K");
    expect(formatTokens(412_000)).toBe("412K");
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(61_400_000)).toBe("61.4M");
    expect(formatTokens(412_000_000)).toBe("412M");
    expect(formatTokens(12_242_695_250)).toBe("12.2B");
  });
  it("drops trailing zeros and handles negatives and junk", () => {
    expect(formatTokens(2_000_000)).toBe("2M");
    expect(formatTokens(-31_000)).toBe("−31K");
    expect(formatTokens(Number.NaN)).toBe("0");
  });
  it("never carries a rounding into a fake 1000K", () => {
    expect(formatTokens(999_960)).toBe("1M");
    expect(formatTokens(9_960)).toBe("10K");
  });
  it("floors when asked", () => {
    expect(formatTokens(1_967_000, { floor: true })).toBe("1.9M");
    expect(formatTokens(1_967_000, { floor: true, digits: 2 })).toBe("1.96M");
  });
  it("splits value and unit", () => {
    expect(splitUnit("61.4M")).toEqual(["61.4", "M"]);
    expect(splitUnit("999")).toEqual(["999", ""]);
  });
});

describe("counts against a goal (never round up to it)", () => {
  it("adds precision near the goal instead of claiming it", () => {
    expect(formatTowardGoal(1_967_000, 2_000_000)).toBe("1.96M");
    expect(formatTowardGoal(1_999_400, 2_000_000)).toBe("1.99M");
    expect(formatTowardGoal(3_960_000, 4_000_000)).toBe("3.96M");
    expect(formatTowardGoal(199_600_000, 200_000_000)).toBe("199.6M");
    expect(formatTowardGoal(99_700, 100_000)).toBe("99.7K");
  });
  it("leaves values far from the goal, at it, or past it alone", () => {
    expect(formatTowardGoal(959_000, 3_000_000)).toBe("959K");
    expect(formatTowardGoal(1_200_000, 2_000_000)).toBe("1.2M");
    expect(formatTowardGoal(2_000_000, 2_000_000)).toBe("2M");
    expect(formatTowardGoal(2_400_000, 2_000_000)).toBe("2.4M");
    expect(formatTowardGoal(0, 2_000_000)).toBe("0");
  });
  it("never equals the goal label while unmet, across a sweep", () => {
    for (const goal of [500_000, 1_000_000, 2_000_000, 2_500_000, 20_000_000, 150_000_000, 1_000_000_000]) {
      for (let f = 0.9; f < 1; f += 0.0007) {
        const s = formatTowardGoal(Math.floor(goal * f), goal);
        expect(parseTokens(s)!).toBeLessThan(goal);
        expect(s).not.toBe(formatTokens(goal));
      }
    }
  });
});

describe("money, percent, multipliers", () => {
  it("formats USD estimates", () => {
    expect(formatUsd(4.82)).toBe("$4.82");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(6715.2)).toBe("$6,715");
    expect(formatUsd(19.5, { cents: false })).toBe("$20");
  });
  it("formats percents and multipliers", () => {
    expect(formatPercent(0.71)).toBe("71%");
    expect(formatPercent(0.0034, 1)).toBe("0.3%");
    expect(formatTimes(9.44)).toBe("9.4×");
    expect(formatTimes(33.94)).toBe("33.9×");
    expect(formatTimes(0)).toBe("0×");
  });
  it("never shows 100% or 0% for shares that are not exact", () => {
    expect(formatPercent(0.997)).toBe(">99%");
    expect(formatPercent(1)).toBe("100%");
    expect(formatPercent(0.003)).toBe("<1%");
    expect(formatPercent(0)).toBe("0%");
    expect(formatPercent(0.9996, 1)).toBe(">99.9%");
    expect(percentValue(0.997)).toBe(99);
    expect(percentValue(1)).toBe(100);
    expect(percentValue(0.002)).toBe(1);
  });
  it("keeps delta chips short", () => {
    expect(formatChange(0.17)).toBe("17%");
    expect(formatChange(-0.12)).toBe("12%");
    expect(formatChange(2.4)).toBe("3.4×");
    expect(formatChange(1571.23)).toBe("10×+");
    expect(formatInt(1234)).toBe("1,234");
  });
});

describe("dates", () => {
  it("does calendar arithmetic without zone drift", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(daysBetween("2025-12-31", "2026-01-02")).toBe(2);
  });
  it("renders human dates and ranges", () => {
    expect(formatDate("2026-09-26")).toBe("Sep 26");
    expect(formatDate("2025-09-27")).toBe("Sep 27, 2025");
    expect(formatDate("2026-09-26", { year: "always" })).toBe("Sep 26, 2026");
    expect(formatLongDate("2026-09-26")).toBe("Saturday, September 26");
    expect(formatDayRange("2026-08-17", "2026-09-26")).toBe("Aug 17 – Sep 26, 2026");
    expect(formatDayRange("2025-12-28", "2026-01-03")).toBe("Dec 28, 2025 – Jan 3, 2026");
    expect(formatRange("2026-03-14", "2026-09-26")).toBe("Mar – Sep 2026");
    expect(formatRange("2025-10-01", "2026-09-26")).toBe("Oct 2025 – Sep 2026");
    expect(formatRange("2026-09-01", "2026-09-26")).toBe("Sep 2026");
  });
  it("follows the locale's order", () => {
    setFormatLocale("en-GB");
    expect(formatDate("2025-09-27")).toMatch(/^27 Sept? 2025$/);
    setFormatLocale("en-US");
  });
  it("says how long ago", () => {
    const now = Date.parse("2026-09-26T12:00:00Z");
    expect(formatAgo("2026-09-26T11:59:40Z", now)).toBe("just now");
    expect(formatAgo("2026-09-26T11:58:00Z", now)).toBe("2 min ago");
    expect(formatAgo("2026-09-26T09:00:00Z", now)).toBe("3 h ago");
    expect(formatAgo("2026-09-25T10:00:00Z", now)).toBe("yesterday");
    expect(formatAgo(null, now)).toBe("never");
  });
});

describe("misc", () => {
  it("pluralises", () => {
    expect(plural(1, "day")).toBe("1 day");
    expect(plural(1203, "day")).toBe("1,203 days");
  });
  it("never shows the user name in paths", () => {
    expect(prettyPath("/Users/alice/.claude/projects")).toBe("~/.claude/projects");
    expect(prettyPath("/opt/logs")).toBe("/opt/logs");
  });
  it("rounds goals to friendly numbers within about 15%", () => {
    expect(friendlyGoal(480_000)).toBe(500_000);
    expect(friendlyGoal(2_600_000)).toBe(2_500_000);
    expect(friendlyGoal(3_200_000)).toBe(3_000_000);
    expect(friendlyGoal(3_600_000)).toBe(4_000_000);
    expect(friendlyGoal(8_000_000)).toBe(8_000_000);
    expect(friendlyGoal(35_600_000)).toBe(40_000_000);
    expect(friendlyGoal(35_600_000, "down")).toBe(30_000_000);
    expect(friendlyGoal(3_200_000, "up")).toBe(4_000_000);
    for (let n = 12_000; n < 1e9; n *= 1.07) expect(Math.abs(Math.log(friendlyGoal(n) / n))).toBeLessThan(0.16);
    expect(friendlyGoal(100)).toBe(10_000);
    expect(friendlyGoal(0)).toBe(0);
  });
  it("prettifies model names", () => {
    expect(prettyModel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5");
    expect(prettyModel("claude-haiku-4-5-20251001")).toBe("Haiku 4.5");
    expect(prettyModel("claude-opus-4-5-20251101")).toBe("Opus 4.5");
    expect(prettyModel("claude-3-5-sonnet-20241022")).toBe("Sonnet 3.5");
    expect(prettyModel("claude-opus-4-1")).toBe("Opus 4.1");
    expect(prettyModel("gpt-5-codex")).toBe("GPT-5 Codex");
    expect(prettyModel("gpt-5.1-codex")).toBe("GPT-5.1 Codex");
    expect(prettyModel("gpt-5")).toBe("GPT-5");
    expect(prettyModel("gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
    expect(prettyModel("gemini-2.5-flash")).toBe("Gemini 2.5 Flash");
    expect(prettyModel("some-local-model")).toBe("some-local-model");
  });
  it("parses typed token amounts", () => {
    expect(parseTokens("750k")).toBe(750_000);
    expect(parseTokens("2.5M")).toBe(2_500_000);
    expect(parseTokens("1,000,000")).toBe(1_000_000);
    expect(parseTokens(" 3 b ")).toBe(3_000_000_000);
    expect(parseTokens("lots")).toBeNull();
    expect(parseTokens("-5")).toBeNull();
  });
});
