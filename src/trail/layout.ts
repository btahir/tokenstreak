// Pure geometry for the Trail (no DOM): level of detail, run classification,
// smoothing, HUD-aware path routing, label collision and tooltip placement.
// Kept separate from the renderer so it can be unit-tested.

import type { ToolShares, TrailDay } from "./types";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Kind = "today" | "lit" | "frozen" | "wisp" | "dark";
/**
 * How a point is drawn:
 * - current: the live streak, the brightest ribbon
 * - past: an earlier run of 3+ lit days, a dimmer, cooler afterglow ribbon
 * - filament: days with tokens outside a qualifying run, a thin continuous thread
 * - bridge: a rest day or spent freeze, a thin moonlight thread
 * - gap: a day with no tokens; the path breaks
 * - today: the comet head
 */
export type Role = "current" | "past" | "filament" | "bridge" | "gap" | "today";

export type DayIn = TrailDay & { isToday?: boolean };

export interface Bucket {
  /** First and last day index covered (inclusive). */
  i0: number;
  i1: number;
  /** Mean tokens per day. */
  tokens: number;
  /** Mean of min(tokens / goal, 2.5). */
  ratio: number;
  kind: Kind;
  tools: ToolShares;
  cache: number;
  /** Lit days in the bucket. */
  lit: number;
}

export interface RunInfo {
  /** Point (bucket) range, inclusive. */
  a: number;
  b: number;
  current: boolean;
  /** Lit or bridged days in the run (day resolution). */
  days: number;
  /** Day index range, inclusive. */
  d0: number;
  d1: number;
}

export const LOD_STEPS = [1, 2, 3, 7, 14, 30] as const;

/** Days per point so neighbouring points sit at least `minPx` apart. */
export function lodBucket(dayStepPx: number, minPx = 3): number {
  for (const b of LOD_STEPS) if (dayStepPx * b >= minPx) return b;
  return LOD_STEPS[LOD_STEPS.length - 1]!;
}

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0 || 1), 0, 1);
  return t * t * (3 - 2 * t);
};

export function dayKind(d: DayIn): Kind {
  return d.isToday ? "today" : d.goalMet ? "lit" : d.frozen ? "frozen" : d.tokens > 0 ? "wisp" : "dark";
}

/**
 * Aggregates days into buckets of `b` days, aligned to the newest day. Today
 * (the last day) always stays its own bucket so the head is exact.
 */
export function bucketDays(days: DayIn[], goal: number, b: number): Bucket[] {
  const n = days.length;
  const g = goal > 0 ? goal : 1;
  const one = (i0: number, i1: number): Bucket => {
    const m = i1 - i0 + 1;
    let tokens = 0;
    let ratio = 0;
    let cache = 0;
    let lit = 0;
    let frozen = 0;
    let zero = 0;
    let today = false;
    const tools: Record<string, number> = {};
    for (let i = i0; i <= i1; i++) {
      const d = days[i]!;
      tokens += d.tokens;
      ratio += clamp(d.tokens / (d.goal && d.goal > 0 ? d.goal : g), 0, 2.5);
      cache += (d.cacheShare || 0) * d.tokens;
      if (d.isToday) today = true;
      else if (d.goalMet) lit++;
      else if (d.frozen) frozen++;
      if (d.tokens <= 0 && !d.isToday) zero++;
      for (const [k, v] of Object.entries(d.tools ?? {})) tools[k] = (tools[k] ?? 0) + (v ?? 0) * Math.max(d.tokens, 1);
    }
    const tsum = Object.values(tools).reduce((a, v) => a + v, 0);
    for (const k of Object.keys(tools)) tools[k] = tsum > 0 ? tools[k]! / tsum : 0;
    let kind: Kind;
    if (today) kind = "today";
    else if (m === 1) kind = dayKind(days[i0]!);
    else if (zero === m) kind = "dark";
    else if (lit > 0 && lit + frozen >= Math.ceil(m * 0.6)) kind = "lit";
    else if (frozen > m / 2) kind = "frozen";
    else kind = "wisp";
    return { i0, i1, tokens: tokens / m, ratio: ratio / m, kind, tools, cache: tokens > 0 ? cache / tokens : 0, lit };
  };
  if (!n) return [];
  if (b <= 1) return days.map((_, i) => one(i, i));
  const out: Bucket[] = [one(n - 1, n - 1)];
  for (let end = n - 2; end >= 0; end -= b) out.push(one(Math.max(0, end - b + 1), end));
  return out.reverse();
}

