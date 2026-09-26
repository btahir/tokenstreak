#!/usr/bin/env node
// Screenshots every mock preset (popover + dashboard, light + dark) from a
// running `pnpm dev:web` (or `pnpm preview:web`) server.
//
//   node scripts/screenshot-mock.mjs [--url http://127.0.0.1:5173] [--out shots] [--preset goal-hit]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const base = arg("--url", "http://127.0.0.1:5173");
const out = arg("--out", "shots");
const only = arg("--preset", null);
const presets = only ? [only] : ["new-user", "first-run-reveal", "streak-30", "heavy-multi-tool", "goal-hit", "streak-at-risk"];
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ colorScheme: theme, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  for (const preset of presets) {
    for (const [view, size] of [["popover", { width: 380, height: 580 }], ["dashboard", { width: 1180, height: 800 }]]) {
      await page.setViewportSize(size);
      await page.goto(`${base}/?view=${view}&preset=${preset}&theme=${theme}&devtools=0&live=0`);
      await page.waitForSelector(`[data-testid="${view}"]`, { timeout: 10_000 });
      await page.waitForTimeout(300);
      const file = `${out}/${preset}-${view}-${theme}.png`;
      await page.screenshot({ path: file, fullPage: view === "dashboard" });
      console.log(file);
    }
  }
  await ctx.close();
}
await browser.close();
