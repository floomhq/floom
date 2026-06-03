import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 40_000,
  retries: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "tests/e2e/report" }]],
  use: {
    baseURL: "https://workeros.floom.dev",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "on-first-retry",
  },
  projects: [
    // ── API tests ─────────────────────────────────────────────────────────────
    // Pure HTTP — no browser, no auth cookies needed.
    // Run: npx playwright test --project=api
    {
      name: "api",
      testMatch: "**/*.api.spec.ts",
      use: { ...devices["Desktop Chrome"] },
    },

    // ── Auth setup ────────────────────────────────────────────────────────────
    // Run ONCE with --headed so you can log in via Google OAuth.
    // Run: npx playwright test --project=setup --headed
    {
      name: "setup",
      testMatch: "**/*.setup.ts",
      use: { ...devices["Desktop Chrome"], headless: false },
    },

    // ── UI tests (admin) ──────────────────────────────────────────────────────
    // Requires setup to have run first.
    // Run: npx playwright test --project=ui --headed
    {
      name: "ui",
      testMatch: "**/*.ui.spec.ts",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/.auth/admin.json",
      },
    },

    // ── UI tests (member) ─────────────────────────────────────────────────────
    // Same specs, different session — verifies member perspective.
    // Run: npx playwright test --project=ui-member --headed
    {
      name: "ui-member",
      testMatch: "**/*.ui.spec.ts",
      dependencies: ["setup"],
      use: {
        ...devices["Desktop Chrome"],
        storageState: "tests/e2e/.auth/member.json",
      },
    },

    // ── All UI (both) ─────────────────────────────────────────────────────────
    // Run all features end-to-end: npx playwright test --project=ui --project=ui-member
  ],
});
