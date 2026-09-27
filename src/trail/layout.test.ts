import { describe, expect, it } from "vitest";
import {
  bucketDays,
  classify,
  clusterRects,
  gaussian,
  lodBucket,
  placeLabels,
  placeTip,
  routeY,
  wanderPeriod,
  type DayIn,
  type Rect,
} from "./layout";

const GOAL = 100;
let n = 0;
function day(tokens: number, extra: Partial<DayIn> = {}): DayIn {
  n++;
  return { date: `2026-01-${String((n % 28) + 1).padStart(2, "0")}`, tokens, goalMet: tokens >= GOAL, tools: { claude: 1 }, cacheShare: 0.9, goal: GOAL, ...extra };
}
const today = (tokens: number) => day(tokens, { isToday: true, goalMet: tokens >= GOAL });
/** Compact day list: L lit, w wisp, . zero, f frozen; the last char is today (T lit / t not yet). */
function days(spec: string): DayIn[] {
  return [...spec].map((ch) =>
    ch === "L" ? day(150) : ch === "w" ? day(40) : ch === "." ? day(0) : ch === "f" ? day(0, { frozen: true }) : ch === "T" ? today(130) : today(50),
  );
}

describe("level of detail", () => {
  it("keeps one day per point while days are at least 3 px apart", () => {
    expect(lodBucket(26)).toBe(1);
    expect(lodBucket(3)).toBe(1);
  });
  it("aggregates dense ranges (3+ years in ~900 px become weekly or coarser)", () => {
    expect(lodBucket(2.9)).toBe(2);
    expect(lodBucket(0.9)).toBe(7);
    expect(lodBucket(900 / 1700)).toBe(7);
    expect(lodBucket(0.05)).toBe(30);
  });
  it("buckets align to today, which always stays its own point", () => {
    const d = days("LLLLLLLLLLT");
    const b = bucketDays(d, GOAL, 3);
    expect(b[b.length - 1]!.kind).toBe("today");
    expect(b[b.length - 1]!.i0).toBe(10);
    expect(b.map((x) => x.i1 - x.i0 + 1)).toEqual([1, 3, 3, 3, 1]);
    expect(b.slice(0, -1).every((x) => x.kind === "lit")).toBe(true);
  });
  it("a bucket is a gap only when every day in it had no tokens", () => {
    const b = bucketDays(days("...L..w....t"), GOAL, 4);
    // [0..2] = "...", [3..6] = "L..w" (wisp: one lit of four), [7..10] = "....", today
    expect(b.map((x) => x.kind)).toEqual(["dark", "wisp", "dark", "today"]);
  });
});

