// Interaction flows: goal-hit celebration, onboarding, share export, settings.
import { expect, test } from "@playwright/test";
import { mock, url, watchConsole } from "./helpers";

test("goal-hit: crossing the goal plays the celebration once", async ({ page }) => {
  const con = watchConsole(page);
  await page.setViewportSize({ width: 380, height: 700 });
  await page.goto(url({ view: "popover", preset: "goal-hit", theme: "dark" }));
  await mock(page);
  await expect(page.getByTestId("progress-meta")).toContainText("to light today’s trail");
  await page.evaluate(() => (window as unknown as { __tokenstreakMock: { triggerGoalReached: () => void } }).__tokenstreakMock.triggerGoalReached());
  const toast = page.getByTestId("goal-toast");
  await expect(toast).toBeVisible();
  await expect(toast).toContainText("Goal lit");
  await expect(page.getByTestId("progress-meta")).not.toContainText("to light");
  await expect(page.locator(".progress--lit")).toBeVisible();
  await expect(page.locator(".hero-lab")).toContainText("Goal lit today");
  // toast leaves and the celebration is acknowledged
  await expect(toast).toBeHidden({ timeout: 6000 });
  const pending = await page.evaluate(() => (window as unknown as { __tokenstreakMock: { snapshot: () => { celebration: unknown } } }).__tokenstreakMock.snapshot().celebration);
  expect(pending).toBeNull();
  con.assertClean();
});

test("goal-hit: live ticking crosses the goal by itself", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 700 });
  await page.goto(`/?view=popover&preset=goal-hit&theme=light&devtools=0&live=1&speed=4`);
  await expect(page.getByTestId("goal-toast")).toBeVisible({ timeout: 15_000 });
});

test("popover pauses the Trail when hidden and resumes when shown", async ({ page }) => {
  await page.setViewportSize({ width: 380, height: 700 });
  await page.goto(url({ view: "popover", preset: "streak-30" }));
  await mock(page);
  await page.waitForFunction(() => ((window as unknown as { __trails?: unknown[] }).__trails ?? []).length > 0);
  const running = () => page.evaluate(() => (window as unknown as { __trails: { isRunning: boolean }[] }).__trails.map((t) => t.isRunning));
  expect(await running()).toContain(true);
  await page.evaluate(() => (window as unknown as { __tokenstreakMock: { emit: (e: string, p: null) => void } }).__tokenstreakMock.emit("popover-hidden", null));
  await expect.poll(running).toEqual([false]);
  await page.evaluate(() => (window as unknown as { __tokenstreakMock: { emit: (e: string, p: null) => void } }).__tokenstreakMock.emit("popover-shown", null));
  await expect.poll(running).toEqual([true]);
});

test("first run: popover reveal opens the dashboard onboarding, which completes", async ({ page }) => {
  const con = watchConsole(page);
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(url({ view: "popover", preset: "first-run-reveal", theme: "light" }));
  await page.getByTestId("reveal-history").click();
  await expect(page.getByTestId("onboarding")).toBeVisible();
  await expect(page.getByTestId("detect-rows").locator(".orow")).toHaveCount(3);
  await page.getByTestId("onb-next").click();
  await expect(page.getByTestId("reveal")).toBeVisible();
  await expect(page.getByTestId("reveal-total")).toContainText("M", { timeout: 4000 });
  await page.getByTestId("onb-next").click();
  await expect(page.getByTestId("goal-preview")).toBeVisible();
  await page.getByTestId("preset-ambitious").click();
  await expect(page.getByTestId("preset-ambitious")).toHaveAttribute("aria-checked", "true");
  await page.getByTestId("onb-start").click();
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page.getByTestId("hero")).toBeVisible();
  con.assertClean();
});

