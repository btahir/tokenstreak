// Share cards, drawn entirely on canvas: the Trail engine renders the sky and
// ribbon offscreen, then text is set directly with the bundled fonts. No DOM
// snapshotting. Laid out at 540 px wide and rendered at 2× (1080 × 1080 or
// 1080 × 1920). Project names appear only when the user allowed them.

import type { AppSnapshot, DayRow, ShareCardData, Tool } from "../api/types";
import { bestRunIn, buildTrailRange, spanSummary, yearWindow } from "../lib/derive";
import { addDays, daysBetween, formatDayRange, formatInt, formatPercent, formatTokens, formatUsd, percentValue, TOOL_SHORT, TOOLS } from "../lib/format";
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
  /** Days the Trail spans (inclusive), and the span itself. */
  maxDays: number;
  trailRange: { from: string; to: string };
}

export const CARD_SIZE: Record<CardFormat, { w: number; h: number }> = { square: { w: 1080, h: 1080 }, story: { w: 1080, h: 1920 } };

/** Days of lead-in drawn before a streak on the streak card. */
export const STREAK_LEAD_IN = 10;

function sum(rows: DayRow[], f: (d: DayRow) => number): number {
  return rows.reduce((a, d) => a + f(d), 0);
}

function mixOf(rows: DayRow[]): { tool: Tool; share: number }[] {
  const tot = sum(rows, (d) => d.claude + d.codex + d.gemini) || 1;
  return TOOLS.map((tool) => ({ tool, share: sum(rows, (d) => d[tool]) / tot })).filter((m) => m.share >= 0.005);
}

/**
 * The cheapest 7-day window (cost per 1M): a full week (5+ active days) when
 * there is one, else any week with 3+ active days.
 */
export function leanestWeek(days: DayRow[], today: string, lookback = 180): { from: string; to: string; perM: number; tokens: number; cache: number; vsUsual: number } | null {
  return leanestWeekWith(days, today, lookback, 5) ?? leanestWeekWith(days, today, lookback, 3);
}

function leanestWeekWith(days: DayRow[], today: string, lookback: number, minActive: number): { from: string; to: string; perM: number; tokens: number; cache: number; vsUsual: number } | null {
  const rows = days.filter((d) => d.date > addDays(today, -lookback) && d.date <= today);
  let best: { from: string; to: string; perM: number; tokens: number; cache: number } | null = null;
  for (let i = 0; i + 7 <= rows.length; i++) {
    const w = rows.slice(i, i + 7);
    const tokens = sum(w, (d) => d.total);
    const active = w.filter((d) => d.total > 0).length;
    const cost = sum(w, (d) => d.cost);
    if (active < minActive || tokens <= 0 || cost <= 0) continue;
    const perM = cost / (tokens / 1e6);
    if (!best || perM < best.perM) best = { from: w[0]!.date, to: w[6]!.date, perM, tokens, cache: spanSummary(w, w[0]!.date, w[6]!.date).cacheShare };
  }
  if (!best) return null;
  const all = rows.filter((d) => d.total > 0);
  const usual = sum(all, (d) => d.cost) / (sum(all, (d) => d.total) / 1e6 || 1);
  return { ...best, vsUsual: usual > 0 ? (best.perM - usual) / usual : 0 };
}

/** The span the streak card describes: the current run, else the longest one. */
export function streakSpan(snap: AppSnapshot): { from: string; to: string; days: number; current: boolean } | null {
  const s = snap.streak;
  if (s.current > 0 && s.currentStart) return { from: s.currentStart, to: snap.today.date, days: s.current, current: true };
  if (s.longest > 0 && s.longestStart && s.longestEnd) return { from: s.longestStart, to: s.longestEnd, days: s.longest, current: false };
  return null;
}

const days1 = (n: number) => `${formatInt(n)} ${n === 1 ? "day" : "days"}`;

