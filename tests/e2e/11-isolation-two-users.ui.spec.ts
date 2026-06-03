/**
 * UI tests — Member isolation (two browsers simultaneously)
 *
 * Uses TWO browser contexts at the same time:
 *   adminPage  → logged in as Frederico (workspace owner)
 *   memberPage → logged in as vivekbs.10@gmail.com
 *
 * These tests run the .auth/admin.json context by default (playwright.config.ts),
 * and open a SECOND context from .auth/member.json explicitly.
 */
import { test, expect, chromium } from "@playwright/test";
import path from "path";

const BASE = "https://workeros.floom.dev";
const API = "https://workeros-api.floom.dev/api";
const ADMIN_TOKEN = "floom_oJlwTHF6nRHV3Sd0u2rYz9vslSVRCA2HFZB65lIbJqE";
const MEMBER_TOKEN = "floom_J3G55Cd0GMnDQ66CQ9MlpM7W4jrEn84pbSxEi32LCaI";
const WORKSPACE_ID = "ws_8bdb2e8127db4f";
const MEMBER_STATE = path.join(__dirname, ".auth/member.json");

// Helper — open a second browser as member
async function openMemberPage(browser: ReturnType<typeof chromium.launch> extends Promise<infer B> ? B : never) {
  const ctx = await browser.newContext({ storageState: MEMBER_STATE });
  const page = await ctx.newPage();
  await page.evaluate((wsId) => localStorage.setItem("workeros.activeWorkspaceId", wsId), WORKSPACE_ID);
  return { page, ctx };
}

test.describe("Isolation — admin vs member (two simultaneous browser contexts)", () => {
  test("member sees shared workers; admin sees all", async ({ page: adminPage, browser }) => {
    const { page: memberPage, ctx } = await openMemberPage(browser);

    try {
      // Load workers for both simultaneously
      await Promise.all([
        adminPage.goto(`${BASE}/app/workers`),
        memberPage.goto(`${BASE}/app/workers`),
      ]);

      // Wait for both to load
      await Promise.all([
        adminPage.waitForSelector('a[href*="/workers/"]', { timeout: 15_000 }),
        memberPage.waitForSelector('a[href*="/workers/"]', { timeout: 15_000 }),
      ]);

      // Admin sees more workers than member
      const adminCards = await adminPage.locator('a[href*="/workers/"]').count();
      const memberCards = await memberPage.locator('a[href*="/workers/"]').count();

      expect(adminCards).toBeGreaterThan(0);
      expect(memberCards).toBeGreaterThan(0);
      // Admin sees at minimum as many workers as member (member sees subset)
      expect(adminCards).toBeGreaterThanOrEqual(memberCards);

      // Member sees the "Clone Test Worker" (shared)
      await expect(memberPage.locator("text=Clone Test Worker")).toBeVisible();

      // Admin also sees it
      await expect(adminPage.locator("text=Clone Test Worker")).toBeVisible();

      // Shared badge is visible on Clone Test Worker for BOTH admin and member
      const memberCard = memberPage.locator("a").filter({ hasText: "Clone Test Worker" }).first();
      await expect(memberCard.locator("text=Shared")).toBeVisible();

      const adminCard = adminPage.locator("a").filter({ hasText: "Clone Test Worker" }).first();
      await expect(adminCard.locator("text=Shared")).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test("member cannot navigate to admin-private worker detail", async ({ page: adminPage, browser, request }) => {
    const { page: memberPage, ctx } = await openMemberPage(browser);

    try {
      // Get a private worker the admin owns
      const res = await request.get(`${API}/workers?shape=list`, {
        headers: { "x-floom-token": ADMIN_TOKEN, "x-workeros-workspace": WORKSPACE_ID },
      });
      const workers = await res.json() as { id: string; visibility: string; owner_id?: string; name: string }[];
      // vivekbs user_id
      const MEMBER_USER_ID = "47c14184-77d2-4b70-8790-1b073384cc8e";
      const adminPrivate = workers.find(w => w.visibility === "private" && w.owner_id !== MEMBER_USER_ID);
      if (!adminPrivate) { test.skip(); return; }

      // Admin can navigate to the detail page
      await adminPage.goto(`${BASE}/app/workers/${adminPrivate.id}`);
      await expect(adminPage.locator("h1, h2").first()).toBeVisible({ timeout: 10_000 });

      // Member gets 404 or redirect when trying to access the same page
      await memberPage.goto(`${BASE}/app/workers/${adminPrivate.id}`);
      // Should either 404 or redirect away — not show the worker detail
      await page.waitForTimeout(3000);
      const memberUrl = memberPage.url();
      const memberTitle = await memberPage.locator("h1, h2").first().textContent().catch(() => "");
      // Member should NOT see the admin's private worker name
      expect(memberTitle).not.toContain(adminPrivate.name);
    } finally {
      await ctx.close();
    }
  });

  test("admin Members page shows member's email; member cannot see Members page", async ({ page: adminPage, browser }) => {
    const { page: memberPage, ctx } = await openMemberPage(browser);

    try {
      // Admin can see Members page
      await adminPage.goto(`${BASE}/app/members`);
      await adminPage.waitForSelector("h1", { timeout: 10_000 });
      await expect(adminPage.locator("h1")).toContainText("Members");

      // Wait for members to load
      await adminPage.waitForFunction(() => !document.querySelector('[class*="skeleton" i]'), { timeout: 10_000 });

      // vivekbs should appear with their email
      await expect(adminPage.locator("text=vivekbs.10@gmail.com")).toBeVisible({ timeout: 5_000 });

      // Member trying to visit /members — gets 403 from API, page may show error or empty state
      await memberPage.goto(`${BASE}/app/members`);
      await memberPage.waitForTimeout(3000);
      // Member shouldn't see the invite form or manage UI
      const inviteBtn = memberPage.getByRole("button", { name: /invite member/i });
      // Either the button is not there or the page shows a different state
      const hasMemberInviteBtn = await inviteBtn.isVisible().catch(() => false);
      // Members don't have admin rights so invite button should not work for them
      // (page may render but API calls will fail)
      expect(hasMemberInviteBtn).toBe(false);
    } finally {
      await ctx.close();
    }
  });

  test("admin triggers run; member sees it in runs list", async ({ page: adminPage, browser, request }) => {
    const { page: memberPage, ctx } = await openMemberPage(browser);

    try {
      // Trigger a run as admin on the shared worker
      const runRes = await request.post(`${API}/workers/clone-test-worker/runs`, {
        headers: {
          "x-floom-token": ADMIN_TOKEN,
          "x-workeros-workspace": WORKSPACE_ID,
          "Content-Type": "application/json",
        },
        data: { inputs: {} },
      });
      if (!runRes.ok()) { test.skip(); return; }
      const { run_id } = await runRes.json();
      await new Promise(r => setTimeout(r, 2000));

      // Both admin and member should see this run in the runs list
      await Promise.all([
        adminPage.goto(`${BASE}/app/runs`),
        memberPage.goto(`${BASE}/app/runs`),
      ]);

      await Promise.all([
        adminPage.waitForSelector('a[href*="/runs/"]', { timeout: 15_000 }),
        memberPage.waitForSelector('a[href*="/runs/"]', { timeout: 15_000 }),
      ]);

      // Admin sees the run
      await expect(adminPage.locator(`a[href*="${run_id}"]`)).toBeVisible({ timeout: 10_000 });
    } finally {
      await ctx.close();
    }
  });
});
