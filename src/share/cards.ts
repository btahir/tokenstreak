// Share cards, drawn entirely on canvas: the Trail engine renders the sky and
// ribbon offscreen, then text is set directly with the bundled fonts. No DOM
// snapshotting. Laid out at 540 px wide and rendered at 2× (1080 × 1080 or
// 1080 × 1920). Project names appear only when the user allowed them.

import type { AppSnapshot, DayRow, ShareCardData, Tool } from "../api/types";
import { buildTrailData } from "../lib/derive";
import { addDays, formatPercent, formatRange, formatTokens, formatUsd, parseDate, TOOL_SHORT, TOOLS } from "../lib/format";
import { Trail } from "../trail/Trail";
import type { TrailData, TrailLayout } from "../trail/types";

export type CardTemplate = "streak" | "year" | "lean";
export type CardFormat = "square" | "story";
export type CardTheme = "light" | "dark";

export interface CardOptions {
  template: CardTemplate;
  format: CardFormat;
  theme: CardTheme;
  showMix: boolean;
  showCost: boolean;
  showProjects: boolean;
}

export interface CardModel {
  headline: string;
  subline: string;
  rangeLabel: string;
  stats: [string, string][];
  mix: { tool: Tool; share: number }[];
  chip: string | null;
  projects: string[] | null;
  trail: TrailData;
  maxDays: number;
}

export const CARD_SIZE: Record<CardFormat, { w: number; h: number }> = { square: { w: 1080, h: 1080 }, story: { w: 1080, h: 1920 } };

function sum(rows: DayRow[], f: (d: DayRow) => number): number {
  return rows.reduce((a, d) => a + f(d), 0);
}

function mixOf(rows: DayRow[]): { tool: Tool; share: number }[] {
  const tot = sum(rows, (d) => d.claude + d.codex + d.gemini) || 1;
  return TOOLS.map((tool) => ({ tool, share: sum(rows, (d) => d[tool]) / tot })).filter((m) => m.share >= 0.005);
}

function cacheOf(rows: DayRow[]): number {
  const t = sum(rows, (d) => d.total);
  return t ? sum(rows, (d) => d.cacheRead) / t : 0;
}

function bestRun(rows: DayRow[]): number {
  return rows.reduce((b, d) => Math.max(b, d.streak), 0);
}

/** The cheapest 7-day window (cost per 1M) with at least 3 active days. */
export function leanestWeek(days: DayRow[], today: string, lookback = 180): { from: string; to: string; perM: number; tokens: number; cache: number; vsUsual: number } | null {
  const rows = days.filter((d) => d.date > addDays(today, -lookback) && d.date <= today);
  let best: { from: string; to: string; perM: number; tokens: number; cache: number } | null = null;
  for (let i = 0; i + 7 <= rows.length; i++) {
    const w = rows.slice(i, i + 7);
    const tokens = sum(w, (d) => d.total);
    const active = w.filter((d) => d.total > 0).length;
    const cost = sum(w, (d) => d.cost);
    if (active < 3 || tokens <= 0 || cost <= 0) continue;
    const perM = cost / (tokens / 1e6);
    if (!best || perM < best.perM) best = { from: w[0]!.date, to: w[6]!.date, perM, tokens, cache: cacheOf(w) };
  }
  if (!best) return null;
  const all = rows.filter((d) => d.total > 0);
  const usual = sum(all, (d) => d.cost) / (sum(all, (d) => d.total) / 1e6 || 1);
  return { ...best, vsUsual: usual > 0 ? (best.perM - usual) / usual : 0 };
}

