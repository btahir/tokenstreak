// The Trail in a real engine: HUD safe zones, label collisions, level of
// detail, tooltip placement, the reveal counter and the goal moment.
import { expect, test, type Page } from "@playwright/test";
import { mock, url, watchConsole } from "./helpers";

type Geo = {
  head: { x: number; y: number };
  points: { x: number; y: number; wd: number; role: string }[];
  labels: { m: number; visible: boolean; x: number; y: number }[];
  lod: number;
};
type Box = { x: number; y: number; w: number; h: number };

/** Trail geometry plus the HUD rectangles, both relative to the canvas. */
async function layoutOf(page: Page, testId: string): Promise<{ geo: Geo; rects: Box[] }> {
  await page.waitForFunction(() => ((window as unknown as { __trails?: { geometry: () => Geo }[] }).__trails ?? []).some((t) => t.geometry().points.length > 0));
  // let the HUD measurement settle (fonts, rAF debounce)
  await page.waitForTimeout(500);
  return page.evaluate((id) => {
    const canvas = document.querySelector<HTMLCanvasElement>(`[data-testid="${id}"]`)!;
    const trails = (window as unknown as { __trails: { canvas: HTMLCanvasElement; geometry: () => Geo }[] }).__trails;
    const t = trails.find((x) => x.canvas === canvas)!;
    const cr = canvas.getBoundingClientRect();
    const rects: Box[] = [];
    canvas.parentElement!.querySelectorAll<HTMLElement>("[data-trail-avoid]").forEach((el) => {
      const els = el.dataset.trailAvoid === "children" ? Array.from(el.children) : [el];
      for (const e of els) {
        const r = e.getBoundingClientRect();
        if (r.width && r.height) rects.push({ x: r.left - cr.left, y: r.top - cr.top, w: r.width, h: r.height });
      }
    });
    return { geo: t.geometry(), rects };
  }, testId);
}

function expectClear(geo: Geo, rects: Box[]) {
  const hits: string[] = [];
  for (const p of geo.points) {
    if (p.role === "gap") continue;
    const half = Math.max(1, p.wd * 0.55);
    for (const r of rects)
      if (p.x >= r.x && p.x <= r.x + r.w && p.y + half > r.y + 2 && p.y - half < r.y + r.h - 2) hits.push(`${p.role} @${Math.round(p.x)},${Math.round(p.y)} in ${JSON.stringify(r)}`);
  }
  expect(hits, hits.slice(0, 5).join("\n")).toEqual([]);
}

for (const [preset, range] of [
  ["heavy-multi-tool", "Week"],
  ["heavy-multi-tool", "Year"],
  ["long-history", "All"],
  ["streak-at-risk", "Month"],
] as const) {
  test(`dashboard hero (${preset}, ${range}): the ribbon never runs under the HUD`, async ({ page }) => {
    const con = watchConsole(page);
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.goto(url({ view: "dashboard", preset, theme: "dark" }));
    await mock(page);
    if (range !== "Year") await page.getByRole("radio", { name: range, exact: true }).click();
    const { geo, rects } = await layoutOf(page, "trail-full");
    expect(rects.length).toBeGreaterThanOrEqual(4); // label, number, pills, tier chip, legend
    expectClear(geo, rects);
    // milestone labels: never overlapping each other or a chip
    const vis = geo.labels.filter((l) => l.visible);
    for (let i = 0; i < vis.length; i++)
      for (let j = i + 1; j < vis.length; j++) expect(Math.hypot(vis[i]!.x - vis[j]!.x, vis[i]!.y - vis[j]!.y)).toBeGreaterThanOrEqual(56);
    for (const l of vis) for (const r of rects) expect(l.x > r.x - 4 && l.x < r.x + r.w + 4 && l.y > r.y - 4 && l.y < r.y + r.h + 4).toBe(false);
    con.assertClean();
  });
}

