import { expect, type Page } from "@playwright/test";

export const PRESETS = ["new-user", "first-run-reveal", "streak-30", "heavy-multi-tool", "goal-hit", "streak-at-risk"] as const;
export const THEMES = ["light", "dark"] as const;

/** Collects console errors and page errors; call `assertClean()` at the end. */
export function watchConsole(page: Page) {
  const errors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(m.text());
  });
  page.on("pageerror", (e) => errors.push(e.message));
  return {
    errors,
    assertClean: () => expect(errors, errors.join("\n")).toEqual([]),
  };
}

export function url(params: Record<string, string>) {
  return `/?${new URLSearchParams({ devtools: "0", live: "0", ...params })}`;
}

export async function mock(page: Page) {
  await page.waitForFunction(() => "__tokenstreakMock" in window);
}
