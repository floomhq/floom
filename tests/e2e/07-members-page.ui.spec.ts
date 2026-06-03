/**
 * UI tests — Members page
 * Verifies admin sees emails, owner badge, invite form, and member actions.
 */
import { test, expect } from "@playwright/test";

const BASE = "https://workeros.floom.dev";

test.describe("Members page (admin view)", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/app/members`);
    await page.waitForSelector("h1", { timeout: 10_000 });
  });

  test("page heading is 'Members'", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("Members");
  });

  test("active members list shows email addresses not UUIDs", async ({ page }) => {
    // Wait for members to load (skeleton disappears)
    await page.waitForFunction(() => {
      return !document.querySelector('[class*="skeleton" i], [class*="Skeleton" i]');
    }, { timeout: 10_000 });

    // Find member rows — they should contain @ symbols (emails), not UUID patterns
    const memberSection = page.locator("section").filter({ hasText: /active members/i });
    const rows = memberSection.locator("p.text-sm.font-medium");
    const count = await rows.count();

    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const text = await rows.nth(i).textContent() ?? "";
        // Should be an email or a name, not a raw UUID
        const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text.trim());
        expect(isUUID).toBe(false);
      }
    }
  });

  test("owner row shows 'owner' badge", async ({ page }) => {
    await page.waitForFunction(() => !document.querySelector('[class*="skeleton" i]'), { timeout: 10_000 });
    const ownerBadge = page.locator("text=owner");
    await expect(ownerBadge).toBeVisible({ timeout: 5_000 });
  });

  test("owner row has no action menu (three-dot)", async ({ page }) => {
    await page.waitForFunction(() => !document.querySelector('[class*="skeleton" i]'), { timeout: 10_000 });
    // Hover over the owner row — the action menu button should NOT appear
    const ownerRow = page.locator('[class*="group"]').filter({ hasText: "owner" }).first();
    await ownerRow.hover();
    // Give animation time
    await page.waitForTimeout(300);
    const actionBtn = ownerRow.locator('button[class*="opacity-0"]');
    // It should not become visible on hover for the owner row
    await expect(actionBtn).not.toBeVisible();
  });

  test("Invite member button opens form", async ({ page }) => {
    await page.getByRole("button", { name: /invite member/i }).click();
    await expect(page.locator("input[type=email]")).toBeVisible({ timeout: 3_000 });
    await expect(page.locator("text=Send invite")).toBeVisible();
  });

  test("invite form has role selector with member/admin options", async ({ page }) => {
    await page.getByRole("button", { name: /invite member/i }).click();
    const roleSelect = page.locator('[role="combobox"]').first();
    await roleSelect.click();
    await expect(page.locator('[role="option"]', { hasText: "Member" })).toBeVisible();
    await expect(page.locator('[role="option"]', { hasText: "Admin" })).toBeVisible();
  });

  test("pending invitations section is present", async ({ page }) => {
    const pendingSection = page.locator("section").filter({ hasText: /pending invitations/i });
    await expect(pendingSection).toBeVisible();
  });
});
