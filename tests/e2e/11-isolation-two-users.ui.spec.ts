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
import { test, expect, chromium, Browser } from "@playwright/test";
import path from "path";
import { API, BASE, ADMIN_TOKEN, MEMBER_TOKEN, WORKSPACE_ID } from "./api.helpers";
const MEMBER_STATE = path.join(__dirname, ".auth/member.json");

// Helper — open a second browser context as member
async function openMemberPage(browser: Browser) {
  const ctx = await browser.newContext({ storageState: MEMBER_STATE });
  // addInitScript runs before any page load — safe even on about:blank
  await ctx.addInitScript((wsId: string) => {
    localStorage.setItem("workeros.activeWorkspaceId", wsId);
  }, WORKSPACE_ID);
  await ctx.addCookies([{
    name: "workeros_active_workspace",
    value: WORKSPACE_ID,
    domain: "workeros.floom.dev",
    path: "/",
    secure: true,
    sameSite: "Lax" as const,
  }]);
  const page = await ctx.newPage();
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

      // Wait for worker cards (have <h3> inside — excludes sidebar nav link)
      await Promise.all([
        adminPage.waitForSelector('a[href*="/workers/"] h3', { timeout: 20_000 }),
        memberPage.waitForSelector('a[href*="/workers/"] h3', { timeout: 20_000 }),
      ]);

      // Count actual worker cards (those with h3 title inside)
      const adminCards = await adminPage.locator('a[href*="/workers/"]:has(h3)').count();
      const memberCards = await memberPage.locator('a[href*="/workers/"]:has(h3)').count();

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
      await expect(memberCard.locator("text=Shared").first()).toBeVisible();

      const adminCard = adminPage.locator("a").filter({ hasText: "Clone Test Worker" }).first();
      await expect(adminCard.locator("text=Shared").first()).toBeVisible();
    } finally {
      await ctx.close();
    }
  });

  test("member cannot navigate to admin-private worker detail", async ({ page: adminPage, browser, request }) => {
    test.setTimeout(70_000);
    const { page: memberPage, ctx } = await openMemberPage(browser);

    try {
      // Get a private worker the admin owns
      const res = await request.get(`${API}/workers?shape=list`, {
        headers: { "x-floom-token": ADMIN_TOKEN, "x-workeros-workspace": WORKSPACE_ID },
      });
      const workers = await res.json() as { id: string; visibility: string; owner_id?: string; name: string }[];
      const MEMBER_USER_ID = "52b79094-b1aa-40de-b3cb-c4c189052059"; // gohigh3242@gmail.com
      const adminPrivate = workers.find(w => w.visibility === "private" && w.owner_id !== MEMBER_USER_ID);
      if (!adminPrivate) { test.skip(); return; }

      // Admin can navigate to the detail page
      await adminPage.goto(`${BASE}/app/workers/${adminPrivate.id}`);
      await expect(adminPage.locator("h1, h2").first()).toBeVisible({ timeout: 20_000 });

      // Member gets 404 or redirect when trying to access the same page
      await memberPage.goto(`${BASE}/app/workers/${adminPrivate.id}`);
      // Should either 404 or redirect away — not show the worker detail
      await memberPage.waitForTimeout(3000);
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

      // gohigh3242 should appear with their email
      await expect(adminPage.locator("text=gohigh3242@gmail.com")).toBeVisible({ timeout: 5_000 });

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

      // Filter by worker_id so the specific run is on the first page
      const runsUrl = `${BASE}/app/runs?worker_id=clone-test-worker`;
      await Promise.all([
        adminPage.goto(runsUrl),
        memberPage.goto(runsUrl),
      ]);

      await Promise.all([
        adminPage.waitForSelector('a[href*="/runs/"]:has(span)', { timeout: 20_000 }),
        memberPage.waitForSelector('a[href*="/runs/"]:has(span)', { timeout: 20_000 }),
      ]);

      // Admin sees the run
      await expect(adminPage.locator(`a[href*="${run_id}"]`)).toBeVisible({ timeout: 10_000 });
      // Member also sees the run (shared worker — visible to all workspace members)
      await expect(memberPage.locator(`a[href*="${run_id}"]`)).toBeVisible({ timeout: 10_000 });
    } finally {
      await ctx.close();
    }
  });
});
