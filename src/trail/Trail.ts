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
  TrailOptions,
  TrailStats,
  TrailTheme,
  TrailTier,
  TrailTool,
  TrailVariant,
} from "./types";
import { filterBlurWorks, softwareBlur } from "./blur";
import {
  bucketDays,
  classify,
  clamp,
  gaussian,
  lodBucket,
  placeLabels,
  routeY,
  smoothstep,
  wanderPeriod,
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
    glowA: 0.5, bodyA: 0.74, strandA: 0.75, pastDim: 0.42, filA: [0.4, 0.25], bodyMul: 1.1, bodyBlur: 1.3, glowMul: 3.4, coreA: 0.85, coreW: 0.24,
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
    glowA: 0.3, bodyA: 1, strandA: 0.22, pastDim: 0.5, filA: [0.55, 0.15], bodyMul: 1, bodyBlur: 0.55, glowMul: 2.6, coreA: 0.92, coreW: 0.16,
    glowTint: [255, 186, 130], glowTintAmt: 0.55,
    afterglow: [186, 132, 206], afterAmt: 0.26,
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
}
interface Sample {
  x: number;
  y: number;
  wd: number;
  a: number;
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
  private dayStep = 0;
  private dayX0 = 0;
  private S = 2;
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
  private sparks: Pt[] = [];
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
  geometry(): { head: { x: number; y: number }; points: { x: number; y: number; wd: number; role: Role }[]; labels: { m: number; visible: boolean; x: number; y: number }[]; lod: number } {
    return {
      head: { ...this.head },
      points: this.pts.map((p) => ({ x: p.x, y: p.y, wd: p.wd, role: p.role })),
      labels: this.milestones.map((m) => ({ m: m.m, ...m.label })),
      lod: this.dayStep > 0 ? Math.round(this.step / this.dayStep) : 1,
    };
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
    const i = clamp(Math.round((x - this.dayX0) / (this.dayStep || 1)), 0, this.days.length - 1);
    this.setHover(i);
  }