export function buildCardModel(snap: AppSnapshot, o: CardOptions, share: ShareCardData | null): CardModel {
  const today = snap.today.date;
  const days = snap.days;
  const story = o.format === "story";
  const trailBase = (maxDays: number) => buildTrailData(snap, { maxDays });
  let m: CardModel;
  if (o.template === "year") {
    const from = addDays(today, -364);
    const rows = days.filter((d) => d.date >= from);
    const tokens = sum(rows, (d) => d.total);
    const busiest = rows.reduce<DayRow | null>((b, d) => (!b || d.total > b.total ? d : b), null);
    const first = rows.find((d) => d.total > 0)?.date ?? from;
    const stats: [string, string][] = [
      ["Days lit", String(rows.filter((d) => d.met).length)],
      ["Best streak", String(Math.max(bestRun(rows), 0))],
      ["Busiest day", busiest ? formatTokens(busiest.total) : "—"],
      ["From cache", formatPercent(cacheOf(rows))],
    ];
    if (o.showCost) stats.splice(2, 1, ["Est. cost", formatUsd(sum(rows, (d) => d.cost), { cents: false })]);
    m = {
      headline: String(parseDate(today).getUTCFullYear()),
      subline: `in light · ${formatTokens(tokens)} tokens`,
      rangeLabel: formatRange(first, today),
      stats,
      mix: mixOf(rows),
      chip: null,
      projects: null,
      trail: trailBase(365),
      maxDays: 365,
    };
  } else if (o.template === "lean") {
    const lw = leanestWeek(days, today);
    const rows = lw ? days.filter((d) => d.date >= lw.from && d.date <= lw.to) : days.slice(-7);
    const perM = lw?.perM ?? 0;
    const stats: [string, string][] = [
      ["From cache", formatPercent(lw?.cache ?? cacheOf(rows))],
      ["vs usual", lw ? `${lw.vsUsual <= 0 ? "−" : "+"}${Math.round(Math.abs(lw.vsUsual) * 100)}%` : "—"],
      ["Tokens", formatTokens(lw?.tokens ?? sum(rows, (d) => d.total))],
      ["Streak", String(snap.streak.current)],
    ];
    if (o.showCost) stats.splice(3, 1, ["Est. cost", formatUsd(sum(rows, (d) => d.cost))]);
    m = {
      headline: formatUsd(perM),
      subline: "per million tokens, my leanest week yet",
      rangeLabel: lw ? formatRange(lw.from, lw.to) : formatRange(addDays(today, -6), today),
      stats,
      mix: mixOf(rows),
      chip: "Personal best · leanest week",
      projects: null,
      trail: trailBase(60),
      maxDays: 60,
    };
  } else {
    const n = snap.streak.current;
    const longest = snap.streak.longest;
    const first = days.find((d) => d.total > 0)?.date ?? today;
    const from = first > addDays(today, -179) ? first : addDays(today, -179);
    const rows = days.filter((d) => d.date >= from);
    const lit = rows.filter((d) => d.met).length;
    const stats: [string, string][] = [
      ["Tokens", formatTokens(sum(rows, (d) => d.total))],
      ["Days lit", String(lit)],
      ["From cache", formatPercent(cacheOf(rows))],
      ["Best streak", String(longest)],
    ];
    if (o.showCost) stats.splice(3, 1, ["Est. cost", formatUsd(sum(rows, (d) => d.cost), { cents: false })]);
    const showing = n > 0 ? n : longest;
    m = {
      headline: `${showing} ${showing === 1 ? "day" : "days"}`,
      subline: n > 1 ? "of unbroken light" : n === 1 ? "the first spark of a streak" : longest > 0 ? "my longest run of light" : "and the trail begins",
      rangeLabel: formatRange(from, today),
      stats,
      mix: mixOf(rows),
      chip: null,
      projects: null,
      trail: trailBase(48),
      maxDays: 48,
    };
  }
  if (!story) m.stats = m.stats.slice(0, 3);
  if (!o.showMix) m.mix = [];
  m.projects = o.showProjects && share?.topProjects?.length ? share.topProjects.slice(0, 3) : null;
  return m;
}

/* ---------------- rendering ---------------- */

const SERIF = "'Instrument Serif', 'New York', Georgia, serif";
const SANS = "'Geist Variable', Geist, -apple-system, system-ui, sans-serif";

export async function ensureCardFonts(): Promise<void> {
  if (!("fonts" in document)) return;
  await Promise.all([
    document.fonts.load(`400 92px ${SERIF}`),
    document.fonts.load(`italic 400 34px ${SERIF}`),
    document.fonts.load(`500 12px ${SANS}`),
    document.fonts.load(`600 12px ${SANS}`),
  ]).catch(() => undefined);
}

interface Palette {
  ink: string;
  mut: string;
  pill: string;
  line: string;
}

const PAL: Record<CardTheme, Palette> = {
  light: { ink: "#231D33", mut: "rgba(35,29,51,0.62)", pill: "rgba(255,255,255,0.62)", line: "rgba(35,29,51,0.08)" },
  dark: { ink: "#FFF4EA", mut: "rgba(255,244,234,0.68)", pill: "rgba(255,255,255,0.12)", line: "rgba(255,255,255,0.14)" },
};

const TOOL_COL: Record<Tool, string> = { claude: "#F7995A", codex: "#EC5F80", gemini: "#8B6CF0" };

function trailLayout(o: CardOptions, maxDays: number, chip: boolean): Partial<TrailLayout> {
  // cards with a chip under the headline push the trail a little lower
  const d = chip ? 0.05 : 0;
  return o.format === "story"
    ? { baseY: 0.6 + d, amp: 0.12, rise: 0.22, headX: 0.84, headR: 22, maxDays, top: 0.38 + d, bottom: 0.74 }
    : { baseY: 0.66 + d, amp: 0.08, rise: 0.12, headX: 0.86, maxDays, top: 0.46 + d * 1.4, bottom: 0.82 };
}

