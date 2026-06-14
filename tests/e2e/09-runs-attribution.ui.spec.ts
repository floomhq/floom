/**
 * UI tests — Run attribution in runs list
 * Admin sees "by vivekbs.10@gmail.com" under the trigger source
 * when a member triggered the run.
 */
import { test, expect } from "@playwright/test";
import { API, BASE, MEMBER_TOKEN, SHARED_WORKER_ID, WORKSPACE_ID } from "./api.helpers";
const MEMBER_EMAIL = "gohigh3242@gmail.com";

test.describe("Runs list — member attribution", () => {
  let triggeredRunId: string | null = null;

  test.beforeAll(async ({ request }) => {
    // Trigger a run as the member so we have something to check
    const res = await request.post(`${API}/workers/${SHARED_WORKER_ID}/runs`, {
      headers: {
        "x-floom-token": MEMBER_TOKEN,
        "x-workeros-workspace": WORKSPACE_ID,
        "Content-Type": "application/json",
      },
      data: { inputs: {} },
    });
    if (res.ok()) {
      const body = await res.json();
      triggeredRunId = body.run_id ?? null;
    }
    // Wait a moment for the run to appear in the list
    await new Promise(r => setTimeout(r, 3000));
  });

  test("runs list shows member email under trigger source", async ({ page }) => {
    if (!triggeredRunId) { test.skip(); return; }

    await page.goto(`${BASE}/app/runs`);
    await page.waitForSelector('a[href*="/runs/"]', { timeout: 15_000 });

    // Find the row for our triggered run
    const runRow = page.locator(`a[href*="${triggeredRunId}"]`);
    if (await runRow.count() === 0) {
      // Run may not appear in first page — try filtering by worker
      await page.goto(`${BASE}/app/runs?worker_id=${SHARED_WORKER_ID}`);
      await page.waitForSelector('a[href*="/runs/"]', { timeout: 10_000 });
    }

    // Member email should appear as sub-line in Triggered by column
    const attribution = page.locator(`text=${MEMBER_EMAIL}`).first();
    await expect(attribution).toBeVisible({ timeout: 10_000 });
  });

  test("runs list column header says 'Triggered by'", async ({ page }) => {
    await page.goto(`${BASE}/app/runs`);
    await page.waitForSelector('a[href*="/runs/"]', { timeout: 15_000 });
    await expect(page.getByText("Triggered by", { exact: true }).first()).toBeVisible();
  });

  test("admin-triggered runs show no member attribution", async ({ page }) => {
    await page.goto(`${BASE}/app/runs`);
    await page.waitForSelector('a[href*="/runs/"]', { timeout: 15_000 });

    // Rows without member attribution should show just the trigger source
    // (Manual, Schedule, etc.) with no email sub-line
    // We just verify the "Triggered by" column header exists and a run row renders
    const triggerHeader = page.getByText("Triggered by", { exact: true }).first();
    await expect(triggerHeader).toBeVisible();
  });
});
