/**
 * Auth setup — run ONCE:
 *   npx playwright test --project=setup
 *
 * Reads credentials from .env.test (gitignored):
 *   PLAYWRIGHT_ADMIN_EMAIL / PLAYWRIGHT_ADMIN_PASSWORD
 *   PLAYWRIGHT_MEMBER_EMAIL / PLAYWRIGHT_MEMBER_PASSWORD
 *
 * Saves sessions to tests/e2e/.auth/ — rerun only when sessions expire.
 */
import { test as setup } from "@playwright/test";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config({ path: path.join(__dirname, "../../.env.test") });

const BASE = "https://workeros.floom.dev";
const WORKSPACE_ID = "ws_8bdb2e8127db4f";
const ADMIN_STATE  = path.join(__dirname, ".auth/admin.json");
const MEMBER_STATE = path.join(__dirname, ".auth/member.json");

async function loginAndSave(page: any, email: string, password: string, stateFile: string) {
  if (!email || !password) throw new Error(`Missing credentials for ${stateFile}`);

  await page.goto(`${BASE}/app/login?mode=signin`);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill(password);
  await page.locator('form button[type="submit"]').click();

  // Wait until redirected into the app
  await page.waitForFunction(
    () => window.location.href.includes("workeros.floom.dev/app") && !window.location.href.includes("/login"),
    { timeout: 30_000, polling: 500 }
  );

  // Pin to Nova Search workspace
  await page.evaluate((wsId: string) => {
    localStorage.setItem("workeros.activeWorkspaceId", wsId);
  }, WORKSPACE_ID);

  await page.waitForSelector("nav, aside", { timeout: 10_000 });

  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  await page.context().storageState({ path: stateFile });
  console.log(`✓ ${email} → ${stateFile}`);
}

setup("authenticate as admin", async ({ page }) => {
  await loginAndSave(
    page,
    process.env.PLAYWRIGHT_ADMIN_EMAIL ?? "",
    process.env.PLAYWRIGHT_ADMIN_PASSWORD ?? "",
    ADMIN_STATE
  );
});

setup("authenticate as member", async ({ page }) => {
  await loginAndSave(
    page,
    process.env.PLAYWRIGHT_MEMBER_EMAIL ?? "",
    process.env.PLAYWRIGHT_MEMBER_PASSWORD ?? "",
    MEMBER_STATE
  );
});
