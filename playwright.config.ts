import { defineConfig, devices } from "@playwright/test";

// End-to-end tests against the browser mock (`pnpm dev:web`). WebKit is the
// engine behind Tauri's WKWebView on macOS, so every test also runs there.
export default defineConfig({
  testDir: "e2e",
  timeout: 30_000,
  fullyParallel: true,
  workers: 4,
  reporter: [["list"]],
  use: { baseURL: "http://127.0.0.1:5173", deviceScaleFactor: 1 },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"], deviceScaleFactor: 1 } },
    { name: "webkit", use: { ...devices["Desktop Safari"], deviceScaleFactor: 1 } },
  ],
  webServer: { command: "pnpm dev:web", url: "http://127.0.0.1:5173", reuseExistingServer: true, timeout: 60_000 },
});
