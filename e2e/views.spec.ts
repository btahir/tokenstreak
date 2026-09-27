// Every view × preset × theme renders without console errors.
import { expect, test } from "@playwright/test";
import { PRESETS, THEMES, url, watchConsole } from "./helpers";

for (const theme of THEMES) {
  for (const preset of PRESETS) {
    test(`popover · ${preset} · ${theme}`, async ({ page }) => {
      const con = watchConsole(page);
      await page.setViewportSize({ width: 380, height: 700 });
      await page.goto(url({ view: "popover", preset, theme }));
      await expect(page.getByTestId("popover")).toBeVisible();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByTestId("trail-popover")).toBeVisible();
      if (preset === "new-user" || preset === "first-run-reveal") {
        await expect(page.getByTestId("first-run")).toBeVisible();
        await expect(page.getByTestId("reveal-history")).toBeVisible();
      } else {
        await expect(page.getByTestId("today-tokens")).not.toBeEmpty();
        await expect(page.getByTestId("streak-pill")).toBeVisible();
        await expect(page.getByTestId("week").locator(".orb")).toHaveCount(7);
        await expect(page.getByTestId("watching")).toContainText("Watching");
      }
      con.assertClean();
    });

    test(`dashboard · ${preset} · ${theme}`, async ({ page }) => {
      const con = watchConsole(page);
      await page.setViewportSize({ width: 1180, height: 800 });
      await page.goto(url({ view: "dashboard", preset, theme }));
      if (preset === "new-user" || preset === "first-run-reveal") {
        await expect(page.getByTestId("onboarding")).toBeVisible();
      } else {
        await expect(page.getByTestId("dashboard")).toBeVisible();
        await expect(page.getByTestId("hero")).toBeVisible();
        await expect(page.getByTestId("stat-tiles").locator(".tile")).toHaveCount(4);
        await expect(page.getByTestId("usage-chart")).toBeVisible();
        await expect(page.getByTestId("efficiency")).toBeVisible();
        await expect(page.getByTestId("breakdowns")).toBeVisible();
        for (const p of ["stats", "achievements", "settings", "overview"] as const) {
          await page.getByTestId(`nav-${p}`).click();
          await expect(page.getByTestId(`page-${p}`)).toBeVisible();
        }
      }
      con.assertClean();
    });
  }
}