export function buildCardModel(snap: AppSnapshot, o: CardOptions, share: ShareCardData | null): CardModel {
  const today = snap.today.date;
  const days = snap.days;
  const story = o.format === "story";
  const rest = snap.streak.restDays;
  const span = (from: string, to: string) => ({ trail: buildTrailRange(snap, from, to, { restDays: rest }), maxDays: daysBetween(from, to) + 1, trailRange: { from, to } });
  let m: CardModel;
  if (o.template === "year") {
    const w = yearWindow(today);
    const y = spanSummary(days, w.from, w.to);
    const stats: [string, string][] = [
      ["Days lit", formatInt(y.daysLit)],
      ["Best streak", formatInt(bestRunIn(days, w.from, w.to, rest))],
      ["Busiest day", y.busiest ? formatTokens(y.busiest.total) : "—"],
      ["From cache", formatPercent(y.cacheShare)],
    ];
    if (o.showCost) stats.splice(2, 1, ["Est. cost", formatUsd(y.cost, { cents: false })]);
    m = {
      headline: "My year",
      subline: `in light · ${formatTokens(y.tokens)} tokens`,
      rangeLabel: "Last 365 days",
      stats,
      mix: mixOf(days.filter((d) => d.date >= w.from)),
      chip: null,
      projects: null,
      ...span(w.from, w.to),
    };
  } else if (o.template === "lean") {
    const lw = leanestWeek(days, today);
    const from = lw?.from ?? addDays(today, -6);
    const to = lw?.to ?? today;
    const wk = spanSummary(days, from, to);
    const leaner = lw ? Math.max(0, -lw.vsUsual) : 0;
    const money = o.showCost && lw;
    const stats: [string, string][] = money
      ? [
          ["From cache", formatPercent(wk.cacheShare)],
          ["Tokens", formatTokens(wk.tokens)],
          ["Est. cost", formatUsd(wk.cost)],
          ["Per 1M vs usual", `−${Math.round(leaner * 100)}%`],
        ]
      : [
          ["From cache", formatPercent(wk.cacheShare)],
          ["Tokens", formatTokens(wk.tokens)],
          lw && leaner >= 0.01 ? ["Per token vs usual", `−${Math.round(leaner * 100)}%`] : ["Active days", `${wk.activeDays} of 7`],
          ["Busiest day", wk.busiest ? formatTokens(wk.busiest.total) : "—"],
        ];
    // a "personal best" needs something to beat: about four weeks of history
    const firstActive = days.find((d) => d.total > 0)?.date ?? today;
    const enoughHistory = daysBetween(firstActive, today) >= 27;
    const pct = percentValue(wk.cacheShare);
    const [headline, subline] = !enoughHistory
      ? ["My week", `in light · ${pct}% from cache`]
      : money
        ? [formatUsd(lw.perM), "per million tokens, my leanest week yet"]
        : lw && leaner >= 0.01
          ? [`${Math.round(leaner * 100)}% leaner`, "per token than usual, my leanest week yet"]
          : [`${pct}%`, "from cache, my leanest week yet"];
    m = {
      headline,
      subline,
      rangeLabel: formatDayRange(from, to),
      stats,
      mix: mixOf(days.filter((d) => d.date >= from && d.date <= to)),
      chip: enoughHistory ? "Personal best · leanest week" : null,
      projects: null,
      ...span(from, to),
    };
  } else {
    const sp = streakSpan(snap);
    if (sp) {
      const st = spanSummary(days, sp.from, sp.to);
      const all: Record<string, [string, string]> = {
        tokens: ["Tokens", formatTokens(st.tokens)],
        lit: ["Days lit", formatInt(st.daysLit)],
        best: ["Best day", st.busiest ? formatTokens(st.busiest.total) : "—"],
        cache: ["From cache", formatPercent(st.cacheShare)],
        cost: ["Est. cost", formatUsd(st.cost, { cents: false })],
      };
      const keys = story ? ["tokens", "lit", "best", "cache"] : ["tokens", "best", "cache"];
      if (o.showCost) keys.splice(keys.indexOf("best"), 1, "cost");
      m = {
        headline: days1(sp.days),
        subline: sp.current ? (sp.days > 1 ? "of unbroken light" : "the first spark of a streak") : "my longest run of light",
        rangeLabel: formatDayRange(sp.from, sp.to),
        stats: keys.map((k) => all[k]!),
        mix: mixOf(days.filter((d) => d.date >= sp.from && d.date <= sp.to)),
        chip: null,
        projects: null,
        ...span(addDays(sp.from, -STREAK_LEAD_IN), sp.to),
      };
    } else {
      const from = addDays(today, -13);
      const st = spanSummary(days, from, today);
      m = {
        headline: "Day one",
        subline: "and the trail begins",
        rangeLabel: formatDayRange(from, today),
        stats: [
          ["Tokens", formatTokens(st.tokens)],
          ["Active days", formatInt(st.activeDays)],
          ["From cache", formatPercent(st.cacheShare)],
        ],
        mix: mixOf(days.filter((d) => d.date >= from)),
        chip: null,
        projects: null,
        ...span(from, today),
      };
    }
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
  const L: Partial<TrailLayout> =
    o.format === "story"
      ? // 9:16: the ribbon fills the band between the headline and the stats (which start near 0.71)
        { baseY: 0.6 + d * 0.5, amp: 0.1, rise: 0.1, headX: 0.84, headR: 22, maxDays, top: 0.45 + d, bottom: 0.68, wMax: 20 }
      : { baseY: 0.66 + d, amp: 0.08, rise: 0.12, headX: 0.86, maxDays, top: 0.46 + d * 1.4, bottom: 0.82 };
  if (maxDays <= 14) {
    // a week: one deliberate rising arc across the card instead of a tiny comet in a corner
    Object.assign(L, { left: 0.07, maxStep: 400, amp: 0.02, rise: 0.04, climb: o.format === "story" ? 0.12 : 0.15, wMax: o.format === "story" ? 22 : 20 });
    if (o.format === "square") L.baseY = 0.62 + d;
  }
  // the lean card is about efficiency, not the streak: every active day shines
  if (o.template === "lean") L.emphasizeAll = true;
  return L;
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

  const P = PAL[o.theme];
  const padX = 32;
  const story = o.format === "story";
  const dark = o.theme === "dark";

  // ---- layout first (measure only), so the sky can keep stars and hills away from text ----
  const hPx = fit(c, model.headline, (px) => `400 ${px}px ${SERIF}`, story ? 150 : 92, W - padX * 2);
  const hTop = story ? 30 + 22 + 70 : 30 + 22 + 26;
  const hBase = hTop + hPx * 0.8;
  const sPx = fit(c, model.subline, (px) => `italic 400 ${px}px ${SERIF}`, story ? 46 : 34, W - padX * 2);
  // the subline clears the headline's descenders ("My year" over "in light")
  const descends = /[gjpqy,;]/.test(model.headline);
  const sBase = hBase + (descends ? hPx * 0.2 + sPx * 0.38 : hPx * 0.06) + sPx * 0.74;
  const chipY = sBase + (story ? 24 : 16);
  const textBottom = model.chip ? chipY + 28 : sBase + sPx * 0.25;
  // text never sits on the ridge: the hills stay below the footer block
  const hillTop = story ? 0.946 : 0.957;
  const fPx = story ? 15.5 : 13;
  const footY = Math.round(H * hillTop) - (story ? 14 : 10);
  const mixY = story && model.mix.length ? footY - fPx - 12 : footY;
  let statsBottom = mixY - fPx - (story ? 30 : 18);
  const projectsY = statsBottom + 4;
  if (model.projects) statsBottom -= fPx + 14;
  const sLab = story ? 15.5 : 12.5;
  const sVal = story ? 60 : 36;
  const rowH = sLab + 10 + sVal * 0.82;
  const statsTop = story ? statsBottom - (rowH * 2 + 34) : statsBottom - sVal * 0.8 - 9 - sLab;

  // ---- sky + trail ----
  const tc = document.createElement("canvas");
  const base = trailLayout(o, model.maxDays, !!model.chip);
  const layout: Partial<TrailLayout> = {
    ...base,
    hillTop,
    // the ribbon lives between the headline block and the stats
    top: Math.max(base.top ?? 0, (textBottom + 18) / H),
    bottom: Math.min(base.bottom ?? 1, (statsTop - 20) / H),
    starFree: [
      { x: 0, y: 0, w: W, h: 64 },
      { x: padX - 6, y: hTop - 10, w: W - padX * 2 + 12, h: textBottom - hTop + 16 },
      { x: 0, y: statsTop - 12, w: W, h: H - statsTop + 12 },
    ],
  };
  const trail = new Trail(tc, { theme: o.theme, variant: "card", layout, seed: 7, size: { width: W, height: H, dpr: S }, reducedMotion: false });
  trail.setData(model.trail);
  trail.renderStill(3.4, 1.8);
  trail.destroy();
  c.drawImage(tc, 0, 0);

  // paper grain
  c.save();
  c.globalAlpha = dark ? 0.05 : 0.045;
  c.globalCompositeOperation = "overlay";
  c.fillStyle = c.createPattern(grain(), "repeat")!;
  c.fillRect(0, 0, out.width, out.height);
  c.restore();

  c.scale(S, S);
  c.textBaseline = "alphabetic";
  if (dark) {
    // dusk ground: a soft scrim so the stats and legend never sit on the bright horizon band
    const sg = c.createLinearGradient(0, statsTop - 50, 0, footY + 10);
    sg.addColorStop(0, "rgba(22,15,38,0)");
    sg.addColorStop(0.45, "rgba(22,15,38,0.38)");
    sg.addColorStop(1, "rgba(22,15,38,0.66)");
    c.fillStyle = sg;
    c.fillRect(0, statsTop - 50, W, H - statsTop + 50);
  }

  // header
  logo(c, padX, 30, 22);
  c.fillStyle = P.ink;
  c.font = `400 21px ${SERIF}`;
  c.fillText("Tokenstreak", padX + 30, 48);
  c.fillStyle = P.mut;
  c.font = `500 ${story ? 15 : 13}px ${SANS}`;
  c.textAlign = "right";
  c.fillText(model.rangeLabel, W - padX, 46);
  c.textAlign = "left";

  // headline
  c.fillStyle = P.ink;
  c.font = `400 ${hPx}px ${SERIF}`;
  (c as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = `${-0.025 * hPx}px`;
  c.fillText(model.headline, padX - hPx * 0.02, hBase);
  (c as CanvasRenderingContext2D & { letterSpacing?: string }).letterSpacing = "0px";
  c.fillStyle = P.mut;
  c.font = `italic 400 ${sPx}px ${SERIF}`;
  c.fillText(model.subline, padX, sBase);

  // chip (lean)
  if (model.chip) {
    c.font = `600 12px ${SANS}`;
    const tw = c.measureText(model.chip).width;
    const cy = chipY;
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

  // footer: at least ~26 px at 1080 wide (square), ~31 px (story)
  const g = fPx * 0.78;
  c.font = `500 ${fPx}px ${SANS}`;
  let fx = padX;
  for (const mx of model.mix) {
    const label = `${TOOL_SHORT[mx.tool]} ${Math.round(mx.share * 100)}%`;
    c.fillStyle = TOOL_COL[mx.tool];
    const gy = mixY - fPx * 0.35;
    c.beginPath();
    if (mx.tool === "claude") c.arc(fx + g / 2, gy, g / 2, 0, 7);
    else if (mx.tool === "codex") c.roundRect(fx, gy - g / 2, g, g, g * 0.28);
    else {
      c.moveTo(fx + g / 2, gy - g * 0.55);
      c.lineTo(fx + g * 1.05, gy + g / 2);
      c.lineTo(fx - g * 0.05, gy + g / 2);
      c.closePath();
    }
    c.fill();
    // a thin ink ring keeps every swatch visible on the warm horizon (AA non-text contrast)
    c.strokeStyle = dark ? "rgba(255,244,234,0.7)" : "rgba(35,29,51,0.55)";
    c.lineWidth = 1;
    c.stroke();
    c.fillStyle = P.mut;
    c.fillText(label, fx + g + 5, mixY);
    fx += g + 5 + c.measureText(label).width + fPx;
  }
  c.fillStyle = P.mut;
  if (story) c.fillText("tokenstreak · free & open source", padX, footY);
  else {
    const long = "tokenstreak · free & open source";
    const credit = fx + c.measureText(long).width + 8 <= W - padX ? long : "tokenstreak";
    c.textAlign = "right";
    c.fillText(credit, W - padX, footY);
    c.textAlign = "left";
  }

  // projects line (only when allowed)
  if (model.projects) {
    c.font = `500 ${fPx}px ${SANS}`;
    c.fillStyle = P.mut;
    c.fillText(`Built: ${model.projects.join(" · ")}`, padX, projectsY);
  }

  // stats: frameless serif numerals
  if (story) {
    const lPx = 15.5;
    const vPx = 60;
    const rowH = lPx + 10 + vPx * 0.82;
    const gap = 34;
    const gw = W - padX * 2;
    const top = statsBottom - (rowH * 2 + gap);
    model.stats.slice(0, 4).forEach(([lab, val], i) => {
      const col = i % 2;
      const row = Math.floor(i / 2);
      const x = padX + col * (gw / 2 + 8);
      const y = top + row * (rowH + gap);
      c.fillStyle = P.mut;
      c.font = `500 ${lPx}px ${SANS}`;
      c.fillText(lab, x, y + lPx);
      c.fillStyle = P.ink;
      const vp = fit(c, val, (px) => `400 ${px}px ${SERIF}`, vPx, gw / 2 - 16);
      c.font = `400 ${vp}px ${SERIF}`;
      c.fillText(val, x, y + lPx + 10 + vPx * 0.82);
    });
  } else {
    let x = padX;
    const valBase = statsBottom;
    const lPx = 12.5;
    for (const [lab, val] of model.stats) {
      c.font = `400 36px ${SERIF}`;
      const vw = c.measureText(val).width;
      c.font = `500 ${lPx}px ${SANS}`;
      const lw = c.measureText(lab).width;
      c.fillStyle = P.mut;
      c.fillText(lab, x, valBase - 36 * 0.8 - 9);
      c.fillStyle = P.ink;
      c.font = `400 36px ${SERIF}`;
      c.fillText(val, x, valBase);
      x += Math.max(vw, lw) + 28;
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
