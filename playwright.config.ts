import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "tests/e2e/report" }]],
  use: {
    baseURL: "https://workeros.floom.dev",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  projects: [
    // API-level tests — no browser, no auth cookie needed.
    // Run with: npx playwright test --project=api
    {
      name: "api",
      testMatch: "**/*.api.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    // Full UI tests — require storageState from auth setup.
    // Run setup first: npx playwright test --project=setup
    // Then run UI:     npx playwright test --project=ui
    {
      name: "setup",
      testMatch: "**/*.setup.ts",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "ui",
      testMatch: "**/*.ui.spec.ts",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/.auth/admin.json",
      },
    },
    {
      name: "ui-member",
      testMatch: "**/*.ui.spec.ts",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/.auth/member.json",
      },
    },
  ],
});
