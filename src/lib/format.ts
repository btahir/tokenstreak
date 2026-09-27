// Number and date formatting shared by every view and the share cards.

import type { Tool } from "../api/types";

const trim = (s: string) => s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

/** Scales a count to its compact unit: [value, unit]. */
function unitOf(abs: number): [number, string] {
  if (abs >= 1e12) return [abs / 1e12, "T"];
  if (abs >= 1e9) return [abs / 1e9, "B"];
  if (abs >= 1e6) return [abs / 1e6, "M"];
  if (abs >= 1e3) return [abs / 1e3, "K"];
  return [abs, ""];
}

/**
 * Compact token counts: 412K, 8.5K, 61.4M, 412M, 12.2B.
 * One decimal below 100 of a unit, none above; trailing ".0" is dropped.
 * `floor` rounds toward zero instead of to nearest (for values below a goal).
 */
export function formatTokens(n: number, opts: { digits?: number; floor?: boolean; fixed?: boolean } = {}): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  let [v, u] = unitOf(abs);
  // rounding can carry into the next unit (999.96K -> 1000K): step up instead
  if (!opts.floor && u && u !== "T" && Math.round(v) >= 1000) [v, u] = unitOf(abs * 1.0001);
  if (u === "") return `${sign}${opts.floor ? Math.floor(abs) : Math.round(abs)}`;
  const d = opts.digits ?? (u === "K" && v >= 10 ? 0 : 1);
  const places = v >= 100 && opts.digits === undefined ? 0 : d;
  const k = Math.pow(10, places);
  const r = opts.floor ? Math.floor(v * k + 1e-9) / k : Math.round(v * k) / k;
  return `${sign}${opts.fixed ? r.toFixed(places) : trim(r.toFixed(places))}${u}`;
}

/**
 * A count shown against a goal. Never rounds up to (or past) the goal while it
 * is unmet: 1,967,000 of 2M reads "1.96M", 1,999,400 reads "1.99M".
 */
export function formatTowardGoal(n: number, goal: number): string {
  if (!(goal > 0) || n >= goal || n <= 0) return formatTokens(n);
  const goalLabel = formatTokens(goal);
  const plain = formatTokens(n);
  // plain is fine when it neither reaches the goal nor looks like it
  if (parseTokens(plain)! < goal && plain !== goalLabel && n < goal * 0.95) return plain;
  const [v] = unitOf(n);
  const intDigits = String(Math.floor(v)).length;
  for (let d = Math.max(1, 3 - intDigits); d <= 4; d++) {
    const s = formatTokens(n, { digits: d, floor: true });
    const back = parseTokens(s);
    if (s !== goalLabel && back !== null && back < goal) return s;
  }
  return formatTokens(n, { digits: 4, floor: true });
}

/** Splits a compact number into its value and unit: "61.4M" -> ["61.4", "M"]. */
export function splitUnit(s: string): [string, string] {
  const m = /^([−-]?[\d.,]+)(\D*)$/.exec(s);
  return m ? [m[1]!, m[2]!] : [s, ""];
}

/** Full, grouped count: 1,234,567. */
export function formatInt(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export function formatUsd(n: number, opts: { cents?: boolean } = {}): string {
  if (!Number.isFinite(n)) return "$0";
  if (n > 0 && n < 0.01) return "<$0.01";
  const digits = opts.cents === false || n >= 1000 ? 0 : 2;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits });
}

/**
 * A share as a percent. Never claims 100% (or 0%) unless the value is exactly
 * 1 (or 0): 0.997 reads ">99%", 0.003 reads "<1%".
 */
export function formatPercent(r: number, digits = 0): string {
  if (!Number.isFinite(r)) return "0%";
  const s = trim((r * 100).toFixed(digits));
  const top = trim((100).toFixed(digits));
  if (r < 1 && r > 0.5 && s === top) return `>${trim((100 - Math.pow(10, -digits)).toFixed(digits))}%`;
  if (r > 0 && Number(s) === 0) return `<${trim(Math.pow(10, -digits).toFixed(digits))}%`;
  return `${s}%`;
}

