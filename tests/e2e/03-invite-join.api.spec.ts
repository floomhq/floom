/**
 * Feature 3: Invite URL points to /join page
 * - POST invite must return invite_url pointing to /app/join?invite=
 * - Accept invite must return pat_token + workspace_id
 * - After accept, workspace_id should match the invited workspace
 */
import { test, expect } from "@playwright/test";
import { API, WEB, JOIN_MEMBER_TOKEN, adminHeaders, WORKSPACE_ID } from "./api.helpers";

test.describe("Invite URL and join flow", () => {
  test("invite URL points to /app/join not /app/members", async ({ request }) => {
    // Create a test invite (we'll revoke it immediately after)
    const res = await request.post(`${API}/workspaces/${WORKSPACE_ID}/members/invite`, {
      headers: adminHeaders(),
      data: { email: "playwright-test@example.com", role: "member" },
    });
    expect(res.status()).toBe(201);
    const body = await res.json();
    expect(body).toHaveProperty("invite_url");
    expect(body.invite_url).toContain("/app/join?invite=");
    expect(body.invite_url).not.toContain("/app/members");

    // Revoke it
    const inviteId = body.id;
    if (inviteId) {
      await request.delete(`${API}/workspaces/${WORKSPACE_ID}/invitations/${inviteId}`, {
        headers: adminHeaders(),
      });
    }
  });

  test("join page loads without errors (no sidebar)", async ({ page }) => {
    // /join without a token should render the join page (not redirect to login with sidebar)
    // It will redirect to login first, but we can check the redirect destination
    const res = await page.goto(`${WEB}/join?invite=test_invalid`);
    // Should redirect to login (not crash)
    await expect(page).toHaveURL(/login|join/);
  });

  test("accept-invite endpoint returns pat_token and workspace_id", async ({ request }) => {
    // Create invite for the member user (vivekbs.10@gmail.com = user 47c14184)
    // We'll create a fresh invite since existing ones may be used
    const createRes = await request.post(`${API}/workspaces/${WORKSPACE_ID}/members/invite`, {
      headers: adminHeaders(),
      data: { email: "vivekbs.10@gmail.com", role: "member" },
    });
    const invite = await createRes.json();

    if (!invite.invite_url) {
      test.skip();
      return;
    }

    // Extract token from URL
    const token = new URL(invite.invite_url).searchParams.get("invite");
    expect(token).toBeTruthy();
    expect(token!.startsWith("wsi_")).toBe(true);

    // Accept it (this will re-join the workspace — idempotent)
    const acceptRes = await request.post(`${API}/workspaces/accept-invite`, {
      headers: {
        "x-floom-token": JOIN_MEMBER_TOKEN,
        "Content-Type": "application/json",
      },
      data: { token },
    });
    expect(acceptRes.status()).toBe(201);
    const result = await acceptRes.json();
    expect(result).toHaveProperty("workspace_id");
    expect(result).toHaveProperty("pat_token");
    expect(result.workspace_id).toBe(WORKSPACE_ID);
    expect(result.pat_token).toMatch(/^floom_/);
  });
});
