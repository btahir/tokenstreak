#!/usr/bin/env node
// Captures every Trail surface (popover sky, dashboard hero per range and width,
// lab, reveal and goal-moment sequences, share cards) from a running mock server.
// Mock data only.
//
//   node scripts/trail-shots.mjs [--url http://127.0.0.1:5173] [--out shots/trail] [--engine chromium|webkit]
//        [--only popover,hero,lab,reveal,goal,cards,tip] [--themes light,dark]
import { chromium, webkit } from "playwright";
import { mkdirSync } from "node:fs";

const arg = (name, def) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
};
const base = arg("--url", "http://127.0.0.1:5173");
const engine = arg("--engine", "chromium");
const out = `${arg("--out", "shots/trail")}/${engine}`;
const only = arg("--only", "popover,hero,lab,reveal,goal,cards,tip").split(",");
const themes = arg("--themes", "light,dark").split(",");
const heroPresets = arg("--presets", "sparse,streak-30,heavy-multi-tool,goal-hit,streak-at-risk,long-history").split(",");
mkdirSync(out, { recursive: true });

const browser = await (engine === "webkit" ? webkit : chromium).launch();
const q = (p) => new URLSearchParams({ devtools: "0", live: "0", ...p }).toString();
const want = (k) => only.includes(k);
const log = (f) => console.log(f);

for (const theme of themes) {
  const ctx = await browser.newContext({ colorScheme: theme, deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  const go = async (params, size, wait = 900) => {
    await page.setViewportSize(size);
    await page.goto(`${base}/?${q({ theme, ...params })}`);
    await page.waitForSelector("#root > *", { timeout: 15_000 });
    await page.waitForTimeout(wait);
  };

  if (want("popover"))
    for (const preset of ["new-user", "sparse", "first-run-reveal", "streak-30", "heavy-multi-tool", "goal-hit", "streak-at-risk", "long-history"]) {
      await go({ view: "popover", preset, wall: "1" }, { width: 440, height: 760 }, 1300);
      const f = `${out}/pop-${preset}-${theme}.png`;
      await page.locator(".pop").screenshot({ path: f });
      log(f);
    }

  if (want("hero"))
    for (const w of [1180, 900])
      for (const preset of heroPresets)
        for (const range of w === 900 ? ["Year", "All"] : ["Week", "Month", "Year", "All"]) {
          if (range !== "Year" && !["heavy-multi-tool", "long-history", "streak-30", "sparse"].includes(preset)) continue;
          await go({ view: "dashboard", preset }, { width: w, height: 800 }, 900);
          const seg = page.getByRole("radio", { name: range }).or(page.getByRole("button", { name: range, exact: true }));
          if (range !== "Year") await seg.first().click();
          await page.waitForTimeout(700);
          const f = `${out}/hero-${preset}-${range.toLowerCase()}-${w}-${theme}.png`;
          await page.getByTestId("hero").screenshot({ path: f });
          log(f);
        }

  if (want("tip")) {
    await go({ view: "dashboard", preset: "heavy-multi-tool" }, { width: 1180, height: 800 }, 900);
    const box = await page.getByTestId("trail-full").boundingBox();
    for (const [name, fx, fy] of [["top", 0.5, 0.1], ["left", 0.03, 0.5], ["right", 0.97, 0.5], ["mid", 0.6, 0.6]]) {
      await page.mouse.move(box.x + box.width * fx, box.y + box.height * fy);
      await page.waitForTimeout(250);
      const f = `${out}/tip-${name}-${theme}.png`;
      await page.screenshot({ path: f, clip: { x: box.x - 20, y: box.y - 20, width: box.width + 40, height: box.height + 40 } });
      log(f);
    }
  }

  if (want("lab")) {
    await go({ view: "lab", part: "trails" }, { width: 1400, height: 1100 }, 1500);
    const f = `${out}/lab-${theme}.png`;
    await page.screenshot({ path: f, fullPage: true });
    log(f);
  }

  if (want("reveal")) {
    await page.setViewportSize({ width: 1180, height: 800 });
    await page.goto(`${base}/?${q({ theme, view: "dashboard", preset: "first-run-reveal", step: "2" })}`);
    const t0 = Date.now();
    for (const ms of [150, 700, 1300, 1900, 2600, 3400]) {
      const wait = ms - (Date.now() - t0);
      if (wait > 0) await page.waitForTimeout(wait);
      const f = `${out}/reveal-${String(ms).padStart(4, "0")}-${theme}.png`;
      await page.screenshot({ path: f });
      log(f);
    }
  }

  if (want("goal")) {
    for (const view of ["popover", "dashboard"]) {
      await go({ view, preset: "goal-hit", wall: "1" }, view === "popover" ? { width: 440, height: 760 } : { width: 1180, height: 800 }, 1300);
      await page.evaluate(() => window.__tokenstreakMock.triggerGoalReached());
      const t0 = Date.now();
      for (const ms of [80, 250, 450, 700, 1000, 1500, 2200, 3200]) {
        const wait = ms - (Date.now() - t0);
        if (wait > 0) await page.waitForTimeout(wait);
        const f = `${out}/goal-${view}-${String(ms).padStart(4, "0")}-${theme}.png`;
        if (view === "popover") await page.locator(".pop").screenshot({ path: f });
        else await page.getByTestId("hero").screenshot({ path: f });
        log(f);
      }
    }
  }

  if (want("cards")) {
    await go({ view: "dashboard", preset: "heavy-multi-tool" }, { width: 1200, height: 900 }, 600);
    for (const preset of ["heavy-multi-tool", "long-history", "sparse"])
      for (const tpl of ["streak", "year", "lean"])
        for (const fmt of ["square", "story"]) {
          if (preset !== "heavy-multi-tool" && fmt === "story") continue;
          const b64 = await page.evaluate(async ([tpl, fmt, theme, preset]) => {
            const m = await import("/src/share/cards.ts");
            const mock = await import("/src/api/mock/index.ts");
            const snap = (await mock.loadPreset(preset)).snapshot;
            const o = { template: tpl, format: fmt, theme, showMix: true, showCost: false, showProjects: false };
            const c = await m.renderCard(m.buildCardModel(snap, o, null), o);
            return m.canvasToBase64(c);
          }, [tpl, fmt, theme, preset]);
          const { writeFileSync } = await import("node:fs");
          const f = `${out}/card-${preset}-${tpl}-${fmt}-${theme}.png`;
          writeFileSync(f, Buffer.from(b64, "base64"));
          log(f);
        }
  }
  await ctx.close();
}
await browser.close();