  private dayX(i: number): number {
    return i >= this.days.length - 1 ? this.head.x : this.dayX0 + i * this.dayStep;
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
      const last = run.current ? this.days.length - 1 - (this.days[this.days.length - 1]!.goalMet ? 0 : 1) : run.d1;
      h.run = { days: run.current ? this.data?.streak.current ?? run.days : run.days, from: this.days[run.d0]?.date ?? "", to: this.days[Math.max(run.d0, last)]?.date ?? "", current: run.current };
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
    this.dayStep = dayStep;
    this.dayX0 = x0;

    // level of detail: aggregate days so points stay >= 3 px apart
    const lod = n > 2 ? lodBucket(dayStep, 3) : 1;
    const B = bucketDays(days, goal, lod);
    const m = B.length;
    const step = dayStep * lod;
    this.step = step;
    const px = B.map((b, i) => (i === m - 1 ? x1 : x0 + ((b.i0 + b.i1) / 2) * dayStep));
    // emphasizeAll (short cards): a quiet day narrows the arc to a thread instead of breaking it
    const { roles, runs } = classify(B, { minPastRun: 3, bridgeGaps: v.emphasizeAll ? 3 : Math.floor(5 / Math.max(0.5, step)) });
    this.runs = runs;

    // natural centre line: a slow wander seeded by the date, lifted by busy stretches
    const period = wanderPeriod(dayStep);
    const TAU = Math.PI * 2;
    const act = gaussian(
      B.map((b) => b.ratio),
      clamp(22 / Math.max(0.5, step), 1.2, 24),
    );
    const natural = B.map((b, i) => {
      const num = lastNum - (n - 1 - (b.i0 + b.i1) / 2);
      const noise =
        Math.sin((num / period) * TAU + this.seed) * 0.6 +
        Math.sin((num / (period * 0.5)) * TAU + this.seed * 2.1) * 0.22 +
        Math.sin((num / (period * 2.2)) * TAU + this.seed * 0.7) * 0.3;
      const climb = v.climb ? (v.climb * h * ((b.i0 + b.i1) / 2 - (n - 1) / 2)) / Math.max(1, n - 1) : 0;
      return h * v.baseY + noise * v.amp * h - (clamp(act[i]!, 0, 2.2) - 0.9) * v.rise * h - climb;
    });

    // width and intensity per point, by role
    const wMin = v.wMin * k;
    const wMax = v.wMax * k;
    const floor = Math.max(1.5, wMin * 0.9);
    const shape = (r: number) => 0.78 * Math.pow(Math.min(r, 1), 0.8) + 0.22 * clamp((r - 1) / 1.5, 0, 1);
    const ribbonW = (r: number) => wMin + (wMax - wMin) * shape(r);
    const all = !!v.emphasizeAll;
    const wd = B.map((b, i) => {
      const role = roles[i]!;
      if (role === "gap") return 0;
      if (role === "bridge") return Math.max(1.2, wMin * 0.8);
      if (all) return b.tokens > 0 || role === "today" ? ribbonW(Math.max(b.ratio, 0.7)) : floor;
      if (role === "filament") return floor + (wMax * 0.42 - floor) * Math.pow(Math.min(b.ratio, 1), 1.1);
      return ribbonW(b.ratio);
    });
    const prevRole = m > 1 ? roles[m - 2] : "gap";
    const todayOnRun = B[m - 1]!.ratio >= 1 || prevRole === "current" || prevRole === "bridge";
    const al = B.map((b, i) => {
      const role = roles[i]!;
      if (all && role !== "gap" && role !== "bridge") return b.tokens > 0 || role === "today" ? 1 : 0.5;
      if (role === "today") return todayOnRun ? 1 : T.filA[0] + (1 - T.filA[0]) * Math.min(b.ratio, 1);
      if (role === "current") return 1;
      if (role === "past") return T.pastDim;
      if (role === "bridge") return 0.62;
      if (role === "filament") return T.filA[0] + T.filA[1] * Math.min(b.ratio, 1);
      return 0;
    });
    const cool = roles.map((r) => (all ? 0 : r === "past" ? T.afterAmt : r === "filament" ? T.afterAmt * 0.6 : 0));
    const u = roles.map(() => 0.5);
    for (const r of runs) {
      const end = r.current ? m - 1 : r.b;
      for (let q = r.a; q <= end; q++) u[q] = end > r.a ? (q - r.a) / (end - r.a) : 1;
      // the start of the current run fades in over its first days: no overexposed blob
      if (r.current && lod <= 2 && end - r.a >= 3) {
        [0.42, 0.7, 0.9].forEach((f, j) => {
          if (r.a + j < end) {
            wd[r.a + j]! *= f;
            al[r.a + j] = al[r.a + j]! * (0.3 + 0.7 * f);
          }
        });
      }
    }
    if (all) for (let q = 0; q < m; q++) u[q] = m > 1 ? q / (m - 1) : 1;
    u[m - 1] = 1;
    const mask = roles.map((r) => r !== "gap");
    const sig = clamp(9 / Math.max(0.5, step), 0.7, 4);
    // history swells gently (wider smoothing); the current run keeps its day-to-day shape
    const sigPast = clamp(20 / Math.max(0.5, step), 1, 7);
    const wdCur = gaussian(wd, sig, mask);
    const wdPast = gaussian(wd, sigPast, mask);
    const wdS = gaussian(
      wd.map((_, i) => (roles[i] === "current" || roles[i] === "today" ? wdCur[i]! : wdPast[i]!)),
      0.8,
      mask,
    );
    const alS = gaussian(al, Math.max(sig, sigPast * 0.6), mask);
    const coolS = gaussian(cool, sig, mask);
    // today is drawn live from progress; keep its raw values
    wdS[m - 1] = Math.max(1.5, wd[m - 1]!);
    alS[m - 1] = al[m - 1]!;
    this.bakedProgress = B[m - 1]!.ratio;

    // route the centre line around the HUD
    const headR = v.headR * k;
    const half = wdS.map((x, i) => (i === m - 1 ? headR * 1.35 : x * T.bodyMul * 0.5 + (roles[i] === "gap" ? 3 : 0)));
    const rects = [...(v.avoid ?? []), ...this.avoid];
    const ys = routeY(px, natural, half, rects, { top: h * (v.top ?? 0.12), bottom: h * (v.bottom ?? 0.86), margin: 6 + 4 * k, ramp: 64 * Math.max(0.8, k * 0.8) });

    // tool mix, smoothed along the path: colour drifts with the mix instead of
    // flickering day to day (per-day hue changes read as stripes)
    const sigT = clamp(16 / Math.max(0.5, step), 1.5, 8);
    const mix = TOOLS.map((tk) => gaussian(B.map((b) => b.tools?.[tk] ?? 0), sigT, mask));
    const cacheS = gaussian(B.map((b) => b.cache), sigT, mask);
    const pts: Pt[] = B.map((b, i) => {
      const role = roles[i]!;
      const tools: ToolShares = { claude: mix[0]![i]!, codex: mix[1]![i]!, gemini: mix[2]![i]! };
      const has = tools.claude! + tools.codex! + tools.gemini! > 0.01;
      const col = role === "bridge" ? FROZEN_COL : toolColor(T, has ? tools : { claude: 1 });
      return { x: px[i]!, y: ys[i]!, wd: wdS[i]!, a: alS[i]!, cool: coolS[i]!, u: u[i]!, col, tools, cache: cacheS[i]!, role, b };
    });
    this.pts = pts;
    this.head = { x: pts[m - 1]!.x, y: pts[m - 1]!.y };

    // pieces: contiguous stretches of non-gap points, sampled with Catmull-Rom
    const S = step > 14 ? 8 : step > 5 ? 4 : step > 2.5 ? 2 : 1;
    this.S = S;
    const samples: Sample[] = [];
    const pieces: Piece[] = [];
    const sparks: Pt[] = [];
    const mk = (p1: Pt, p2: Pt, t: number, y: number, seg: number): Sample => ({
      x: lerp(p1.x, p2.x, t),
      y,
      seg,
      wd: lerp(p1.wd, p2.wd, t),
      a: lerp(p1.a, p2.a, t),
      cool: lerp(p1.cool, p2.cool, t),
      u: lerp(p1.u, p2.u, t),
      col: mixRGB(p1.col, p2.col, t),
      cache: lerp(p1.cache, p2.cache, t),
      sh: TOOLS.map((tk) => lerp(p1.tools[tk] ?? 0, p2.tools[tk] ?? 0, t)),
      nx: 0,
      ny: 0,
    });
    let i = 0;
    while (i < m) {
      if (roles[i] === "gap") {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < m && roles[j + 1] !== "gap") j++;
      if (j === i) {
        sparks.push(pts[i]!);
        i = j + 1;
        continue;
      }
      const s0 = samples.length;
      for (let q = i; q < j; q++) {
        const p0 = pts[Math.max(i, q - 1)]!;
        const p1 = pts[q]!;
        const p2 = pts[q + 1]!;
        const p3 = pts[Math.min(j, q + 2)]!;
        for (let s = 0; s < S; s++) {
          const t = s / S;
          const t2 = t * t;
          const t3 = t2 * t;
          const y = 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
          samples.push(mk(p1, p2, t, y, q));
        }
      }
      samples.push(mk(pts[j]!, pts[j]!, 0, pts[j]!.y, j));
      const piece: Piece = { p0: i, p1: j, s0, s1: samples.length - 1, head: j === m - 1 };
      pieces.push(piece);
      // every stretch reads like a small meteor: a long tail fading in from its
      // start, a soft round end (never a flat cap, never a symmetric dash)
      const xs0 = samples[s0]!.x;
      const xs1 = samples[piece.s1]!.x;
      const L = xs1 - xs0;
      const tIn = clamp(Math.min(L * 0.6, Math.max(20, step * 5)), 6, 110);
      const tOut = Math.max(2, Math.min(7, L * 0.12));
      for (let q = s0; q <= piece.s1; q++) {
        const s = samples[q]!;
        const fi = smoothstep(0, tIn, s.x - xs0);
        const fo = piece.head ? 1 : smoothstep(0, tOut, xs1 - s.x);
        s.wd *= (0.08 + 0.92 * fi) * (0.55 + 0.45 * fo);
        s.a *= 0.22 + 0.78 * fi;
        // the body narrows into the head orb, so a big day never ends in a flat cap
        if (piece.head) s.wd *= 1 - 0.55 * smoothstep(xs1 - step * 0.55, xs1, s.x);
      }
      i = j + 1;
    }
    // a lone day between gaps is a tiny meteor of its own; today alone after a
    // gap gets a short lead-in so the head still has a tail
    for (const sp of sparks) {
      const isHead = sp === pts[m - 1];
      const len = isHead ? Math.min(Math.max(step, 12) * 0.9, 34 * k) : Math.min(Math.max(step, 8) * 0.75, 20 * k);
      const s0 = samples.length;
      const wdMax = isHead ? sp.wd : Math.min(sp.wd, Math.max(floor, len * 0.22));
      for (let q = 0; q <= 8; q++) {
        const f = q / 8;
        const x = sp.x - len * (1 - f);
        const smp = mk(sp, sp, 0, 0, pts.indexOf(sp));
        smp.x = x;
        smp.y = this.yAtPts(pts, x);
        smp.wd = wdMax * Math.min(1, f * 1.3 + 0.08) * (isHead ? 1 - 0.5 * smoothstep(0.6, 1, f) : 1);
        smp.a = sp.a * (0.3 + 0.7 * f);
        samples.push(smp);
      }
      pieces.push({ p0: pts.indexOf(sp), p1: pts.indexOf(sp), s0, s1: samples.length - 1, head: isHead });
    }
    sparks.length = 0;
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
    this.sparks = sparks;
    const hp = pieces.find((p) => p.head);
    this.cacheEnd = hp ? hp.s1 : -1;

    // the current run, in samples
    this.curRun = null;
    const cr = runs.find((r) => r.current);
    if (cr && hp && cr.a >= hp.p0) {
      const s0 = samples.findIndex((s, q) => q >= hp.s0 && s.seg >= cr.a);
      if (s0 >= 0) this.curRun = { s0, s1: hp.s1, p0: cr.a, p1: m - 1, days: cr.days };
    }
    // dense layouts: fade the current run in over ~3 days worth of pixels (no hot start)
    if (this.curRun && lod > 2) {
      const x0r = samples[this.curRun.s0]!.x;
      const R = Math.max(3 * dayStep * lod, 24 * k);
      for (let q = this.curRun.s0; q <= this.curRun.s1; q++) {
        const f = smoothstep(0, R, samples[q]!.x - x0r);
        if (f >= 1) break;
        samples[q]!.wd *= 0.15 + 0.85 * f;
        samples[q]!.a *= 0.35 + 0.65 * f;
      }
      // and the history just before it narrows into the same pinch: the run reads as new
      if (hp && this.curRun.s0 > hp.s0)
        for (let q = this.curRun.s0 - 1; q >= hp.s0; q--) {
          const d = x0r - samples[q]!.x;
          if (d > R * 0.6) break;
          samples[q]!.wd *= 0.15 + 0.85 * smoothstep(0, R * 0.6, d);
        }
    }
    // a stretch is never much wider than it is long: short runs stay slim streaks, never petals
    for (const pc of pieces) {
      const L = samples[pc.s1]!.x - samples[pc.s0]!.x;
      if (pc.head || L > 90) continue;
      const cap = Math.max(floor, L * 0.18);
      for (let q = pc.s0; q <= pc.s1; q++) samples[q]!.wd = Math.min(samples[q]!.wd, cap);
    }

    // embers: one where each run ended, one in each gap
    const embers: Ember[] = [];
    const er = rng(this.seed * 53);
    for (const r of runs) {
      if (r.current || roles[r.a] !== "past" || (step < 6 && r.days < 7)) continue;
      const p = pts[r.b]!;
      for (let e = 0; e < 2; e++) embers.push({ x: p.x + (er() * 0.6 + 0.4) * 6 * k * (e + 1), y: p.y + (3 + er() * 4) * k * (e + 1), r: (0.75 + er() * 0.5) * k * (1 - e * 0.25), a: 0.75 - e * 0.3 });
    }
    for (let q = 1; q < m - 1; q++) {
      if (roles[q] !== "gap" || roles[q - 1] === "gap") continue;
      let e = q;
      while (e + 1 < m && roles[e + 1] === "gap") e++;
      const gx0 = pts[q - 1]!.x;
      const gx1 = pts[Math.min(m - 1, e + 1)]!.x;
      // one ember per real break (2+ days, or wide enough to see); a run's end already has its own
      if (roles[q - 1] === "past" || (lod === 1 && e === q) || gx1 - gx0 < (step < 6 ? 16 : 12)) continue;
      const gx = gx0 + Math.min((gx1 - gx0) * 0.35, 10 * k);
      embers.push({ x: gx, y: this.yAt(gx) + 5 * k, r: 0.95 * k, a: 0.55 });
    }
    // dense layouts: keep the sky calm
    const cap = step < 6 ? 28 : 60;
    this.embers = embers.length > cap ? embers.filter((_, q) => q % Math.ceil(embers.length / cap) === 0) : embers;

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
        56,
      );
      this.milestones = pre.map((p, q) => ({ ...p, label: v.labels ? lbl[q]! : { visible: false, x: p.x, y: p.y } }));
    }

    // stars
    const r = rng(this.seed * 131);
    this.stars = [];
    const tier = this.tier();
    const count = Math.round(((T.starCount * (w * h)) / (360 * 200)) * (tier.min >= 30 ? 1.5 : 1));
    for (let q = 0; q < Math.min(count, 260); q++)
      this.stars.push({ x: r() * w, y: Math.pow(r(), 1.6) * h * 0.62, s: 0.5 + r() * 1.2, ph: r() * 6.28, sp: 0.6 + r() * 1.6 });
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
      hill(0.9, 0.035, 5.2, 1.1, T.hills[0]);
      hill(0.95, 0.025, 7.5, 3.3, T.hills[1]);
    }
  }

  /** Spans of samples drawn into the cache (today's live segment excluded). */
  private spans(): { s0: number; s1: number; cap: boolean }[] {
    return this.pieces.map((p) => ({ s0: p.s0, s1: p.head ? this.cacheEnd : p.s1, cap: !p.head })).filter((s) => s.s1 - s.s0 >= 1);
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
    for (const s of spans) this.band(g, s.s0, s.s1, "glow", undefined, s.cap);
    for (const p of this.sparks) this.sparkDot(g, p, 3.2);
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
      for (const s of spans) this.band(sx, s.s0, s.s1, "shadow", undefined, s.cap);
      c.save();
      c.globalCompositeOperation = "source-over";
      c.drawImage(this.blurInto(this.blurCache, sc, 4 * k * q2), 0, 0, this.w, this.h);
      c.restore();
    }
    // a faint contrail along the whole path: gaps stay clean breaks in the light,
    // but the eye still reads one continuous trail across every run
    if (this.pts.length > 2) {
      const P = this.pts;
      const x0 = Math.max(0, P[0]!.x);
      const x1 = this.head.x;
      const cg = c.createLinearGradient(x0, 0, x1, 0);
      const col: RGB = this.themeName === "dark" ? [255, 226, 206] : [214, 104, 132];
      const a = this.themeName === "dark" ? 0.13 : 0.16;
      cg.addColorStop(0, rgba(col, 0));
      cg.addColorStop(Math.min(0.2, 60 / Math.max(60, x1 - x0)), rgba(col, a));
      cg.addColorStop(1, rgba(col, a));
      c.save();
      c.globalCompositeOperation = "source-over";
      c.strokeStyle = cg;
      c.lineWidth = Math.max(0.8, 0.9 * k);
      c.lineCap = "round";
      c.beginPath();
      const stepX = Math.max(2, this.step / 3);
      for (let x = x0; x <= x1; x += stepX) {
        if (x === x0) c.moveTo(x, this.yAt(x));
        else c.lineTo(x, this.yAt(x));
      }
      c.lineTo(x1, this.head.y);
      c.stroke();
      c.restore();
    }
    // bodies: all pieces crisp on one layer, then composite once with a light blur
    const bc = this.bodyCache;
    bc.width = this.cache.width;
    bc.height = this.cache.height;
    const bctx = bc.getContext("2d")!;
    bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    bctx.globalCompositeOperation = T.blend;
    for (const s of spans) this.band(bctx, s.s0, s.s1, "body", undefined, s.cap);
    for (const p of this.sparks) this.sparkDot(bctx, p, 1);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (filterBlurWorks() && T.bodyBlur * k * this.dpr >= 1) c.filter = `blur(${(T.bodyBlur * k * this.dpr).toFixed(1)}px)`;
    c.drawImage(bc, 0, 0);
    c.restore();
    for (const s of spans) this.band(c, s.s0, s.s1, "core", undefined, s.cap);
    // afterglow strands on past ribbons (static; only the current run's strands are live)
    for (const r of this.runs) {
      if (r.current) continue;
      const sp = this.runSamples(r);
      if (sp && this.themeName === "dark") this.strandPaths(c, sp.s0, sp.s1, 0, T.pastDim * 0.7, false);
    }
    for (const e of this.embers) {
      const eg = c.createRadialGradient(e.x, e.y, 0, e.x, e.y, e.r * 4);
      eg.addColorStop(0, rgba(T.ember, e.a * (this.themeName === "dark" ? 0.9 : 0.65)));
      eg.addColorStop(0.25, rgba(T.ember, e.a * 0.35));
      eg.addColorStop(1, rgba(T.ember, 0));
      c.fillStyle = eg;
      c.beginPath();
      c.arc(e.x, e.y, e.r * 4, 0, 7);
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

  private runSamples(r: RunInfo): { s0: number; s1: number } | null {
    const piece = this.pieces.find((p) => r.a >= p.p0 && r.b <= p.p1);
    if (!piece) return null;
    let s0 = -1;
    let s1 = -1;
    for (let q = piece.s0; q <= piece.s1; q++) {
      const seg = this.samples[q]!.seg;
      if (seg >= r.a && s0 < 0) s0 = q;
      if (seg <= r.b) s1 = q;
    }
    if (piece.head) s1 = Math.min(s1, this.cacheEnd);
    return s0 >= 0 && s1 - s0 >= 2 ? { s0, s1 } : null;
  }

  private sparkDot(c: Ctx, p: Pt, mul: number): void {
    const T = this.theme;
    const r = Math.max(1.2, p.wd * 0.5) * mul;
    const g = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.6);
    g.addColorStop(0, rgba(this.themeName === "dark" ? T.core : p.col, p.a * (mul > 1 ? T.glowA : 0.9)));
    g.addColorStop(1, rgba(p.col, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(p.x, p.y, r * 1.6, 0, 7);
    c.fill();
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
  private band(c: Ctx, s0: number, s1: number, mode: "glow" | "body" | "core" | "shadow", arr?: Sample[], cap = false): void {
    const T = this.theme;
    const S = arr ?? this.samples;
    const mul = mode === "glow" ? T.glowMul : mode === "core" ? T.coreW : mode === "shadow" ? T.bodyMul * 0.92 : T.bodyMul;
    const minHalf = mode === "core" ? 0.35 : 0;
    const dark = this.themeName === "dark";
    const alphaOf = (s: Sample) => {
      if (mode === "glow") return T.glowA * Math.pow(s.a, 1.15);
      if (mode === "body") return T.bodyA * s.a;
      if (mode === "shadow") return s.a;
      // core: a lit, whiter centre that fades faster than the body on dim days;
      // on very wide ribbons in dark it is held back so additive light never blows out
      const damp = dark ? Math.min(1, Math.pow((9 * this.k) / Math.max(1, s.wd), 0.35)) : 1;
      return T.coreA * Math.pow(clamp((s.a - 0.3) / 0.7, 0, 1), 1.3) * damp;
    };
    if (mode === "shadow") {
      c.fillStyle = T.shadow ?? "transparent";
    } else {
      const g = c.createLinearGradient(S[s0]!.x, 0, S[s1]!.x, 0);
      const span = S[s1]!.x - S[s0]!.x || 1;
      const every = Math.max(1, Math.floor((s1 - s0) / 120));
      for (let j = s0; j <= s1; j += every) {
        const s = S[j]!;
        g.addColorStop(clamp((s.x - S[s0]!.x) / span, 0, 1), rgba(this.colorFor(s, mode), alphaOf(s)));
      }
      const e = S[s1]!;
      g.addColorStop(1, rgba(this.colorFor(e, mode), alphaOf(e)));
      c.fillStyle = g;
    }
    c.beginPath();
    for (let j = s0; j <= s1; j++) {
      const s = S[j]!;
      const hw = Math.max(minHalf, s.wd * mul * 0.5);
      if (j === s0) c.moveTo(s.x + s.nx * hw, s.y + s.ny * hw);
      else c.lineTo(s.x + s.nx * hw, s.y + s.ny * hw);
    }
    if (cap) {
      // round end: the stretch finishes like a soft brush stroke
      const s = S[s1]!;
      const hw = Math.max(minHalf, s.wd * mul * 0.5);
      const th = Math.atan2(s.ny, s.nx);
      c.arc(s.x, s.y, hw, th, th - Math.PI, true);
    }
    for (let j = s1; j >= s0; j--) {
      const s = S[j]!;
      const hw = Math.max(minHalf, s.wd * mul * 0.5);
      c.lineTo(s.x - s.nx * hw, s.y - s.ny * hw);
    }
    c.closePath();
    if (mode === "shadow") {
      c.globalAlpha = 0.9;
      c.fill();
      c.globalAlpha = 1;
    } else c.fill();
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
      const di = clamp((x - this.dayX0) / (this.dayStep || 1), 0, this.cum.length - 1);
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

  /** Tool-mix strands: three thin threads weaving inside a ribbon. */
  private strandPaths(c: Ctx, a: number, b: number, t: number, dim: number, live: boolean): void {
    const S = this.samples;
    const T = this.theme;
    const k = this.k;
    const dark = this.themeName === "dark";
    const wave = T.strandWave * k;
    TOOLS.forEach((tk, ti) => {
      let any = false;
      for (let j = a; j <= b; j += 4) if ((S[j]!.sh[ti] ?? 0) > 0.03) any = true;
      if (!any) return;
      const g = c.createLinearGradient(S[a]!.x, 0, S[b]!.x, 0);
      const span = S[b]!.x - S[a]!.x || 1;
      const every = Math.max(1, Math.floor((b - a) / 30));
      const col = mixRGB(T.tool[tk], dark ? [255, 250, 240] : [255, 255, 255], T.strandWhite);
      for (let j = a; j <= b; j += every) {
        const s = S[j]!;
        g.addColorStop(clamp((s.x - S[a]!.x) / span, 0, 1), rgba(col, T.strandA * dim * s.a * clamp(s.sh[ti]! * 1.6 + 0.08, 0, 1)));
      }
      c.strokeStyle = g;
      c.lineWidth = Math.max(0.6, (dark ? 0.9 : 0.75) * k);
      c.beginPath();
      for (let j = a; j <= b; j++) {
        const s = S[j]!;
        const tp = Math.min(1, (j - a) / 6, (b - j) / 3 + (live ? 1 : 0.1));
        const off =
          (Math.sin(s.x / wave + ti * 2.09 + t * (0.7 + ti * 0.13)) * 0.8 + Math.sin(s.x / (wave * 2.3) - ti + t * 0.3) * 0.2) * s.wd * (dark ? 0.36 : 0.26) * tp;
        const x = s.x + s.nx * off;
        const y = s.y + s.ny * off;
        if (j === a) c.moveTo(x, y);
        else c.lineTo(x, y);
      }
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
      c.fillStyle = "rgba(255,255,255,0.96)";
      c.beginPath();
      c.arc(x, y, r * 0.42, 0, 7);
      c.fill();
    }
    if (lit || tier.min >= 7) this.sparkle(c, x, y, r * (lit ? (dark ? 1.45 : 1.2) : 1.1), t * 0.25, lit ? 0.9 : 0.3, true);
    // milestone: a large star-pop over the head
    if (this.celebrateMilestone && ce >= 0 && ce < 1.8 && !this.reduced) {
      const e = ce / 1.8;
      const sz = R * (1.2 + 3.4 * spring(Math.min(1, ce / 0.7)));
      this.sparkle(c, x, y, sz, ce * 0.8, (1 - e) * 1, false);
      this.sparkle(c, x, y, sz * 0.55, -ce * 0.5 + 0.4, (1 - e) * 0.8, true);
    }
    const hp = this.pieces.find((p) => p.head);
    if (tier.min >= 30 && hp) {
      // the Comet tier's second, longer tail
      const S = this.samples.slice(hp.s0, hp.s1 + 1);
      const j0 = Math.max(0, S.length - 1 - this.S * 6);
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

  private sparkle(c: Ctx, x: number, y: number, s: number, rot: number, a: number, thin = false): void {
    c.save();
    c.translate(x, y);
    c.rotate(rot * 0.3);
    const T = this.theme;
    c.globalCompositeOperation = T.blend;
    const col = T.spark;
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
    const cols: RGB[] = dark ? [[120, 230, 200], [170, 140, 255], [255, 160, 190]] : [[150, 210, 255], [200, 170, 255], [255, 180, 200]];
    c.globalCompositeOperation = dark ? "lighter" : "source-over";
    const alphas = dark ? [0.2, 0.11, 0.09] : [0.24, 0.16, 0.14];
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
        star: i % 6 === 0,
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