/**
 * Assigns a drawing role to every point and finds the runs of lit days.
 * `minPastRun` is the lit-day length for a past run to become a ribbon;
 * gaps of up to `bridgeGaps` points are drawn as a pinch instead of a break
 * (dense layouts, where a one-day gap would be sub-pixel).
 */
export function classify(buckets: Bucket[], opts: { minPastRun?: number; bridgeGaps?: number } = {}): { roles: Role[]; runs: RunInfo[] } {
  const minPast = opts.minPastRun ?? 3;
  const bridge = opts.bridgeGaps ?? 0;
  const n = buckets.length;
  const kinds = buckets.map((b) => b.kind);
  const roles: Role[] = kinds.map((k) => (k === "today" ? "today" : k === "dark" ? "gap" : k === "frozen" ? "bridge" : "filament"));
  // pinch sub-pixel gaps
  if (bridge > 0) {
    let i = 0;
    while (i < n) {
      if (roles[i] !== "gap") {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < n && roles[j + 1] === "gap") j++;
      if (j - i + 1 <= bridge && i > 0 && j < n - 1) for (let q = i; q <= j; q++) roles[q] = "filament";
      i = j + 1;
    }
  }
  const runs: RunInfo[] = [];
  let i = 0;
  while (i < n) {
    if (kinds[i] !== "lit" && !(kinds[i] === "frozen" && i > 0 && kinds[i - 1] === "lit")) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && (kinds[j + 1] === "lit" || kinds[j + 1] === "frozen")) j++;
    // a run never ends on a bridge (unless the bridge reaches yesterday: today can still extend it)
    if (j !== n - 2) while (j > i && kinds[j] === "frozen") j--;
    let days = 0;
    for (let q = i; q <= j; q++) days += kinds[q] === "frozen" ? buckets[q]!.i1 - buckets[q]!.i0 + 1 : Math.max(1, buckets[q]!.lit);
    runs.push({ a: i, b: j, current: false, days, d0: buckets[i]!.i0, d1: buckets[j]!.i1 });
    i = j + 1;
  }
  const last = n - 1;
  const todayLit = n > 0 && kinds[last] === "today" && buckets[last]!.ratio >= 1;
  const tail = runs[runs.length - 1];
  if (tail && tail.b === last - 1) {
    tail.current = true;
  } else if (todayLit) {
    runs.push({ a: last, b: last, current: true, days: 1, d0: buckets[last]!.i0, d1: buckets[last]!.i1 });
  }
  for (const r of runs) {
    const litDays = r.days;
    for (let q = r.a; q <= r.b; q++) {
      if (roles[q] === "today") continue;
      if (kinds[q] === "frozen") roles[q] = "bridge";
      else if (r.current) roles[q] = "current";
      else if (litDays >= minPast || buckets[q]!.i1 > buckets[q]!.i0) roles[q] = "past";
    }
  }
  return { roles, runs };
}

/**
 * Gaussian smoothing with sigma in points. With `mask`, each contiguous
 * true-segment is smoothed on its own (values never bleed across gaps).
 */
export function gaussian(values: number[], sigma: number, mask?: boolean[]): number[] {
  const n = values.length;
  if (sigma < 0.3 || n < 3) return values.slice();
  const r = Math.ceil(sigma * 2.5);
  const k: number[] = [];
  for (let i = -r; i <= r; i++) k.push(Math.exp(-(i * i) / (2 * sigma * sigma)));
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    if (mask && !mask[i]) {
      out[i] = values[i]!;
      continue;
    }
    let s = 0;
    let ws = 0;
    for (let j = -r; j <= r; j++) {
      const q = i + j;
      if (q < 0 || q >= n) continue;
      if (mask) {
        // stop at the first masked-out point in either direction
        let blocked = false;
        const dir = j < 0 ? -1 : 1;
        for (let z = i + dir; dir < 0 ? z >= q : z <= q; z += dir)
          if (!mask[z]) {
            blocked = true;
            break;
          }
        if (blocked) continue;
      }
      const w = k[j + r]!;
      s += values[q]! * w;
      ws += w;
    }
    out[i] = ws > 0 ? s / ws : values[i]!;
  }
  return out;
}

/** Smooth maximum / minimum (C1 continuous, within k/2 of the hard version). */
export const smax = (a: number, b: number, k: number) => 0.5 * (a + b + Math.sqrt((a - b) * (a - b) + k * k));
export const smin = (a: number, b: number, k: number) => 0.5 * (a + b - Math.sqrt((a - b) * (a - b) + k * k));

