import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1, // specs share one database; the golden-path spec mutates it last
  retries: 0,
  globalSetup: "./e2e/global-setup.ts",
  reporter: [["list"]],
  use: {
    baseURL: "http://localhost:3111",
    trace: "retain-on-failure",
  },
  expect: {
    toHaveScreenshot: {
      // deterministic UI (no motion in baselines)
      animations: "disabled",
      maxDiffPixelRatio: 0.001,
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "MONEYAPP_DB_PATH=data/e2e.db MONEYAPP_FAKE_PRICES=1 pnpm start --port 3111",
    url: "http://localhost:3111",
    // never baseline against a stale or foreign server
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