function logo(c: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  const k = s / 32;
  c.save();
  c.translate(x, y);
  c.scale(k, k);
  const g = c.createLinearGradient(3, 25, 25, 7);
  g.addColorStop(0, "#8B6CF0");
  g.addColorStop(0.55, "#F0728C");
  g.addColorStop(1, "#FFB27A");
  c.strokeStyle = g;
  c.lineWidth = 3.6;
  c.lineCap = "round";
  c.beginPath();
  c.moveTo(3, 25);
  c.bezierCurveTo(9, 24, 12, 20, 15, 15);
  c.bezierCurveTo(18, 10, 21, 7, 25, 7);
  c.stroke();
  c.fillStyle = "#FFF3E0";
  c.beginPath();
  c.arc(25, 7, 4.6, 0, 7);
  c.fill();
  c.strokeStyle = "#FFB27A";
  c.lineWidth = 1.4;
  c.stroke();
  c.restore();
}

function spark(c: CanvasRenderingContext2D, x: number, y: number, r: number, col: string): void {
  const k = r * 0.14;
  c.fillStyle = col;
  c.beginPath();
  c.moveTo(x, y - r);
  c.quadraticCurveTo(x + k, y - k, x + r, y);
  c.quadraticCurveTo(x + k, y + k, x, y + r);
  c.quadraticCurveTo(x - k, y + k, x - r, y);
  c.quadraticCurveTo(x - k, y - k, x, y - r);
  c.fill();
}

function roundRect(c: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

let grainTile: HTMLCanvasElement | null = null;
function grain(): HTMLCanvasElement {
  if (grainTile) return grainTile;
  const t = document.createElement("canvas");
  t.width = t.height = 256;
  const c = t.getContext("2d")!;
  const img = c.createImageData(256, 256);
  let s = 1234567;
  for (let i = 0; i < img.data.length; i += 4) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const v = (s >> 16) & 0xff;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
    img.data[i + 3] = 255;
  }
  c.putImageData(img, 0, 0);
  grainTile = t;
  return t;
}

/** Fits a font size so `text` is at most `max` wide. */
function fit(c: CanvasRenderingContext2D, text: string, font: (px: number) => string, px: number, max: number): number {
  c.font = font(px);
  const w = c.measureText(text).width;
  return w > max ? Math.floor((px * max) / w) : px;
}

