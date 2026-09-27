// Number and date formatting shared by every view and the share cards.

import type { Tool } from "../api/types";

const trim = (s: string) => s.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");

/**
 * Compact token counts: 412K, 8.5K, 61.4M, 412M, 12.2B.
 * One decimal below 100 of a unit, none above; trailing ".0" is dropped.
 */
export function formatTokens(n: number, opts: { digits?: number } = {}): string {
  if (!Number.isFinite(n)) return "0";
  const abs = Math.abs(n);
  const sign = n < 0 ? "−" : "";
  const d = opts.digits ?? 1;
  const unit = (v: number, u: string) => `${sign}${v >= 100 ? Math.round(v) : trim(v.toFixed(d))}${u}`;
  if (abs >= 1e12) return unit(abs / 1e12, "T");
  if (abs >= 1e9) return unit(abs / 1e9, "B");
  if (abs >= 1e6) return unit(abs / 1e6, "M");
  if (abs >= 1e4) return `${sign}${Math.round(abs / 1e3)}K`;
  if (abs >= 1e3) return `${sign}${trim((abs / 1e3).toFixed(1))}K`;
  return `${sign}${Math.round(abs)}`;
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

export function formatPercent(r: number, digits = 0): string {
  if (!Number.isFinite(r)) return "0%";
  return `${trim((r * 100).toFixed(digits))}%`;
}

/** "×9.4" style multiplier. */
export function formatTimes(r: number): string {
  if (!Number.isFinite(r) || r <= 0) return "×0";
  return `×${r >= 100 ? Math.round(r) : trim(r.toFixed(1))}`;
}

export const TOOL_NAMES: Record<Tool, string> = { claude: "Claude Code", codex: "Codex CLI", gemini: "Gemini CLI" };
export const TOOL_SHORT: Record<Tool, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini" };
export const TOOLS: Tool[] = ["claude", "codex", "gemini"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

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

/** "26 Sep". */
export function formatDay(d: string): string {
  const x = parseDate(d);
  return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]}`;
}

/** "Sep 26" (tooltips, lists). */
export function formatMonthDay(d: string): string {
  const x = parseDate(d);
  return `${MONTHS[x.getUTCMonth()]} ${x.getUTCDate()}`;
}

/** "26 Sep 2026". */
export function formatDayYear(d: string): string {
  const x = parseDate(d);
  return `${x.getUTCDate()} ${MONTHS[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
}

/** "Friday 26 September". */
export function formatLongDate(d: string): string {
  const x = parseDate(d);
  return `${WEEKDAYS[x.getUTCDay()]} ${x.getUTCDate()} ${MONTHS_LONG[x.getUTCMonth()]}`;
}

export function weekdayShort(d: string): string {
  return WEEKDAYS[parseDate(d).getUTCDay()]!.slice(0, 3);
}

export function monthShort(d: string): string {
  return MONTHS[parseDate(d).getUTCMonth()]!;
}

export function monthName(i: number): string {
  return MONTHS_LONG[i] ?? "";
}

/** "Mar – Sep 2026" or "Oct 2025 – Sep 2026". */
export function formatRange(from: string, to: string): string {
  const a = parseDate(from);
  const b = parseDate(to);
  const sameYear = a.getUTCFullYear() === b.getUTCFullYear();
  if (sameYear && a.getUTCMonth() === b.getUTCMonth()) return `${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
  return sameYear
    ? `${MONTHS[a.getUTCMonth()]} – ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`
    : `${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()} – ${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`;
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

/** Rounds a goal to a friendly 1/2/5 × 10^n step (never below 10K). */
export function friendlyGoal(n: number): number {
  if (!(n > 0)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(n)));
  const m = n / p;
  const step = m < 1.5 ? 1 : m < 3.5 ? 2 : m < 7.5 ? 5 : 10;
  return Math.max(10_000, step * p);
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
