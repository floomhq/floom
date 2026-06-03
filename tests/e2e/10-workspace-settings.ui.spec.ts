/**
 * UI tests — Settings page, Workspace tab
 */
import { test, expect } from "@playwright/test";

const BASE = "https://workeros.floom.dev";
const ORIGINAL_NAME = "Nova Search";

test.describe("Settings — Workspace tab", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/app/settings`);
    await page.waitForSelector('[role="tablist"]', { timeout: 10_000 });
    await page.waitForLoadState("networkidle");
  });

  test("Workspace is the first tab and active by default", async ({ page }) => {
    const workspaceTab = page.getByRole("tab", { name: /workspace/i }).first();
    await expect(workspaceTab).toBeVisible();
    const dataState = await workspaceTab.getAttribute("data-state");
    const ariaSelected = await workspaceTab.getAttribute("aria-selected");
    expect(dataState === "active" || ariaSelected === "true").toBe(true);
  });

  test("workspace tab shows current workspace name", async ({ page }) => {
    const nameInput = page.locator("input[placeholder='Workspace name']");
    await expect(nameInput).toBeVisible({ timeout: 8_000 });
    const value = await nameInput.inputValue();
    expect(value.length).toBeGreaterThan(0);
  });

  test("can rename workspace and it saves", async ({ page }) => {
    const nameInput = page.locator("input[placeholder='Workspace name']");
    await expect(nameInput).toBeVisible({ timeout: 8_000 });
    // Wait for the workspace name to be loaded (not empty)
    await expect(nameInput).not.toHaveValue("", { timeout: 8_000 });

    // Triple-click to select all, then pressSequentially fires real key events React detects
    await nameInput.click({ clickCount: 3 });
    await nameInput.pressSequentially("Nova Search Test");

    const renameBtn = page.getByRole("button", { name: /rename/i });
    await expect(renameBtn).toBeEnabled({ timeout: 5_000 });
    await renameBtn.click();

    await expect(page.getByText("Workspace renamed")).toBeVisible({ timeout: 8_000 });
    await expect(nameInput).toHaveValue("Nova Search Test");

    // Restore
    await nameInput.click({ clickCount: 3 });
    await nameInput.pressSequentially(ORIGINAL_NAME);
    await page.getByRole("button", { name: /rename/i }).click();
    await expect(page.getByText("Workspace renamed")).toBeVisible({ timeout: 8_000 });
  });

  test("rename button disabled when name unchanged", async ({ page }) => {
    await expect(page.locator("input[placeholder='Workspace name']")).toBeVisible({ timeout: 8_000 });
    await expect(page.getByRole("button", { name: /rename/i })).toBeDisabled();
  });

  test("team section shows member count", async ({ page }) => {
    // The Members row shows "X active members/member"
    await expect(page.getByText(/active member/i).first()).toBeVisible({ timeout: 10_000 });
  });

  test("Manage → link goes to /members", async ({ page }) => {
    await page.locator("text=Manage →").click();
    await expect(page).toHaveURL(/\/members/, { timeout: 5_000 });
  });

  test("all other tabs still accessible", async ({ page }) => {
    for (const tabName of ["API access", "System", "Appearance", "Data", "Danger zone"]) {
      const tab = page.getByRole("tab", { name: tabName }).first();
      await tab.click();
      await expect(async () => {
        const dataState = await tab.getAttribute("data-state");
        const ariaSelected = await tab.getAttribute("aria-selected");
        expect(dataState === "active" || ariaSelected === "true").toBe(true);
      }).toPass({ timeout: 5_000 });
    }
  });
});
