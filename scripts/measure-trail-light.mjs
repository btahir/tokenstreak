#!/usr/bin/env node
// Lightness profile of the light-theme Trail history (round-3 acceptance): on the
// first dashboard after onboarding, sample vertical CIELAB L* profiles through
// goal-day history and report peak L*, plateau width and edge falloff (CSS px),
// in Chromium and WebKit. Mock data only.
//
//   node scripts/measure-trail-light.mjs [--url http://127.0.0.1:5173]
import { chromium, webkit } from "playwright";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg("--url", "http://127.0.0.1:5173");

/** Runs in the page: profiles through history on the full Trail canvas. */
export const PROFILE_FN = `(() => {
  const canvas = document.querySelector('[data-testid="trail-full"]');
  const t = (window.__trails || []).find((x) => x.canvas === canvas);
  const g = t.geometry();
  const dpr = canvas.width / canvas.clientWidth;
  const ctx = canvas.getContext("2d");
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const Lstar = (r, g2, b) => { const Y = 0.2126 * lin(r) + 0.7152 * lin(g2) + 0.0722 * lin(b); return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y; };
  const pts = g.points.filter((p, i) => p.role !== "gap" && p.hw > 0.95 && p.gw > 0.95 && p.wd > 5 && i > 0 && i < g.points.length - 1
    && g.points[i - 1].role !== "gap" && g.points[i + 1].role !== "gap");
  const out = [];
  for (const p of pts) {
    const x = Math.round(p.x * dpr);
    const y0 = Math.round((p.y - 40) * dpr);
    const hgt = Math.round(80 * dpr);
    const d = ctx.getImageData(x, y0, 1, hgt).data;
    const raw = [];
    for (let i = 0; i < hgt; i++) raw.push(Lstar(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]));
    // one-device-pixel box filter: Skia dithers gradients (alternating +-1 L*), CoreGraphics doesn't
    const L = raw.map((v, i) => (raw[Math.max(0, i - 1)] + v + raw[Math.min(raw.length - 1, i + 1)]) / 3);
    const sky = (L.slice(0, 6).reduce((a, b) => a + b, 0) + L.slice(-6).reduce((a, b) => a + b, 0)) / 12;
    let pk = 0;
    for (let i = 1; i < L.length; i++) if (L[i] > L[pk]) pk = i;
    const max = L[pk];
    // plateau: contiguous samples within 0.5 L* of the peak
    let a = pk, b = pk;
    while (a > 0 && L[a - 1] >= max - 0.5) a--;
    while (b < L.length - 1 && L[b + 1] >= max - 0.5) b++;
    // edge falloff on each side: the 10-90% width of the step from the ribbon's body (its
    // darkest point) to its outer edge, just inside where the bloom begins
    const side = (dir) => {
      const reach = Math.round(p.wd * 0.78 * dpr);
      let v = pk;
      for (let i = pk; Math.abs(i - pk) <= reach && i >= 0 && i < L.length; i += dir) if (L[i] < L[v]) v = i;
      const outer = L[Math.max(0, Math.min(L.length - 1, pk + dir * reach))];
      const span = outer - L[v];
      if (span < 1) return 0;
      // sub-sample crossing positions (linear interpolation between samples)
      const cross = (frac) => {
        const th = L[v] + frac * span;
        let j = v;
        while (j + dir >= 0 && j + dir < L.length && L[j + dir] < th) j += dir;
        const a = L[j], b = L[j + dir] ?? a;
        return j + dir * (b === a ? 0 : (th - a) / (b - a));
      };
      return Math.abs(cross(0.9) - cross(0.1)) / dpr;
    };
    out.push({ x: p.x, peak: max, sky, plateau: (b - a + 1) / dpr, falloffUp: side(-1), falloffDown: side(1) });
  }
  return out;
})()`;

export function summarize(rows) {
  const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
  return {
    n: rows.length,
    peakL: +med(rows.map((r) => r.peak)).toFixed(1),
    skyL: +med(rows.map((r) => r.sky)).toFixed(1),
    plateauPx: +med(rows.map((r) => r.plateau)).toFixed(1),
    falloffPx: +med(rows.map((r) => Math.min(r.falloffUp, r.falloffDown))).toFixed(2),
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const res = {};
  for (const [name, eng] of [["chromium", chromium], ["webkit", webkit]]) {
    const b = await eng.launch();
    const page = await (await b.newContext({ colorScheme: "light", deviceScaleFactor: 2 })).newPage();
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.goto(`${base}/?view=dashboard&preset=first-run-reveal&step=3&theme=light&devtools=0&live=0`);
    await page.getByTestId("onb-start").click();
    await page.getByTestId("hero").waitFor();
    await page.waitForTimeout(1500);
    res[name] = summarize(await page.evaluate(PROFILE_FN));
    await b.close();
  }
  const diff = (k) => Math.abs(res.chromium[k] - res.webkit[k]) / Math.max(1e-9, Math.abs(res.chromium[k]));
  console.log(JSON.stringify({ ...res, enginesDiff: { peakL: +(diff("peakL") * 100).toFixed(1) + "%", falloffPx: +(diff("falloffPx") * 100).toFixed(1) + "%" } }, null, 1));
}
