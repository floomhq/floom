/**
 * Auth setup — run ONCE with `npx playwright test --project=setup --headed`
 *
 * Opens two browser windows. Log in with Google in each:
 *   1. Admin window  → log in as Frederico (workspace owner)
 *   2. Member window → log in as vivekbs.10@gmail.com
 *
 * Playwright saves the session cookies + localStorage to:
 *   tests/e2e/.auth/admin.json
 *   tests/e2e/.auth/member.json
 *
 * Rerun setup only when sessions expire (typically 7-30 days).
 */
import { test as setup, expect } from "@playwright/test";
import path from "path";

const BASE = "https://workeros.floom.dev";
const WORKSPACE_ID = "ws_8bdb2e8127db4f";

const ADMIN_STATE = path.join(__dirname, ".auth/admin.json");
const MEMBER_STATE = path.join(__dirname, ".auth/member.json");

// ---------------------------------------------------------------------------
// Admin login
// ---------------------------------------------------------------------------
setup("authenticate as admin", async ({ page }) => {
  await page.goto(`${BASE}/app/login`);

  // Click Google sign-in
  await page.getByRole("button", { name: /google/i }).click();

  // Wait for Google OAuth to complete and redirect back to the app.
  // This gives you 60 seconds to complete the Google login flow.
  await page.waitForURL(`${BASE}/app/**`, { timeout: 60_000 });

  // Set the active workspace in localStorage so the app starts in Nova Search
  await page.evaluate((wsId) => {
    localStorage.setItem("workeros.activeWorkspaceId", wsId);
  }, WORKSPACE_ID);

  // Verify we're actually logged in (sidebar should show workers nav)
  await expect(page.getByRole("link", { name: /workers/i }).first()).toBeVisible({ timeout: 10_000 });

  // Save session
  await page.context().storageState({ path: ADMIN_STATE });
  console.log("✓ Admin session saved to", ADMIN_STATE);
});

// ---------------------------------------------------------------------------
// Member login
// ---------------------------------------------------------------------------
setup("authenticate as member", async ({ page }) => {
  await page.goto(`${BASE}/app/login`);

  // NOTE: After clicking Google sign-in, make sure to select the MEMBER
  // account (vivekbs.10@gmail.com), not the admin account.
  await page.getByRole("button", { name: /google/i }).click();

  await page.waitForURL(`${BASE}/app/**`, { timeout: 60_000 });

  // Set the active workspace to Nova Search
  await page.evaluate((wsId) => {
    localStorage.setItem("workeros.activeWorkspaceId", wsId);
  }, WORKSPACE_ID);

  await expect(page.getByRole("link", { name: /workers/i }).first()).toBeVisible({ timeout: 10_000 });

  await page.context().storageState({ path: MEMBER_STATE });
  console.log("✓ Member session saved to", MEMBER_STATE);
});
