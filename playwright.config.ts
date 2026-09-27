import { defineConfig, devices } from "@playwright/test";

// End-to-end tests against the browser mock (`pnpm dev:web`).
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: true,
  workers: 4,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5173", ...devices["Desktop Chrome"], deviceScaleFactor: 1 },
  webServer: { command: "pnpm dev:web", url: "http://127.0.0.1:5173", reuseExistingServer: true, timeout: 60_000 },
});