describe("runs and roles", () => {
  it("history is one continuous thread: runs of 3+ lit days are ribbons, short runs and under-goal days are filaments, zero days are gaps", () => {
    const { roles, runs } = classify(bucketDays(days("wLLL.LwLLT"), GOAL, 1));
    expect(roles).toEqual(["filament", "past", "past", "past", "gap", "filament", "filament", "current", "current", "today"]);
    expect(runs.find((r) => r.current)).toMatchObject({ a: 7, b: 8, current: true });
    expect(runs[0]).toMatchObject({ a: 1, b: 3, days: 3, current: false });
  });
  it("a freeze bridges a run and keeps it going (moonlight bridge)", () => {
    const { roles, runs } = classify(bucketDays(days("LLfLLt"), GOAL, 1));
    expect(roles).toEqual(["current", "current", "bridge", "current", "current", "today"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.days).toBe(5);
  });
  it("a freeze on yesterday keeps the current run attached to today", () => {
    const { runs } = classify(bucketDays(days("LLLft"), GOAL, 1));
    expect(runs[0]!.current).toBe(true);
  });
  it("today alone starts the current run once lit", () => {
    const { runs } = classify(bucketDays(days("LL.T"), GOAL, 1));
    expect(runs.find((r) => r.current)).toMatchObject({ a: 3, b: 3 });
  });
  it("sub-pixel gaps are pinched instead of breaking the path", () => {
    const b = bucketDays(days("LLL.LLL..LLt"), GOAL, 1);
    expect(classify(b).roles[3]).toBe("gap");
    const pinched = classify(b, { bridgeGaps: 1 }).roles;
    expect(pinched[3]).toBe("filament");
    expect(pinched[7]).toBe("gap");
  });
});

describe("smoothing", () => {
  it("never bleeds across a masked gap", () => {
    const v = [10, 10, 10, 0, 0, 1, 1, 1];
    const mask = [true, true, true, false, false, true, true, true];
    const s = gaussian(v, 2, mask);
    expect(s.slice(0, 3).every((x) => Math.abs(x - 10) < 1e-9)).toBe(true);
    expect(s.slice(5).every((x) => Math.abs(x - 1) < 1e-9)).toBe(true);
  });
  it("wander period is a stable power of two, at least 24 days", () => {
    for (const st of [0.5, 2, 8, 30]) {
      const p = wanderPeriod(st);
      expect(Math.log2(p) % 1).toBe(0);
      expect(p).toBeGreaterThanOrEqual(24);
      expect(p * st).toBeGreaterThanOrEqual(260);
    }
  });
});

describe("HUD routing", () => {
  const xs = Array.from({ length: 121 }, (_, i) => i * 10);
  const half = xs.map(() => 6);
  const bounds = { top: 20, bottom: 280 };

  it("merges a label / number / pills stack into one block", () => {
    const stack: Rect[] = [
      { x: 24, y: 20, w: 90, h: 16 },
      { x: 24, y: 42, w: 210, h: 60 },
      { x: 24, y: 110, w: 380, h: 28 },
      { x: 1000, y: 18, w: 180, h: 28 },
    ];
    const c = clusterRects(stack, 40);
    expect(c).toHaveLength(2);
    expect(c[0]).toEqual({ x: 24, y: 20, w: 380, h: 118 });
  });

  it("routes the path clear of every HUD rectangle (no ribbon under the hero text or chips)", () => {
    const hud: Rect[] = [
      { x: 24, y: 20, w: 380, h: 118 }, // hero text + pills
      { x: 1000, y: 18, w: 180, h: 28 }, // tier chip
      { x: 800, y: 262, w: 380, h: 18 }, // legend
    ];
    // a natural path that runs straight through the hero block and the legend
    const natural = xs.map((x) => (x < 600 ? 110 : 270));
    const y = routeY(xs, natural, half, hud, { ...bounds, margin: 8, ramp: 60 });
    for (const r of hud)
      xs.forEach((x, i) => {
        if (x < r.x || x > r.x + r.w) return;
        const top = y[i]! - half[i]!;
        const bot = y[i]! + half[i]!;
        expect(bot <= r.y || top >= r.y + r.h).toBe(true);
      });
  });

  it("stays smooth: no kinks where it bends around a rectangle", () => {
    const hud: Rect[] = [{ x: 300, y: 60, w: 200, h: 120 }];
    const natural = xs.map(() => 120);
    const y = routeY(xs, natural, half, hud, { ...bounds, margin: 8, ramp: 60 });
    let maxJump = 0;
    let maxBend = 0;
    for (let i = 1; i < y.length; i++) maxJump = Math.max(maxJump, Math.abs(y[i]! - y[i - 1]!));
    for (let i = 1; i < y.length - 1; i++) maxBend = Math.max(maxBend, Math.abs(y[i + 1]! - 2 * y[i]! + y[i - 1]!));
    expect(maxJump).toBeLessThan(14); // at 10 px per point
    expect(maxBend).toBeLessThan(6);
  });

  it("goes above a rectangle when the natural path is above it", () => {
    const hud: Rect[] = [{ x: 300, y: 150, w: 200, h: 60 }];
    const natural = xs.map(() => 160);
    const y = routeY(xs, natural, half, hud, { ...bounds, margin: 8, ramp: 60 });
    expect(y[40]!).toBeLessThanOrEqual(150 - 8 - 6 + 0.5);
  });

  it("respects the vertical bounds", () => {
    const y = routeY(xs, xs.map((x) => (x % 200 < 100 ? -50 : 400)), half, [], { ...bounds });
    expect(Math.min(...y)).toBeGreaterThanOrEqual(bounds.top);
    expect(Math.max(...y)).toBeLessThanOrEqual(bounds.bottom);
  });
});

describe("milestone labels", () => {
  const bounds = { w: 900, h: 300 };
  it("never overlaps two labels ('730days'): the higher milestone wins, the other hides", () => {
    const out = placeLabels(
      [
        { x: 700, y: 80, w: 44, h: 14, priority: 7 },
        { x: 712, y: 78, w: 50, h: 14, priority: 30 },
      ],
      [],
      bounds,
    );
    expect(out[1]!.visible).toBe(true);
    expect(out[0]!.visible).toBe(false);
  });
  it("keeps labels at least 56 px apart", () => {
    const out = placeLabels(
      [
        { x: 100, y: 80, w: 40, h: 14, priority: 7 },
        { x: 150, y: 80, w: 40, h: 14, priority: 30 },
        { x: 400, y: 80, w: 40, h: 14, priority: 100 },
      ],
      [],
      bounds,
    );
    expect(out.map((o) => o.visible)).toEqual([false, true, true]);
  });
  it("moves a label off a chip, or hides it (the tier chip never hides '100 days')", () => {
    const chip: Rect = { x: 760, y: 18, w: 140, h: 28 };
    const moved = placeLabels([{ x: 820, y: 34, w: 60, h: 14, priority: 100, alts: [{ x: 740, y: 70 }] }], [chip], bounds);
    expect(moved[0]).toMatchObject({ visible: true, x: 740, y: 70 });
    const hidden = placeLabels([{ x: 820, y: 34, w: 60, h: 14, priority: 100 }], [chip], bounds);
    expect(hidden[0]!.visible).toBe(false);
  });
  it("keeps labels inside the canvas", () => {
    const out = placeLabels([{ x: 895, y: 100, w: 60, h: 14, priority: 7 }], [], bounds);
    expect(out[0]!.x + 30).toBeLessThanOrEqual(900);
  });
});

describe("tooltip placement", () => {
  it("sits above the day when there is room", () => {
    const p = placeTip(400, 200, 180, 80, 900, 300);
    expect(p.below).toBe(false);
    expect(p.top + 80).toBeLessThanOrEqual(200);
  });
  it("flips below near the top of the hero instead of being clipped", () => {
    const p = placeTip(400, 60, 180, 80, 900, 300);
    expect(p.below).toBe(true);
    expect(p.top).toBeGreaterThanOrEqual(60);
  });
  it("is clamped inside the card at both edges", () => {
    expect(placeTip(5, 200, 180, 80, 900, 300).left).toBeGreaterThanOrEqual(8);
    const r = placeTip(895, 200, 180, 80, 900, 300);
    expect(r.left + 180).toBeLessThanOrEqual(892);
  });
});
