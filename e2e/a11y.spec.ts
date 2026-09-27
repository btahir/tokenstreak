// Accessibility: axe-core (WCAG 2.x A and AA rules) on every view, in both
// themes, with zero serious or critical violations. Canvas skies can't be
// measured by axe; text over them is checked by eye in the review shots.
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { THEMES, url } from "./helpers";

interface View {
  name: string;
  params: Record<string, string>;
  size: { width: number; height: number };
  ready: string;
  act?: (page: Page) => Promise<void>;
}

const VIEWS: View[] = [
  { name: "popover", params: { view: "popover", preset: "streak-30" }, size: { width: 380, height: 760 }, ready: "popover" },
  { name: "popover at risk", params: { view: "popover", preset: "streak-at-risk" }, size: { width: 380, height: 760 }, ready: "popover" },
  { name: "popover first run", params: { view: "popover", preset: "new-user" }, size: { width: 380, height: 760 }, ready: "first-run" },
  { name: "overview", params: { view: "dashboard", preset: "heavy-multi-tool" }, size: { width: 1180, height: 800 }, ready: "page-overview" },
  { name: "stats", params: { view: "dashboard", preset: "heavy-multi-tool", page: "stats" }, size: { width: 1180, height: 800 }, ready: "page-stats" },
  { name: "achievements", params: { view: "dashboard", preset: "heavy-multi-tool", page: "achievements" }, size: { width: 1180, height: 800 }, ready: "page-achievements" },
  { name: "settings", params: { view: "dashboard", preset: "heavy-multi-tool", page: "settings" }, size: { width: 1180, height: 800 }, ready: "page-settings" },
  { name: "share dialog", params: { view: "dashboard", preset: "heavy-multi-tool", share: "1" }, size: { width: 1180, height: 800 }, ready: "share-dialog" },
  { name: "onboarding 1", params: { view: "dashboard", preset: "first-run-reveal", step: "1" }, size: { width: 1180, height: 800 }, ready: "onboarding" },
  { name: "onboarding 2", params: { view: "dashboard", preset: "first-run-reveal", step: "2" }, size: { width: 1180, height: 800 }, ready: "onboarding" },
  { name: "onboarding 3", params: { view: "dashboard", preset: "first-run-reveal", step: "3" }, size: { width: 1180, height: 800 }, ready: "onboarding" },
];

for (const theme of THEMES) {
  for (const v of VIEWS) {
    test(`axe · ${v.name} · ${theme}`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize(v.size);
      await page.goto(url({ ...v.params, theme }));
      await expect(page.getByTestId(v.ready)).toBeVisible();
      // let entry animations and count-ups settle
      await page.waitForTimeout(900);
      const r = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      const bad = r.violations.filter((x) => x.impact === "serious" || x.impact === "critical");
      const report = bad.map((x) => `${x.id} (${x.impact}): ${x.nodes.length} nodes\n${x.nodes.slice(0, 6).map((n) => `  ${n.target.join(" ")} ${n.failureSummary?.split("\n").slice(1, 2).join("") ?? ""}`).join("\n")}`).join("\n");
      expect(report).toBe("");
    });
  }
}
