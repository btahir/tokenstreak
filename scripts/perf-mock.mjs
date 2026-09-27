#!/usr/bin/env node
// Measures popover first paint, popover re-show latency and Trail frame times
// against a built web bundle (`pnpm build:web && pnpm preview:web`), or any
// running mock server (--url).
//
//   node scripts/perf-mock.mjs [--url http://127.0.0.1:4173]
import { chromium } from "playwright";

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const base = arg("--url", "http://127.0.0.1:4173");
const browser = await chromium.launch();
const ctx = await browser.newContext({ deviceScaleFactor: 2 });
const page = await ctx.newPage();
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };

// 1. popover cold load: navigation start -> first contentful paint -> first Trail frame
const loads = [];
for (let i = 0; i < 5; i++) {
  await page.setViewportSize({ width: 380, height: 640 });
  await page.goto(`${base}/?view=popover&preset=heavy-multi-tool&devtools=0&live=0`);
  await page.waitForFunction(() => (window.__trails ?? []).some((t) => t.stats.frames > 0));
  loads.push(await page.evaluate(() => {
    const data = performance.getEntriesByName("ts:data")[0]?.startTime ?? NaN;
    return { data, trail: performance.now() };
  }));
}
// 2. re-show latency: popover-shown event -> next two frames (the window is pre-created in the app)
const reshow = [];
for (let i = 0; i < 10; i++) {
  await page.evaluate(() => window.__tokenstreakMock.emit("popover-hidden", null));
  reshow.push(await page.evaluate(() => new Promise((r) => {
    const t0 = performance.now();
    window.__tokenstreakMock.emit("popover-shown", null);
    requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now() - t0)));
  })));
}
// 3. Trail frame cost (CPU time spent issuing draw calls per frame) (popover and full dashboard variant), 4 s of animation each
await page.waitForTimeout(4000);
const pop = await page.evaluate(() => ({ ...window.__trails[0].stats }));
await page.setViewportSize({ width: 1180, height: 800 });
await page.goto(`${base}/?view=dashboard&preset=heavy-multi-tool&devtools=0&live=0`);
await page.waitForTimeout(4500);
const full = await page.evaluate(() => ({ ...window.__trails[0].stats }));
// 4. idle: hidden popover draws nothing
await page.setViewportSize({ width: 380, height: 640 });
await page.goto(`${base}/?view=popover&preset=heavy-multi-tool&devtools=0&live=0`);
await page.waitForTimeout(1500);
await page.evaluate(() => window.__tokenstreakMock.emit("popover-hidden", null));
const f0 = await page.evaluate(() => window.__trails[0].stats.frames);
await page.waitForTimeout(3000);
const f1 = await page.evaluate(() => window.__trails[0].stats.frames);

const r = (n) => Math.round(n * 10) / 10;
console.log(JSON.stringify({
  popoverDataReadyMs: r(median(loads.map((l) => l.data))),
  popoverFirstTrailFrameMs: r(median(loads.map((l) => l.trail))),
  popoverReshowToFrameMs: r(median(reshow)),
  trailPopoverFrameMs: { mean: r(pop.frameMs), max: r(pop.maxFrameMs), cacheRebuildMs: r(pop.cacheMs) },
  trailFullFrameMs: { mean: r(full.frameMs), max: r(full.maxFrameMs), cacheRebuildMs: r(full.cacheMs) },
  hiddenPopoverFramesIn3s: f1 - f0,
}, null, 2));
await browser.close();
