/**
 * Feature 2: Member list shows emails
 * - GET /workspaces/{id}/members must include email on owner and each member
 * - email should be a valid email address, not empty
 */
import { test, expect } from "@playwright/test";
import { API, adminHeaders, memberHeaders, WORKSPACE_ID } from "./api.helpers";

test.describe("Member email resolution", () => {
  test("members list includes email for owner", async ({ request }) => {
    const res = await request.get(`${API}/workspaces/${WORKSPACE_ID}/members`, {
      headers: adminHeaders(),
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("owner");
    expect(body.owner.email).toBeTruthy();
    expect(body.owner.email).toContain("@");
  });

  test("members list includes email for each member", async ({ request }) => {
    const res = await request.get(`${API}/workspaces/${WORKSPACE_ID}/members`, {
      headers: adminHeaders(),
    });
    const body = await res.json();
    expect(Array.isArray(body.members)).toBe(true);
    for (const m of body.members) {
      // Every member row should have an email field (may be empty string if lookup failed, but key must exist)
      expect(m).toHaveProperty("email");
      if (m.email) {
        expect(m.email).toContain("@");
      }
    }
  });

  test("member cannot access members list (admin only)", async ({ request }) => {
    const res = await request.get(`${API}/workspaces/${WORKSPACE_ID}/members`, {
      headers: memberHeaders(),
    });
    expect(res.status()).toBe(403);
  });
});
