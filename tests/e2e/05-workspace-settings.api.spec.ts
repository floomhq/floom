/**
 * Feature 5: Workspace settings — rename endpoint
 * - PATCH /workspaces/{id} must be available (owner only)
 * - Rename updates the workspace name
 * - Non-owner gets 404
 */
import { test, expect } from "@playwright/test";
import { API, adminHeaders, memberHeaders, WORKSPACE_ID } from "./api.helpers";

test.describe("Workspace rename", () => {
  const ORIGINAL_NAME = "Nova Search";

  test("owner can rename workspace", async ({ request }) => {
    const res = await request.patch(`${API}/workspaces/${WORKSPACE_ID}`, {
      headers: adminHeaders(),
      data: { name: "Nova Search (renamed)" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.name).toBe("Nova Search (renamed)");

    // Restore
    await request.patch(`${API}/workspaces/${WORKSPACE_ID}`, {
      headers: adminHeaders(),
      data: { name: ORIGINAL_NAME },
    });
  });

  test("rename is reflected in workspace list immediately", async ({ request }) => {
    await request.patch(`${API}/workspaces/${WORKSPACE_ID}`, {
      headers: adminHeaders(),
      data: { name: "Test Name Check" },
    });

    const listRes = await request.get(`${API}/workspaces`, { headers: adminHeaders() });
    const body = await listRes.json();
    const ws = (body.workspaces ?? []).find((w: { id: string }) => w.id === WORKSPACE_ID);
    expect(ws?.name).toBe("Test Name Check");

    // Restore
    await request.patch(`${API}/workspaces/${WORKSPACE_ID}`, {
      headers: adminHeaders(),
      data: { name: ORIGINAL_NAME },
    });
  });

  test("member cannot rename workspace (404)", async ({ request }) => {
    const res = await request.patch(`${API}/workspaces/${WORKSPACE_ID}`, {
      headers: memberHeaders(),
      data: { name: "Hack Attempt" },
    });
    expect(res.status()).toBe(404);
  });

  test("rename validates name length", async ({ request }) => {
    const res = await request.patch(`${API}/workspaces/${WORKSPACE_ID}`, {
      headers: adminHeaders(),
      data: { name: "" },
    });
    expect([400, 422]).toContain(res.status());
  });
});
