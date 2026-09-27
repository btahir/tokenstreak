// The Trail: a ribbon of light that grows one segment per day across a dusk
// sky. Plain Canvas 2D, no dependencies. Ported from docs/design/signature/trail.js.
//
//   const trail = new Trail(canvas, { theme: "dark", variant: "popover" });
//   trail.setData(data);       // re-lays out and re-caches
//   trail.setProgress(0.9);    // live fraction of today's goal (eases)
//   trail.celebrate();         // goal-hit moment, once per day
//   trail.reveal();            // first-run draw-in (2.4 s)
//   trail.onHover((h) => …);   // "full" variant tooltip
//   trail.pause(); trail.resume(); trail.destroy();
//
// Visual encoding
//   x          time, one step per day; today is the comet head
//   y          stable wander seeded by the date + smoothed activity (busy weeks soar)
//   width      tokens / goal (capped at 2.5x)
//   continuity lit days form one ribbon; under goal = wisp; zero = gap; frozen = bridge
//   strands    tool mix (apricot Claude, rose Codex, violet Gemini)
//   core       efficiency: more cache reuse = whiter, cooler core
//   head       today's progress: the orb fills its halo ring and ignites at 100%
//   sky        tier by streak; the horizon warms with today's progress
//
// Performance: the sky and the history ribbon are cached offscreen whenever
// data, size or theme change. Each frame draws only strands, today's segment,
// the shimmer, the head and a few dozen particles. The loop stops on pause(),
// when the document is hidden, and drops to `idleFps` after a quiet spell.

import type {
  ToolShares,
  TrailData,
  TrailDay,
  TrailHover,
  TrailLayout,
  TrailOptions,
  TrailStats,
  TrailTheme,
  TrailTier,
  TrailTool,
  TrailVariant,
} from "./types";

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
  pastDim: number;
  wMul: number;
  bodyMul: number;
  bodyBlur: number;
  glowMul: number;
  coreA: number;
  /** Tint mixed into glow colours (light theme warms its halo). */
  glowTint: RGB | null;
  glowTintAmt: number;
  star: string;
  starA: number;
  starCount: number;
  text: string;
  halo: string;
  ring: RGB;
  ringA: number;
  horizon: string;
  /** A soft sun disc low behind the head (light theme). */
  sun: string | null;
  /** Darker rim drawn under the body for definition on pale skies. */
  rim: RGB | null;
  rimA: number;
  wisp: number;
  /** A lighter inner band inside the body (0 = off): gives the light ribbon a silky, lit-tube look. */
  inner: number;
  innerTint: RGB;
  /** Soft drop shadow under the ribbon (light theme: a silk ribbon lifted off paper). */
  shadow: string | null;
  /** Core width as a fraction of the body. */
  coreW: number;
  /** How far strand colours are mixed toward white. */
  strandWhite: number;
  shimmer: RGB;
  shimmerA: number;
  spark: RGB;
}

export const THEMES: Record<TrailTheme, ThemeDef> = {
  dark: {
    sky: [[0, "#1A1433"], [0.38, "#35214F"], [0.66, "#7E3B6A"], [0.88, "#D9736A"], [1, "#F3A46E"]],
    hills: ["rgba(40,24,62,0.85)", "rgba(22,15,38,0.96)"],
    tool: { claude: [255, 172, 112], codex: [246, 110, 142], gemini: [156, 126, 250], other: [220, 200, 230] },
    core: [255, 247, 234],
    coolCore: [226, 240, 255],
    blend: "lighter",
    glowA: 0.55, bodyA: 0.9, strandA: 0.8, pastDim: 0.4, wMul: 1, bodyMul: 1.15, bodyBlur: 1.6, glowMul: 3.6, coreA: 0.95,
    glowTint: null, glowTintAmt: 0,
    star: "rgba(255,248,240,", starA: 0.8, starCount: 70,
    text: "rgba(255,244,234,0.72)", halo: "rgba(255,244,234,0.35)",
    ring: [255, 226, 190], ringA: 0.9,
    horizon: "rgba(255,190,130,",
    sun: null,
    rim: null, rimA: 0,
    wisp: 0.45,
    inner: 0, innerTint: [255, 247, 234], strandWhite: 0.45, shadow: null, coreW: 0.24,
    shimmer: [255, 247, 234], shimmerA: 0.55,
    spark: [255, 244, 225],
  },
  // Golden hour. Additive light can't glow on a pale sky, so the ribbon is a
  // saturated dusk body with a warm halo, a crisp darker rim and a white core.
  light: {
    sky: [[0, "#ECE4FB"], [0.36, "#F6E2EE"], [0.7, "#FFE0CC"], [0.9, "#FFEBD9"], [1, "#FFF3E6"]],
    hills: ["rgba(242,208,222,0.78)", "rgba(250,226,222,1)"],
    tool: { claude: [248, 132, 68], codex: [234, 80, 120], gemini: [120, 88, 232], other: [150, 140, 170] },
    core: [255, 253, 248],
    coolCore: [240, 248, 255],
    blend: "source-over",
    glowA: 0.36, bodyA: 1, strandA: 0.5, pastDim: 0.5, wMul: 1.05, bodyMul: 1, bodyBlur: 0.45, glowMul: 4.4, coreA: 0.95,
    glowTint: [255, 196, 128], glowTintAmt: 0.6,
    star: "rgba(240,150,110,", starA: 0.34, starCount: 14,
    text: "rgba(35,29,51,0.62)", halo: "rgba(35,29,51,0.2)",
    ring: [232, 93, 122], ringA: 0.78,
    horizon: "rgba(255,196,140,",
    sun: "rgba(255,214,170,",
    rim: [150, 50, 90], rimA: 0.05,
    wisp: 0.55,
    inner: 0.8, innerTint: [255, 226, 196], strandWhite: 0.3, shadow: "rgba(150,56,96,0.18)", coreW: 0.13,
    shimmer: [255, 250, 236], shimmerA: 0.85,
    spark: [255, 184, 120],
  },
};