export interface RouteOptions {
  /** Hard vertical bounds for the path centre. */
  top: number;
  bottom: number;
  /** Clearance between a HUD rectangle and the ribbon edge. */
  margin?: number;
  /** Horizontal distance over which a rectangle's influence fades out. */
  ramp?: number;
}

function interpY(xs: number[], ys: number[], x: number): number {
  if (!xs.length) return 0;
  if (x <= xs[0]!) return ys[0]!;
  for (let i = 1; i < xs.length; i++) if (xs[i]! >= x) {
    const t = (x - xs[i - 1]!) / (xs[i]! - xs[i - 1]! || 1);
    return ys[i - 1]! + (ys[i]! - ys[i - 1]!) * t;
  }
  return ys[ys.length - 1]!;
}

/** Which side of a rectangle the path should pass: "below" or "above" it. */
export function routeSide(r: Rect, naturalY: number, half: number, o: RouteOptions): "below" | "above" {
  const margin = o.margin ?? 8;
  const roomAbove = r.y - margin - half - o.top;
  const roomBelow = o.bottom - (r.y + r.h + margin + half);
  const prefer = naturalY >= r.y + r.h / 2 ? "below" : "above";
  if (prefer === "below" && roomBelow < 0 && roomAbove > roomBelow) return "above";
  if (prefer === "above" && roomAbove < 0 && roomBelow > roomAbove) return "below";
  return prefer;
}

/**
 * Bends the path's centre line around HUD rectangles. For each rectangle the
 * path goes below or above it (whichever the natural path is closer to and has
 * room), with influence fading smoothly beyond the rectangle's sides, then the
 * result is smoothed and soft-clamped so it never kinks.
 */
/**
 * Merges rectangles the path could not pass between (they overlap
 * horizontally and the vertical gap is under `minGap`) into one block, so a
 * stack like label / number / pills is avoided as a whole.
 */
export function clusterRects(rects: Rect[], minGap: number): Rect[] {
  let out = rects.filter((r) => r.w > 0 && r.h > 0).map((r) => ({ ...r }));
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < out.length; i++)
      for (let j = i + 1; j < out.length; j++) {
        const a = out[i]!;
        const b = out[j]!;
        const xOverlap = a.x < b.x + b.w && b.x < a.x + a.w;
        const gap = Math.max(a.y, b.y) - Math.min(a.y + a.h, b.y + b.h);
        if (xOverlap && gap < minGap) {
          const x = Math.min(a.x, b.x);
          const y = Math.min(a.y, b.y);
          out[i] = { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
          out.splice(j, 1);
          merged = true;
          break outer;
        }
      }
  }
  return out;
}

export function routeY(xs: number[], ys: number[], halfIn: number[], rectsIn: Rect[], o: RouteOptions): number[] {
  const n = xs.length;
  if (!n) return [];
  // clearance varies smoothly along the path (a running max, then smoothed), so
  // a thin day next to a wide one never makes the route jump
  const W = 4;
  const half = gaussian(
    halfIn.map((_, i) => {
      let m = 0;
      for (let j = Math.max(0, i - W); j <= Math.min(n - 1, i + W); j++) m = Math.max(m, halfIn[j]!);
      return m;
    }),
    2,
  );
  const margin = o.margin ?? 8;
  const ramp = o.ramp ?? 56;
  const maxHalf = half.reduce((a, b) => Math.max(a, b), 0);
  const rects = clusterRects(rectsIn, 2 * (maxHalf + margin) + 4);
  const lo = new Array<number>(n).fill(o.top);
  const hi = new Array<number>(n).fill(o.bottom);
  for (const r of rects) {
    if (r.w <= 0 || r.h <= 0) continue;
    const cx = r.x + r.w / 2;
    const hMid = half[Math.max(0, Math.min(n - 1, xs.findIndex((x) => x >= cx)))] ?? half[n - 1] ?? 0;
    const nat = interpY(xs, ys, cx);
    const side = routeSide(r, nat, hMid, o);
    // the further the path must move, the longer the approach (gentle bends, never a kink)
    const target = side === "below" ? r.y + r.h + margin + hMid : r.y - margin - hMid;
    const disp = side === "below" ? Math.max(0, target - nat) : Math.max(0, nat - target);
    const rr = Math.max(ramp, disp * 2.2);
    for (let i = 0; i < n; i++) {
      const x = xs[i]!;
      const d = x < r.x ? r.x - x : x > r.x + r.w ? x - (r.x + r.w) : 0;
      if (d >= rr) continue;
      const f = 1 - smoothstep(0, rr, d);
      if (side === "below") lo[i] = Math.max(lo[i]!, o.top + (r.y + r.h + margin + half[i]! - o.top) * f);
      else hi[i] = Math.min(hi[i]!, o.bottom + (r.y - margin - half[i]! - o.bottom) * f);
    }
  }
  const fit = (y: number, i: number) => {
    const a = lo[i]!;
    const b = hi[i]!;
    return a > b ? (a + b) / 2 : clamp(y, a, b);
  };
  let out = ys.map((y, i) => fit(y, i));
  const dx = n > 1 ? (xs[n - 1]! - xs[0]!) / (n - 1) : 1;
  const sigma = clamp(ramp / 3 / (dx || 1), 0.5, 40);
  for (let pass = 0; pass < 3; pass++) out = gaussian(out, sigma).map((y, i) => fit(y, i));
  // soft clamp: C1 continuous where the path meets a limit
  const k = 10;
  return out.map((y, i) => {
    const a = lo[i]!;
    const b = hi[i]!;
    if (a > b) return (a + b) / 2;
    return clamp(smin(smax(y, a, k), b, k), a, b);
  });
}

