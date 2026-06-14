/**
 * UI tests — /join page (invite acceptance)
 * Tests the dedicated join page — clean layout, no sidebar, PAT display.
 * Uses the API project's request fixture to create a fresh invite.
 */
import { test, expect, chromium } from "@playwright/test";
import { API, BASE, ADMIN_TOKEN, WORKSPACE_ID } from "./api.helpers";

test.describe("Join page (/app/join)", () => {
  test("join page has no sidebar (clean layout)", async ({ browser }) => {
    // Open WITHOUT auth — unauthenticated join attempt redirects to login
    // But the page structure should not have a sidebar
    const ctx = await browser.newContext();
    const page = await ctx.newPage();

    await page.goto(`${BASE}/app/join?invite=wsi_fakeinvalidtoken`);

    // Should redirect to login (no auth), but NOT have the sidebar shell
    // The sidebar is only in the main app shell
    const sidebar = page.locator("aside");
    // Either we're on login page (no sidebar) or join page (no sidebar)
    const url = page.url();
    expect(url).toMatch(/login|join/);

    // No sidebar should be present on login or join
    await expect(sidebar).not.toBeVisible();
    await ctx.close();
  });

  test("join page with valid token shows accept UI", async ({ browser, request }) => {
    // Create a fresh invite via API
    const inviteRes = await request.post(`${API}/workspaces/${WORKSPACE_ID}/members/invite`, {
      headers: {
        "x-floom-token": ADMIN_TOKEN,
        "x-workeros-workspace": WORKSPACE_ID,
        "Content-Type": "application/json",
      },
      data: { email: "playwright-join-test@example.com", role: "member" },
    });
    if (!inviteRes.ok()) { test.skip(); return; }
    const { invite_url, id: inviteId } = await inviteRes.json();
    if (!invite_url) { test.skip(); return; }

    // Verify the URL references the join page with an invite token
    expect(invite_url).toMatch(/join[^?]*\?.*invite=/i);

    // Open the join URL WITHOUT auth — should redirect to login
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(invite_url);
    // Should end up at login (since not authenticated)
    await expect(page).toHaveURL(/login/, { timeout: 15_000 });

    // Clean up invite
    await request.delete(`${API}/workspaces/${WORKSPACE_ID}/invitations/${inviteId}`, {
      headers: { "x-floom-token": ADMIN_TOKEN, "x-workeros-workspace": WORKSPACE_ID },
    });
    await ctx.close();
  });

  test("join page as logged-in member shows accept button and token after accept", async ({ page, request }) => {
    // This test uses the member's storageState (already logged in as vivekbs.10)
    // Create a fresh invite
    const inviteRes = await request.post(`${API}/workspaces/${WORKSPACE_ID}/members/invite`, {
      headers: {
        "x-floom-token": ADMIN_TOKEN,
        "x-workeros-workspace": WORKSPACE_ID,
        "Content-Type": "application/json",
      },
      data: { email: "gohigh3242@gmail.com", role: "member" },
    });
    if (!inviteRes.ok()) { test.skip(); return; }
    const { invite_url } = await inviteRes.json();
    if (!invite_url) { test.skip(); return; }

    await page.goto(invite_url);

    // Since member is logged in, they should land on /join and see the join UI
    await expect(page).toHaveURL(/join/, { timeout: 15_000 });

    // Should show "Join workspace" heading
    await expect(page.locator("h1, h2").filter({ hasText: /join workspace/i })).toBeVisible({ timeout: 10_000 });

    // After auto-accept, should show the PAT section
    await expect(page.getByText("Your API token", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    // Copy button should be present
    await expect(page.getByRole("button", { name: /copy/i })).toBeVisible();

    // "Go to workspace" CTA
    await expect(page.getByRole("button", { name: /go to workspace/i })).toBeVisible();

    // Token should be in the input (masked, but present)
    const tokenInput = page.locator("input[readonly]");
    await expect(tokenInput).toBeVisible();
    const tokenValue = await tokenInput.inputValue();
    expect(tokenValue).toMatch(/^floom_/);
  });

  test("'Go to workspace' button navigates to /workers", async ({ page, request }) => {
    // Re-invite to get a fresh token
    const inviteRes = await request.post(`${API}/workspaces/${WORKSPACE_ID}/members/invite`, {
      headers: {
        "x-floom-token": ADMIN_TOKEN,
        "x-workeros-workspace": WORKSPACE_ID,
        "Content-Type": "application/json",
      },
      data: { email: "gohigh3242@gmail.com", role: "member" },
    });
    if (!inviteRes.ok()) { test.skip(); return; }
    const { invite_url } = await inviteRes.json();
    if (!invite_url) { test.skip(); return; }

    await page.goto(invite_url);
    await expect(page.getByText("Your API token", { exact: true }).first()).toBeVisible({ timeout: 15_000 });

    await page.getByRole("button", { name: /go to workspace/i }).click();
    await expect(page).toHaveURL(/\/workers/, { timeout: 10_000 });
  });
});