test("dashboard hero at the minimum window width keeps labels apart", async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 620 });
  await page.goto(url({ view: "dashboard", preset: "long-history", theme: "light" }));
  await mock(page);
  await page.getByRole("radio", { name: "All", exact: true }).click();
  const { geo, rects } = await layoutOf(page, "trail-full");
  expectClear(geo, rects);
  const vis = geo.labels.filter((l) => l.visible);
  for (let i = 0; i < vis.length; i++) for (let j = i + 1; j < vis.length; j++) expect(Math.hypot(vis[i]!.x - vis[j]!.x, vis[i]!.y - vis[j]!.y)).toBeGreaterThanOrEqual(56);
});

test("3+ years in the All range: history compressed and smooth, the current run keeps a quarter of the width", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(url({ view: "dashboard", preset: "long-history" }));
  await mock(page);
  await page.getByRole("radio", { name: "All", exact: true }).click();
  const { geo } = await layoutOf(page, "trail-full");
  expect(geo.points.length).toBeLessThan(400);
  const pts = geo.points;
  let worst = 0;
  for (let i = 1; i < pts.length; i++) worst = Math.max(worst, Math.abs(pts[i]!.y - pts[i - 1]!.y) / Math.max(1, pts[i]!.x - pts[i - 1]!.x));
  expect(worst).toBeLessThan(1.2);
  const width = await page.getByTestId("trail-full").evaluate((c) => c.clientWidth);
  const firstCur = pts.find((p) => p.role === "current")!;
  expect((geo.head.x - firstCur.x) / width).toBeGreaterThan(0.2);
  await expect(page.getByTestId("trail-legend-note")).toContainText("older history compressed");
});

test("zero days are visible breaks at 40-120 visible days, and the legend says so", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(url({ view: "dashboard", preset: "streak-30" }));
  await mock(page);
  const { geo } = await layoutOf(page, "trail-full");
  const gaps = geo.points.filter((p) => p.role === "gap");
  expect(gaps.length).toBeGreaterThan(5);
  await expect(page.getByTestId("trail-legend-note")).toContainText("gaps = days off");
  // history days with tokens are part of the ribbon: at least 2.5 px wide
  for (const p of geo.points) if (p.role !== "gap") expect(p.wd).toBeGreaterThanOrEqual(2.4);
});