export interface LabelIn {
  x: number;
  /** Centre y of the preferred placement. */
  y: number;
  w: number;
  h: number;
  /** Alternative centres, tried in order when the preferred one collides. */
  alts?: { x: number; y: number }[];
  priority: number;
}
export interface LabelOut {
  visible: boolean;
  x: number;
  y: number;
}

const hit = (a: Rect, b: Rect, pad = 0) => a.x - pad < b.x + b.w && a.x + a.w + pad > b.x && a.y - pad < b.y + b.h && a.y + a.h + pad > b.y;

/**
 * Hides or moves labels so none overlaps a HUD rectangle, leaves the bounds,
 * or sits within `minDist` of a label already placed (higher priority first).
 */
export function placeLabels(labels: LabelIn[], rects: Rect[], bounds: { w: number; h: number }, minDist = 56): LabelOut[] {
  const out: LabelOut[] = labels.map((l) => ({ visible: false, x: l.x, y: l.y }));
  const placed: Rect[] = [];
  const order = labels.map((_, i) => i).sort((a, b) => labels[b]!.priority - labels[a]!.priority);
  for (const i of order) {
    const l = labels[i]!;
    for (const cand of [{ x: l.x, y: l.y }, ...(l.alts ?? [])]) {
      const cy = cand.y;
      const x = clamp(cand.x, l.w / 2 + 4, bounds.w - l.w / 2 - 4);
      const box: Rect = { x: x - l.w / 2, y: cy - l.h / 2, w: l.w, h: l.h };
      if (box.y < 2 || box.y + box.h > bounds.h - 2) continue;
      if (rects.some((r) => hit(box, r, 4))) continue;
      if (placed.some((p) => hit(box, p, 6) || Math.hypot(p.x + p.w / 2 - x, p.y + p.h / 2 - cy) < minDist)) continue;
      placed.push(box);
      out[i] = { visible: true, x, y: cy };
      break;
    }
  }
  return out;
}

/**
 * Places a tooltip anchored at (ax, ay) inside a box: above the anchor when
 * there is room (at least `minAbove`), otherwise below, and always clamped
 * horizontally inside the box.
 */
export function placeTip(ax: number, ay: number, tipW: number, tipH: number, boxW: number, boxH: number, gap = 16, pad = 8, minAbove = 90): { left: number; top: number; below: boolean } {
  const roomAbove = ay - gap - pad;
  const below = roomAbove < Math.max(tipH, minAbove) && boxH - (ay + gap + tipH) >= pad - 0.5 * tipH;
  let top = below ? ay + gap : ay - gap - tipH;
  top = clamp(top, pad, Math.max(pad, boxH - tipH - pad));
  const left = clamp(ax - tipW / 2, pad, Math.max(pad, boxW - tipW - pad));
  return { left, top, below };
}

/** Wander period (in days) for a given day step: at least ~260 px on screen, quantized so it rarely changes. */
export function wanderPeriod(dayStepPx: number): number {
  const want = Math.max(24, 260 / Math.max(0.05, dayStepPx));
  return Math.pow(2, Math.ceil(Math.log2(want)));
}
