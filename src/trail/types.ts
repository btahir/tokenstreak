// Data contract and options for the Trail, the signature visual.

export type TrailTool = "claude" | "codex" | "gemini";
/** Fractions of a day's tokens per tool (any subset of keys). */
export type ToolShares = Partial<Record<TrailTool, number>>;

export interface TrailDay {
  /** Local calendar date, YYYY-MM-DD. Seeds the stable wander of the path. */
  date: string;
  /** Total tokens (input + output + cache read + cache write). */
  tokens: number;
  /** Met the goal in force that day. */
  goalMet: boolean;
  /** A rest day or streak freeze bridged this day. */
  frozen?: boolean;
  /** Specifically a spent streak freeze (for copy; drawn like `frozen`). */
  freeze?: boolean;
  tools: ToolShares;
  /** cacheRead / total, 0..1. */
  cacheShare: number;
  /** Goal in force that day (for tooltips). */
  goal?: number;
}

export interface TrailData {
  /** Daily goal in force today. */
  goal: number;
  today: { tokens: number; tools: ToolShares; cacheShare: number; date?: string };
  streak: { current: number; best: number };
  /** Oldest to newest, excluding today, one entry per local day (gaps filled with tokens: 0). */
  history: TrailDay[];
}

export type TrailTheme = "light" | "dark";
export type TrailVariant = "popover" | "full" | "card" | "icon";

export interface TrailLayout {
  headX: number;
  left: number;
  baseY: number;
  amp: number;
  rise: number;
  maxDays: number;
  wMin: number;
  wMax: number;
  headR: number;
  hills: boolean;
  labels: boolean;
  scale?: number;
  /** Head x (fraction of width) when there is no history yet. Default 0.5. */
  soloX?: number;
  smooth?: number;
  freq?: number;
  /** Vertical clamp for the path, as fractions of the height. */
  top?: number;
  bottom?: number;
  /** Largest day step, in layout units (scaled by the size factor). Default 34 (popover/card) or 58 (full). */
  maxStep?: number;
  /** Fraction of the height the path climbs from its first day to the head (short, deliberate arcs). */
  climb?: number;
  /** Draw every day with tokens at full ribbon brightness (cards about something other than the streak). */
  emphasizeAll?: boolean;
  /** Fixed HUD rectangles (CSS px) the path routes around, in addition to `setAvoid()`. */
  avoid?: { x: number; y: number; w: number; h: number }[];
}

export interface TrailOptions {
  theme?: TrailTheme;
  variant?: TrailVariant;
  layout?: Partial<TrailLayout>;
  seed?: number;
  reducedMotion?: boolean;
  /**
   * Fixed logical size instead of the canvas's CSS box (offscreen rendering,
   * share cards). With a fixed size the engine never starts its own loop.
   */
  size?: { width: number; height: number; dpr?: number };
  /** Start the animation loop immediately (default true unless `size` is set). */
  autoStart?: boolean;
  /** Frame rate once idle (no pointer activity for `idleAfterMs`). Default 30. */
  idleFps?: number;
  idleAfterMs?: number;
}

export interface TrailTier {
  min: number;
  id: "kindling" | "ember" | "glow" | "comet" | "aurora" | "halo";
  name: string;
}

/** A day under the pointer (or keyboard focus) on the full variant. */
export interface TrailHover {
  day: TrailDay & { isToday?: boolean };
  index: number;
  x: number;
  y: number;
  /** The run of lit days this day belongs to, if any (dates inclusive). */
  run?: { days: number; from: string; to: string; current: boolean };
}

export interface TrailStats {
  /** Mean time spent drawing one frame (ms), rolling. */
  frameMs: number;
  /** Worst frame in the rolling window (ms). */
  maxFrameMs: number;
  /** Time of the last cache rebuild (ms). */
  cacheMs: number;
  frames: number;
}
