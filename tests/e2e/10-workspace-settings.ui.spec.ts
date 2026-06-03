/**
 * UI tests — Settings page, Workspace tab
 * Verifies rename form, member count, and link to /members.
 */
import { test, expect } from "@playwright/test";

const BASE = "https://workeros.floom.dev";
const ORIGINAL_NAME = "Nova Search";

test.describe("Settings — Workspace tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/app/settings`);
    await page.waitForSelector('[role="tablist"]', { timeout: 10_000 });
  });

  test("Workspace is the first tab and active by default", async ({ page }) => {
    const workspaceTab = page.getByRole("tab", { name: /workspace/i });
    await expect(workspaceTab).toBeVisible();
    await expect(workspaceTab).toHaveAttribute("data-state", "active");
  });

  test("workspace tab shows current workspace name", async ({ page }) => {
    const nameInput = page.locator("input[placeholder='Workspace name']");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });
    const value = await nameInput.inputValue();
    expect(value.length).toBeGreaterThan(0);
  });

  test("can rename workspace and it saves", async ({ page }) => {
    const nameInput = page.locator("input[placeholder='Workspace name']");
    await expect(nameInput).toBeVisible({ timeout: 5_000 });

    // Clear and type a new name
    await nameInput.fill("Nova Search (UI Test)");
    await page.getByRole("button", { name: /rename/i }).click();

    // Success toast should appear
    await expect(page.locator("text=Workspace renamed")).toBeVisible({ timeout: 5_000 });

    // Input should now show the new name
    await expect(nameInput).toHaveValue("Nova Search (UI Test)");

    // Restore original name
    await nameInput.fill(ORIGINAL_NAME);
    await page.getByRole("button", { name: /rename/i }).click();
    await expect(page.locator("text=Workspace renamed")).toBeVisible({ timeout: 5_000 });
  });

  test("rename button disabled when name unchanged", async ({ page }) => {
    await page.waitForSelector("input[placeholder='Workspace name']", { timeout: 5_000 });
    const renameBtn = page.getByRole("button", { name: /rename/i });
    await expect(renameBtn).toBeDisabled();
  });

  test("team section shows member count", async ({ page }) => {
    // Wait for member count to load
    await page.waitForFunction(() => {
      const team = document.querySelector("section");
      return team && /member/.test(team.textContent ?? "");
    }, { timeout: 8_000 });

    const teamSection = page.locator("section").filter({ hasText: /team/i });
    await expect(teamSection).toBeVisible();
  });

  test("Manage → link goes to /members", async ({ page }) => {
    await page.locator("text=Manage →").click();
    await expect(page).toHaveURL(/\/members/, { timeout: 5_000 });
  });

  test("all other tabs still accessible", async ({ page }) => {
    for (const tabName of ["API access", "System", "Appearance", "Data", "Danger zone"]) {
      await page.getByRole("tab", { name: tabName }).click();
      await expect(page.getByRole("tab", { name: tabName })).toHaveAttribute("data-state", "active");
    }
  });
});
