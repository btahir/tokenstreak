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

test("3+ years in the All range aggregate to weekly points or coarser", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(url({ view: "dashboard", preset: "long-history" }));
  await mock(page);
  await page.getByRole("radio", { name: "All", exact: true }).click();
  const { geo } = await layoutOf(page, "trail-full");
  expect(geo.lod).toBeGreaterThanOrEqual(7);
  expect(geo.points.length).toBeLessThan(260);
  // smooth: no point-to-point jumps steeper than the step
  const pts = geo.points;
  let worst = 0;
  for (let i = 1; i < pts.length; i++) worst = Math.max(worst, Math.abs(pts[i]!.y - pts[i - 1]!.y) / Math.max(1, pts[i]!.x - pts[i - 1]!.x));
  expect(worst).toBeLessThan(1.2);
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
  // while the count-up lands, yesterday's count is still what you see
  await page.waitForTimeout(250);
  await expect(page.locator(".ts-roll-old")).toHaveText(before);
  await expect(page.getByTestId("goal-toast")).toBeHidden();
  await expect(page.getByTestId("goal-toast")).toBeVisible({ timeout: 3000 });
  await expect(page.locator(".ts-roll-old")).toHaveCount(0);
  expect(Number((await page.getByTestId("streak-pill").locator("b").textContent())!.trim())).toBe(Number(before) + 1);
});
