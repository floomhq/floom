/**
 * Feature 1: Workers list visibility badge
 * - Workers list must include `visibility` field on every item
 * - Shared workers have visibility='shared'; private have 'private'
 * - Members only see their own private workers + all shared workers
 */
import { test, expect } from "@playwright/test";
import { API, adminHeaders, memberHeaders, WORKSPACE_ID, MEMBER_USER_ID } from "./api.helpers";

test.describe("Worker visibility field", () => {
  test("admin workers list includes visibility on all items", async ({ request }) => {
    const res = await request.get(`${API}/workers?shape=list`, {
      headers: adminHeaders(),
    });
    expect(res.status()).toBe(200);
    const workers = await res.json();
    expect(Array.isArray(workers)).toBe(true);
    expect(workers.length).toBeGreaterThan(0);
    for (const w of workers) {
      expect(w).toHaveProperty("visibility");
      expect(["private", "shared"]).toContain(w.visibility);
    }
  });

  test("at least one shared worker visible to members", async ({ request }) => {
    const res = await request.get(`${API}/workers?shape=list`, {
      headers: memberHeaders(),
    });
    expect(res.status()).toBe(200);
    const workers = await res.json();
    const shared = workers.filter((w: { visibility: string }) => w.visibility === "shared");
    expect(shared.length).toBeGreaterThan(0);
  });

  test("member cannot see other users' private workers", async ({ request }) => {
    const memberRes = await request.get(`${API}/workers?shape=list`, { headers: memberHeaders() });
    expect(memberRes.status()).toBe(200);
    const memberWorkers = await memberRes.json() as { id: string; visibility: string; owner_id?: string }[];
    // Every private worker in member's list must belong to the member themselves.
    // Members cannot see other users' private workers — only shared workers or their own.
    for (const w of memberWorkers) {
      if (w.visibility === "private") {
        expect(w.owner_id).toBe(MEMBER_USER_ID);
      }
    }
  });

  test("set visibility via PATCH and verify list reflects change", async ({ request }) => {
    // Get any private admin worker
    const listRes = await request.get(`${API}/workers?shape=list`, { headers: adminHeaders() });
    const workers = await listRes.json() as { id: string; visibility: string }[];
    const privateWorker = workers.find(w => w.visibility === "private");
    if (!privateWorker) { test.skip(); return; }

    // Mark it shared
    const patchRes = await request.patch(`${API}/workers/${privateWorker.id}/visibility`, {
      headers: adminHeaders(),
      data: { visibility: "shared" },
    });
    expect(patchRes.status()).toBe(200);

    // Verify list now shows shared
    const afterRes = await request.get(`${API}/workers?shape=list`, { headers: adminHeaders() });
    const after = await afterRes.json() as { id: string; visibility: string }[];
    const updated = after.find(w => w.id === privateWorker.id);
    expect(updated?.visibility).toBe("shared");

    // Revert
    await request.patch(`${API}/workers/${privateWorker.id}/visibility`, {
      headers: adminHeaders(),
      data: { visibility: "private" },
    });
  });
});