export const VARIANTS: Record<TrailVariant, TrailLayout> = {
  popover: { headX: 0.84, left: -0.04, baseY: 0.56, amp: 0.12, rise: 0.16, maxDays: 42, wMin: 1.4, wMax: 11, headR: 15, hills: true, labels: false },
  full: { headX: 0.92, left: 0.02, baseY: 0.62, amp: 0.13, rise: 0.26, maxDays: 400, wMin: 1.4, wMax: 18, headR: 14, hills: true, labels: true },
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

export function tierFor(streak: number): TrailTier {
  let r = TIERS[0]!;
  for (const t of TIERS) if (streak >= t.min) r = t;
  return r;
}

/** The next tier above `streak`, or null at the top. */
export function nextTier(streak: number): TrailTier | null {
  return TIERS.find((t) => t.min > streak) ?? null;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutQuint = (t: number) => 1 - Math.pow(1 - t, 5);
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const spring = (t: number) => 1 - Math.exp(-6 * t) * Math.cos(10 * t);
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
const mixRGB = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function hash(n: number): number {
  n = (n << 13) ^ n;
  return 1 - ((n * (n * n * 15731 + 789221) + 1376312589) & 0x7fffffff) / 1073741824;
}

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

let filterSupport: boolean | null = null;
function supportsFilter(): boolean {
  if (filterSupport === null) {
    try {
      const c = document.createElement("canvas").getContext("2d");
      if (!c) return (filterSupport = false);
      c.filter = "blur(2px)";
      filterSupport = c.filter === "blur(2px)";
    } catch {
      filterSupport = false;
    }
  }
  return filterSupport;
}

type Kind = "today" | "lit" | "frozen" | "wisp" | "dark";
interface Pt {
  x: number;
  y: number;
  kind: Kind;
  wd: number;
  col: RGB;
  tools: ToolShares;
  cache: number;
  day: TrailDay & { isToday?: boolean };
  i: number;
}
interface Sample {
  x: number;
  y: number;
  seg: number;
  wd: number;
  col: RGB;
  cache: number;
  sh: number[];
  nx: number;
  ny: number;
}
interface Run {
  a: number;
  b: number;
  current: boolean;
  startDay: number;
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
  private particles: Particle[] = [];
  private t = 0;
  private last = 0;
  private running = false;
  private destroyed = false;
  private dirty = true;
  private raf = 0;
  private celebrateAt = -1;
  private revealAt = -1;
  private revealing = false;
  private hover: Pt | null = null;
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
  readonly stats: TrailStats = { frameMs: 0, maxFrameMs: 0, cacheMs: 0, frames: 0 };

  // geometry (valid after _layout)
  private w = 0;
  private h = 0;
  private dpr = 1;
  private k = 1;
  private step = 0;
  private S = 2;
  private pts: Pt[] = [];
  private samples: Sample[] = [];
  private runs: Run[] = [];
  private head = { x: 0, y: 0 };
  private milestones: { m: number; x: number; y: number }[] = [];
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

  /** Live update of today's fraction of the goal; eases toward it. */
  setProgress(p: number): void {
    if (!this.data) return;
    const was = this.data.today.tokens >= this.data.goal && this.data.goal > 0;
    this.data.today.tokens = p * this.data.goal;
    this.progressTarget = p;
    if (p >= 1 !== was) this.dirty = true;
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

  /** Goal-hit moment: shockwave, spark burst, shimmer racing back down the run. */
  celebrate(): void {
    this.celebrateAt = this.t;
    this.progressShown = Math.max(this.progressShown, Math.min(1, this.progressTarget));
    this.burst();
    this.kick();
  }

  /** First-run draw-in over 2.4 s. */
  reveal(): void {
    this.revealAt = this.t;
    this.revealing = true;
    this.kick();
  }

  get isRevealing(): boolean {
    return this.revealing && this.t - this.revealAt < 2.4;
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
    if (i === null || !this.pts.length) {
      this.clearHover();
      return null;
    }
    const p = this.pts[clamp(Math.round(i), 0, this.pts.length - 1)]!;
    return this.setHover(p);
  }

  get hoveredIndex(): number | null {
    return this.hover ? this.hover.i : null;
  }

  get dayCount(): number {
    return this.pts.length;
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
  }

  tier(): TrailTier {
    return tierFor(this.data ? this.data.streak.current : 0);
  }

  headPosition(): { x: number; y: number } | null {
    return this.pts.length ? { ...this.head } : null;
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
      if (!this.layout()) return;
      this.paintSky();
      this.paintRibbon();
      this.dirty = false;
    }
    this.progressShown = this.progressTarget;
    const dt = 1 / 30;
    const steps = Math.round(warmup / dt);
    const reduced = this.reduced;
    this.t = time - warmup;
    for (let i = 0; i < steps; i++) {
      this.t += dt;
      this.draw(dt, i < steps - 1);
    }
    this.reduced = reduced;
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
      if (this.layout()) {
        this.paintSky();
        this.paintRibbon();
        this.dirty = false;
        this.stats.cacheMs = performance.now() - t0;
      } else return;
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
    if (!this.pts.length) return;
    this.poke();
    const first = this.pts[0]!;
    const i = clamp(Math.round((x - first.x) / (this.step || 1)), 0, this.pts.length - 1);
    this.setHover(this.pts[i]!);
  }

  private setHover(p: Pt): TrailHover {
    this.hover = p;
    this.kick();
    const h: TrailHover = { day: p.day, index: p.i, x: p.x, y: p.y };
    this.hoverCb?.(h);
    return h;
  }

  private clearHover(): void {
    this.hover = null;
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
    const today: TrailDay & { isToday: boolean } = {
      tokens: d.today.tokens,
      goalMet: d.goal > 0 && d.today.tokens >= d.goal,
      tools: d.today.tools,
      cacheShare: d.today.cacheShare,
      isToday: true,
      date: d.today.date ?? "",
      goal: d.goal,
    };
    const days: (TrailDay & { isToday?: boolean })[] = [...hist, today];
    const n = days.length;
    const lastNum = dayNumber(hist.length ? hist[hist.length - 1]!.date : null, 20000) + 1;
    let x0 = w * v.left;
    const x1 = n === 1 ? w * (v.soloX ?? 0.5) : w * v.headX;
    let step = n > 1 ? (x1 - x0) / (n - 1) : 0;
    const maxStep = 34 * k;
    if (step > maxStep) {
      step = maxStep;
      x0 = x1 - step * (n - 1);
    }
    this.step = step;
    // smoothed activity (EMA both ways) for the "soar"
    const ratio = days.map((q) => clamp(q.tokens / goal, 0, 2.5));
    const ema = ratio.slice();
    const al = v.smooth ?? clamp(12 / n, 0.07, 0.3);
    {
      const m = Math.min(n, 14);
      let sum = 0;
      for (let i = 0; i < m; i++) sum += ratio[i]!;
      ema[0] = sum / m;
    }
    for (let i = 1; i < n; i++) ema[i] = lerp(ema[i - 1]!, ratio[i]!, al);
    // zero-phase: a backward EMA over the forward one, so busy days lift the
    // path smoothly instead of kinking it day by day
    for (let i = n - 2; i >= 0; i--) ema[i] = lerp(ema[i + 1]!, ema[i]!, al * 1.4);
    const top = v.top ?? 0.16;
    const bottom = v.bottom ?? 0.84;
    const pts: Pt[] = days.map((q, i) => {
      const num = lastNum - (n - 1 - i);
      const fq = v.freq ?? clamp(50 / n, 0.2, 1);
      const noise =
        Math.sin(num * 0.23 * fq + this.seed) * 0.5 +
        Math.sin(num * 0.061 * fq + this.seed * 2.1) * 0.4 +
        hash(num) * 0.06 * fq;
      let y = h * v.baseY + noise * v.amp * h - (ema[i]! - 0.9) * v.rise * h;
      y = clamp(y, h * top, h * bottom);
      const kind: Kind = q.isToday ? "today" : q.goalMet ? "lit" : q.frozen ? "frozen" : q.tokens > 0 ? "wisp" : "dark";
      const wd = (v.wMin + Math.pow(clamp(ratio[i]!, 0, 2.5) / 2.5, 0.7) * (v.wMax - v.wMin)) * k * T.wMul;
      return {
        x: x1 - (n - 1 - i) * step,
        y,
        kind,
        wd: kind === "frozen" ? v.wMin * k * 1.4 : wd,
        col: kind === "frozen" ? FROZEN_COL : toolColor(T, Object.keys(q.tools ?? {}).length ? q.tools : { claude: 1 }),
        tools: q.tools ?? {},
        cache: q.cacheShare || 0,
        day: q,
        i,
      };
    });
    // dense layouts: relax y a little more so a year reads as one sweep
    if (step < 8) {
      for (let pass = 0; pass < (step < 4 ? 3 : 2); pass++) {
        const ys = pts.map((p) => p.y);
        for (let i = 1; i < n - 1; i++) pts[i]!.y = ys[i - 1]! * 0.25 + ys[i]! * 0.5 + ys[i + 1]! * 0.25;
      }
    }
    const passes = step < 4 ? 6 : step < 8 ? 3 : 2;
    for (let pass = 0; pass < passes; pass++) {
      const ws = pts.map((p) => p.wd);
      for (let i = 1; i < n - 1; i++)
        if (pts[i]!.kind === "lit" && pts[i - 1]!.kind === "lit") pts[i]!.wd = ws[i - 1]! * 0.25 + ws[i]! * 0.5 + ws[i + 1]! * 0.25;
    }
    // Catmull-Rom sampling for gentle curves
    const S = step > 14 ? 8 : step > 5 ? 4 : 2;
    const samples: Sample[] = [];
    for (let i = 0; i < n - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)]!;
      const p1 = pts[i]!;
      const p2 = pts[i + 1]!;
      const p3 = pts[Math.min(n - 1, i + 2)]!;
      for (let s = 0; s < S; s++) {
        const t = s / S;
        const t2 = t * t;
        const t3 = t2 * t;
        const y =
          0.5 *
          (2 * p1.y +
            (-p0.y + p2.y) * t +
            (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
            (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
        samples.push({
          x: lerp(p1.x, p2.x, t),
          y,
          seg: i + 1,
          wd: lerp(p1.wd, p2.wd, t),
          col: mixRGB(p1.col, p2.col, t),
          cache: lerp(p1.cache, p2.cache, t),
          sh: TOOLS.map((tk) => lerp(p1.tools[tk] ?? 0, p2.tools[tk] ?? 0, t)),
          nx: 0,
          ny: 0,
        });
      }
    }
    const L = pts[n - 1]!;
    samples.push({ x: L.x, y: L.y, seg: n - 1, wd: L.wd, col: L.col, cache: L.cache, sh: TOOLS.map((tk) => L.tools[tk] ?? 0), nx: 0, ny: 0 });
    for (let j = 0; j < samples.length; j++) {
      const a = samples[Math.max(0, j - 1)]!;
      const b = samples[Math.min(samples.length - 1, j + 1)]!;
      const nx = -(b.y - a.y);
      const ny = b.x - a.x;
      const len = Math.hypot(nx, ny) || 1;
      samples[j]!.nx = nx / len;
      samples[j]!.ny = ny / len;
    }
    this.pts = pts;
    this.samples = samples;
    this.S = S;
    // runs: consecutive segments whose destination day is lit (or today, attached to a lit run)
    const runs: Run[] = [];
    let cur: Run | null = null;
    const prevLit = n > 1 && (pts[n - 2]!.kind === "lit" || pts[n - 2]!.kind === "frozen");
    for (let j = 1; j < samples.length; j++) {
      const kind = pts[samples[j]!.seg]!.kind;
      const litLike = kind === "lit" || kind === "frozen" || (kind === "today" && (L.day.goalMet || prevLit));
      if (litLike) {
        if (!cur) {
          cur = { a: j - 1, b: j, current: false, startDay: 0 };
          runs.push(cur);
        } else cur.b = j;
      } else cur = null;
    }
    for (const r of runs) {
      r.current = r.b >= samples.length - 1 - S;
      r.startDay = samples[r.a]!.seg;
    }
    this.runs = runs;
    this.head = { x: L.x, y: L.y };
    // milestone stars along the current run
    this.milestones = [];
    const curRun = runs.find((r) => r.current);
    const streak = d.streak.current;
    if (curRun)
      for (const m of MILESTONES) {
        if (streak >= m) {
          const dayIdx = n - 1 - (streak - m) - (L.day.goalMet ? 0 : 1);
          const p = pts[dayIdx];
          if (p && dayIdx > 0) this.milestones.push({ m, x: p.x, y: p.y - p.wd * 1.2 - 10 * k });
        }
      }
    // stars
    const r = rng(this.seed * 131);
    this.stars = [];
    const tier = this.tier();
    const count = Math.round(((T.starCount * (w * h)) / (360 * 200)) * (tier.min >= 30 ? 1.5 : 1));
    for (let i = 0; i < Math.min(count, 260); i++)
      this.stars.push({ x: r() * w, y: Math.pow(r(), 1.6) * h * 0.62, s: 0.5 + r() * 1.2, ph: r() * 6.28, sp: 0.6 + r() * 1.6 });
    if (this.hover) this.hover = this.pts[clamp(this.hover.i, 0, this.pts.length - 1)] ?? null;
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

  private paintRibbon(): void {
    const c = this.cache.getContext("2d")!;
    const T = this.theme;
    const S = this.samples;
    const k = this.k;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.globalCompositeOperation = T.blend;
    c.lineCap = "round";
    c.lineJoin = "round";
    const n = this.pts.length;
    const last = S.length - 1;
    // wisps (usage below goal) and frozen bridges
    for (let j = 1; j < S.length; j++) {
      const kind = this.pts[S[j]!.seg]!.kind;
      if (kind !== "wisp" && kind !== "frozen") continue;
      if (S[j]!.seg === n - 1) continue;
      if (kind === "frozen" && this.runs.some((r) => j > r.a && j <= r.b)) continue;
      c.strokeStyle = rgba(S[j]!.col, kind === "wisp" ? T.wisp : 0.7);
      c.lineWidth = Math.max(1, 1.2 * k);
      c.setLineDash(kind === "frozen" ? [2 * k, 4 * k] : []);
      c.beginPath();
      c.moveTo(S[j - 1]!.x, S[j - 1]!.y);
      c.lineTo(S[j]!.x, S[j]!.y);
      c.stroke();
    }
    c.setLineDash([]);
    const spans = this.runs
      .map((run) => ({ run, dim: run.current ? 1 : T.pastDim, end: Math.min(run.b, last - (run.current ? this.S : 0)) }))
      .filter((x) => x.end - x.run.a >= 1);
    // glow on a quarter-resolution canvas: the blur is ~16x cheaper and looks the same upscaled
    const q = this.dpr * 0.25;
    const gc = this.glowCache;
    gc.width = Math.max(1, Math.round(this.w * q));
    gc.height = Math.max(1, Math.round(this.h * q));
    const g = gc.getContext("2d")!;
    g.setTransform(q, 0, 0, q, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    g.globalCompositeOperation = T.blend;
    for (const x of spans) this.ribbonLayers(g, x.run.a, x.end, x.dim, x.run.current, "glow", q);
    c.drawImage(gc, 0, 0, this.w, this.h);
    if (T.shadow && supportsFilter()) {
      // one blurred, offset silhouette of every run
      c.save();
      c.filter = `blur(${(3.5 * k).toFixed(1)}px)`;
      c.translate(0, 3.2 * k);
      for (const x of spans) this.ribbonLayers(c, x.run.a, x.end, x.dim, x.run.current, "shadow", this.dpr);
      c.restore();
    }
    // light theme: a thin darker rim gives the ribbon an edge on a pale sky
    if (T.rim) for (const x of spans) this.ribbonLayers(c, x.run.a, x.end, x.dim, x.run.current, "rim", this.dpr);
    // bodies: all runs crisp on one layer, then composite once with a light blur
    const bc = this.bodyCache;
    bc.width = this.cache.width;
    bc.height = this.cache.height;
    const bctx = bc.getContext("2d")!;
    bctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    bctx.globalCompositeOperation = T.blend;
    for (const x of spans) this.ribbonLayers(bctx, x.run.a, x.end, x.dim, x.run.current, "body", this.dpr);
    c.save();
    c.setTransform(1, 0, 0, 1, 0, 0);
    if (supportsFilter() && T.bodyBlur * k * this.dpr >= 1) c.filter = `blur(${(T.bodyBlur * k * this.dpr).toFixed(1)}px)`;
    c.drawImage(bc, 0, 0);
    c.restore();
    if (T.inner > 0) for (const x of spans) this.ribbonLayers(c, x.run.a, x.end, x.dim, x.run.current, "inner", this.dpr);
    for (const x of spans) {
      this.ribbonLayers(c, x.run.a, x.end, x.dim, x.run.current, "core", this.dpr);
      if (!x.run.current) this.embers(c, S[x.end]!, x.dim);
    }
    c.globalCompositeOperation = "source-over";
  }

  private ribbonLayers(c: Ctx, a: number, b: number, dim: number, current: boolean, mode: "glow" | "body" | "core" | "rim" | "inner" | "shadow", scale: number): void {
    const T = this.theme;
    const S = this.samples;
    const k = this.k;
    const grad = (alpha: number, kind: "core" | "glow" | "body" | "rim" | "inner") => {
      const g = c.createLinearGradient(S[a]!.x, 0, S[b]!.x, 0);
      const span = S[b]!.x - S[a]!.x || 1;
      const every = Math.max(1, Math.floor((b - a) / 40));
      for (let j = a; j <= b; j += every) {
        const s = S[j]!;
        let col: RGB;
        if (kind === "core") col = mixRGB(T.core, T.coolCore, clamp((s.cache - 0.4) / 0.5, 0, 1));
        else if (kind === "glow" && T.glowTint) col = mixRGB(s.col, T.glowTint, T.glowTintAmt);
        else if (kind === "rim" && T.rim) col = mixRGB(s.col, T.rim, 0.6);
        else if (kind === "inner") col = mixRGB(s.col, T.innerTint, 0.55);
        else col = s.col;
        g.addColorStop(clamp((s.x - S[a]!.x) / span, 0, 1), rgba(col, alpha * dim));
      }
      return g;
    };
    // taper measured in pixels, so short runs in dense layouts become slim wisps instead of spikes
    const taper = (j: number) => {
      const s = S[j]!;
      const dIn = s.x - S[a]!.x;
      const dOut = S[b]!.x - s.x;
      const w = Math.max(1, s.wd);
      return Math.min(1, dIn / (w * 1.6) + 0.12, current ? 1 : dOut / (w * 1.1) + 0.12);
    };
    const poly = (mul: number, pad = 0) => {
      c.beginPath();
      for (let j = a; j <= b; j++) {
        const s = S[j]!;
        const hw = s.wd * mul * taper(j) * 0.5 + pad;
        if (j === a) c.moveTo(s.x + s.nx * hw, s.y + s.ny * hw);
        else c.lineTo(s.x + s.nx * hw, s.y + s.ny * hw);
      }
      for (let j = b; j >= a; j--) {
        const s = S[j]!;
        const hw = s.wd * mul * taper(j) * 0.5 + pad;
        c.lineTo(s.x - s.nx * hw, s.y - s.ny * hw);
      }
      c.closePath();
      c.fill();
    };
    if (mode === "glow") {
      if (supportsFilter()) {
        c.filter = `blur(${(8 * k * scale).toFixed(1)}px)`;
        c.fillStyle = grad(T.glowA, "glow");
        poly(T.glowMul);
        c.filter = "none";
      } else {
        for (const [m, al] of [[5, 0.12], [3.4, 0.16], [2.2, 0.22]] as const) {
          c.fillStyle = grad(T.glowA * al * 2.2, "glow");
          poly((m * T.glowMul) / 3.6);
        }
      }
      return;
    }
    if (mode === "rim") {
      c.fillStyle = grad(T.rimA, "rim");
      poly(T.bodyMul, Math.max(0.6, 0.7 * k));
      return;
    }
    if (mode === "shadow") {
      c.fillStyle = T.shadow ?? "transparent";
      c.globalAlpha = dim;
      poly(T.bodyMul * 0.9);
      c.globalAlpha = 1;
      return;
    }
    if (mode === "inner") {
      c.fillStyle = grad(T.inner, "inner");
      poly(T.bodyMul * 0.5);
      return;
    }
    if (mode === "body") {
      c.fillStyle = grad(T.bodyA, "body");
      poly(T.bodyMul);
      return;
    }
    c.fillStyle = grad(T.coreA, "core");
    poly(T.coreW);
  }

  private embers(c: Ctx, s: Sample, dim: number): void {
    const r = rng(Math.round(s.x * 13));
    // dense layouts have many broken runs: fewer, fainter embers so a year stays clean
    const count = this.step < 4 ? 2 : this.step < 8 ? 4 : 6;
    const a = this.themeName === "dark" ? 0.55 : 0.4;
    for (let i = 0; i < count; i++) {
      c.fillStyle = rgba(this.theme.tool.claude, a * dim * (1 - i / 7));
      c.beginPath();
      c.arc(s.x + (r() - 0.3) * 10 * this.k, s.y + r() * 16 * this.k, (0.6 + r() * 1.2) * this.k, 0, 7);
      c.fill();
    }
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
    if (simulateOnly) {
      this.headSparks(prog, t, tier);
      this.stepParticles(dt);
      return;
    }
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, c.canvas.width, c.canvas.height);
    const ce = this.celebrateAt >= 0 ? this.t - this.celebrateAt : -1;
    const pulse = ce >= 0 && ce < 0.6 && !this.reduced ? 1 + Math.sin((ce / 0.6) * Math.PI) * 0.012 : 1;
    c.setTransform(this.dpr * pulse, 0, 0, this.dpr * pulse, (1 - pulse) * w * this.dpr * 0.5, (1 - pulse) * h * this.dpr * 0.5);
    c.drawImage(this.skyCache, 0, 0, w, h);
    // horizon warmth grows with today's progress; blooms after the goal
    const warm = clamp(prog, 0, 1) * 0.5 + (prog >= 1 ? 0.25 : 0) + (ce >= 0 ? Math.max(0, 0.6 - ce * 0.25) : 0);
    const hg = c.createRadialGradient(this.head.x, h * 1.05, 0, this.head.x, h * 1.05, h * 1.1);
    hg.addColorStop(0, `${T.horizon}${((dark ? 0.45 : 0.5) * warm).toFixed(3)})`);
    hg.addColorStop(1, `${T.horizon}0)`);
    c.fillStyle = hg;
    c.fillRect(0, 0, w, h);
    if (tier.min >= 100) this.aurora(c, t);
    const revealP = this.revealing ? clamp((this.t - this.revealAt) / 2.4, 0, 1) : 1;
    if (this.revealing && revealP >= 1) this.revealing = false;
    for (const s of this.stars) {
      const tw = 0.35 + 0.65 * Math.abs(Math.sin(t * s.sp + s.ph));
      c.fillStyle = `${T.star}${(tw * T.starA * revealP).toFixed(3)})`;
      const yy = dark ? s.y : s.y + Math.sin(t * 0.3 + s.ph) * 4;
      c.beginPath();
      c.arc(s.x, yy, s.s * (dark ? 1 : 1.3), 0, 7);
      c.fill();
    }
    const first = this.pts[0]!;
    const revealX = revealP < 1 ? lerp(first.x - 20, this.head.x + 4, easeInOut(revealP)) : w + 10;
    c.save();
    c.beginPath();
    c.rect(0, 0, revealX, h);
    c.clip();
    c.drawImage(this.cache, 0, 0, w, h);
    c.globalCompositeOperation = T.blend;
    this.strands(c, t, revealX);
    this.todaySegment(c, prog);
    this.shimmer(c, t, ce);
    c.restore();
    this.milestones.forEach((m, i) => {
      if (m.x > revealX) return;
      this.sparkle(c, m.x, m.y, (5 + i * 1.5) * k, t * 0.6 + i, 0.9, v.labels ? m.m : null);
    });
    if (revealP >= 1) this.drawHead(c, prog, t, ce, tier);
    else if (revealP > 0.02) {
      const s = this.sampleAtX(revealX);
      if (s) this.glowDot(c, s.x, s.y, 10 * k, 0.9);
    }
    this.headSparks(prog, t, tier);
    this.stepParticles(dt);
    this.drawParticles(c);
    if (ce >= 0 && ce < 1.2 && !this.reduced) {
      const p = easeOutCubic(ce / 1.2);
      c.strokeStyle = dark ? `rgba(255,236,210,${(0.7 * (1 - p)).toFixed(3)})` : `rgba(240,114,140,${(0.55 * (1 - p)).toFixed(3)})`;
      c.lineWidth = 2.5 * k * (1 - p) + 0.5;
      c.beginPath();
      c.arc(this.head.x, this.head.y, v.headR * k * (1 + p * 7), 0, 7);
      c.stroke();
    }
    if (this.hover) {
      c.globalCompositeOperation = "source-over";
      c.strokeStyle = T.halo;
      c.lineWidth = 1;
      c.setLineDash([3, 4]);
      c.beginPath();
      c.moveTo(this.hover.x, 0);
      c.lineTo(this.hover.x, h);
      c.stroke();
      c.setLineDash([]);
      c.globalCompositeOperation = T.blend;
      this.glowDot(c, this.hover.x, this.hover.y, 7 * k, 1);
      if (!dark) {
        c.globalCompositeOperation = "source-over";
        c.fillStyle = "rgba(255,255,255,0.95)";
        c.strokeStyle = rgba(this.hover.col, 0.9);
        c.lineWidth = 1.5;
        c.beginPath();
        c.arc(this.hover.x, this.hover.y, 3.2, 0, 7);
        c.fill();
        c.stroke();
      }
    }
    if (ce >= 0 && ce < 0.5) {
      c.globalCompositeOperation = "source-over";
      c.fillStyle = `rgba(255,240,220,${(0.22 * (1 - ce / 0.5)).toFixed(3)})`;
      c.fillRect(0, 0, w, h);
    }
    c.globalCompositeOperation = "source-over";
  }

  private sampleAtX(x: number): Sample | null {
    let best: Sample | null = null;
    for (const s of this.samples) {
      if (s.x <= x) best = s;
      else break;
    }
    return best;
  }

  private strands(c: Ctx, t: number, maxX: number): void {
    const S = this.samples;
    const T = this.theme;
    const k = this.k;
    const dark = this.themeName === "dark";
    for (const run of this.runs) {
      const a = run.a;
      const b = run.b;
      if (S[a]!.x > maxX) continue;
      const dim = run.current ? 1 : T.pastDim * 0.8;
      TOOLS.forEach((tk, ti) => {
        const g = c.createLinearGradient(S[a]!.x, 0, S[b]!.x, 0);
        const span = S[b]!.x - S[a]!.x || 1;
        const every = Math.max(1, Math.floor((b - a) / 30));
        const col = mixRGB(T.tool[tk], dark ? [255, 250, 240] : [255, 255, 255], T.strandWhite);
        for (let j = a; j <= b; j += every)
          g.addColorStop(clamp((S[j]!.x - S[a]!.x) / span, 0, 1), rgba(col, T.strandA * dim * clamp(S[j]!.sh[ti]! * 1.6 + 0.08, 0, 1)));
        c.strokeStyle = g;
        c.lineWidth = Math.max(0.7, 0.9 * k);
        c.beginPath();
        for (let j = a; j <= b; j++) {
          const s = S[j]!;
          const tp = Math.min(1, (j - a) / 6, (b - j) / 3 + (run.current ? 1 : 0.1));
          const off =
            (Math.sin(s.x / (26 * k) + ti * 2.09 + t * (0.7 + ti * 0.13)) * 0.8 + Math.sin(s.x / (61 * k) - ti + t * 0.3) * 0.2) *
            s.wd *
            0.4 *
            tp;
          const x = s.x + s.nx * off;
          const y = s.y + s.ny * off;
          if (j === a) c.moveTo(x, y);
          else c.lineTo(x, y);
        }
        c.stroke();
      });
    }
  }

  private todaySegment(c: Ctx, prog: number): void {
    const S = this.samples;
    const n = S.length;
    const T = this.theme;
    const k = this.k;
    const a = Math.max(0, n - 1 - this.S);
    const b = n - 1;
    if (b - a < 1) return;
    const prevKind = this.pts.length > 1 ? this.pts[this.pts.length - 2]!.kind : "dark";
    const prevLit = prevKind === "lit" || prevKind === "frozen";
    const wTarget = (this.v.wMin + Math.pow(clamp(prog, 0, 2.5) / 2.5, 0.7) * (this.v.wMax - this.v.wMin)) * k * T.wMul;
    const wPrev = S[a]!.wd;
    const col = S[b]!.col;
    const widthAt = (j: number) => {
      const f = (j - a) / (b - a);
      return prevLit ? lerp(wPrev, wTarget, f) : wTarget * Math.min(1, f * 1.4 + 0.1);
    };
    const draw = (mul: number, alpha: number, fill: RGB, pad = 0) => {
      c.beginPath();
      for (let j = a; j <= b; j++) {
        const s = S[j]!;
        const hw = widthAt(j) * mul * 0.5 + pad;
        if (j === a) c.moveTo(s.x + s.nx * hw, s.y + s.ny * hw);
        else c.lineTo(s.x + s.nx * hw, s.y + s.ny * hw);
      }
      for (let j = b; j >= a; j--) {
        const s = S[j]!;
        const hw = widthAt(j) * mul * 0.5 + pad;
        c.lineTo(s.x - s.nx * hw, s.y - s.ny * hw);
      }
      c.closePath();
      c.fillStyle = rgba(fill, alpha);
      c.fill();
    };
    const lit = prog >= 1;
    const a0 = lit ? 1 : 0.55 + 0.45 * clamp(prog, 0, 1);
    const glowCol = T.glowTint ? mixRGB(col, T.glowTint, T.glowTintAmt) : col;
    draw(T.glowMul * 0.9, T.glowA * 0.3 * a0, glowCol);
    if (T.rim) draw(T.bodyMul, T.rimA * a0, mixRGB(col, T.rim, 0.6), Math.max(0.6, 0.7 * k));
    draw(T.bodyMul, T.bodyA * 0.85 * a0, col);
    if (T.inner > 0) draw(T.bodyMul * 0.5, T.inner * a0, mixRGB(col, T.innerTint, 0.55));
    draw(T.coreW * 1.25, (this.themeName === "dark" ? 0.8 : 0.85) * a0, T.core);
  }

  private shimmer(c: Ctx, t: number, ce: number): void {
    const run = this.runs.find((r) => r.current);
    if (!run || this.reduced) return;
    const S = this.samples;
    const a = run.a;
    const b = run.b;
    const len = b - a;
    if (len < 4) return;
    let p: number;
    if (ce >= 0 && ce < 1.6) p = 1 - easeOutQuint(clamp((ce - 0.15) / 1.3, 0, 1));
    else p = easeInOut((t % 7) / 7);
    const center = a + p * len;
    const win = Math.max(6, len * 0.08);
    const T = this.theme;
    const boost = ce >= 0 && ce < 1.6 ? 1.6 : 1;
    c.lineCap = "round";
    for (let j = Math.max(a + 1, Math.floor(center - win)); j <= Math.min(b, Math.ceil(center + win)); j++) {
      const f = 1 - Math.abs(j - center) / win;
      if (f <= 0) continue;
      c.strokeStyle = rgba(T.shimmer, T.shimmerA * f * f * boost);
      c.lineWidth = S[j]!.wd * (this.themeName === "dark" ? 0.9 : 0.55) * boost;
      c.beginPath();
      c.moveTo(S[j - 1]!.x, S[j - 1]!.y);
      c.lineTo(S[j]!.x, S[j]!.y);
      c.stroke();
    }
  }

  private drawHead(c: Ctx, prog: number, t: number, ce: number, tier: TrailTier): void {
    const T = this.theme;
    const k = this.k;
    const x = this.head.x;
    const y = this.head.y;
    const R = this.v.headR * k;
    const dark = this.themeName === "dark";
    const lit = prog >= 1;
    const f = clamp(prog, 0, 1);
    const breath = this.reduced ? 1 : 1 + Math.sin(t * 2.2) * 0.04;
    let pop = 1;
    if (ce >= 0 && ce < 1.4) pop = 1 + (spring(ce / 0.9) - 1) * 0.6 + (1 - clamp(ce / 0.25, 0, 1)) * 0.5;
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
    const warmCol: RGB = dark ? col : mixRGB(col, [255, 170, 120], 0.35);
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
    if (lit || tier.min >= 7) this.sparkle(c, x, y, r * (lit ? (dark ? 1.45 : 1.2) : 1.1), t * 0.25, lit ? 0.9 : 0.3, null, true);
    if (tier.min >= 30) {
      const S = this.samples;
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

  private headSparks(prog: number, _t: number, _tier: TrailTier): void {
    if (this.reduced || !this.pts.length) return;
    const lit = prog >= 1;
    const f = clamp(prog, 0, 1);
    const R = this.v.headR * this.k;
    const r = R * (0.45 + 0.55 * f);
    const rand = this.random;
    if (rand() < (0.08 + 0.25 * f) * (lit ? 1.6 : 1)) {
      const col = this.pts[this.pts.length - 1]!.col;
      this.particles.push({
        x: this.head.x + (rand() - 0.5) * r,
        y: this.head.y + (rand() - 0.5) * r,
        vx: (-20 - rand() * 30) * Math.max(1, this.k * 0.8),
        vy: 6 + rand() * 14,
        life: 0,
        max: 1.2 + rand(),
        s: (0.6 + rand() * 1.2) * this.k,
        col: this.themeName === "light" ? (rand() < 0.5 ? [255, 170, 120] : [240, 120, 140]) : rand() < 0.5 ? col : this.theme.core,
      });
    }
  }

  private sparkle(c: Ctx, x: number, y: number, s: number, rot: number, a: number, label: number | null, thin = false): void {
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
    if (label) {
      c.globalCompositeOperation = "source-over";
      c.fillStyle = T.text;
      c.font = `500 ${Math.round(10 * Math.max(1, this.k * 0.8))}px "Geist Variable", Geist, system-ui`;
      c.textAlign = "center";
      c.fillText(`${label} days`, x, y - s - 6);
    }
  }

  private glowDot(c: Ctx, x: number, y: number, r: number, a: number): void {
    const g = c.createRadialGradient(x, y, 0, x, y, r);
    const col: RGB = this.themeName === "dark" ? this.theme.core : [255, 190, 150];
    g.addColorStop(0, rgba(col, a));
    g.addColorStop(1, rgba(col, 0));
    c.fillStyle = g;
    c.beginPath();
    c.arc(x, y, r, 0, 7);
    c.fill();
  }

  private aurora(c: Ctx, t: number): void {
    const w = this.w;
    const h = this.h;
    const dark = this.themeName === "dark";
    const cols: RGB[] = dark ? [[120, 230, 200], [170, 140, 255], [255, 160, 190]] : [[150, 210, 255], [200, 170, 255], [255, 180, 200]];
    c.save();
    c.globalCompositeOperation = dark ? "lighter" : "source-over";
    for (let b = 0; b < 3; b++) {
      const top = h * (0.08 + b * 0.05);
      const bot = h * (0.42 + b * 0.04);
      // the gradient fades out inside the wavy polygon, so no edge ever shows
      const g = c.createLinearGradient(0, top + h * 0.05, 0, bot - h * 0.06);
      g.addColorStop(0, rgba(cols[b]!, 0));
      g.addColorStop(0.55, rgba(cols[b]!, dark ? 0.14 : 0.2));
      g.addColorStop(1, rgba(cols[b]!, 0));
      c.fillStyle = g;
      c.beginPath();
      for (let x = 0; x <= w; x += 10) c.lineTo(x, top + Math.sin((x / w) * 5 + t * 0.35 + b * 2) * h * 0.05);
      for (let x = w; x >= 0; x -= 10) c.lineTo(x, bot + Math.sin((x / w) * 4 + t * 0.28 + b) * h * 0.06);
      c.closePath();
      c.fill();
    }
    c.restore();
  }

  private burst(): void {
    if (!this.pts.length || this.reduced) return;
    const T = this.theme;
    const k = this.k || 1;
    const cols: RGB[] = [T.tool.claude, T.tool.codex, T.tool.gemini, T.core, [255, 214, 140]];
    const rand = this.random;
    for (let i = 0; i < 110; i++) {
      const a = rand() * Math.PI * 2;
      const sp = (60 + rand() * 220) * k;
      this.particles.push({
        x: this.head.x,
        y: this.head.y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 40 * k,
        life: 0,
        max: 1 + rand() * 1.4,
        s: (0.8 + rand() * 2) * k,
        col: cols[i % cols.length]!,
        g: 110 * k,
        drag: 2.2,
        star: i % 7 === 0,
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
    c.globalCompositeOperation = this.theme.blend;
    for (const p of this.particles) {
      const a = 1 - p.life / p.max;
      if (p.star) this.sparkle(c, p.x, p.y, p.s * 3, p.life * 3, a, null);
      else {
        c.fillStyle = rgba(p.col, a * 0.95);
        c.beginPath();
        c.arc(p.x, p.y, p.s * (0.6 + a * 0.4), 0, 7);
        c.fill();
      }
    }
  }
}
