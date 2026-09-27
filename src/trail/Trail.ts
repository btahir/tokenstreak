// The Trail: a ribbon of light that grows one segment per day across a dusk
// sky. Plain Canvas 2D, no dependencies.
//
//   const trail = new Trail(canvas, { theme: "dark", variant: "popover" });
//   trail.setData(data);       // re-lays out and re-caches
//   trail.setAvoid(rects);     // HUD rectangles the path routes around
//   trail.setProgress(0.9);    // live fraction of today's goal (eases)
//   trail.celebrate();         // goal-hit moment, once per day
//   trail.reveal();            // first-run draw-in; onReveal(p) reports tokens drawn
//   trail.onHover((h) => …);   // "full" variant tooltip
//   trail.pause(); trail.resume(); trail.destroy();
//
// Visual encoding
//   x          time, one step per day (dense ranges aggregate days: level of detail by zoom)
//   y          stable wander seeded by the date + smoothed activity, routed around the HUD
//   width      tokens / goal, with a floor so every day with tokens stays visible
//   continuity every day with tokens is one continuous thread of light; lit runs swell
//              into ribbons (the current run brightest, past runs as a cooler afterglow);
//              a day with no tokens is a clean gap with a single ember; rest days and
//              spent freezes are a thin moonlight bridge
//   strands    tool mix (apricot Claude, rose Codex, violet Gemini)
//   core       efficiency: more cache reuse = whiter, cooler core
//   head       today's progress: the orb fills its halo ring and ignites at 100%
//   sky        tier by streak; the horizon warms with today's progress
//
// Performance: the sky and the history ribbon are cached offscreen whenever
// data, size, theme or HUD rectangles change. Each frame draws only the live
// strands of the current run, today's segment, the shimmer, the head and a few
// dozen particles. The loop stops on pause(), when the document is hidden, and
// drops to `idleFps` after a quiet spell.

import type {
  ToolShares,
  TrailData,
  TrailHover,
  TrailLayout,
  TrailLayoutInfo,
  TrailOptions,
  TrailStats,
  TrailTheme,
  TrailTier,
  TrailTool,
  TrailVariant,
} from "./types";
import { filterBlurWorks, softwareBlur } from "./blur";
import {
  axisDay,
  axisX,
  makeAxis,
  bucketDays,
  classify,
  clamp,
  gaussian,
  lodBucket,
  placeLabels,
  routeY,
  smoothstep,
  wanderPeriod,
  type Axis,
  type Bucket,
  type DayIn,
  type Rect,
  type Role,
  type RunInfo,
} from "./layout";

type RGB = [number, number, number];

interface ThemeDef {
  sky: [number, string][];
  hills: [string, string];
  tool: Record<TrailTool | "other", RGB>;
  core: RGB;
  coolCore: RGB;
  blend: GlobalCompositeOperation;
  glowA: number;
  bodyA: number;
  strandA: number;
  /** Opacity of past runs relative to the current one. */
  pastDim: number;
  /** Filament opacity: base + per-unit-of-goal. */
  filA: [number, number];
  /** History opacity: goal days, other days with tokens. */
  histA: [number, number];
  bodyMul: number;
  bodyBlur: number;
  glowMul: number;
  coreA: number;
  coreW: number;
  /** Tint mixed into glow colours (light theme warms its bloom). */
  glowTint: RGB | null;
  glowTintAmt: number;
  /** Cooler tint for past runs (the afterglow). */
  afterglow: RGB;
  afterAmt: number;
  /** Light theme: the body runs from rose (start of a run) to apricot (its head). */
  ramp: [RGB, RGB] | null;
  rampAmt: number;
  star: string;
  starA: number;
  starCount: number;
  text: string;
  textHalo: string;
  halo: string;
  ring: RGB;
  ringA: number;
  horizon: string;
  sun: string | null;
  /** Soft drop shadow under the ribbon (light theme: lifts it off the paper). */
  shadow: string | null;
  strandWhite: number;
  /** Strand wiggle wavelength, in layout units. */
  strandWave: number;
  shimmer: RGB;
  shimmerA: number;
  spark: RGB;
  ember: RGB;
  /** Celebration particles: fills and an optional darker edge (light theme). */
  confetti: RGB[];
  confettiEdge: number;
  flash: RGB;
  flashA: number;
}

export const THEMES: Record<TrailTheme, ThemeDef> = {
  dark: {
    sky: [[0, "#1A1433"], [0.38, "#35214F"], [0.66, "#7E3B6A"], [0.88, "#D9736A"], [1, "#F3A46E"]],
    hills: ["rgba(40,24,62,0.85)", "rgba(22,15,38,0.96)"],
    tool: { claude: [255, 172, 112], codex: [246, 110, 142], gemini: [156, 126, 250], other: [220, 200, 230] },
    core: [255, 247, 234],
    coolCore: [226, 240, 255],
    blend: "lighter",
    glowA: 0.5, bodyA: 0.74, strandA: 0.75, pastDim: 0.42, filA: [0.4, 0.25], histA: [0.52, 0.36], bodyMul: 1.1, bodyBlur: 1.3, glowMul: 3.4, coreA: 0.85, coreW: 0.24,
    glowTint: null, glowTintAmt: 0,
    afterglow: [196, 170, 255], afterAmt: 0.4,
    ramp: null, rampAmt: 0,
    star: "rgba(255,248,240,", starA: 0.8, starCount: 70,
    text: "rgba(255,244,234,0.78)", textHalo: "rgba(26,20,51,0.55)", halo: "rgba(255,244,234,0.35)",
    ring: [255, 226, 190], ringA: 0.9,
    horizon: "rgba(255,190,130,",
    sun: null,
    shadow: null,
    strandWhite: 0.45, strandWave: 30,
    shimmer: [255, 247, 234], shimmerA: 0.5,
    spark: [255, 244, 225],
    ember: [255, 190, 130],
    confetti: [[255, 172, 112], [246, 110, 142], [156, 126, 250], [255, 247, 234], [255, 214, 140]],
    confettiEdge: 0,
    flash: [255, 222, 196], flashA: 0.16,
  },
  // Golden hour. Additive light can't glow on a pale sky, so the ribbon is one
  // saturated dusk body (rose into apricot along its length) with a soft warm
  // bloom, a single thin white core and a faint drop shadow. No outlines.
  light: {
    sky: [[0, "#ECE4FB"], [0.36, "#F6E2EE"], [0.7, "#FFE0CC"], [0.9, "#FFEBD9"], [1, "#FFF3E6"]],
    hills: ["rgba(242,208,222,0.78)", "rgba(250,226,222,1)"],
    tool: { claude: [247, 128, 70], codex: [232, 78, 122], gemini: [124, 92, 230], other: [150, 140, 170] },
    core: [255, 253, 248],
    coolCore: [244, 250, 255],
    blend: "source-over",
    glowA: 0.3, bodyA: 1, strandA: 0.22, pastDim: 0.5, filA: [0.55, 0.15], histA: [0.6, 0.46], bodyMul: 1, bodyBlur: 0.55, glowMul: 2.6, coreA: 0.92, coreW: 0.16,
    glowTint: [255, 186, 130], glowTintAmt: 0.55,
    afterglow: [186, 132, 206], afterAmt: 0.08,
    ramp: [[232, 84, 128], [255, 142, 84]], rampAmt: 0.6,
    star: "rgba(240,150,110,", starA: 0.34, starCount: 14,
    text: "rgba(35,29,51,0.7)", textHalo: "rgba(255,246,238,0.8)", halo: "rgba(35,29,51,0.2)",
    ring: [226, 80, 116], ringA: 0.82,
    horizon: "rgba(255,196,140,",
    sun: "rgba(255,214,170,",
    shadow: "rgba(168,64,96,0.16)",
    strandWhite: 0.55, strandWave: 52,
    shimmer: [255, 250, 238], shimmerA: 0.6,
    spark: [255, 172, 110],
    ember: [250, 150, 100],
    confetti: [[246, 122, 58], [228, 64, 112], [116, 80, 226], [255, 178, 60], [240, 96, 150]],
    confettiEdge: 0.5,
    flash: [255, 246, 232], flashA: 0.28,
  },
};

export const VARIANTS: Record<TrailVariant, TrailLayout> = {
  popover: { headX: 0.84, left: -0.04, baseY: 0.5, amp: 0.1, rise: 0.12, maxDays: 42, wMin: 1.4, wMax: 11, headR: 15, hills: true, labels: false, top: 0.18, bottom: 0.84 },
  full: { headX: 0.92, left: 0.02, baseY: 0.6, amp: 0.12, rise: 0.22, maxDays: 400, wMin: 1.4, wMax: 17, headR: 14, hills: true, labels: true, maxStep: 80, top: 0.1, bottom: 0.86 },
  card: { headX: 0.86, left: -0.04, baseY: 0.6, amp: 0.12, rise: 0.16, maxDays: 180, wMin: 1.8, wMax: 18, headR: 17, hills: true, labels: false },
  icon: { headX: 0.8, left: 0.05, baseY: 0.6, amp: 0.1, rise: 0.2, maxDays: 30, wMin: 2, wMax: 10, headR: 12, hills: false, labels: false },
};

export const TIERS: TrailTier[] = [
  { min: 0, id: "kindling", name: "Kindling" },
  { min: 1, id: "ember", name: "Ember" },
  { min: 7, id: "glow", name: "Glow" },
  { min: 30, id: "comet", name: "Comet" },
  { min: 100, id: "aurora", name: "Aurora" },
  { min: 365, id: "halo", name: "Halo" },
];
export const MILESTONES = [7, 30, 100, 365];
const TOOLS: TrailTool[] = ["claude", "codex", "gemini"];
const FROZEN_COL: RGB = [169, 216, 245];
const SHADOW_COL: RGB = [168, 64, 96];
/** Seconds the first-run draw-in takes. */
export const REVEAL_SECONDS = 2.6;

export function tierFor(streak: number): TrailTier {
  let r = TIERS[0]!;
  for (const t of TIERS) if (streak >= t.min) r = t;
  return r;
}

