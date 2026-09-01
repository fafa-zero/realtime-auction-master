import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  timeout: 30_000,
  expect: { timeout: 8_000 },
  fullyParallel: true,
  reporter: "list",
  use: {
    baseURL: process.env.AUCTION_WEB_URL ?? "http://127.0.0.1:4300",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    ...devices["Desktop Chrome"]
  },
  webServer: {
    command: "npm run demo",
    url: "http://127.0.0.1:4300/api/health",
    reuseExistingServer: true,
    timeout: 120_000
  }
});