/** Whole-number percent that never rounds to 100 (or 0) unless exact. */
export function percentValue(r: number): number {
  if (!Number.isFinite(r)) return 0;
  const v = Math.round(r * 100);
  if (v >= 100 && r < 1) return 99;
  if (v <= 0 && r > 0) return 1;
  return v;
}

/** "9.4×" style multiplier. */
export function formatTimes(r: number): string {
  if (!Number.isFinite(r) || r <= 0) return "0×";
  return `${r >= 100 ? formatInt(r) : trim(r.toFixed(1))}×`;
}

/**
 * A relative change for a delta chip, kept short: "17%", "3.2×" once the value
 * is more than triple, "10×+" beyond that. `frac` is (now - usual) / usual.
 */
export function formatChange(frac: number): string {
  const a = Math.abs(frac);
  if (frac > 0 && a >= 9) return "10×+";
  if (frac > 0 && a >= 2) return `${trim((1 + frac).toFixed(1))}×`;
  return `${Math.round(a * 100)}%`;
}

export const TOOL_NAMES: Record<Tool, string> = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI" };
export const TOOL_SHORT: Record<Tool, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
export const TOOLS: Tool[] = ["claude", "codex", "gemini"];


/** Parses YYYY-MM-DD as a calendar date (UTC noon, so zones never shift it). */
export function parseDate(d: string): Date {
  const [y, m, dd] = d.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, (m || 1) - 1, dd || 1, 12));
}

export function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: string, n: number): string {
  return isoDate(new Date(parseDate(d).getTime() + n * 864e5));
}

export function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / 864e5);
}

/* ---------------- dates: one Intl formatter everywhere ---------------- */

let LOCALE: string | undefined;
let REF_YEAR: number | null = null;

/** Tests pin the locale; the app follows the system's. */
export function setFormatLocale(locale: string | undefined): void {
  LOCALE = locale;
  fmtCache.clear();
}

/** The year dates are relative to (the snapshot's today); defaults to the clock. */
export function setReferenceDate(today: string | null): void {
  REF_YEAR = today ? parseDate(today).getUTCFullYear() : null;
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function dtf(opts: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = JSON.stringify(opts);
  let f = fmtCache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(LOCALE, { timeZone: "UTC", ...opts });
    fmtCache.set(key, f);
  }
  return f;
}

function refYear(): number {
  return REF_YEAR ?? new Date().getFullYear();
}

/**
 * The one short date format: "Sep 27" this year, "Sep 27, 2025" otherwise
 * (locale order, so "27 Sep 2025" in en-GB). `year: "always"` forces the year.
 */
export function formatDate(d: string, opts: { year?: "auto" | "always" } = {}): string {
  const x = parseDate(d);
  const withYear = opts.year === "always" || x.getUTCFullYear() !== refYear();
  return dtf(withYear ? { month: "short", day: "numeric", year: "numeric" } : { month: "short", day: "numeric" }).format(x);
}

/** "Saturday, September 26" (locale order). */
export function formatLongDate(d: string): string {
  const x = parseDate(d);
  const withYear = x.getUTCFullYear() !== refYear();
  return dtf(withYear ? { weekday: "long", month: "long", day: "numeric", year: "numeric" } : { weekday: "long", month: "long", day: "numeric" }).format(x);
}

export function weekdayShort(d: string): string {
  return dtf({ weekday: "short" }).format(parseDate(d));
}

export function monthShort(d: string): string {
  return dtf({ month: "short" }).format(parseDate(d));
}

export function monthName(i: number): string {
  return i >= 0 && i < 12 ? dtf({ month: "long" }).format(new Date(Date.UTC(2026, i, 15, 12))) : "";
}

type RangeFmt = Intl.DateTimeFormat & { formatRange?: (a: Date, b: Date) => string };

/** Month span: "Mar – Sep 2026", "Oct 2025 – Sep 2026", "Sep 2026". */
export function formatRange(from: string, to: string): string {
  const a = parseDate(from);
  const b = parseDate(to);
  const f = dtf({ month: "short", year: "numeric" }) as RangeFmt;
  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) return f.format(b);
  return f.formatRange ? f.formatRange(a, b).replace(/\s*[–-]\s*/, " – ") : `${f.format(a)} – ${f.format(b)}`;
}

