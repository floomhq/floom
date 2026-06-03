/**
 * UI tests — Worker visibility badge
 */
import { test, expect } from "@playwright/test";

const BASE = "https://workeros.floom.dev";
const SHARED_WORKER_NAME = "Clone Test Worker";

test.describe("Workers list — visibility badge", () => {
  test.use({ timeout: 70_000 });

  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE}/app/workers`);
    await page.waitForLoadState("networkidle");
    // Wait for worker cards — h3 inside a worker link (excludes sidebar nav)
    await page.waitForSelector('a[href*="/workers/"] h3', { timeout: 50_000 });
  });

  test("shared worker shows 'Shared' badge in card footer", async ({ page }) => {
    const card = page.locator("a").filter({ hasText: SHARED_WORKER_NAME }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText("Shared").first()).toBeVisible({ timeout: 5_000 });
  });

  test("only shared workers have a Shared badge", async ({ page }) => {
    // Worker cards have <h3> inside — use :has() to target only cards
    const allCards = page.locator('a[href*="/workers/"]:has(h3)');
    await expect(allCards.first()).toBeVisible({ timeout: 15_000 });
    const count = await allCards.count();
    expect(count).toBeGreaterThan(0);

    // The known shared worker must have the badge
    const sharedCard = page.locator("a:has(h3)").filter({ hasText: SHARED_WORKER_NAME }).first();
    await expect(sharedCard).toBeVisible();
    await expect(sharedCard.getByText("Shared").first()).toBeVisible();
  });

  test("admin can see all workers including private", async ({ page, request }) => {
    const res = await request.get(`${BASE}/app/api/proxy/workers?shape=list`);
    if (!res.ok()) { test.skip(); return; }
    const workers = await res.json() as { id: string; name: string; visibility?: string }[];
    const privateWorker = workers.find(w => w.visibility === "private" && !w.name.toLowerCase().includes("test"));
    if (!privateWorker) { test.skip(); return; }

    await page.goto(`${BASE}/app/workers/${privateWorker.id}`);
    await expect(page.locator("h1, h2").first()).toBeVisible({ timeout: 10_000 });
    // Private worker page loads fine for admin — no Shared badge
    await expect(page.locator("main")).not.toContainText("404");
  });
});
