#!/usr/bin/env node
// Trail frame cost in Chromium and WebKit against a built web bundle (pnpm build:web && pnpm preview:web):
// popover idle, popover during the goal moment, and the dashboard with 3.5 years in the All range.
import { chromium, webkit } from "playwright";
const base = process.argv[2] ?? "http://127.0.0.1:4173";
const out = {};
for (const [name, eng] of [["chromium", chromium], ["webkit", webkit]]) {
  const b = await eng.launch();
  const p = await (await b.newContext({ deviceScaleFactor: 2 })).newPage();
  await p.setViewportSize({ width: 380, height: 700 });
  await p.goto(`${base}/?view=popover&preset=goal-hit&devtools=0&live=0&theme=dark`);
  await p.waitForFunction(() => (window.__trails ?? []).some((t) => t.stats.frames > 30));
  await p.waitForTimeout(2500);
  const idle = await p.evaluate(() => ({ ...window.__trails[0].stats }));
  await p.evaluate(() => window.__tokenstreakMock.triggerGoalReached());
  await p.waitForTimeout(700);
  await p.evaluate(() => { const t = window.__trails[0]; t.frameTimes = []; });
  await p.waitForTimeout(1600);
  const celeb = await p.evaluate(() => ({ ...window.__trails[0].stats }));
  await p.setViewportSize({ width: 1180, height: 800 });
  await p.goto(`${base}/?view=dashboard&preset=long-history&devtools=0&live=0&theme=dark`);
  await p.waitForTimeout(1200);
  await p.getByRole("radio", { name: "All", exact: true }).click();
  await p.waitForTimeout(2500);
  const full = await p.evaluate(() => ({ ...window.__trails[0].stats }));
  const r = (x) => Math.round(x * 100) / 100;
  out[name] = { popoverIdle: { mean: r(idle.frameMs), max: r(idle.maxFrameMs), cache: r(idle.cacheMs) }, popoverCelebration: { mean: r(celeb.frameMs), max: r(celeb.maxFrameMs) }, dashboardLongHistoryAll: { mean: r(full.frameMs), max: r(full.maxFrameMs), cache: r(full.cacheMs) } };
  await b.close();
}
console.log(JSON.stringify(out, null, 1));
