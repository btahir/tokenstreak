#!/usr/bin/env node
// Screenshots every view, preset and theme from a running mock server
// (`pnpm dev:web` or `pnpm preview:web`). Mock data only; never real logs.
//
//   node scripts/screenshot-mock.mjs [--url http://127.0.0.1:5173] [--out shots] [--only popover|dashboard|pages|onboarding|share|cards]
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const base = arg("--url", "http://127.0.0.1:5173");
const out = arg("--out", "shots");
const only = arg("--only", null);
const PRESETS = ["new-user", "first-run-reveal", "streak-30", "heavy-multi-tool", "goal-hit", "streak-at-risk"];
mkdirSync(out, { recursive: true });

const browser = await chromium.launch();
const q = (p) => new URLSearchParams({ devtools: "0", live: "0", ...p }).toString();
const want = (k) => !only || only === k;

for (const theme of ["light", "dark"]) {
  const ctx = await browser.newContext({ colorScheme: theme, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const shot = async (name, params, size, { full = false, wait = 700, act } = {}) => {
    await page.setViewportSize(size);
    await page.goto(`${base}/?${q({ theme, ...params })}`);
    await page.waitForSelector("#root > *", { timeout: 10_000 });
    await page.waitForTimeout(wait);
    if (act) await act(page);
    if (full) {
      await page.evaluate(() => {
        for (const el of [document.documentElement, document.body, document.getElementById("root")]) {
          el.style.height = "auto";
          el.style.overflow = "visible";
        }
        const win = document.querySelector(".win");
        if (win) win.style.height = "auto";
        const main = document.querySelector(".main");
        if (main) main.style.overflow = "visible";
      });
      await page.waitForTimeout(400);
    }
    const file = `${out}/${name}-${theme}.png`;
    await page.screenshot({ path: file, fullPage: full });
    console.log(file);
  };
  if (want("popover"))
    for (const preset of PRESETS) await shot(`popover-${preset}`, { view: "popover", preset, wall: "1" }, { width: 440, height: 760 }, { wait: 1200 });
  if (want("popover"))
    await shot("popover-goal-moment", { view: "popover", preset: "goal-hit", wall: "1" }, { width: 440, height: 760 }, {
      act: async (p) => {
        await p.evaluate(() => window.__tokenstreakMock.triggerGoalReached());
        await p.waitForTimeout(1300);
      },
    });
  if (want("dashboard"))
    for (const preset of ["streak-30", "heavy-multi-tool", "goal-hit", "streak-at-risk"])
      await shot(`dashboard-${preset}`, { view: "dashboard", preset }, { width: 1180, height: 800 }, { full: true, wait: 1400 });
  if (want("pages"))
    for (const pg of ["stats", "achievements", "settings"])
      await shot(`dashboard-${pg}`, { view: "dashboard", preset: "heavy-multi-tool", page: pg }, { width: 1180, height: 800 }, { full: true, wait: 1200 });
  if (want("onboarding"))
    for (const step of ["1", "2", "3"])
      await shot(`onboarding-${step}`, { view: "dashboard", preset: "first-run-reveal", step }, { width: 1180, height: 800 }, { wait: step === "2" ? 3400 : 2000 });
  if (want("share"))
    await shot("dashboard-share", { view: "dashboard", preset: "heavy-multi-tool", share: "1", card: theme }, { width: 1180, height: 800 }, { wait: 2200 });
  if (want("cards")) {
    await page.setViewportSize({ width: 1200, height: 900 });
    await page.goto(`${base}/?${q({ theme, view: "dashboard", preset: "heavy-multi-tool" })}`);
    await page.waitForSelector("[data-testid=dashboard]");
    for (const tpl of ["streak", "year", "lean"])
      for (const fmt of ["square", "story"]) {
        const b64 = await page.evaluate(async ([tpl, fmt, theme]) => {
          const m = await import("/src/share/cards.ts");
          const snap = window.__tokenstreakMock.snapshot();
          const o = { template: tpl, format: fmt, theme, showMix: true, showCost: false, showProjects: false };
          const c = await m.renderCard(m.buildCardModel(snap, o, null), o);
          return m.canvasToBase64(c);
        }, [tpl, fmt, theme]);
        const { writeFileSync } = await import("node:fs");
        const file = `${out}/card-${tpl}-${fmt}-${theme}.png`;
        writeFileSync(file, Buffer.from(b64, "base64"));
        console.log(file);
      }
  }
  await ctx.close();
}
await browser.close();