/** Renders a card to a new canvas of the export size (1080 wide). */
export async function renderCard(model: CardModel, o: CardOptions): Promise<HTMLCanvasElement> {
  await ensureCardFonts();
  const W = 540;
  const H = o.format === "story" ? 960 : 540;
  const S = 2;
  const out = document.createElement("canvas");
  out.width = W * S;
  out.height = H * S;
  const c = out.getContext("2d")!;

  // sky + trail
  const tc = document.createElement("canvas");
  const trail = new Trail(tc, { theme: o.theme, variant: "card", layout: trailLayout(o, model.maxDays, !!model.chip), seed: 7, size: { width: W, height: H, dpr: S }, reducedMotion: false });
  trail.setData(model.trail);
  trail.renderStill(3.4, 1.8);
  trail.destroy();
  c.drawImage(tc, 0, 0);

  // paper grain
  c.save();
  c.globalAlpha = o.theme === "dark" ? 0.05 : 0.045;
  c.globalCompositeOperation = "overlay";
  c.fillStyle = c.createPattern(grain(), "repeat")!;
  c.fillRect(0, 0, out.width, out.height);
  c.restore();

  c.scale(S, S);
  const P = PAL[o.theme];
  const padX = 32;
  const story = o.format === "story";
  c.textBaseline = "alphabetic";

  // header
  logo(c, padX, 30, 22);
  c.fillStyle = P.ink;
  c.font = `400 21px ${SERIF}`;
  c.fillText("Tokenstreak", padX + 30, 48);
  c.fillStyle = P.mut;
  c.font = `500 12.5px ${SANS}`;
  c.textAlign = "right";
  c.fillText(model.rangeLabel, W - padX, 46);
  c.textAlign = "left";

  // headline
  const hPx = fit(c, model.headline, (px) => `400 ${px}px ${SERIF}`, story ? 150 : 92, W - padX * 2);
  const hTop = story ? 30 + 22 + 70 : 30 + 22 + 26;
  const hBase = hTop + hPx * 0.8;
  c.fillStyle = P.ink;
  c.font = `400 ${hPx}px ${SERIF}`;
  (c as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${-0.025 * hPx}px`;
  c.fillText(model.headline, padX - hPx * 0.02, hBase);
  (c as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";
  const sPx = fit(c, model.subline, (px) => `italic 400 ${px}px ${SERIF}`, story ? 46 : 34, W - padX * 2);
  const sBase = hBase + (story ? 16 : 10) + sPx * 1.0;
  c.fillStyle = P.mut;
  c.font = `italic 400 ${sPx}px ${SERIF}`;
  c.fillText(model.subline, padX, sBase);

  // chip (lean)
  if (model.chip) {
    c.font = `600 12px ${SANS}`;
    const tw = c.measureText(model.chip).width;
    const cy = sBase + (story ? 24 : 16);
    const ch = 28;
    const cw = tw + 22 + 18;
    c.fillStyle = P.pill;
    roundRect(c, padX, cy, cw, ch, 14);
    c.fill();
    c.strokeStyle = P.line;
    c.lineWidth = 1;
    c.stroke();
    spark(c, padX + 16, cy + ch / 2, 6, "#A9D8F5");
    c.fillStyle = P.ink;
    c.fillText(model.chip, padX + 28, cy + ch / 2 + 4.2);
  }

  // footer
  const footY = H - 28 - 3;
  c.font = `500 11.5px ${SANS}`;
  let fx = padX;
  for (const mx of model.mix) {
    const label = `${TOOL_SHORT[mx.tool]} ${Math.round(mx.share * 100)}%`;
    c.fillStyle = TOOL_COL[mx.tool];
    const gy = footY - 4;
    if (mx.tool === "claude") {
      c.beginPath();
      c.arc(fx + 4.5, gy, 4.5, 0, 7);
      c.fill();
    } else if (mx.tool === "codex") {
      roundRect(c, fx, gy - 4.5, 9, 9, 2.5);
      c.fill();
    } else {
      c.beginPath();
      c.moveTo(fx + 4.5, gy - 5);
      c.lineTo(fx + 9.5, gy + 4.5);
      c.lineTo(fx - 0.5, gy + 4.5);
      c.closePath();
      c.fill();
    }
    c.fillStyle = P.mut;
    c.fillText(label, fx + 14, footY);
    fx += 14 + c.measureText(label).width + 12;
  }
  c.textAlign = "right";
  c.fillStyle = P.mut;
  c.fillText("tokenstreak · free & open source", W - padX, footY);
  c.textAlign = "left";

  // projects line (only when allowed)
  let statsBottom = footY - 11.5 - 18;
  if (model.projects) {
    c.font = `500 11.5px ${SANS}`;
    c.fillStyle = P.mut;
    c.fillText(`Built: ${model.projects.join(" · ")}`, padX, statsBottom + 4);
    statsBottom -= 22;
  }

  // stats
  if (story) {
    const gh = 2 * (11.5 + 6 + 46) + 22 + 44;
    const gy = statsBottom - gh;
    const gw = W - padX * 2;
    c.save();
    c.fillStyle = P.pill;
    roundRect(c, padX, gy, gw, gh, 24);
    c.fill();
    c.strokeStyle = P.line;
    c.lineWidth = 1;
    c.stroke();
    c.restore();
    model.stats.slice(0, 4).forEach(([lab, val], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = padX + 24 + col * ((gw - 48 - 26) / 2 + 26);
      const y = gy + 22 + row * (11.5 + 6 + 46 + 22);
      c.fillStyle = P.mut;
      c.font = `500 11.5px ${SANS}`;
      c.fillText(lab, x, y + 11);
      c.fillStyle = P.ink;
      c.font = `400 46px ${SERIF}`;
      c.fillText(val, x, y + 11.5 + 6 + 38);
    });
  } else {
    let x = padX;
    const valBase = statsBottom;
    for (const [lab, val] of model.stats) {
      c.font = `400 34px ${SERIF}`;
      const vw = c.measureText(val).width;
      c.font = `500 11.5px ${SANS}`;
      const lw = c.measureText(lab).width;
      c.fillStyle = P.mut;
      c.fillText(lab, x, valBase - 34 * 0.8 - 8);
      c.fillStyle = P.ink;
      c.font = `400 34px ${SERIF}`;
      c.fillText(val, x, valBase);
      x += Math.max(vw, lw) + 26;
    }
  }
  return out;
}

export function cardFileName(o: CardOptions): string {
  const s = CARD_SIZE[o.format];
  return `tokenstreak-${o.template}-${s.w}x${s.h}-${o.theme}.png`;
}

export function canvasToBase64(c: HTMLCanvasElement): string {
  return c.toDataURL("image/png").split(",")[1] ?? "";
}

/** Copies a canvas to the clipboard as PNG. Resolves false where unsupported. */
export async function copyCanvas(c: HTMLCanvasElement): Promise<boolean> {
  try {
    if (!("ClipboardItem" in window) || !navigator.clipboard?.write) return false;
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, "image/png"));
    if (!blob) return false;
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
    return true;
  } catch {
    return false;
  }
}
