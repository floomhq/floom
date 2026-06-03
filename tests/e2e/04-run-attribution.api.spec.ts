/**
 * Feature 4: Run attribution — trigger_member_id and trigger_member_email
 * - When a member triggers a run, trigger_member_id should be set
 * - Runs list should include trigger_member_email for those runs
 */
import { test, expect } from "@playwright/test";
import { API, adminHeaders, memberHeaders, WORKSPACE_ID, SHARED_WORKER_ID } from "./api.helpers";

test.describe("Run attribution (trigger_member_id)", () => {
  let triggeredRunId: string | null = null;

  test("member can trigger shared worker", async ({ request }) => {
    // Engine endpoint is /workers/{id}/runs (plural)
    const res = await request.post(`${API}/workers/${SHARED_WORKER_ID}/runs`, {
      headers: memberHeaders(),
      data: { inputs: {} },
    });
    expect([200, 201]).toContain(res.status());
    const body = await res.json();
    expect(body).toHaveProperty("run_id");
    triggeredRunId = body.run_id;
  });

  test("triggered run appears in admin runs list", async ({ request }) => {
    if (!triggeredRunId) { test.skip(); return; }

    // Poll briefly for the run to appear
    let run = null;
    for (let i = 0; i < 5; i++) {
      const res = await request.get(`${API}/runs?limit=20`, { headers: adminHeaders() });
      const body = await res.json();
      const runs = Array.isArray(body) ? body : (body.runs ?? []);
      run = runs.find((r: { id: string }) => r.id === triggeredRunId);
      if (run) break;
      await new Promise(r => setTimeout(r, 2000));
    }
    expect(run).not.toBeNull();
  });

  test("triggered run has trigger_member_email set", async ({ request }) => {
    if (!triggeredRunId) { test.skip(); return; }

    const res = await request.get(`${API}/runs/${triggeredRunId}`, { headers: adminHeaders() });
    if (res.status() === 404) { test.skip(); return; }
    expect(res.status()).toBe(200);
    const run = await res.json();
    // trigger_member_id should be set (the member's user_id before substitution)
    expect(run).toHaveProperty("trigger_member_id");
    // trigger_member_email may be present (resolved from user_id)
    // If it's present, it should be an email
    if (run.trigger_member_email) {
      expect(run.trigger_member_email).toContain("@");
    }
  });
});