/** Day span: "Aug 17 – Sep 26, 2026", "Dec 28, 2025 – Jan 3, 2026". */
export function formatDayRange(from: string, to: string): string {
  const a = parseDate(from);
  const b = parseDate(to);
  const f = dtf({ month: "short", day: "numeric", year: "numeric" }) as RangeFmt;
  if (from === to) return f.format(a);
  return f.formatRange ? f.formatRange(a, b).replace(/\s*[–-]\s*/, " – ") : `${f.format(a)} – ${f.format(b)}`;
}

/** "just now", "2 min ago", "3 h ago", "yesterday", "4 days ago". */
export function formatAgo(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "never";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

/** Plural helper: plural(3, "day") -> "3 days". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${formatInt(n)} ${n === 1 ? word : many}`;
}

/** Shortens a log folder for display: home becomes "~". Never shows other users' paths. */
export function prettyPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

const GOAL_STEPS = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/**
 * Rounds a goal to the nearest friendly step (1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 8 ×
 * 10^n; never below 10K). The error stays under about 15%, and `dir` can force
 * the snap below or above `n`.
 */
export function friendlyGoal(n: number, dir: "nearest" | "down" | "up" = "nearest"): number {
  if (!(n > 0)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(n)));
  const m = n / p;
  let step: number;
  if (dir === "down") step = [...GOAL_STEPS].reverse().find((s) => s <= m + 1e-9) ?? 1;
  else if (dir === "up") step = GOAL_STEPS.find((s) => s >= m - 1e-9) ?? 10;
  else step = GOAL_STEPS.reduce((b, s) => (Math.abs(Math.log(s / m)) < Math.abs(Math.log(b / m)) ? s : b), 1);
  return Math.max(10_000, Math.round(step * p));
}

/** Parses "500k", "2.5M", "1,000,000". */
export function parseTokens(s: string): number | null {
  const m = /^\s*([\d.,]+)\s*([kmb]?)\s*$/i.exec(s);
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  const mul = { "": 1, k: 1e3, m: 1e6, b: 1e9 }[m[2]!.toLowerCase() as "" | "k" | "m" | "b"];
  return Math.round(n * mul);
}

const MODEL_WORDS: Record<string, string> = { gpt: "GPT", codex: "Codex", mini: "mini", nano: "nano", pro: "Pro", flash: "Flash", lite: "Lite", max: "Max", turbo: "Turbo" };

/**
 * A readable model name: "claude-sonnet-4-5-20250929" -> "Sonnet 4.5",
 * "gpt-5.1-codex" -> "GPT-5.1 Codex", "gemini-2.5-pro" -> "Gemini 2.5 Pro".
 * Unknown shapes come back unchanged; keep the raw ID for tooltips.
 */
export function prettyModel(id: string): string {
  if (!id) return id;
  const raw = id.replace(/^(anthropic|openai|google)[/.]/, "").replace(/[-@]\d{8}$/, "").replace(/-latest$/, "");
  const claude = /^claude-(?:(\d+)(?:[-.](\d+))?-)?(opus|sonnet|haiku)(?:-(\d+)(?:[-.](\d))?)?/.exec(raw);
  if (claude) {
    const fam = claude[3]!.charAt(0).toUpperCase() + claude[3]!.slice(1);
    const ver = claude[4] ? `${claude[4]}${claude[5] ? `.${claude[5]}` : ""}` : claude[1] ? `${claude[1]}${claude[2] ? `.${claude[2]}` : ""}` : "";
    return ver ? `${fam} ${ver}` : fam;
  }
  const gpt = /^gpt-(\d+(?:\.\d+)?)(.*)$/.exec(raw);
  if (gpt) {
    const rest = gpt[2]!.split("-").filter(Boolean).map((w) => MODEL_WORDS[w] ?? w);
    return [`GPT-${gpt[1]}`, ...rest].join(" ");
  }
  const gem = /^gemini-(\d+(?:\.\d+)?)(.*)$/.exec(raw);
  if (gem) {
    const rest = gem[2]!.split("-").filter((w) => w && !/^(exp|preview|\d{2}-\d{2})$/.test(w)).map((w) => MODEL_WORDS[w] ?? w);
    return ["Gemini", gem[1], ...rest].join(" ");
  }
  return id;
}