/** The next tier above `streak`, or null at the top. */
export function nextTier(streak: number): TrailTier | null {
  return TIERS.find((t) => t.min > streak) ?? null;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
/** Reveal pacing: starts moving at once, settles gently onto the head. */
const easeReveal = (t: number) => 1 - Math.pow(1 - t, 2.2) * (1 - 0.35 * t);
const spring = (t: number) => 1 - Math.exp(-6 * t) * Math.cos(10 * t);
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

/** Mulberry32: small deterministic PRNG. */
export function rng(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function dayNumber(date: string | null | undefined, fallback: number): number {
  if (!date) return fallback;
  const t = Date.parse(`${date}T12:00:00Z`);
  return Number.isNaN(t) ? fallback : Math.round(t / 864e5);
}

function toolColor(theme: ThemeDef, tools: ToolShares): RGB {
  let s = 0;
  const c: RGB = [0, 0, 0];
  for (const k of Object.keys(tools) as TrailTool[]) {
    const col = theme.tool[k] ?? theme.tool.other;
    const v = tools[k] ?? 0;
    s += v;
    c[0] += col[0] * v;
    c[1] += col[1] * v;
    c[2] += col[2] * v;
  }
  return s > 0 ? [c[0] / s, c[1] / s, c[2] / s] : theme.tool.claude;
}

/** One drawn point: a day, or a bucket of days in dense layouts. */
interface Pt {
  x: number;
  y: number;
  /** Ribbon width (px) after smoothing. */
  wd: number;
  /** Intensity 0..1 after smoothing. */
  a: number;
  /** Afterglow (cool) tint amount 0..1. */
  cool: number;
  /** Position along its run, 0 (start) .. 1 (end), for the light body ramp. */
  u: number;
  col: RGB;
  tools: ToolShares;
  cache: number;
  role: Role;
  b: Bucket;
  /** History weight: 1 = history, 0 = the current run (crossfades over a few days). */
  hw: number;
  /** Goal weight for history's lit core: 1 goal day, 0.35 other days with tokens, 0 none. */
  gw: number;
}
interface Sample {
  x: number;
  y: number;
  wd: number;
  a: number;
  /** History weight (see Pt.hw), goal weight (Pt.gw), end fade 0..1 at breaks. */
  hw: number;
  gw: number;
  ef: number;
  cool: number;
  u: number;
  col: RGB;
  cache: number;
  sh: number[];
  nx: number;
  ny: number;
  /** Point index where this sample's segment starts. */
  seg: number;
}
/** A contiguous stretch of light between gaps. */
interface Piece {
  p0: number;
  p1: number;
  s0: number;
  s1: number;
  /** Ends at today's head (its last segment is drawn live). */
  head: boolean;
  /** A 1-2 day stretch between breaks: drawn as a point of light, not a band. */
  spark?: boolean;
}
interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  s: number;
  col: RGB;
  g?: number;
  drag?: number;
  star?: boolean;
}
interface Star {
  x: number;
  y: number;
  s: number;
  ph: number;
  sp: number;
}
interface Milestone {
  m: number;
  x: number;
  y: number;
  /** Ribbon y at the milestone day (for the roll call). */
  ry: number;
  label: { visible: boolean; x: number; y: number };
}
interface Ember {
  x: number;
  y: number;
  r: number;
  a: number;
}

type Ctx = CanvasRenderingContext2D;

export class Trail {
  readonly canvas: HTMLCanvasElement;
  private ctx: Ctx;
  private themeName: TrailTheme;
  private theme: ThemeDef;
  private variantName: TrailVariant;
  private v: TrailLayout;
  private reduced: boolean;
  private fixedSize: TrailOptions["size"];
  private cache = document.createElement("canvas");
  private skyCache = document.createElement("canvas");
  private glowCache = document.createElement("canvas");
  private bodyCache = document.createElement("canvas");
  private blurCache = document.createElement("canvas");
  private shadowCache = document.createElement("canvas");
  private auroraCache: HTMLCanvasElement | null = null;
  private auroraPad = 0;
  private particles: Particle[] = [];
  private t = 0;
  private last = 0;
  private running = false;
  private destroyed = false;
  private dirty = true;
  private raf = 0;
  private celebrateAt = -1;
  private celebrateMilestone = false;
  private revealAt = -1;
  private revealing = false;
  private revealCb: ((p: number) => void) | null = null;
  private lastRevealP = -1;
  private hoverDay: number | null = null;
  private hoverCb: ((h: TrailHover | null) => void) | null = null;
  private progressShown = 0;
  private progressTarget = 0;
  private data: TrailData | null = null;
  private seed: number;
  private random: () => number = Math.random;
  private idleFps: number;
  private idleAfterMs: number;
  private lastActivity = 0;
  private lastDrawn = 0;
  private ro: ResizeObserver | null = null;
  private onVis: (() => void) | null = null;
  private onMove: ((e: PointerEvent) => void) | null = null;
  private onLeave: (() => void) | null = null;
  private hiddenPause = false;
  private userPaused = false;
  private frameTimes: number[] = [];
  private avoid: Rect[] = [];
  private avoidKey = "";
  readonly stats: TrailStats = { frameMs: 0, maxFrameMs: 0, cacheMs: 0, frames: 0 };

  // geometry (valid after layout)
  private w = 0;
  private h = 0;
  private dpr = 1;
  private k = 1;
  /** Pixel step between points and between days. */
  private step = 0;
  private axis: Axis = { x0: 0, x1: 0, split: 0, xSplit: 0, stepOld: 0, stepNew: 0 };
  /** Days per point in the recent part of the axis. */
  private lod = 1;
  /** Every zero day shows as its own break (false in dense views). */
  private everyGapVisible = true;
  private layoutCb: ((info: TrailLayoutInfo) => void) | null = null;
  private days: DayIn[] = [];
  private cum: number[] = [];
  private pts: Pt[] = [];
  private samples: Sample[] = [];
  private pieces: Piece[] = [];
  private runs: RunInfo[] = [];
  private curRun: { s0: number; s1: number; p0: number; p1: number; days: number } | null = null;
  /** Last sample of the cached ribbon (today's segment is live after it). */
  private cacheEnd = -1;
  /** Today's fraction of the goal baked into the cached ribbon. */
  private bakedProgress = 0;
  private embers: Ember[] = [];
  private head = { x: 0, y: 0 };
  private milestones: Milestone[] = [];
  private stars: Star[] = [];

  constructor(canvas: HTMLCanvasElement, opts: TrailOptions = {}) {
    this.canvas = canvas;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Trail: 2D canvas unavailable");
    this.ctx = ctx;
    this.themeName = opts.theme ?? "dark";
    this.theme = THEMES[this.themeName];
    this.variantName = opts.variant ?? "popover";
    this.v = { ...VARIANTS[this.variantName], ...(opts.layout ?? {}) };
    this.reduced =
      opts.reducedMotion ?? (typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    this.seed = opts.seed ?? 7;
    this.fixedSize = opts.size;
    this.idleFps = opts.idleFps ?? 30;
    this.idleAfterMs = opts.idleAfterMs ?? 12_000;
    this.frame = this.frame.bind(this);

    if (!this.fixedSize) {
      this.ro = new ResizeObserver(() => {
        this.dirty = true;
        this.kick();
      });
      this.ro.observe(canvas);
      this.onVis = () => {
        this.hiddenPause = document.hidden;
        if (document.hidden) this.stopLoop();
        else this.startLoop();
      };
      document.addEventListener("visibilitychange", this.onVis);
      this.hiddenPause = document.hidden;
    }
    if (this.variantName === "full" && !this.fixedSize) {
      this.onMove = (e) => {
        const r = canvas.getBoundingClientRect();
        this.hoverAt(e.clientX - r.left);
      };
      this.onLeave = () => this.clearHover();
      canvas.addEventListener("pointermove", this.onMove);
      canvas.addEventListener("pointerleave", this.onLeave);
    }
    this.lastActivity = performance.now();
    if (opts.autoStart ?? !this.fixedSize) this.startLoop();
  }

  /* ---------------- public API ---------------- */

  setData(d: TrailData): void {
    this.data = { ...d, today: { ...d.today }, history: d.history };
    this.dirty = true;
    this.progressTarget = d.goal > 0 ? d.today.tokens / d.goal : 0;
    if (this.progressShown === 0 || this.reduced) this.progressShown = this.progressTarget;
    this.kick();
  }

  /**
   * HUD rectangles (CSS px, relative to the canvas) the path must route
   * around. Rounded to 4 px; only a real change re-lays out.
   */
  setAvoid(rects: Rect[]): void {
    const q = (n: number) => Math.round(n / 4) * 4;
    const r = rects.filter((x) => x.w > 0 && x.h > 0).map((x) => ({ x: q(x.x), y: q(x.y), w: q(x.w), h: q(x.h) }));
    const key = JSON.stringify(r);
    if (key === this.avoidKey) return;
    this.avoidKey = key;
    this.avoid = r;
    this.dirty = true;
    this.kick();
  }

  /** Live update of today's fraction of the goal; eases toward it. */
  setProgress(p: number): void {
    if (!this.data) return;
    const was = this.data.today.tokens >= this.data.goal && this.data.goal > 0;
    this.data.today.tokens = p * this.data.goal;
    this.progressTarget = p;
    if (p >= 1 !== was || Math.abs(p - this.bakedProgress) > 0.015) this.dirty = true;
    this.kick();
  }

  setTheme(name: TrailTheme): void {
    if (name === this.themeName) return;
    this.themeName = name;
    this.theme = THEMES[name];
    this.dirty = true;
    this.kick();
  }

  setReducedMotion(r: boolean): void {
    this.reduced = r;
    this.kick();
  }

  /**
   * Goal-hit moment: the comet ignites (shockwave, burst, sky brightens), then
   * a flash races back along the streak and every lit day pulses once in
   * sequence (the roll call). Milestone days add a large star-pop.
   */
  celebrate(): void {
    this.celebrateAt = this.t;
    this.progressShown = Math.max(this.progressShown, Math.min(1, this.progressTarget));
    this.celebrateMilestone = !!this.data && MILESTONES.includes(this.data.streak.current);
    this.burst();
    this.kick();
  }

  /** First-run draw-in over REVEAL_SECONDS. */
  reveal(): void {
    this.revealAt = this.t;
    this.revealing = true;
    this.lastRevealP = -1;
    if (this.reduced) {
      this.revealing = false;
      this.revealCb?.(1);
    }
    this.kick();
  }

  /** Called after each layout with what the Trail shows (for a truthful legend). */
  onLayout(cb: ((info: TrailLayoutInfo) => void) | null): void {
    this.layoutCb = cb;
    if (cb && this.pts.length) cb(this.layoutInfo());
  }

  layoutInfo(): TrailLayoutInfo {
    return { everyGapVisible: this.everyGapVisible, lod: this.lod, compressed: this.axis.split > 0 };
  }

  /** Reports the share of history tokens drawn so far during a reveal (0..1). */
  onReveal(cb: ((p: number) => void) | null): void {
    this.revealCb = cb;
  }

  get isRevealing(): boolean {
    return this.revealing && this.t - this.revealAt < REVEAL_SECONDS;
  }

  /** Subscribe to hover changes (full variant). Returns an unsubscribe. */
  onHover(cb: (h: TrailHover | null) => void): () => void {
    this.hoverCb = cb;
    return () => {
      if (this.hoverCb === cb) this.hoverCb = null;
    };
  }

  /** Keyboard access: move the hover to a day index (clamped); null clears. */
  hoverIndex(i: number | null): TrailHover | null {
    if (i === null || !this.days.length) {
      this.clearHover();
      return null;
    }
    return this.setHover(clamp(Math.round(i), 0, this.days.length - 1));
  }

  get hoveredIndex(): number | null {
    return this.hoverDay;
  }

  get dayCount(): number {
    return this.days.length;
  }

  pause(): void {
    this.userPaused = true;
    this.stopLoop();
  }

  resume(): void {
    this.userPaused = false;
    this.lastActivity = performance.now();
    this.startLoop();
  }

  get isRunning(): boolean {
    return this.running;
  }

  destroy(): void {
    this.destroyed = true;
    this.stopLoop();
    this.ro?.disconnect();
    if (this.onVis) document.removeEventListener("visibilitychange", this.onVis);
    if (this.onMove) this.canvas.removeEventListener("pointermove", this.onMove);
    if (this.onLeave) this.canvas.removeEventListener("pointerleave", this.onLeave);
    this.hoverCb = null;
    this.revealCb = null;
  }

  tier(): TrailTier {
    return tierFor(this.data ? this.data.streak.current : 0);
  }

  headPosition(): { x: number; y: number } | null {
    return this.pts.length ? { ...this.head } : null;
  }

  /** Debug/test view of the laid-out geometry (CSS px). */
  geometry(): { head: { x: number; y: number }; points: { x: number; y: number; wd: number; role: Role; hw: number; gw: number }[]; labels: { m: number; visible: boolean; x: number; y: number }[]; lod: number } {
    return {
      head: { ...this.head },
      points: this.pts.map((p) => ({ x: p.x, y: p.y, wd: p.wd, role: p.role, hw: p.hw, gw: p.gw })),
      labels: this.milestones.map((m) => ({ m: m.m, ...m.label })),
      lod: this.lod,
    };
  }

  /** Debug/test view of the tool strands along the current run (CSS px). */
  strandGeometry(t = 0): { x: number; y: number; w: number }[][] {
    const r = this.curRun;
    if (!r || r.s1 - r.s0 < 2) return [];
    return TOOLS.map((_, ti) => this.strandPoints(r.s0, r.s1, t, ti, true));
  }

  /** Marks user activity so the loop returns to full frame rate. */
  poke(): void {
    this.lastActivity = performance.now();
    this.startLoop();
  }

  /**
   * Renders one still frame synchronously at animation time `time` (seconds).
   * Used for share cards and screenshots; particles come from a seeded PRNG so
   * the result is deterministic. `warmup` pre-simulates head sparks.
   */
  renderStill(time = 3.2, warmup = 1.6): void {
    if (!this.data) return;
    this.random = rng(this.seed * 977);
    this.particles = [];
    if (this.dirty) {
      if (!this.rebuild()) return;
    }
    this.progressShown = this.progressTarget;
    const dt = 1 / 30;
    const steps = Math.round(warmup / dt);
    this.t = time - warmup;
    for (let i = 0; i < steps; i++) {
      this.t += dt;
      this.draw(dt, i < steps - 1);
    }
    this.random = Math.random;
  }

  /* ---------------- loop control ---------------- */

  private kick(): void {
    if (this.fixedSize) return;
    this.lastActivity = performance.now();
    this.startLoop();
  }

  private startLoop(): void {
    if (this.destroyed || this.running || this.userPaused || this.hiddenPause || this.fixedSize) return;
    this.running = true;
    this.last = 0;
    this.raf = requestAnimationFrame(this.frame);
  }

  private stopLoop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
  }

  private rebuild(): boolean {
    if (!this.layout()) return false;
    this.layoutCb?.(this.layoutInfo());
    this.paintSky();
    this.paintRibbon();
    this.auroraCache = null;
    if (this.tier().min >= 100) this.paintAurora();
    this.dirty = false;
    return true;
  }

  private frame(now: number): void {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    // Frame-rate governor: full rate while something is happening, idleFps otherwise.
    const busy =
      now - this.lastActivity < this.idleAfterMs ||
      this.particles.length > 12 ||
      this.revealing ||
      (this.celebrateAt >= 0 && this.t - this.celebrateAt < 3) ||
      Math.abs(this.progressTarget - this.progressShown) > 0.002;
    const minGap = this.reduced && !busy ? 1000 / 2 : busy ? 0 : 1000 / this.idleFps - 2;
    if (this.lastDrawn && now - this.lastDrawn < minGap) return;
    const dt = this.last ? Math.min(0.05, (now - this.last) / 1000) : 0.016;
    this.last = now;
    this.lastDrawn = now;
    this.t += dt;
    if (!this.data) return;
    const t0 = performance.now();
    if (this.dirty) {
      if (this.rebuild()) this.stats.cacheMs = performance.now() - t0;
      else return;
    }
    const t1 = performance.now();
    this.draw(dt);
    const ms = performance.now() - t1;
    this.frameTimes.push(ms);
    if (this.frameTimes.length > 120) this.frameTimes.shift();
    this.stats.frames++;
    this.stats.frameMs = this.frameTimes.reduce((a, b) => a + b, 0) / this.frameTimes.length;
    this.stats.maxFrameMs = Math.max(...this.frameTimes);
  }

  /* ---------------- hover ---------------- */

  private hoverAt(x: number): void {
    if (!this.days.length) return;
    this.poke();
    const i = clamp(Math.round(axisDay(this.axis, x)), 0, this.days.length - 1);
    this.setHover(i);
  }

  private dayX(i: number): number {
    return i >= this.days.length - 1 ? this.head.x : axisX(this.axis, i);
  }

  /** Path centre y at any x (also inside gaps). */
  private yAt(x: number): number {
    return this.yAtPts(this.pts, x);
  }

  private yAtPts(P: Pt[], x: number): number {
    if (!P.length) return this.h / 2;
    if (x <= P[0]!.x) return P[0]!.y;
    for (let i = 1; i < P.length; i++)
      if (P[i]!.x >= x) {
        const a = P[i - 1]!;
        const b = P[i]!;
        const t = (x - a.x) / (b.x - a.x || 1);
        // cosine blend: smooth enough for a tooltip anchor
        return lerp(a.y, b.y, (1 - Math.cos(t * Math.PI)) / 2);
      }
    return P[P.length - 1]!.y;
  }

  private runOfDay(i: number): RunInfo | undefined {
    return this.runs.find((r) => i >= r.d0 && i <= (r.current ? this.days.length - 1 : r.d1));
  }

  private setHover(i: number): TrailHover {
    this.hoverDay = i;
    this.kick();
    const x = this.dayX(i);
    const run = this.runOfDay(i);
    const day = this.days[i]!;
    const h: TrailHover = { day, index: i, x, y: this.yAt(x) };
    if (run && (day.goalMet || day.frozen || day.isToday)) {
      const D = this.days;
      const lit = (q: number) => !!D[q] && (D[q]!.goalMet || (!!D[q]!.isToday && D[q]!.tokens >= (this.data?.goal ?? Infinity)));
      let from: string;
      let to: string;
      let len: number;
      if (run.current) {
        // the streak's own start (a level-of-detail bucket can start a day early)
        let q = D.length - 1;
        if (!lit(q)) q--;
        to = D[q]?.date ?? "";
        let a = q;
        while (a - 1 >= 0 && (D[a - 1]!.goalMet || D[a - 1]!.frozen)) a--;
        from = this.data?.streak.start ?? D[a]?.date ?? "";
        len = this.data?.streak.current ?? run.days;
      } else {
        // first and last lit day inside the run's boundary buckets
        let a = run.d0;
        while (a < run.d1 && !D[a]!.goalMet) a++;
        let b = run.d1;
        while (b > a && !D[b]!.goalMet) b--;
        from = D[a]?.date ?? "";
        to = D[b]?.date ?? "";
        len = run.days;
      }
      h.run = { days: len, from, to, current: run.current };
    }
    this.hoverCb?.(h);
    return h;
  }

  private clearHover(): void {
    this.hoverDay = null;
    this.hoverCb?.(null);
    this.kick();
  }

  /* ---------------- geometry ---------------- */

  private layout(): boolean {
    const c = this.canvas;
    const dpr = this.fixedSize?.dpr ?? Math.min(globalThis.devicePixelRatio || 1, 2);
    const w = this.fixedSize?.width ?? c.clientWidth;
    const h = this.fixedSize?.height ?? c.clientHeight;
    if (!w || !h || !this.data) return false;
    this.w = w;
    this.h = h;
    this.dpr = dpr;
    for (const k of [c, this.cache, this.skyCache]) {
      k.width = Math.round(w * dpr);
      k.height = Math.round(h * dpr);
    }
    const d = this.data;
    const v = this.v;
    const T = this.theme;
    const goal = d.goal > 0 ? d.goal : 1;
    const k = Math.min(h / 200, w / 360) * (v.scale ?? 1);
    this.k = k;
    const hist = d.history.slice(-(v.maxDays - 1));
    const today: DayIn = {
      tokens: d.today.tokens,
      goalMet: d.goal > 0 && d.today.tokens >= d.goal,
      tools: d.today.tools,
      cacheShare: d.today.cacheShare,
      isToday: true,
      date: d.today.date ?? "",
      goal: d.goal,
    };
    const days: DayIn[] = [...hist, today];
    this.days = days;
    const n = days.length;
    let acc = 0;
    this.cum = days.map((q) => (acc += q.isToday ? 0 : q.tokens));
    const lastNum = dayNumber(hist.length ? hist[hist.length - 1]!.date : null, 20000) + 1;
    let x0 = w * v.left;
    const x1 = n === 1 ? w * (v.soloX ?? 0.5) : w * v.headX;
    let dayStep = n > 1 ? (x1 - x0) / (n - 1) : 0;
    const maxStep = (v.maxStep ?? 34) * k;
    if (dayStep > maxStep) {
      dayStep = maxStep;
      x0 = x1 - dayStep * (n - 1);
    }
    // long views: the current run plus a two-week lead-in keeps at least a quarter of the width
    let curStartIdx: number | null = null;
    {
      let q = n - 2;
      while (q >= 0 && (days[q]!.goalMet || days[q]!.frozen)) q--;
      if (q < n - 2) curStartIdx = q + 1;
      else if (today.goalMet) curStartIdx = n - 1;
    }
    const axis = makeAxis(n, x0, x1, curStartIdx === null ? null : Math.max(0, curStartIdx - 14), 0.32, v.labels || v.maxDays > 365 ? 366 : Infinity);
    this.axis = axis;

    // level of detail: aggregate days so points stay >= 3 px apart (per axis part)
    const lodOld = n > 2 ? lodBucket(axis.stepOld, 3) : 1;
    const lodNew = n > 2 ? lodBucket(axis.stepNew, 3) : 1;
    const B = bucketDays(days, goal, lodOld, axis.split ? { at: axis.split, b: lodNew } : undefined);
    const m = B.length;
    const px = B.map((b, i) => (i === m - 1 ? x1 : (axisX(axis, b.i0) + axisX(axis, b.i1)) / 2));
    // typical spacing between points, in px (both axis parts aim for ~3-6 px when dense)
    const gapsPx = px.slice(1).map((x, i) => x - px[i]!).sort((a, b) => a - b);
    const step = gapsPx.length ? gapsPx[Math.floor(gapsPx.length / 2)]! : dayStep;
    this.step = step;
    this.lod = axis.split ? lodNew : lodOld;
    // every zero day is its own visible break once a day gets >= 4 px; denser views
    // only break for whole empty buckets (the legend says so)
    const dayPx = axis.split ? axis.stepNew : dayStep;
    this.everyGapVisible = dayPx >= 4 && this.lod === 1 && (!axis.split || lodOld === 1);
    const { roles, runs } = classify(B, { minPastRun: 3, bridgeGaps: v.emphasizeAll ? 3 : dayPx >= 4 || this.lod > 1 ? 0 : 1 });
    this.runs = runs;
    // dense layouts: a rest day or freeze inside a run is sub-pixel; draw it as part of the run
    if (step < 8)
      for (const r of runs)
        for (let q = r.a; q <= r.b; q++) if (roles[q] === "bridge") roles[q] = r.current ? "current" : "past";

    // natural centre line: a slow wander seeded by the date, lifted by busy stretches
    const period = wanderPeriod(dayStep);
    const TAU = Math.PI * 2;
    const act = gaussian(
      B.map((b) => b.ratio),
      clamp(22 / Math.max(0.5, step), 1.2, 24),
    );
    const natural = B.map((b, i) => {
      const num = lastNum - (n - 1 - (b.i0 + b.i1) / 2);
      // a piecewise axis wanders by screen position so the zoomed part never kinks
      const ph = axis.split ? ((px[i]! - x0) / 260) * TAU : (num / period) * TAU;
      const noise = Math.sin(ph + this.seed) * 0.6 + Math.sin(ph * 2 + this.seed * 2.1) * 0.22 + Math.sin(ph / 2.2 + this.seed * 0.7) * 0.3;
      const climb = v.climb ? (v.climb * h * ((b.i0 + b.i1) / 2 - (n - 1) / 2)) / Math.max(1, n - 1) : 0;
      return h * v.baseY + noise * v.amp * h - (clamp(act[i]!, 0, 2.2) - 0.9) * v.rise * h - climb;
    });

    // width and intensity per point. One ribbon: every day with tokens is part of it,
    // as wide as its share of the goal (never thinner than 2.5 px); lit days glow brighter.
    const wMin = v.wMin * k;
    const wMax = v.wMax * k;
    const shape = (r: number) => 0.78 * Math.pow(Math.min(r, 1), 0.8) + 0.22 * clamp((r - 1) / 1.5, 0, 1);
    const ribbonW = (r: number) => wMin + (wMax - wMin) * shape(r);
    const body = ribbonW(1);
    const subW = (r: number) => Math.max(2.5, body * Math.min(r, 1));
    const all = !!v.emphasizeAll;
    const wd = B.map((b, i) => {
      const role = roles[i]!;
      if (role === "gap") return 0;
      if (role === "bridge") return Math.max(2.5, body * 0.45);
      // a quiet day in a short card narrows the arc gently (a hard pinch read as a crease)
      if (all) return b.tokens > 0 || role === "today" ? ribbonW(Math.max(b.ratio, 0.7)) : ribbonW(0.7) * 0.6;
      // a bridged (sub-pixel) gap narrows, but never below 40% of the body
      if (b.tokens <= 0 && role !== "today") return Math.max(2.5, body * 0.45);
      return b.ratio >= 1 ? ribbonW(b.ratio) : role === "today" ? ribbonW(b.ratio) : subW(b.ratio);
    });
    const prevRole = m > 1 ? roles[m - 2] : "gap";
    const todayOnRun = B[m - 1]!.ratio >= 1 || prevRole === "current" || prevRole === "bridge";
    const al = B.map((b, i) => {
      const role = roles[i]!;
      if (all && role !== "gap" && role !== "bridge") return b.tokens > 0 || role === "today" ? 1 : 0.7;
      if (role === "today") return todayOnRun ? 1 : T.histA[1] + (1 - T.histA[1]) * Math.min(b.ratio, 1);
      if (role === "current") return 1;
      if (role === "gap") return 0;
      if (role === "bridge") return 0.55;
      if (b.tokens <= 0) return T.histA[1] * 0.8;
      // history: goal days a little brighter than the rest
      return b.ratio >= 1 || role === "past" ? T.histA[0] : T.histA[1] + (T.histA[0] - T.histA[1]) * 0.5 * Math.min(b.ratio, 1);
    });
    const cool = roles.map((r) => (all || r === "current" || r === "today" ? 0 : T.afterAmt));
    // light theme body: rose at the start of the current run warming to apricot at the head;
    // all history sits at one rose tone
    const u = roles.map(() => 0.45);
    for (const r of runs) {
      const end = r.current ? m - 1 : r.b;
      for (let q = r.a; q <= end; q++) u[q] = end > r.a ? 0.45 + (0.55 * (q - r.a)) / (end - r.a) : 1;
    }
    if (all) for (let q = 0; q < m; q++) u[q] = m > 1 ? q / (m - 1) : 1;
    u[m - 1] = 1;
    const mask = roles.map((r) => r !== "gap");
    // width keeps each day's shape, softly; brightness and tint crossfade over ~3-5 days,
    // so history flows into the current run without a pinch or a seam
    const sigW = clamp(6 / Math.max(0.5, step), 0.6, 3);
    const sigA = clamp(Math.max(1.3, 10 / Math.max(0.5, step)), 1.3, 4);
    // history is a slimmer, calmer ribbon than the current run: narrower and smoothed more,
    // blended into the run's own width over the same few days as the brightness
    const isCur = roles.map((r) => r === "current" || r === "today");
    const curW = gaussian(wd, sigW, mask);
    const pastW = gaussian(
      wd.map((x) => Math.min(x * 0.62, body * 0.72)),
      clamp(14 / Math.max(0.5, step), 1, 5),
      mask,
    );
    const blend = gaussian(
      isCur.map((c) => (c ? 1 : 0)),
      sigA,
      mask,
    );
    const wdS = wd.map((_, i) => (all ? curW[i]! : lerp(pastW[i]!, curW[i]!, isCur[i] ? Math.max(0.5, blend[i]!) : blend[i]!)));
    const histW = wd.map((_, i) => (all ? 0 : 1 - (isCur[i] ? Math.max(0.5, blend[i]!) : blend[i]!)));
    const goalW = gaussian(
      B.map((b, i) => (roles[i] === "gap" ? 0 : b.tokens <= 0 && roles[i] !== "today" ? 0 : b.ratio >= 1 || roles[i] === "past" ? 1 : 0.35)),
      0.8,
      mask,
    );
    const alS = gaussian(al, sigA, mask);
    const coolS = gaussian(cool, sigA, mask);
    // today follows progress; keep its raw values
    wdS[m - 1] = Math.max(1.5, wd[m - 1]!);
    alS[m - 1] = al[m - 1]!;
    this.bakedProgress = B[m - 1]!.ratio;

    // route the centre line around the HUD
    const headR = v.headR * k;
    const half = wdS.map((x, i) => (i === m - 1 ? headR * 1.35 : x * T.bodyMul * 0.5 + (roles[i] === "gap" ? 3 : 0)));
    const rects = [...(v.avoid ?? []), ...this.avoid];
    const ys = routeY(px, natural, half, rects, { top: h * (v.top ?? 0.12), bottom: h * (v.bottom ?? 0.86), margin: 6 + 4 * k, ramp: 64 * Math.max(0.8, k * 0.8) });

    // tool mix, smoothed along the path: colour drifts with the mix instead of flickering
    const sigT = clamp(16 / Math.max(0.5, step), 1.5, 8);
    const mix = TOOLS.map((tk) => gaussian(B.map((b) => b.tools?.[tk] ?? 0), sigT, mask));
    const cacheS = gaussian(B.map((b) => b.cache), sigT, mask);
    const cols = B.map((_, i) => {
      const tools: ToolShares = { claude: mix[0]![i]!, codex: mix[1]![i]!, gemini: mix[2]![i]! };
      const has = tools.claude! + tools.codex! + tools.gemini! > 0.01;
      return roles[i] === "bridge" ? FROZEN_COL : toolColor(T, has ? tools : { claude: 1 });
    });
    const ch = [0, 1, 2].map((c) => gaussian(cols.map((x) => x[c]!), 0.9, mask));
    const pts: Pt[] = B.map((b, i) => {
      const role = roles[i]!;
      const tools: ToolShares = { claude: mix[0]![i]!, codex: mix[1]![i]!, gemini: mix[2]![i]! };
      const col: RGB = [ch[0]![i]!, ch[1]![i]!, ch[2]![i]!];
      return { x: px[i]!, y: ys[i]!, wd: wdS[i]!, a: alS[i]!, cool: coolS[i]!, u: u[i]!, col, tools, cache: cacheS[i]!, role, b, hw: histW[i]!, gw: goalW[i]! };
    });
    this.pts = pts;
    this.head = { x: pts[m - 1]!.x, y: pts[m - 1]!.y };

    // pieces: stretches of non-gap points, sampled at an even x spacing along one smooth
    // centre curve. Each stretch reaches halfway into a gap, leaving a clean hole, and
    // ends in a short symmetric soft end with a round cap.
    const dx = clamp(step / 4, 1.2, 5);
    const samples: Sample[] = [];
    const pieces: Piece[] = [];
    const curve = (x: number): { y: number; seg: number } => {
      let q = 0;
      while (q < m - 2 && pts[q + 1]!.x < x) q++;
      const p1 = pts[q]!;
      const p2 = pts[Math.min(m - 1, q + 1)]!;
      if (x <= p1.x || p2 === p1) return { y: p1.y, seg: q };
      const p0 = pts[Math.max(0, q - 1)]!;
      const p3 = pts[Math.min(m - 1, q + 2)]!;
      const t = clamp((x - p1.x) / (p2.x - p1.x || 1), 0, 1);
      const t2 = t * t;
      const t3 = t2 * t;
      const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      return { y, seg: q };
    };
    const hole = Math.max(2.5, 0.22 * step);
    const ext = clamp(0.5 * step - hole, 0, 0.5 * step);
        let i = 0;
    while (i < m) {
      if (roles[i] === "gap") {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < m && roles[j + 1] !== "gap") j++;
      const isHead = j === m - 1;
      const lone = i === j;
      const e = lone && !isHead ? Math.max(ext, 0.35 * step, 3) : ext;
      const xa = i === 0 ? pts[0]!.x : pts[i]!.x - (lone && isHead ? Math.max(e, Math.min(Math.max(step, 12) * 0.9, 34 * k)) : e);
      const xb = isHead ? pts[j]!.x : pts[j]!.x + e;
      const s0 = samples.length;
      const cnt = Math.max(2, Math.ceil((xb - xa) / dx));
      for (let q = 0; q <= cnt; q++) {
        const x = xa + ((xb - xa) * q) / cnt;
        let { y, seg } = curve(x);
        // beyond a stretch's first/last day (reaching into a gap) continue straight along its
        // own tangent: bending toward the gap's routed point drew a hook at the start
        if (x < pts[i]!.x && j > i) y = pts[i]!.y + ((pts[i + 1]!.y - pts[i]!.y) / (pts[i + 1]!.x - pts[i]!.x || 1)) * (x - pts[i]!.x);
        else if (x > pts[j]!.x && j > i) y = pts[j]!.y + ((pts[j]!.y - pts[j - 1]!.y) / (pts[j]!.x - pts[j - 1]!.x || 1)) * (x - pts[j]!.x);
        // attributes interpolate only between this stretch's own points
        let a = clamp(seg, i, j);
        if (x < pts[a]!.x && a > i) a--;
        const bIdx = Math.min(j, a + 1);
        const p1 = pts[a]!;
        const p2 = pts[bIdx]!;
        const t = p2 === p1 ? 0 : clamp((x - p1.x) / (p2.x - p1.x || 1), 0, 1);
        samples.push({
          x,
          y,
          seg: a,
          wd: lerp(p1.wd, p2.wd, t),
          a: lerp(p1.a, p2.a, t),
          hw: lerp(p1.hw, p2.hw, t),
          gw: lerp(p1.gw, p2.gw, t),
          ef: 1,
          cool: lerp(p1.cool, p2.cool, t),
          u: lerp(p1.u, p2.u, t),
          col: mixRGB(p1.col, p2.col, t),
          cache: lerp(p1.cache, p2.cache, t),
          sh: TOOLS.map((tk) => lerp(p1.tools[tk] ?? 0, p2.tools[tk] ?? 0, t)),
          nx: 0,
          ny: 0,
        });
      }
      const piece: Piece = { p0: i, p1: j, s0, s1: samples.length - 1, head: isHead, spark: !isHead && !all && j - i <= 1 };
      pieces.push(piece);
      // ends fade like light flickering off (no caps): over min(10 px, 35% of the stretch)
      // the width tapers to 55% and the alpha to 0
      const fadeLen = Math.max(2, Math.min(10, 0.35 * (xb - xa)));
      for (let q = s0; q <= piece.s1; q++) {
        const s = samples[q]!;
        // only a path that starts at the canvas edge begins at full strength; one that starts
        // inside (short cards) tapers in like any other stretch
        // (the current run's own start eases in over a couple of days: its white core tapers in)
        const startLen = i === 0 ? Math.max(fadeLen, 0.22 * (xb - xa)) : isHead ? Math.max(fadeLen, Math.min(2.5 * step, 0.3 * (xb - xa))) : fadeLen;
        const atStart = i === 0 && pts[0]!.x <= 2 ? 1 : smoothstep(0, startLen, s.x - xa);
        const atEnd = isHead ? 1 : smoothstep(0, fadeLen, xb - s.x);
        const f = Math.min(atStart, atEnd);
        // the current run grows out of nothing at its start; other stretches taper to 55%
        s.wd *= isHead && atStart < atEnd ? 0.25 + 0.75 * f : 0.55 + 0.45 * f;
        s.ef = f;
        // the path's very first day fades in from the left edge
        if (i === 0 && q - s0 < 12) s.a *= 0.45 + 0.55 * ((q - s0) / 12);
        // the body narrows into the head orb, so a big day never ends in a flat cap
        if (isHead) s.wd *= 1 - 0.55 * smoothstep(xb - Math.max(step, 10) * 0.55, xb, s.x);
        // a lone today after a gap grows out of a short lead-in
        if (isHead && lone) {
          const f = (s.x - xa) / Math.max(1, xb - xa);
          s.wd *= Math.min(1, f * 1.3 + 0.08);
          s.a *= 0.3 + 0.7 * f;
        }
      }
      i = j + 1;
    }
    // normals, per piece (never across a gap)
    for (const pc of pieces)
      for (let q = pc.s0; q <= pc.s1; q++) {
        const a = samples[Math.max(pc.s0, q - 1)]!;
        const b = samples[Math.min(pc.s1, q + 1)]!;
        const nx = -(b.y - a.y);
        const ny = b.x - a.x;
        const len = Math.hypot(nx, ny) || 1;
        samples[q]!.nx = nx / len;
        samples[q]!.ny = ny / len;
      }
    this.samples = samples;
    this.pieces = pieces;
    const hp = pieces.find((p) => p.head);
    this.cacheEnd = hp ? hp.s1 : -1;

    // the current run, in samples
    this.curRun = null;
    const cr = runs.find((r) => r.current);
    if (cr && hp && cr.a >= hp.p0) {
      const s0 = samples.findIndex((s, q) => q >= hp.s0 && s.seg >= cr.a);
      if (s0 >= 0) this.curRun = { s0, s1: hp.s1, p0: cr.a, p1: m - 1, days: cr.days };
    }

    // embers: a single soft ember in each visible break
    const embers: Ember[] = [];
    for (let q = 1; q < m - 1; q++) {
      if (roles[q] !== "gap" || roles[q - 1] === "gap") continue;
      let e = q;
      while (e + 1 < m && roles[e + 1] === "gap") e++;
      const gx0 = pts[q - 1]!.x;
      const gx1 = pts[Math.min(m - 1, e + 1)]!.x;
      if (gx1 - gx0 < 8) continue;
      const gx = (gx0 + gx1) / 2;
      embers.push({ x: gx, y: this.yAt(gx) + 3 * k, r: 0.95 * k, a: 0.6 });
    }
    const emberCap = 48;
    this.embers = embers.length > emberCap ? embers.filter((_, q) => q % Math.ceil(embers.length / emberCap) === 0) : embers;

    // milestone stars along the current run, labels placed without collisions
    this.milestones = [];
    const streak = d.streak.current;
    if (cr) {
      const pre: Omit<Milestone, "label">[] = [];
      for (const ms of MILESTONES) {
        if (streak < ms) continue;
        const dayIdx = n - 1 - (streak - ms) - (today.goalMet ? 0 : 1);
        if (dayIdx <= 0 || dayIdx >= n) continue;
        const x = this.dayX(dayIdx);
        const s = this.sampleAtX(x);
        const ry = s ? s.y : this.yAt(x);
        const wdAt = s ? s.wd : wMin;
        pre.push({ m: ms, x, y: ry - wdAt * 1.1 - 10 * k, ry });
      }
      const fs = Math.round(10 * Math.max(1, k * 0.8));
      const ctx = this.ctx;
      ctx.font = `500 ${fs}px "Geist Variable", Geist, system-ui`;
      const lbl = placeLabels(
        pre.map((p) => {
          const tw = ctx.measureText(`${p.m} days`).width + 6;
          const s = (5 + 1.5) * k;
          const cy = p.y - s - 4 - fs / 2;
          // above the star, else beside it (never far below: the label must read as the star's)
          return { x: p.x, y: cy, alts: [{ x: p.x - s - 6 - tw / 2, y: p.y }, { x: p.x + s + 6 + tw / 2, y: p.y }], w: tw, h: fs + 4, priority: p.m };
        }),
        v.labels ? rects : [],
        { w, h },
        72,
      );
      // a label whose star sits in the head's glow would pile onto it: keep the star only
      const glowR = v.headR * k * 2.8;
      this.milestones = pre.map((p, q) => {
        const near = Math.hypot(p.x - this.head.x, p.y - this.head.y) < glowR;
        return { ...p, label: v.labels && !near ? lbl[q]! : { visible: false, x: p.x, y: p.y } };
      });
    }

    // stars
    const r = rng(this.seed * 131);
    this.stars = [];
    const tier = this.tier();
    const count = Math.round(((T.starCount * (w * h)) / (360 * 200)) * (tier.min >= 30 ? 1.5 : 1));
    const free = v.starFree ?? [];
    for (let q = 0; q < Math.min(count, 260); q++) {
      const st = { x: r() * w, y: Math.pow(r(), 1.6) * h * 0.62, s: 0.5 + r() * 1.2, ph: r() * 6.28, sp: 0.6 + r() * 1.6 };
      // no stars behind text
      if (free.some((f) => st.x > f.x - 4 && st.x < f.x + f.w + 4 && st.y > f.y - 4 && st.y < f.y + f.h + 4)) continue;
      this.stars.push(st);
    }
    if (this.hoverDay !== null) this.hoverDay = clamp(this.hoverDay, 0, n - 1);
    return true;
  }

  /* ---------------- cached layers ---------------- */

  private paintSky(): void {
    const c = this.skyCache.getContext("2d")!;
    const w = this.w;
    const h = this.h;
    const T = this.theme;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, w, h);
    const g = c.createLinearGradient(0, 0, 0, h);
    for (const [o, col] of T.sky) g.addColorStop(o, col);
    c.fillStyle = g;
    c.fillRect(0, 0, w, h);
    if (T.sun) {
      // a low, soft sun behind the head: the golden-hour light source
      const sx = this.head.x;
      const sy = h * 0.98;
      const sg = c.createRadialGradient(sx, sy, 0, sx, sy, h * 0.95);
      sg.addColorStop(0, `${T.sun}0.75)`);
      sg.addColorStop(0.35, `${T.sun}0.32)`);
      sg.addColorStop(1, `${T.sun}0)`);
      c.fillStyle = sg;
      c.fillRect(0, 0, w, h);
      // violet haze in the upper-left for depth
      const vg = c.createRadialGradient(w * 0.08, -h * 0.1, 0, w * 0.08, -h * 0.1, h * 1.1);
      vg.addColorStop(0, "rgba(206,190,250,0.45)");
      vg.addColorStop(1, "rgba(206,190,250,0)");
      c.fillStyle = vg;
      c.fillRect(0, 0, w, h);
    }
    if (this.v.hills) {
      const hill = (base: number, amp: number, f: number, ph: number, col: string) => {
        c.fillStyle = col;
        c.beginPath();
        c.moveTo(0, h);
        for (let x = 0; x <= w + 8; x += 8)
          c.lineTo(x, h * base + Math.sin((x / w) * f + ph) * amp * h + Math.sin((x / w) * f * 2.7 + ph * 2) * amp * 0.35 * h);
        c.lineTo(w, h);
        c.fill();
      };
      if (this.v.hillTop !== undefined) {
        // the ridge never rises above hillTop: text above it stays on the sky
        const top = this.v.hillTop;
        const a1 = Math.min(0.02, (1 - top) * 0.3);
        hill(top + a1 * 1.35, a1, 5.2, 1.1, T.hills[0]);
        hill(top + a1 * 1.35 + (1 - top) * 0.35, a1 * 0.7, 7.5, 3.3, T.hills[1]);
      } else {
        hill(0.9, 0.035, 5.2, 1.1, T.hills[0]);
        hill(0.95, 0.025, 7.5, 3.3, T.hills[1]);
      }
    }
  }

  /** Spans of samples drawn as bands (1-2 day sparks are drawn as points of light). */
  private spans(): { s0: number; s1: number }[] {
    return this.pieces.filter((p) => !p.spark).map((p) => ({ s0: p.s0, s1: p.head ? this.cacheEnd : p.s1 })).filter((s) => s.s1 - s.s0 >= 1);
  }

  private paintRibbon(): void {
    const c = this.cache.getContext("2d")!;
    const T = this.theme;
    const k = this.k;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.globalCompositeOperation = T.blend;
    const spans = this.spans();
    // bloom on a quarter-resolution canvas: the blur is ~16x cheaper and looks the same upscaled
    const q = this.dpr * 0.25;
    const gc = this.glowCache;
    gc.width = Math.max(1, Math.round(this.w * q));
    gc.height = Math.max(1, Math.round(this.h * q));
    const g = gc.getContext("2d")!;
    g.setTransform(q, 0, 0, q, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    g.globalCompositeOperation = T.blend;
    for (const s of spans) this.band(g, s.s0, s.s1, "glow");
    for (const pc of this.pieces) if (pc.spark) this.paintSpark(g, pc, true);
    // Blur by compositing with an identity transform: filter radii then mean
    // device pixels in every engine (WebKit scales them by the transform).
    c.drawImage(this.blurInto(this.blurCache, gc, 8 * k * q), 0, 0, this.w, this.h);
    if (T.shadow) {
      const q2 = this.dpr * 0.5;
      const sc = this.shadowCache;
      sc.width = Math.max(1, Math.round(this.w * q2));
      sc.height = Math.max(1, Math.round(this.h * q2));
      const sx = sc.getContext("2d")!;
      sx.setTransform(q2, 0, 0, q2, 0, 3.4 * k * q2);
      sx.clearRect(0, -10, this.w, this.h + 10);
      for (const s of spans) this.band(sx, s.s0, s.s1, "shadow");
      c.save();
      c.globalCompositeOperation = "source-over";
      c.drawImage(this.blurInto(this.blurCache, sc, 4 * k * q2), 0, 0, this.w, this.h);
      c.restore();
    }
    // bodies: all pieces crisp on one layer, then composite once with a light blur
    const bc = this.bodyCache;
    bc.width = this.cache.width;
    bc.height = this.cache.height;
    const bctx = bc.getContext("2d")!;
    bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    bctx.globalCompositeOperation = T.blend;
    for (const s of spans) this.band(bctx, s.s0, s.s1, "body");
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    const blurPx = T.bodyBlur * k * this.dpr;
    if (blurPx >= 1 && filterBlurWorks()) {
      c.filter = `blur(${blurPx.toFixed(1)}px)`;
      c.drawImage(bc, 0, 0);
    } else if (blurPx >= 1) {
      // WebKit accepts ctx.filter but ignores it: soften by resampling through a smaller
      // canvas instead (bilinear down and up is about a one-to-two device-pixel blur)
      const f = clamp(1 / blurPx, 0.35, 0.6);
      const sc = this.blurCache;
      sc.width = Math.max(1, Math.round(bc.width * f));
      sc.height = Math.max(1, Math.round(bc.height * f));
      const sx = sc.getContext("2d")!;
      sx.setTransform(1, 0, 0, 1, 0, 0);
      sx.clearRect(0, 0, sc.width, sc.height);
      sx.imageSmoothingEnabled = true;
      sx.imageSmoothingQuality = "high";
      sx.drawImage(bc, 0, 0, sc.width, sc.height);
      c.imageSmoothingEnabled = true;
      c.imageSmoothingQuality = "high";
      c.drawImage(sc, 0, 0, bc.width, bc.height);
    } else c.drawImage(bc, 0, 0);
    c.restore();
    if (this.themeName === "light") this.paintLightHistory(c, spans);
    for (const s of spans) this.band(c, s.s0, s.s1, "core");
    for (const pc of this.pieces) if (pc.spark) this.paintSpark(c, pc, false);
    // compressed axis: a hairline break across the ribbon where older history is squeezed
    if (this.axis.split > 0) {
      const xb = this.axis.xSplit;
      const yb = this.yAt(xb);
      const sa = this.sampleAtX(xb);
      const half = (sa ? sa.wd * T.bodyMul * 0.5 : 6 * k) + 3;
      c.save();
      c.globalCompositeOperation = "destination-out";
      c.strokeStyle = "rgba(0,0,0,0.85)";
      c.lineWidth = 1.2;
      for (const off of [-2.2, 2.2]) {
        c.beginPath();
        c.moveTo(xb + off - half * 0.35, yb + half);
        c.lineTo(xb + off + half * 0.35, yb - half);
        c.stroke();
      }
      c.restore();
      c.globalCompositeOperation = T.blend;
    }
    for (const e of this.embers) {
      const eg = c.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.r * 3);
      eg.addColorStop(0, rgba(T.ember, e.a * (this.themeName === "dark" ? 0.9 : 0.65)));
      eg.addColorStop(0.25, rgba(T.ember, e.a * 0.35));
      eg.addColorStop(1, rgba(T.ember, 0));
      c.fillStyle = eg;
      c.beginPath();
      c.arc(e.x, e.y, e.r * 3, 0, 7);
      c.fill();
    }
    // a soft 40% mask under any HUD element the route could not clear
    const rects = [...(this.v.avoid ?? []), ...this.avoid];
    if (rects.length) {
      c.globalCompositeOperation = "destination-out";
      const T2 = this.theme;
      const hits = (r: Rect) => this.samples.some((q) => q.x >= r.x - 6 && q.x <= r.x + r.w + 6 && q.y + q.wd * T2.bodyMul * 0.5 >= r.y - 4 && q.y - q.wd * T2.bodyMul * 0.5 <= r.y + r.h + 4);
      for (const r of rects.filter(hits))
        for (let s = 0; s < 4; s++) {
          const inset = 12 - s * 5;
          c.fillStyle = "rgba(0,0,0,0.11)";
          c.beginPath();
          c.roundRect(r.x - inset, r.y - inset, r.w + inset * 2, r.h + inset * 2, 10 + inset);
          c.fill();
        }
    }
    c.globalCompositeOperation = "source-over";
  }

  /** Draws `src` into `dst` (same pixel size) through a device-pixel blur. */
  private blurInto(dst: HTMLCanvasElement, src: HTMLCanvasElement, px: number): HTMLCanvasElement {
    dst.width = src.width;
    dst.height = src.height;
    const d = dst.getContext("2d")!;
    d.setTransform(1, 0, 0, 1, 0, 0);
    d.clearRect(0, 0, dst.width, dst.height);
    if (filterBlurWorks()) {
      d.filter = `blur(${Math.max(0.5, px).toFixed(1)}px)`;
      d.drawImage(src, 0, 0);
      d.filter = "none";
    } else {
      d.drawImage(src, 0, 0);
      softwareBlur(dst, px);
    }
    return dst;
  }

  private colorFor(s: Sample, mode: "glow" | "body" | "core"): RGB {
    const T = this.theme;
    if (mode === "core") return mixRGB(T.core, T.coolCore, clamp((s.cache - 0.4) / 0.5, 0, 1));
    let col = s.col;
    if (T.ramp && mode === "body") col = mixRGB(col, mixRGB(T.ramp[0], T.ramp[1], s.u), T.rampAmt);
    if (s.cool > 0) col = mixRGB(col, T.afterglow, s.cool);
    if (mode === "glow" && T.glowTint) col = mixRGB(col, T.glowTint, T.glowTintAmt);
    return col;
  }

  /** One filled band along samples s0..s1 with per-sample width and alpha. */
  private band(c: Ctx, s0: number, s1: number, mode: "glow" | "body" | "core" | "shadow", arr?: Sample[]): void {
    const T = this.theme;
    const dark = this.themeName === "dark";
    // light: history is drawn by paintLightHistory; these layers fade out with the history weight
    const cur = (s: Sample) => (dark ? 1 : 1 - s.hw);
    const mul = mode === "glow" ? T.glowMul : mode === "core" ? T.coreW : mode === "shadow" ? T.bodyMul * 0.92 : T.bodyMul;
    const alphaOf = (s: Sample) => {
      if (mode === "glow") {
        // light history gets a warm bloom that scales with brightness (not its square)
        // (light history draws its own bloom geometrically in paintLightHistory, for engine parity)
        return dark ? T.glowA * Math.pow(s.a, 1.15) * s.ef : T.glowA * Math.pow(s.a, 2) * (1 - s.hw) * s.ef;
      }
      if (mode === "body") return T.bodyA * s.a * cur(s) * s.ef;
      if (mode === "shadow") return 0.16 * clamp((s.a - 0.55) / 0.45, 0, 1) * cur(s) * s.ef;
      // core: fades faster than the body on dim days; on very wide ribbons in dark it is held
      // back so additive light never blows out; it fades out first at a break
      const damp = dark ? Math.min(1, Math.pow((9 * this.k) / Math.max(1, s.wd), 0.35)) : 1;
      return T.coreA * Math.pow(clamp((s.a - 0.62) / 0.38, 0, 1), 1.2) * damp * cur(s) * s.ef * s.ef;
    };
    const glowMul = (s: Sample) => (mode === "glow" && !dark ? lerp(T.glowMul, 3.2, s.hw) : mul);
    this.fillBand(
      c,
      arr ?? this.samples,
      s0,
      s1,
      (s) => Math.max(mode === "core" ? 0.35 : 0, s.wd * glowMul(s) * 0.5),
      (s) => (mode === "shadow" ? SHADOW_COL : this.colorFor(s, mode as "glow" | "body" | "core")),
      alphaOf,
    );
  }

  /** Fills the band between offset curves with a horizontal colour/alpha gradient. */
  private fillBand(c: Ctx, S: Sample[], s0: number, s1: number, half: (s: Sample) => number, col: (s: Sample) => RGB, alpha: (s: Sample) => number): void {
    if (s1 - s0 < 1) return;
    const g = c.createLinearGradient(S[s0]!.x, 0, S[s1]!.x, 0);
    const span = S[s1]!.x - S[s0]!.x || 1;
    const every = Math.max(1, Math.floor((s1 - s0) / 120));
    for (let j = s0; j <= s1; j += every) {
      const s = S[j]!;
      g.addColorStop(clamp((s.x - S[s0]!.x) / span, 0, 1), rgba(col(s), alpha(s)));
    }
    const e = S[s1]!;
    g.addColorStop(1, rgba(col(e), alpha(e)));
    c.fillStyle = g;
    c.beginPath();
    for (let j = s0; j <= s1; j++) {
      const s = S[j]!;
      const hw = half(s);
      if (j === s0) c.moveTo(s.x + s.nx * hw, s.y + s.ny * hw);
      else c.lineTo(s.x + s.nx * hw, s.y + s.ny * hw);
    }
    for (let j = s1; j >= s0; j--) {
      const s = S[j]!;
      const hw = half(s);
      c.lineTo(s.x - s.nx * hw, s.y - s.ny * hw);
    }
    c.closePath();
    c.fill();
  }

  /**
   * Light theme history: light, not paint. A cross-section falloff (three soft bands
   * in the run's own warm ramp) under a lit, pre-softened core that is brighter than
   * the sky on goal days. Pure geometry and gradients: no ctx.filter, so it renders
   * the same in WebKit and Chromium.
   */
  private paintLightHistory(c: Ctx, spans: { s0: number; s1: number }[]): void {
    const T = this.theme;
    const coral: RGB = [255, 150, 120];
    const bodyCol = (s: Sample): RGB => mixRGB(T.ramp ? mixRGB(s.col, mixRGB(T.ramp[0], T.ramp[1], s.u), T.rampAmt) : s.col, coral, 0.5);
    const coreCol: RGB = [255, 248, 240];
    c.save();
    c.globalCompositeOperation = "source-over";
    const glowCol = (s: Sample): RGB => mixRGB(bodyCol(s), T.glowTint ?? coral, T.glowTintAmt);
    for (const sp of spans) {
      // warm bloom: a haze out to 3.2 body widths (glowA * a), in soft steps; no ctx.filter
      for (const wm of [3.2, 2.6, 2.05, 1.6])
        this.fillBand(c, this.samples, sp.s0, sp.s1, (s) => s.wd * wm * 0.5, glowCol, (s) => T.glowA * s.a * 0.26 * s.hw * s.ef);
      // cross-section: wide and faint to narrow and denser, so the edge falls off over several px
      for (const [wm, am] of [[1.3, 0.06], [1.08, 0.1], [0.86, 0.13], [0.66, 0.16], [0.46, 0.18]] as const)
        this.fillBand(c, this.samples, sp.s0, sp.s1, (s) => s.wd * T.bodyMul * wm * 0.5, bodyCol, (s) => am * s.hw * s.ef);
      // the lit core: full on goal days, dimmer on other days; fades out first at a break
      // (pre-softened in three passes; the innermost stays under the current run's crisp core)
      for (const [wm, am] of [[0.5, 0.2], [0.3, 0.35], [0.14, 0.8]] as const)
        this.fillBand(c, this.samples, sp.s0, sp.s1, (s) => Math.max(0.4, s.wd * wm * 0.5), () => coreCol, (s) => am * s.hw * s.gw * s.ef * s.ef);
    }
    c.restore();
  }

  /** A 1-2 day stretch between breaks: a point of light with a warm halo. */
  private paintSpark(c: Ctx, pc: Piece, glowOnly: boolean): void {
    const S = this.samples;
    let top = S[pc.s0]!;
    for (let q = pc.s0; q <= pc.s1; q++) if (S[q]!.wd > top.wd) top = S[q]!;
    const mid = S[Math.round((pc.s0 + pc.s1) / 2)]!;
    const w = Math.max(3, top.wd);
    const dark = this.themeName === "dark";
    const T = this.theme;
    const halo: RGB = dark ? mixRGB(mid.col, T.afterglow, 0.3) : [255, 170, 120];
    const a = dark ? Math.max(0.5, mid.a) : 0.5 + 0.5 * mid.gw;
    if (glowOnly) {
      const g = c.createRadialGradient(mid.x, mid.y, 0, mid.x, mid.y, w * 2.2);
      g.addColorStop(0, rgba(halo, 0.35 * a));
      g.addColorStop(1, rgba(halo, 0));
      c.fillStyle = g;
      c.beginPath();
      c.arc(mid.x, mid.y, w * 2.2, 0, 7);
      c.fill();
      return;
    }
    const g = c.createRadialGradient(mid.x, mid.y, 0, mid.x, mid.y, w * 1.6);
    g.addColorStop(0, rgba([255, 250, 244], 0.95 * a));
    g.addColorStop(0.19, rgba([255, 246, 236], 0.85 * a));
    g.addColorStop(0.45, rgba(halo, 0.45 * a));
    g.addColorStop(1, rgba(halo, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(mid.x, mid.y, w * 1.6, 0, 7);
    c.fill();
  }

  /* ---------------- live layers ---------------- */

  private draw(dt: number, simulateOnly = false): void {
    const c = this.ctx;
    const T = this.theme;
    const w = this.w;
    const h = this.h;
    const t = this.reduced ? 0 : this.t;
    const k = this.k;
    const v = this.v;
    const dark = this.themeName === "dark";
    const tier = this.tier();
    this.progressShown += (this.progressTarget - this.progressShown) * Math.min(1, dt * 3.2);
    const prog = this.progressShown;
    const revealP = this.revealing ? clamp((this.t - this.revealAt) / REVEAL_SECONDS, 0, 1) : 1;
    if (simulateOnly) {
      this.headSparks(prog, revealP);
      this.stepParticles(dt);
      return;
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    const ce = this.celebrateAt >= 0 ? this.t - this.celebrateAt : -1;
    const celebrating = ce >= 0 && ce < 3 && !this.reduced;
    const pulse = celebrating && ce < 0.7 ? 1 + Math.sin((ce / 0.7) * Math.PI) * 0.014 : 1;
    c.setTransform(this.dpr * pulse, 0, 0, this.dpr * pulse, (1 - pulse) * this.head.x * this.dpr, (1 - pulse) * this.head.y * this.dpr);
    c.drawImage(this.skyCache, 0, 0, w, h);
    // horizon warmth grows with today's progress; blooms after the goal
    const warm = clamp(prog, 0, 1) * 0.5 + (prog >= 1 ? 0.25 : 0) + (ce >= 0 ? Math.max(0, 0.7 - ce * 0.3) : 0);
    const hg = c.createRadialGradient(this.head.x, h * 1.05, 0, this.head.x, h * 1.05, h * 1.1);
    hg.addColorStop(0, `${T.horizon}${((dark ? 0.45 : 0.5) * warm).toFixed(3)})`);
    hg.addColorStop(1, `${T.horizon}0)`);
    c.fillStyle = hg;
    c.fillRect(0, 0, w, h);
    if (tier.min >= 100) this.aurora(c, t);
    if (this.revealing) {
      if (revealP >= 1) this.revealing = false;
      this.reportReveal(revealP);
    }
    const twinkleBoost = celebrating && ce < 1.6 ? 1 + 0.8 * (1 - ce / 1.6) : 1;
    // stars in four brightness groups: four fills per frame instead of one per star
    const groups: Star[][] = [[], [], [], []];
    for (const s of this.stars) groups[Math.min(3, Math.floor(Math.abs(Math.sin(t * s.sp + s.ph)) * 4))]!.push(s);
    c.fillStyle = `${T.star}1)`;
    groups.forEach((g, gi) => {
      if (!g.length) return;
      const tw = 0.35 + 0.65 * ((gi + 0.5) / 4);
      c.globalAlpha = Math.min(1, tw * T.starA * revealP * twinkleBoost);
      c.beginPath();
      for (const s of g) {
        const yy = dark ? s.y : s.y + Math.sin(s.ph) * 4;
        const r = s.s * (dark ? 1 : 1.3);
        c.moveTo(s.x + r, yy);
        c.arc(s.x, yy, r, 0, 6.2832);
      }
      c.fill();
    });
    c.globalAlpha = 1;
    const first = this.pts[0]!;
    const revealX = revealP < 1 ? lerp(Math.max(0, first.x) - 20, this.head.x + 4, easeReveal(revealP)) : w + 10;
    c.save();
    if (revealP < 1) {
      c.beginPath();
      c.rect(0, 0, revealX, h);
      c.clip();
    }
    c.drawImage(this.cache, 0, 0, w, h);
    c.globalCompositeOperation = T.blend;
    if (this.curRun && this.curRun.s1 - this.curRun.s0 >= 2 && this.samples[this.curRun.s0]!.x < revealX) this.strandPaths(c, this.curRun.s0, this.curRun.s1, t, 1, true);
    this.shimmer(c, t, ce);
    if (celebrating) this.rollCall(c, ce);
    c.restore();
    const fs = Math.round(10 * Math.max(1, k * 0.8));
    this.milestones.forEach((m, i) => {
      if (m.x > revealX) return;
      let s = (5 + i * 1.5) * k;
      let a = 0.9;
      // the roll call makes each milestone star flare as the flash passes it
      const rc = this.rollCallEnvelope(m.x, ce);
      if (rc > 0) {
        s *= 1 + rc * 0.9;
        a = Math.min(1, a + rc);
      }
      this.sparkle(c, m.x, m.y, s, t * 0.6 + i, a);
      if (m.label.visible) this.label(c, `${m.m} days`, m.label.x, m.label.y, fs);
    });
    if (revealP >= 1) this.drawHead(c, prog, t, ce, tier);
    else if (revealP > 0.02) {
      const y = this.yAt(revealX);
      this.glowDot(c, revealX, y, 11 * k, 0.95);
      this.glowDot(c, revealX, y, 4 * k, 1);
    }
    this.headSparks(prog, revealP);
    this.stepParticles(dt);
    this.drawParticles(c);
    if (celebrating && ce < 1.4) {
      // shockwave: two rings racing well past the comet
      const reach = Math.max(w, h) * 0.5;
      for (const [delay, wmul] of [[0, 1], [0.14, 0.55]] as const) {
        const e = ce - delay;
        if (e < 0 || e > 1.2) continue;
        const p = easeOutCubic(e / 1.2);
        c.globalCompositeOperation = "source-over";
        c.strokeStyle = dark ? rgba([255, 236, 210], 0.75 * (1 - p) * wmul) : rgba([226, 80, 116], 0.7 * (1 - p) * wmul);
        c.lineWidth = (3 * k * (1 - p) + 0.6) * wmul;
        c.beginPath();
        c.arc(this.head.x, this.head.y, v.headR * k + p * reach, 0, 7);
        c.stroke();
      }
    }
    if (this.hoverDay !== null && this.days.length) {
      const hx = this.dayX(this.hoverDay);
      const hy = this.yAt(hx);
      const gap = this.days[this.hoverDay]!.tokens <= 0 && !this.days[this.hoverDay]!.isToday;
      c.globalCompositeOperation = "source-over";
      c.strokeStyle = T.halo;
      c.lineWidth = 1;
      c.setLineDash([3, 4]);
      c.beginPath();
      c.moveTo(hx, 0);
      c.lineTo(hx, h);
      c.stroke();
      c.setLineDash([]);
      if (gap) {
        c.strokeStyle = T.halo;
        c.lineWidth = 1.2;
        c.beginPath();
        c.arc(hx, hy, 3.5, 0, 7);
        c.stroke();
      } else {
        c.globalCompositeOperation = T.blend;
        this.glowDot(c, hx, hy, 7 * k, 1);
        if (!dark) {
          c.globalCompositeOperation = "source-over";
          c.fillStyle = "rgba(255,255,255,0.95)";
          c.strokeStyle = rgba(T.ring, 0.9);
          c.lineWidth = 1.5;
          c.beginPath();
          c.arc(hx, hy, 3.2, 0, 7);
          c.fill();
          c.stroke();
        }
      }
    }
    if (celebrating && ce < 0.9) {
      // the whole sky brightens for a moment
      const e = ce < 0.12 ? ce / 0.12 : Math.pow(1 - (ce - 0.12) / 0.78, 1.6);
      c.globalCompositeOperation = dark ? "lighter" : "source-over";
      c.fillStyle = rgba(T.flash, T.flashA * clamp(e, 0, 1));
      c.fillRect(0, 0, w, h);
    }
    c.globalCompositeOperation = "source-over";
  }

  private reportReveal(p: number): void {
    if (!this.revealCb) return;
    let frac = 1;
    if (p < 1 && this.cum.length > 1) {
      const first = this.pts[0]!;
      const x = lerp(Math.max(0, first.x) - 20, this.head.x + 4, easeReveal(p));
      const di = clamp(axisDay(this.axis, x), 0, this.cum.length - 1);
      const i0 = Math.floor(di);
      const total = this.cum[this.cum.length - 1]! || 1;
      const a = i0 > 0 ? this.cum[i0 - 1]! : 0;
      const b = this.cum[i0]!;
      frac = clamp(lerp(a, b, di - i0) / total, 0, 1);
    }
    if (frac === this.lastRevealP) return;
    this.lastRevealP = frac;
    this.revealCb(frac);
  }

  private label(c: Ctx, text: string, x: number, y: number, fs: number): void {
    const T = this.theme;
    c.globalCompositeOperation = "source-over";
    c.font = `500 ${fs}px "Geist Variable", Geist, system-ui`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.lineWidth = 3;
    c.lineJoin = "round";
    c.strokeStyle = T.textHalo;
    c.strokeText(text, x, y);
    c.fillStyle = T.text;
    c.fillText(text, x, y);
    c.textBaseline = "alphabetic";
  }

  private sampleAtX(x: number): Sample | null {
    let best: Sample | null = null;
    let bd = Infinity;
    for (const s of this.samples) {
      const d = Math.abs(s.x - x);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best && bd <= Math.max(2, this.step) ? best : null;
  }

  /**
   * Tool-mix strand paths: resampled along arc length at <= 2 px (position and normal
   * interpolated between samples), phased by arc length, so they are smooth curves in
   * any layout (per-sample offsets on sparse samples aliased into closed polygons).
   * Each point carries a weight that fades the strand where the ribbon is thinner than
   * about 6 px or the underlying samples are sparse.
   */
  strandPoints(a: number, b: number, t: number, ti: number, live = true): { x: number; y: number; w: number }[] {
    const S = this.samples;
    const T = this.theme;
    const k = this.k;
    const dark = this.themeName === "dark";
    const wave = T.strandWave * k;
    const out: { x: number; y: number; w: number }[] = [];
    if (b - a < 1) return out;
    const ds = 2;
    let len = 0;
    let total = 0;
    for (let j = a + 1; j <= b; j++) total += Math.hypot(S[j]!.x - S[j - 1]!.x, S[j]!.y - S[j - 1]!.y);
    for (let j = a; j < b; j++) {
      const p = S[j]!;
      const q = S[j + 1]!;
      const seg = Math.hypot(q.x - p.x, q.y - p.y);
      const n = Math.max(1, Math.ceil(seg / ds));
      // sparse samples (a compressed axis): the ribbon's shape between them is guesswork
      const sparse = smoothstep(wave / 8, wave / 5, seg);
      for (let u = 0; u < n; u++) {
        const f = u / n;
        const x = lerp(p.x, q.x, f);
        const y = lerp(p.y, q.y, f);
        let nx = lerp(p.nx, q.nx, f);
        let ny = lerp(p.ny, q.ny, f);
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl;
        ny /= nl;
        const wd = lerp(p.wd, q.wd, f);
        const l = len + seg * f;
        const tp = Math.min(1, l / (6 * ds * 3), (total - l) / (3 * ds * 3) + (live ? 1 : 0.1));
        const off = (Math.sin(l / wave + ti * 2.09 + t * (0.7 + ti * 0.13)) * 0.8 + Math.sin(l / (wave * 2.3) - ti + t * 0.3) * 0.2) * wd * (dark ? 0.36 : 0.26) * tp;
        out.push({ x: x + nx * off, y: y + ny * off, w: smoothstep(4.5, 7, wd) * (1 - sparse) * lerp(p.a, q.a, f) * clamp(lerp(p.sh[ti] ?? 0, q.sh[ti] ?? 0, f) * 1.6 + 0.08, 0, 1) });
      }
      len += seg;
    }
    const e = S[b]!;
    out.push({ x: e.x, y: e.y, w: 0 });
    return out;
  }

  /** Tool-mix strands: three thin threads weaving inside the current run. */
  private strandPaths(c: Ctx, a: number, b: number, t: number, dim: number, live: boolean): void {
    const S = this.samples;
    const T = this.theme;
    const k = this.k;
    const dark = this.themeName === "dark";
    TOOLS.forEach((tk, ti) => {
      let any = false;
      for (let j = a; j <= b; j += 4) if ((S[j]!.sh[ti] ?? 0) > 0.03) any = true;
      if (!any) return;
      const pts = this.strandPoints(a, b, t, ti, live);
      if (pts.length < 2) return;
      const g = c.createLinearGradient(pts[0]!.x, 0, pts[pts.length - 1]!.x, 0);
      const x0 = pts[0]!.x;
      const span = pts[pts.length - 1]!.x - x0 || 1;
      const every = Math.max(1, Math.floor(pts.length / 40));
      const col = mixRGB(T.tool[tk], dark ? [255, 250, 240] : [255, 255, 255], T.strandWhite);
      for (let j = 0; j < pts.length; j += every) g.addColorStop(clamp((pts[j]!.x - x0) / span, 0, 1), rgba(col, T.strandA * dim * pts[j]!.w));
      c.strokeStyle = g;
      c.lineWidth = Math.max(0.6, (dark ? 0.9 : 0.75) * k);
      c.lineJoin = "round";
      c.beginPath();
      pts.forEach((p, j) => (j === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y)));
      c.stroke();
    });
  }

  private shimmer(c: Ctx, t: number, ce: number): void {
    const run = this.curRun;
    if (!run || this.reduced || this.fixedSize) return;
    if (ce >= 0 && ce < 2.2) return; // the roll call owns the ribbon during the celebration
    const a = run.s0;
    const b = run.s1;
    const len = b - a;
    if (len < 4) return;
    // constant speed along the run, fading in and out at its ends (never parks on the start)
    const p = (t % 7) / 7;
    const env = Math.sin(Math.PI * p);
    const center = a + p * len;
    const win = Math.max(8, len * 0.11);
    this.glide(c, Math.max(a, Math.floor(center - win)), Math.min(b, Math.ceil(center + win)), (j) => {
      const f = 1 - Math.abs(j - center) / win;
      return f > 0 ? this.theme.shimmerA * f * f * env : 0;
    }, this.themeName === "dark" ? 0.8 : 0.45);
  }

  /**
   * A soft band of light over samples a..b (no caps, no hard edges): alpha per
   * sample from `alpha`, width as a fraction of the ribbon.
   */
  private glide(c: Ctx, a: number, b: number, alpha: (j: number) => number, widthMul: number): void {
    if (b - a < 1) return;
    const S = this.samples;
    const T = this.theme;
    const g = c.createLinearGradient(S[a]!.x, 0, S[b]!.x, 0);
    const span = S[b]!.x - S[a]!.x || 1;
    for (let j = a; j <= b; j++) g.addColorStop(clamp((S[j]!.x - S[a]!.x) / span, 0, 1), rgba(T.shimmer, alpha(j) * S[j]!.a));
    c.fillStyle = g;
    c.beginPath();
    for (let j = a; j <= b; j++) {
      const s = S[j]!;
      const hw = s.wd * widthMul * 0.5;
      if (j === a) c.moveTo(s.x + s.nx * hw, s.y + s.ny * hw);
      else c.lineTo(s.x + s.nx * hw, s.y + s.ny * hw);
    }
    for (let j = b; j >= a; j--) {
      const s = S[j]!;
      const hw = s.wd * widthMul * 0.5;
      c.lineTo(s.x - s.nx * hw, s.y - s.ny * hw);
    }
    c.closePath();
    c.fill();
  }

  /* ---------------- celebration ---------------- */

  /** Roll-call timing: when the flash starts and how long it takes to run the streak. */
  private rollCallTiming(): { start: number; dur: number } {
    const days = this.curRun?.days ?? 1;
    return { start: 0.16, dur: clamp(0.5 + days * 0.012, 0.65, 1.25) };
  }

  /** 0..1 flare for a point at x as the roll-call flash passes it. */
  private rollCallEnvelope(x: number, ce: number): number {
    const run = this.curRun;
    if (!run || ce < 0 || this.reduced) return 0;
    const x0 = this.samples[run.s0]!.x;
    const x1 = this.head.x;
    if (x < x0 - 1 || x > x1 + 1) return 0;
    const { start, dur } = this.rollCallTiming();
    const u = (x1 - x) / (x1 - x0 || 1); // 0 at the head, 1 at the run's start
    const tPass = start + u * dur;
    const dtp = ce - tPass;
    if (dtp < -0.05) return 0;
    return dtp < 0 ? 1 + dtp / 0.05 : Math.exp(-dtp / 0.32);
  }

  /** A flash racing back along the streak; every lit day pulses once, in sequence. */
  private rollCall(c: Ctx, ce: number): void {
    const run = this.curRun;
    if (!run) return;
    const S = this.samples;
    const k = this.k;
    const dark = this.themeName === "dark";
    const { start, dur } = this.rollCallTiming();
    const x0 = S[run.s0]!.x;
    const x1 = this.head.x;
    const p = (ce - start) / dur;
    // the ribbon brightens behind the flash, then settles
    if (p > 0 && p < 1.6) {
      const fx = x1 - (x1 - x0) * clamp(p, 0, 1);
      let j0 = run.s0;
      while (j0 < run.s1 && S[j0]!.x < fx - 2) j0++;
      this.glide(c, Math.max(run.s0, j0 - 1), run.s1, (j) => (dark ? 0.6 : 0.8) * this.rollCallEnvelope(S[j]!.x, ce), dark ? 1.05 : 0.65);
      if (p <= 1) {
        const y = this.yAt(fx);
        c.globalCompositeOperation = dark ? "lighter" : "source-over";
        this.glowDot(c, fx, y, 16 * k, 0.9);
        this.glowDot(c, fx, y, 5 * k, 1);
      }
    }
    // each lit day pulses once as the flash passes
    const P = this.pts;
    const every = Math.max(1, Math.ceil(5 / Math.max(1, this.step)));
    for (let q = run.p0; q < P.length - 1; q += every) {
      const pt = P[q]!;
      if (pt.role !== "current") continue;
      const env = this.rollCallEnvelope(pt.x, ce);
      if (env < 0.04) continue;
      const s = (2.4 + pt.wd * 0.32) * k * (0.5 + env * 0.8);
      this.sparkle(c, pt.x, pt.y, s, q * 0.7, env);
    }
  }

  private drawHead(c: Ctx, prog: number, t: number, ce: number, tier: TrailTier): void {
    const T = this.theme;
    const k = this.k;
    const x = this.head.x;
    const y = this.head.y;
    const R = this.v.headR * k;
    const dark = this.themeName === "dark";
    // emphasizeAll cards (the lean week) end in a lit comet: the card is not about today's goal
    const lit = prog >= 1 || !!this.v.emphasizeAll;
    const f = lit ? 1 : clamp(prog, 0, 1);
    const breath = this.reduced ? 1 : 1 + Math.sin(t * 2.2) * 0.04;
    let pop = 1;
    if (ce >= 0 && ce < 1.4 && !this.reduced) pop = 1 + (spring(ce / 0.9) - 1) * 0.6 + (1 - clamp(ce / 0.25, 0, 1)) * 0.7;
    c.globalCompositeOperation = "source-over";
    if (!lit) {
      c.strokeStyle = T.halo;
      c.lineWidth = 1.2 * k;
      c.setLineDash([2 * k, 3 * k]);
      c.beginPath();
      c.arc(x, y, R * 1.25, 0, 7);
      c.stroke();
      c.setLineDash([]);
      c.strokeStyle = rgba(T.ring, T.ringA);
      c.lineWidth = (dark ? 2 : 1.8) * k;
      c.lineCap = "round";
      c.beginPath();
      c.arc(x, y, R * 1.25, -Math.PI / 2, -Math.PI / 2 + f * Math.PI * 2);
      c.stroke();
    } else if (tier.min >= 365) {
      c.strokeStyle = dark ? "rgba(255,214,140,0.6)" : "rgba(232,150,60,0.55)";
      c.lineWidth = 1.4 * k;
      c.beginPath();
      c.arc(x, y, R * 1.7 + Math.sin(t) * 1.5, 0, 7);
      c.stroke();
    }
    c.globalCompositeOperation = T.blend;
    const r = R * (0.45 + 0.55 * f) * breath * pop * (lit ? 1.12 : 1);
    const col = this.pts[this.pts.length - 1]!.col;
    const warmCol: RGB = dark ? col : mixRGB(col, [255, 160, 110], 0.4);
    const g = c.createRadialGradient(x, y, 0, x, y, r * 2.6);
    g.addColorStop(0, rgba(T.core, 1));
    g.addColorStop(0.14, rgba(T.core, 0.9));
    g.addColorStop(0.32, rgba(warmCol, lit ? 0.6 : 0.35 + 0.2 * f));
    g.addColorStop(0.62, rgba(warmCol, lit ? 0.18 : 0.1));
    g.addColorStop(1, rgba(warmCol, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r * 2.6, 0, 7);
    c.fill();
    if (!dark) {
      // light: a real light source, a warm bloom around a soft white core
      const bl = c.createRadialGradient(x, y, 0, x, y, r * 4.4);
      bl.addColorStop(0, "rgba(255,196,140,0.42)");
      bl.addColorStop(0.4, "rgba(255,170,120,0.16)");
      bl.addColorStop(1, "rgba(255,170,120,0)");
      c.fillStyle = bl;
      c.beginPath();
      c.arc(x, y, r * 4.4, 0, 7);
      c.fill();
      const wc = c.createRadialGradient(x, y, 0, x, y, r * 0.8);
      wc.addColorStop(0, "rgba(255,255,255,1)");
      wc.addColorStop(0.55, "rgba(255,252,246,0.95)");
      wc.addColorStop(1, "rgba(255,244,232,0)");
      c.fillStyle = wc;
      c.beginPath();
      c.arc(x, y, r * 0.8, 0, 7);
      c.fill();
    }
    if (lit || tier.min >= 7) this.sparkle(c, x, y, r * (lit ? (dark ? 1.45 : 1.3) : 1.1), t * 0.25, lit ? 0.9 : 0.3, true, dark ? undefined : [255, 250, 242]);
    // milestone: a large star-pop over the head
    if (this.celebrateMilestone && ce >= 0 && ce < 1.8 && !this.reduced) {
      const e = ce / 1.8;
      const sz = R * (1.2 + 3.4 * spring(Math.min(1, ce / 0.7)));
      this.sparkle(c, x, y, sz, ce * 0.8, (1 - e) * 1, false);
      this.sparkle(c, x, y, sz * 0.55, -ce * 0.5 + 0.4, (1 - e) * 0.8, true);
    }
    const hp = this.pieces.find((p) => p.head);
    if (tier.min >= 30 && hp && !this.v.emphasizeAll) {
      // the Comet tier's second, longer tail
      const S = this.samples.slice(hp.s0, hp.s1 + 1);
      let j0 = S.length - 1;
      while (j0 > 0 && S[S.length - 1]!.x - S[j0 - 1]!.x < Math.max(this.step * 6, 60 * k)) j0--;
      c.strokeStyle = rgba(dark ? T.core : [240, 130, 110], dark ? 0.18 : 0.28);
      c.lineWidth = 1.2 * k;
      c.beginPath();
      for (let j = j0; j < S.length; j++) {
        const s = S[j]!;
        const off = (S.length - 1 - j) / (S.length - 1 - j0 || 1);
        const yy = s.y - 8 * k * off - 4 * k;
        if (j === j0) c.moveTo(s.x, yy);
        else c.lineTo(s.x, yy);
      }
      c.stroke();
    }
  }

  private headSparks(prog: number, revealP: number): void {
    if (this.reduced || !this.pts.length || revealP < 1) return;
    const lit = prog >= 1;
    const f = clamp(prog, 0, 1);
    const R = this.v.headR * this.k;
    const r = R * (0.45 + 0.55 * f);
    const rand = this.random;
    if (rand() < (0.08 + 0.25 * f) * (lit ? 1.6 : 1)) {
      const col = this.pts[this.pts.length - 1]!.col;
      const T = this.theme;
      this.particles.push({
        x: this.head.x + (rand() - 0.5) * r,
        y: this.head.y + (rand() - 0.5) * r,
        vx: (-20 - rand() * 30) * Math.max(1, this.k * 0.8),
        vy: 6 + rand() * 14,
        life: 0,
        max: 1.2 + rand(),
        s: (0.6 + rand() * 1.2) * this.k * (this.themeName === "light" ? 0.8 : 1),
        col: this.themeName === "light" ? (rand() < 0.6 ? [255, 176, 112] : [255, 222, 190]) : rand() < 0.5 ? col : T.core,
      });
    }
  }

  private sparkle(c: Ctx, x: number, y: number, s: number, rot: number, a: number, thin = false, colour?: RGB): void {
    c.save();
    c.translate(x, y);
    c.rotate(rot * 0.3);
    const T = this.theme;
    c.globalCompositeOperation = T.blend;
    const col = colour ?? T.spark;
    const pin = thin ? 0.45 : 1;
    for (const [wmul, al] of [[1 * pin, 0.14], [0.35 * pin, 1]] as const) {
      c.fillStyle = rgba(col, a * al);
      c.beginPath();
      c.moveTo(0, -s);
      c.quadraticCurveTo(s * 0.12 * wmul, -s * 0.12 * wmul, s, 0);
      c.quadraticCurveTo(s * 0.12 * wmul, s * 0.12 * wmul, 0, s);
      c.quadraticCurveTo(-s * 0.12 * wmul, s * 0.12 * wmul, -s, 0);
      c.quadraticCurveTo(-s * 0.12 * wmul, -s * 0.12 * wmul, 0, -s);
      c.fill();
    }
    c.restore();
  }

  private glowDot(c: Ctx, x: number, y: number, r: number, a: number): void {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const col: RGB = this.themeName === "dark" ? this.theme.core : [255, 176, 130];
    g.addColorStop(0, rgba(col, a));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, 7);
    c.fill();
  }

  /** Paints soft aurora curtains once (blurred, quarter resolution). */
  private paintAurora(): void {
    const w = this.w;
    const h = this.h;
    const q = this.dpr * 0.25;
    const pad = w * 0.1;
    const src = this.shadowCache;
    src.width = Math.max(1, Math.round((w + pad * 2) * q));
    src.height = Math.max(1, Math.round(h * q));
    const c = src.getContext("2d")!;
    c.setTransform(q, 0, 0, q, pad * q, 0);
    c.clearRect(-pad, 0, w + pad * 2, h);
    const dark = this.themeName === "dark";
    // light: saturated enough to read on a pale sky (pastels vanished into it)
    const cols: RGB[] = dark ? [[120, 230, 200], [170, 140, 255], [255, 160, 190]] : [[88, 176, 236], [150, 112, 238], [236, 112, 168]];
    c.globalCompositeOperation = dark ? "lighter" : "source-over";
    const alphas = dark ? [0.2, 0.11, 0.09] : [0.3, 0.2, 0.16];
    const r = rng(this.seed * 71);
    for (let b = 0; b < 3; b++) {
      const top = h * (0.05 + b * 0.06);
      const bot = h * (0.36 + b * 0.05);
      const ph = r() * 6;
      const wave = (x: number, f: number, amp: number) => Math.sin((x / w) * f + ph) * amp * h + Math.sin((x / w) * f * 2.3 + ph * 1.7) * amp * 0.4 * h;
      const g = c.createLinearGradient(0, top - h * 0.1, 0, bot + h * 0.1);
      g.addColorStop(0, rgba(cols[b]!, 0));
      g.addColorStop(0.55, rgba(cols[b]!, alphas[b]!));
      g.addColorStop(1, rgba(cols[b]!, 0));
      c.fillStyle = g;
      c.beginPath();
      for (let x = -pad; x <= w + pad; x += 8) c.lineTo(x, top + wave(x, 3.1 + b, 0.1));
      for (let x = w + pad; x >= -pad; x -= 8) c.lineTo(x, bot + wave(x, 2.4 + b, 0.08));
      c.closePath();
      c.fill();
      const rays = 7 + Math.round(r() * 5);
      for (let i = 0; i < rays; i++) {
        const x = -pad + r() * (w + pad * 2);
        const rw = w * (0.01 + r() * 0.035);
        const yt = top + wave(x, 3.1 + b, 0.1);
        const yb = bot + wave(x, 2.4 + b, 0.08);
        const rg = c.createLinearGradient(0, yt, 0, yb);
        rg.addColorStop(0, rgba(cols[b]!, 0));
        rg.addColorStop(0.7, rgba(cols[b]!, alphas[b]! * (0.4 + r() * 0.6)));
        rg.addColorStop(1, rgba(cols[b]!, 0));
        c.fillStyle = rg;
        c.fillRect(x, yt, rw, yb - yt);
      }
    }
    this.auroraCache = this.blurInto(document.createElement("canvas"), src, 14 * this.k * q);
    this.auroraPad = pad;
  }

  private aurora(c: Ctx, t: number): void {
    if (!this.auroraCache) return;
    const drift = Math.sin(t * 0.12) * this.auroraPad * 0.8;
    c.save();
    c.globalCompositeOperation = this.themeName === "dark" ? "lighter" : "source-over";
    c.globalAlpha = 0.8 + 0.2 * Math.sin(t * 0.4);
    c.drawImage(this.auroraCache, -this.auroraPad + drift, 0, this.w + this.auroraPad * 2, this.h);
    c.restore();
  }

  private burst(): void {
    if (!this.pts.length || this.reduced) return;
    const T = this.theme;
    const k = this.k || 1;
    const rand = this.random;
    const count = this.celebrateMilestone ? 190 : 150;
    for (let i = 0; i < count; i++) {
      const a = rand() * Math.PI * 2;
      const sp = (70 + Math.pow(rand(), 0.7) * 300) * k;
      this.particles.push({
        x: this.head.x,
        y: this.head.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 50 * k,
        life: 0,
        max: 1.1 + rand() * 1.6,
        s: (0.9 + rand() * 2.1) * k,
        col: T.confetti[i % T.confetti.length]!,
        g: 120 * k,
        drag: 2.1,
        star: i % 9 === 0,
      });
    }
  }

  private stepParticles(dt: number): void {
    const P = this.particles;
    for (let i = P.length - 1; i >= 0; i--) {
      const p = P[i]!;
      p.life += dt;
      if (p.life > p.max) {
        P.splice(i, 1);
        continue;
      }
      const drag = p.drag ?? 0.6;
      p.vx *= Math.exp(-drag * dt);
      p.vy *= Math.exp(-drag * dt);
      p.vy += (p.g ?? 10) * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    if (P.length > 400) P.splice(0, P.length - 400);
  }

  private drawParticles(c: Ctx): void {
    const T = this.theme;
    c.globalCompositeOperation = T.blend;
    const edge = T.confettiEdge;
    for (const p of this.particles) {
      const a = 1 - p.life / p.max;
      if (p.star) this.sparkle(c, p.x, p.y, p.s * 3, p.life * 3, a);
      else {
        c.fillStyle = rgba(p.col, a * 0.95);
        c.beginPath();
        c.arc(p.x, p.y, p.s * (0.6 + a * 0.4), 0, 7);
        c.fill();
        if (edge > 0 && p.g) {
          // light theme: a darker rim so confetti reads on cream
          c.strokeStyle = rgba(mixRGB(p.col, [60, 20, 50], 0.45), a * edge);
          c.lineWidth = 0.8;
          c.stroke();
        }
      }
    }
  }
}