test("share dialog: every template and format renders; Save PNG downloads", async ({ page }) => {
  const con = watchConsole(page);
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(url({ view: "dashboard", preset: "heavy-multi-tool", theme: "dark" }));
  await page.getByTestId("share-open").click();
  const dialog = page.getByTestId("share-dialog");
  await expect(dialog).toBeVisible();
  for (const tpl of ["Streak", "My year in light", "Leanest week"]) {
    await dialog.getByRole("radio", { name: new RegExp(tpl) }).click();
    for (const fmt of ["Square 1:1", "Story 9:16"]) {
      await dialog.getByRole("radio", { name: fmt }).click();
      await expect(dialog.locator("canvas")).toBeVisible();
      const size = await dialog.locator("canvas").evaluate((c: HTMLCanvasElement) => [c.width, c.height]);
      expect(size).toEqual(fmt.startsWith("Square") ? [1080, 1080] : [1080, 1920]);
    }
  }
  const download = page.waitForEvent("download");
  await page.getByTestId("share-save").click();
  expect((await download).suggestedFilename()).toBe("tokenstreak-lean-1080x1920-dark.png");
  await page.keyboard.press("Escape");
  await expect(dialog).toBeHidden();
  con.assertClean();
});

test("trail tooltip follows the pointer and the keyboard", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(url({ view: "dashboard", preset: "streak-30", theme: "light" }));
  const canvas = page.getByTestId("trail-full");
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.6);
  await expect(page.getByTestId("trail-tip")).toBeVisible();
  await page.mouse.move(0, 0);
  await expect(page.getByTestId("trail-tip")).toBeHidden();
  await canvas.focus();
  await expect(page.getByTestId("trail-tip")).toContainText("Today");
  await page.keyboard.press("ArrowLeft");
  await expect(page.getByTestId("trail-tip")).not.toContainText("Today");
});

test("settings: theme, goals and privacy controls apply", async ({ page }) => {
  const con = watchConsole(page);
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(`/?view=dashboard&preset=streak-30&devtools=0&live=0&page=settings`);
  await expect(page.getByTestId("page-settings")).toBeVisible();
  await page.getByRole("radio", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByRole("radio", { name: "Light" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  await page.getByRole("button", { name: "Custom…" }).first().click();
  await page.getByLabel("Custom daily goal").fill("7M");
  await page.getByLabel("Custom daily goal").press("Enter");
  await expect(page.getByTestId("daily-goal")).toHaveText("7M");
  await expect.poll(() => page.evaluate(() => (window as unknown as { __tokenstreakMock: { snapshot: () => { goals: { daily: number } } } }).__tokenstreakMock.snapshot().goals.daily)).toBe(7_000_000);
  const names = page.getByRole("switch", { name: "Show project names on cards" });
  await expect(names).toHaveAttribute("aria-checked", "false");
  await names.click();
  await expect(names).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("privacy")).toContainText("Tokens stay on this Mac");
  await expect(page.getByTestId("about")).toContainText("MIT");
  con.assertClean();
});

test("achievements: all badges with dates or progress", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 800 });
  await page.goto(`/?view=dashboard&preset=heavy-multi-tool&devtools=0&live=0&page=achievements`);
  const grid = page.getByTestId("achievement-grid");
  await expect(grid.locator(".badge")).toHaveCount(24);
  await expect(grid.locator(".badge--locked")).toHaveCount(2);
  await expect(grid).toContainText("Unlocked");
});

test.describe("reduced motion", () => {
  test.use({ reducedMotion: "reduce" });
  test("the goal moment still lands as a glow and a toast", async ({ page }) => {
    const con = watchConsole(page);
    await page.setViewportSize({ width: 380, height: 700 });
    await page.goto(url({ view: "popover", preset: "goal-hit", theme: "light" }));
    await mock(page);
    await page.evaluate(() => (window as unknown as { __tokenstreakMock: { triggerGoalReached: () => void } }).__tokenstreakMock.triggerGoalReached());
    await expect(page.getByTestId("goal-toast")).toBeVisible();
    await expect(page.locator(".progress--lit")).toBeVisible();
    con.assertClean();
  });
});
