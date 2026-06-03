/**
 * Auth setup — run ONCE with:
 *   npx playwright test --project=setup --headed
 *
 * Two browser windows open sequentially.
 * Log in with Google in each — Playwright saves the session.
 *
 * Saved to:
 *   tests/e2e/.auth/admin.json   (Frederico — workspace owner)
 *   tests/e2e/.auth/member.json  (vivekbs.10@gmail.com — workspace member)
 *
 * Re-run only when sessions expire.
 */
import { test as setup, expect } from "@playwright/test";
import path from "path";

const BASE = "https://workeros.floom.dev";
const WORKSPACE_ID = "ws_8bdb2e8127db4f";
const ADMIN_STATE  = path.join(__dirname, ".auth/admin.json");
const MEMBER_STATE = path.join(__dirname, ".auth/member.json");

async function loginAndSave(page: any, label: string, statePath: string) {
  console.log(`\n=== ${label} ===`);
  console.log(`Opening login page — click "Continue with Google" and sign in.`);
  console.log(`Waiting up to 2 minutes for you to complete Google sign-in...\n`);

  await page.goto(`${BASE}/app/login`);

  // The Google button is an <a> tag, not a <button>
  const googleLink = page.locator("a").filter({ hasText: /continue with google/i });
  await expect(googleLink).toBeVisible({ timeout: 10_000 });
  await googleLink.click();

  // Wait for Google OAuth to complete and land back on the app.
  // This can take up to 2 minutes depending on Google's flow.
  await page.waitForFunction(
    () => {
      const url = window.location.href;
      return (
        url.includes("workeros.floom.dev/app") &&
        !url.includes("/login") &&
        !url.includes("accounts.google") &&
        !url.includes("oauth") &&
        !url.includes("callback")
      );
    },
    { timeout: 120_000, polling: 1000 }
  );

  console.log(`✓ Logged in — landed at: ${page.url()}`);

  // Set active workspace
  await page.evaluate((wsId: string) => {
    localStorage.setItem("workeros.activeWorkspaceId", wsId);
  }, WORKSPACE_ID);

  // Wait for the main UI to be ready
  await page.waitForSelector('nav, aside, [class*="sidebar" i]', { timeout: 15_000 });

  // Save session state
  await page.context().storageState({ path: statePath });
  console.log(`✓ Session saved to ${statePath}\n`);
}

setup("authenticate as admin", async ({ page }) => {
  await loginAndSave(page, "ADMIN LOGIN (Frederico — workspace owner)", ADMIN_STATE);
});

setup("authenticate as member", async ({ page }) => {
  console.log("\n>>> IMPORTANT: In this window, sign in as vivekbs.10@gmail.com (the MEMBER account) <<<\n");
  await loginAndSave(page, "MEMBER LOGIN (vivekbs.10@gmail.com)", MEMBER_STATE);
});