test("the tooltip dates the current streak from its real start", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(url({ view: "dashboard", preset: "heavy-multi-tool" }));
  await mock(page);
  const start = await page.evaluate(() => (window as unknown as { __tokenstreakMock: { snapshot: () => { streak: { currentStart: string } } } }).__tokenstreakMock.snapshot().streak.currentStart);
  await page.getByTestId("trail-full").focus();
  await page.keyboard.press("End");
  const tip = page.getByTestId("trail-tip-run");
  await expect(tip).toBeVisible();
  const label = await page.evaluate((d) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${d}T12:00:00Z`)), start);
  await expect(tip).toContainText(label);
});

for (const preset of ["streak-at-risk", "heavy-multi-tool", "sparse", "goal-hit"]) {
  test(`popover (${preset}): the ribbon clears the hero number, pill and top bar`, async ({ page }) => {
    await page.setViewportSize({ width: 380, height: 700 });
    await page.goto(url({ view: "popover", preset, theme: "light" }));
    await mock(page);
    const { geo, rects } = await layoutOf(page, "trail-popover");
    expect(rects.length).toBeGreaterThanOrEqual(3);
    expectClear(geo, rects);
  });
}

test("trail tooltip stays inside the hero: flips below near the top, clamps at the edges", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(url({ view: "dashboard", preset: "heavy-multi-tool" }));
  await mock(page);
  const canvas = page.getByTestId("trail-full");
  const hero = await page.getByTestId("hero").boundingBox();
  const box = (await canvas.boundingBox())!;
  for (const fx of [0.01, 0.5, 0.99]) {
    await page.mouse.move(box.x + box.width * fx, box.y + 30);
    const tip = page.getByTestId("trail-tip");
    await expect(tip).toBeVisible();
    await page.waitForTimeout(150);
    const t = (await tip.boundingBox())!;
    expect(t.x).toBeGreaterThanOrEqual(hero!.x);
    expect(t.x + t.width).toBeLessThanOrEqual(hero!.x + hero!.width + 0.5);
    expect(t.y).toBeGreaterThanOrEqual(hero!.y);
    expect(t.y + t.height).toBeLessThanOrEqual(hero!.y + hero!.height + 0.5);
  }
});

test("hovering a day in a run shows the run it belongs to", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(url({ view: "dashboard", preset: "heavy-multi-tool" }));
  await mock(page);
  await page.getByTestId("trail-full").focus();
  await page.keyboard.press("End");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("trail-tip-run")).toContainText("-day streak");
});

test("reveal: the counter follows the light and the facts wait for the head", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(url({ view: "dashboard", preset: "first-run-reveal", step: "2", theme: "dark" }));
  const total = page.getByTestId("reveal-total");
  await expect(total).toBeVisible();
  await page.waitForTimeout(900);
  // mid-reveal: some but not all tokens counted, and no facts yet
  const mid = await page.evaluate(() => {
    const t = (window as unknown as { __trails: { isRevealing: boolean }[] }).__trails.find((x) => x.isRevealing);
    return { revealing: !!t, text: document.querySelector("[data-testid=reveal-total]")!.textContent };
  });
  expect(mid.revealing).toBe(true);
  await expect(page.getByTestId("reveal-facts").locator(".ofact")).toHaveCount(0);
  const midNum = parseFloat(mid.text!.replace(/[^0-9.]/g, ""));
  await expect(page.getByTestId("reveal-facts").locator(".ofact")).toHaveCount(4, { timeout: 5000 });
  const endNum = parseFloat((await total.textContent())!.replace(/[^0-9.]/g, ""));
  expect(midNum).toBeGreaterThan(0);
  expect(midNum).toBeLessThan(endNum);
});

test("goal moment: ignition, then the streak digit rolls, then the toast", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 700 });
  await page.goto(url({ view: "popover", preset: "goal-hit", theme: "light" }));
  await mock(page);
  await page.waitForTimeout(400);
  const before = (await page.getByTestId("streak-pill").locator("b").textContent())!.trim();
  await page.evaluate(() => (window as unknown as { __tokenstreakMock: { triggerGoalReached: () => void } }).__tokenstreakMock.triggerGoalReached());
  // while the count-up lands, yesterday's count and the pre-goal label are still what you see
  await page.waitForTimeout(250);
  await expect(page.locator(".ts-roll-old")).toHaveText(before);
  await expect(page.locator(".hero-lab")).not.toContainText("Goal lit");
  await expect(page.getByTestId("progress-meta")).toContainText("to light");
  await expect(page.getByTestId("goal-toast")).toBeHidden();
  await expect(page.getByTestId("goal-toast")).toBeVisible({ timeout: 3000 });
  await expect(page.locator(".ts-roll-old")).toHaveCount(0);
  expect(Number((await page.getByTestId("streak-pill").locator("b").textContent())!.trim())).toBe(Number(before) + 1);
});

/* ---- round 3: light-theme history reads as light, in both engines ---- */

/** In-page CIELAB profiles through goal-day history (see scripts/measure-trail-light.mjs). */
async function lightProfile(page: Page) {
  return page.evaluate(() => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="trail-full"]')!;
    const t = (window as unknown as { __trails: { canvas: HTMLCanvasElement; geometry: () => { points: { x: number; y: number; wd: number; role: string; hw: number; gw: number }[] } }[] }).__trails.find((x) => x.canvas === canvas)!;
    const pts = t.geometry().points;
    const dpr = canvas.width / canvas.clientWidth;
    const ctx = canvas.getContext("2d")!;
    const lin = (c: number) => ((c /= 255) <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const Ls = (r: number, g: number, b: number) => {
      const Y = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
      return Y > 0.008856 ? 116 * Math.cbrt(Y) - 16 : 903.3 * Y;
    };
    const rows: { peak: number; plateau: number; falloff: number }[] = [];
    pts.forEach((p, i) => {
      if (p.role === "gap" || p.hw < 0.95 || p.gw < 0.95 || p.wd < 5 || !pts[i - 1] || !pts[i + 1] || pts[i - 1]!.role === "gap" || pts[i + 1]!.role === "gap") return;
      const hgt = Math.round(80 * dpr);
      const d = ctx.getImageData(Math.round(p.x * dpr), Math.round((p.y - 40) * dpr), 1, hgt).data;
      const raw: number[] = [];
      for (let q = 0; q < hgt; q++) raw.push(Ls(d[q * 4]!, d[q * 4 + 1]!, d[q * 4 + 2]!));
      const L = raw.map((v, q) => (raw[Math.max(0, q - 1)]! + v + raw[Math.min(raw.length - 1, q + 1)]!) / 3);
      let pk = 0;
      for (let q = 1; q < L.length; q++) if (L[q]! > L[pk]!) pk = q;
      let a = pk;
      let b = pk;
      while (a > 0 && L[a - 1]! >= L[pk]! - 0.5) a--;
      while (b < L.length - 1 && L[b + 1]! >= L[pk]! - 0.5) b++;
      const side = (dir: number) => {
        const reach = Math.round(p.wd * 0.78 * dpr);
        let v = pk;
        for (let q = pk; Math.abs(q - pk) <= reach && q >= 0 && q < L.length; q += dir) if (L[q]! < L[v]!) v = q;
        const span = L[Math.max(0, Math.min(L.length - 1, pk + dir * reach))]! - L[v]!;
        if (span < 1) return 0;
        const cross = (f: number) => {
          const th = L[v]! + f * span;
          let j = v;
          while (j + dir >= 0 && j + dir < L.length && L[j + dir]! < th) j += dir;
          const x0 = L[j]!;
          const x1 = L[j + dir] ?? x0;
          return j + dir * (x1 === x0 ? 0 : (th - x0) / (x1 - x0));
        };
        return Math.abs(cross(0.9) - cross(0.1)) / dpr;
      };
      rows.push({ peak: L[pk]!, plateau: (b - a + 1) / dpr, falloff: Math.min(side(-1), side(1)) });
    });
    const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    return { n: rows.length, peak: med(rows.map((r) => r.peak)), plateau: med(rows.map((r) => r.plateau)), falloff: med(rows.map((r) => r.falloff)) };
  });
}

test.describe("light history is light, not paint", () => {
  test.use({ deviceScaleFactor: 2, colorScheme: "light" });
  test("goal days peak above the sky with a soft edge (L* >= 95, plateau <= 2 px, falloff >= 3 px)", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.goto(url({ view: "dashboard", preset: "first-run-reveal", step: "3", theme: "light" }));
    await page.getByTestId("onb-start").click();
    await page.getByTestId("hero").waitFor();
    await page.waitForTimeout(1200);
    const p = await lightProfile(page);
    expect(p.n).toBeGreaterThan(2);
    expect(p.peak).toBeGreaterThanOrEqual(95);
    expect(p.plateau).toBeLessThanOrEqual(2);
    expect(p.falloff).toBeGreaterThanOrEqual(3);
  });
});

test.describe("the ribbon body is soft in every engine", () => {
  test.use({ deviceScaleFactor: 2, colorScheme: "dark" });
  test("WebKit and Chromium both soften history edges (no reliance on ctx.filter)", async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.goto(url({ view: "dashboard", preset: "first-run-reveal", step: "3", theme: "dark" }));
    await page.getByTestId("onb-start").click();
    await page.getByTestId("hero").waitFor();
    await page.waitForTimeout(1200);
    // the 10-90% width of each history edge's brightness step, in CSS px (a crisp edge is ~0.5)
    const edge = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="trail-full"]')!;
      const t = (window as unknown as { __trails: { canvas: HTMLCanvasElement; geometry: () => { points: { x: number; y: number; wd: number; role: string; hw: number }[] } }[] }).__trails.find((x) => x.canvas === canvas)!;
      const pts = t.geometry().points.filter((p, i, a) => p.role !== "gap" && p.hw > 0.95 && p.wd > 6 && a[i - 1]?.role !== "gap" && a[i + 1]?.role !== "gap");
      const dpr = canvas.width / canvas.clientWidth;
      const ctx = canvas.getContext("2d")!;
      const widths: number[] = [];
      for (const p of pts) {
        const hgt = Math.round(p.wd * 2 * dpr);
        const d = ctx.getImageData(Math.round(p.x * dpr), Math.round((p.y - p.wd) * dpr), 1, hgt).data;
        const v: number[] = [];
        for (let q = 0; q < hgt; q++) v.push(d[q * 4]! + d[q * 4 + 1]! + d[q * 4 + 2]!);
        const mid = Math.round(hgt / 2);
        const hi = Math.max(...v.slice(mid - 2, mid + 3));
        const lo = v[hgt - 1]!;
        if (hi - lo < 30) continue;
        const at = (f: number) => {
          let j = mid;
          while (j < hgt - 1 && v[j]! > lo + f * (hi - lo)) j++;
          return j;
        };
        widths.push((at(0.1) - at(0.9)) / dpr);
      }
      widths.sort((a, b) => a - b);
      return { n: widths.length, median: widths[Math.floor(widths.length / 2)] ?? 0 };
    });
    expect(edge.n).toBeGreaterThan(2);
    expect(edge.median).toBeGreaterThanOrEqual(1.5);
  });
});

/* ---- launch media: strands never close into loops; the hero swaps on ignition ---- */

for (const [preset, range] of [
  ["long-history", "All"],
  ["heavy-multi-tool", "Year"],
] as const) {
  test(`tool strands (${preset}, ${range}): smooth, finely sampled, never self-intersecting`, async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.goto(url({ view: "dashboard", preset, theme: "dark" }));
    await mock(page);
    if (range !== "Year") await page.getByRole("radio", { name: range, exact: true }).click();
    await layoutOf(page, "trail-full");
    const r = await page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid="trail-full"]')!;
      const t = (window as unknown as { __trails: { canvas: HTMLCanvasElement; strandGeometry: (t: number) => { x: number; y: number; w: number }[][] }[] }).__trails.find((x) => x.canvas === canvas)!;
      const cross = (a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }, d: { x: number; y: number }) => {
        const o = (p: typeof a, q: typeof a, s: typeof a) => Math.sign((q.x - p.x) * (s.y - p.y) - (q.y - p.y) * (s.x - p.x));
        return o(a, b, c) * o(a, b, d) < 0 && o(c, d, a) * o(c, d, b) < 0;
      };
      let maxSeg = 0;
      let loops = 0;
      let strands = 0;
      for (const tt of [0, 1.7, 3.3]) {
        for (const pts of t.strandGeometry(tt)) {
          if (pts.length < 3) continue;
          strands++;
          for (let i = 1; i < pts.length - 1; i++) maxSeg = Math.max(maxSeg, Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
          // a visible strand must never cross itself (that is what drew the closed "chain links")
          for (let i = 1; i < pts.length; i++) {
            if (pts[i]!.w < 0.02) continue;
            for (let j = i + 2; j < pts.length; j++) if (pts[j]!.w >= 0.02 && cross(pts[i - 1]!, pts[i]!, pts[j - 1]!, pts[j]!)) loops++;
          }
        }
      }
      return { maxSeg, loops, strands };
    });
    expect(r.strands).toBeGreaterThan(0);
    expect(r.maxSeg).toBeLessThanOrEqual(2.5);
    expect(r.loops).toBe(0);
  });
}

test("dashboard goal moment: the hero keeps the pre-goal label, chip and streak until ignition", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(url({ view: "dashboard", preset: "goal-hit", theme: "dark" }));
  await mock(page);
  await page.waitForTimeout(500);
  const before = (await page.getByTestId("hero-streak").textContent())!;
  await page.evaluate(() => (window as unknown as { __tokenstreakMock: { triggerGoalReached: () => void } }).__tokenstreakMock.triggerGoalReached());
  await page.waitForTimeout(300);
  await expect(page.locator(".hero__lab")).toHaveText("Today’s light");
  await expect(page.getByTestId("hero-progress")).not.toContainText("Lit");
  await expect(page.getByTestId("hero-streak")).toHaveText(before);
  await expect(page.locator(".hero__lab")).toHaveText("Goal lit today", { timeout: 3000 });
  await expect(page.getByTestId("hero-progress")).toContainText("Lit");
  await expect(page.getByTestId("hero-streak")).not.toHaveText(before);
});
