import { describe, expect, it } from "vitest";
import {
  addDays,
  daysBetween,
  formatAgo,
  formatDay,
  formatLongDate,
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
  it("splits value and unit", () => {
    expect(splitUnit("61.4M")).toEqual(["61.4", "M"]);
    expect(splitUnit("999")).toEqual(["999", ""]);
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
    expect(formatTimes(9.44)).toBe("×9.4");
    expect(formatTimes(0)).toBe("×0");
  });
});

describe("dates", () => {
  it("does calendar arithmetic without zone drift", () => {
    expect(addDays("2026-02-28", 1)).toBe("2026-03-01");
    expect(addDays("2026-03-08", 1)).toBe("2026-03-09");
    expect(daysBetween("2025-12-31", "2026-01-02")).toBe(2);
  });
  it("renders human dates and ranges", () => {
    expect(formatDay("2026-09-26")).toBe("26 Sep");
    expect(formatLongDate("2026-09-26")).toBe("Saturday 26 September");
    expect(formatRange("2026-03-14", "2026-09-26")).toBe("Mar – Sep 2026");
    expect(formatRange("2025-10-01", "2026-09-26")).toBe("Oct 2025 – Sep 2026");
    expect(formatRange("2026-09-01", "2026-09-26")).toBe("Sep 2026");
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
  it("rounds goals to friendly numbers", () => {
    expect(friendlyGoal(480_000)).toBe(500_000);
    expect(friendlyGoal(2_600_000)).toBe(2_000_000);
    expect(friendlyGoal(3_600_000)).toBe(5_000_000);
    expect(friendlyGoal(8_000_000)).toBe(10_000_000);
    expect(friendlyGoal(100)).toBe(10_000);
    expect(friendlyGoal(0)).toBe(0);
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
