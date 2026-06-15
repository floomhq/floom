/**
 * Tests for fix/cloud-session-logout-20260615
 *
 * Root cause: the workeros_cloud_session cookie was set with Max-Age equal to
 * the Supabase access token TTL (~3600 s), so the cookie expired every hour
 * even though the refresh_token inside was valid for 30 days.  Additionally,
 * the proxy never attempted to refresh an expired access_token — it simply
 * returned 401 and the UI redirected to /login.
 *
 * Fix (two parts):
 *   1. apps/api/routes/auth.py — cookie Max-Age changed from `expires_in`
 *      (~3600 s) to _SESSION_COOKIE_MAX_AGE (30 days).
 *   2. web/app/api/proxy/[...path]/route.ts — getAccessToken() now checks
 *      `expires_at` and calls POST /auth/refresh when the access_token is
 *      within REFRESH_GRACE_SECONDS of expiry, then forwards the refreshed
 *      Set-Cookie to the browser.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SESSION_COOKIE = "workeros_cloud_session";
const API_BASE = "https://workeros-api.floom.dev";

function makeCookieValue(overrides: {
  access_token?: string;
  refresh_token?: string;
  expires_at?: number;
  user_id?: string;
}): string {
  const payload = {
    access_token: "valid-jwt",
    refresh_token: "valid-refresh-token",
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user_id: "user-123",
    ...overrides,
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

// Shared mutable cookie state so tests can swap it between calls.
const cookieState = vi.hoisted(() => ({ value: "" }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) =>
      name === SESSION_COOKIE ? { value: cookieState.value } : undefined,
  })),
}));

async function loadRoute() {
  vi.resetModules();
  return import("@/app/api/proxy/[...path]/route");
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("session-refresh-logout fix", () => {
  beforeEach(() => {
    process.env.WORKEROS_API_BASE = API_BASE;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.WORKEROS_API_BASE;
    cookieState.value = "";
  });

  // ─── Backend cookie Max-Age ───────────────────────────────────────────────

  it("auth.py: _SESSION_COOKIE_MAX_AGE must be 30 days (not 3600 s)", async () => {
    // We cannot import Python from TS, so assert against the source text.
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(
      resolve(__dirname, "../../apps/api/routes/auth.py"),
      "utf8",
    );
    // The constant must be defined and equal 30 days in seconds.
    expect(src).toContain("_SESSION_COOKIE_MAX_AGE");
    const match = src.match(/_SESSION_COOKIE_MAX_AGE\s*=\s*([\d\s*]+)/);
    expect(match, "_SESSION_COOKIE_MAX_AGE must be defined in auth.py").toBeTruthy();
    // Evaluate the expression (may be '60 * 60 * 24 * 30').
    const evaluated = Function(`"use strict"; return ${match![1].trim()}`)() as number;
    expect(evaluated).toBe(60 * 60 * 24 * 30); // 2592000 s
  });

  it("auth.py: session-setting call sites use _SESSION_COOKIE_MAX_AGE, not expires_in", async () => {
    const { readFileSync } = await import("fs");
    const { resolve } = await import("path");
    const src = readFileSync(
      resolve(__dirname, "../../apps/api/routes/auth.py"),
      "utf8",
    );
    // Old pattern must be gone.
    expect(src).not.toContain('max(int(getattr(session, "expires_in"');
    // The constant must appear in the file (i.e., the call sites were updated).
    expect(src).toContain("max_age=_SESSION_COOKIE_MAX_AGE");
    // There must be no session cookie _set_cookie call that still uses a raw int.
    // Count occurrences of the new pattern — should be at least 4 (callback,
    // fragment-session, password-login, password-signup) + 1 for /auth/refresh.
    const matches = src.match(/max_age=_SESSION_COOKIE_MAX_AGE/g);
    expect(matches, "must find at least 4 max_age=_SESSION_COOKIE_MAX_AGE usages").toBeTruthy();
    expect(matches!.length).toBeGreaterThanOrEqual(4);
  });

  // ─── Proxy: fresh token (not near expiry) ────────────────────────────────

  it("proxy: passes valid non-expiring token through without refresh", async () => {
    const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
    cookieState.value = makeCookieValue({ access_token: "fresh-jwt", expires_at: futureExpiry });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ workers: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { GET } = await loadRoute();

    const res = await GET(
      new NextRequest(`https://workers.floom.dev/api/proxy/workers`),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    // Only one fetch call — to the upstream workers endpoint, not to /auth/refresh.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(`${API_BASE}/api/workers`);
    expect(res.status).toBe(200);
    // Authorization header carries the original fresh token.
    const authHeader = (fetchMock.mock.calls[0][1] as RequestInit)?.headers as
      | Record<string, string>
      | undefined;
    expect(authHeader?.["Authorization"]).toBe("Bearer fresh-jwt");
  });

  // ─── Proxy: near-expiry token → refresh ──────────────────────────────────

  it("proxy: calls /auth/refresh when access_token is within grace window", async () => {
    // Token expires in 30 s — inside the 60 s grace window.
    const nearExpiry = Math.floor(Date.now() / 1000) + 30;
    cookieState.value = makeCookieValue({
      access_token: "expiring-jwt",
      refresh_token: "rt-good",
      expires_at: nearExpiry,
    });

    const newSessionCookie = makeCookieValue({
      access_token: "rotated-jwt",
      refresh_token: "rt-rotated",
      expires_at: Math.floor(Date.now() / 1000) + 3600,
    });

    let refreshCalled = false;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : (url as Request).url;
        if (urlStr.includes("/auth/refresh")) {
          refreshCalled = true;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: {
              "content-type": "application/json",
              "set-cookie": `${SESSION_COOKIE}=${newSessionCookie}; Path=/; HttpOnly; Secure; SameSite=lax; Max-Age=2592000`,
            },
          });
        }
        // Upstream workers request.
        return new Response(JSON.stringify({ workers: [] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

    const { GET } = await loadRoute();

    const res = await GET(
      new NextRequest(`https://workers.floom.dev/api/proxy/workers`),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    expect(refreshCalled, "proxy must call /auth/refresh for near-expiry token").toBe(true);
    // Two fetches: one to /auth/refresh, one to upstream /api/workers.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(res.status).toBe(200);

    // The rotated access token must be used for the upstream request.
    const upstreamCall = fetchMock.mock.calls.find(
      (c) => !(typeof c[0] === "string" && c[0].includes("/auth/refresh")) &&
             !(c[0] instanceof URL && c[0].href.includes("/auth/refresh")),
    );
    expect(upstreamCall).toBeTruthy();
    const upstreamHeaders = (upstreamCall![1] as RequestInit)?.headers as Record<string, string> | undefined;
    expect(upstreamHeaders?.["Authorization"]).toBe("Bearer rotated-jwt");

    // The rotated session cookie must be forwarded to the browser.
    const setCookieHeader = res.headers.get("set-cookie");
    expect(setCookieHeader, "refreshed Set-Cookie must be forwarded to the browser").toBeTruthy();
    expect(setCookieHeader).toContain(SESSION_COOKIE);
  });

  // ─── Proxy: expired token + refresh fails → 401 ──────────────────────────

  it("proxy: returns 401 when access_token is expired and refresh fails", async () => {
    const pastExpiry = Math.floor(Date.now() / 1000) - 10;
    cookieState.value = makeCookieValue({
      access_token: "expired-jwt",
      refresh_token: "rt-revoked",
      expires_at: pastExpiry,
    });

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === "string" ? url : url instanceof URL ? url.href : (url as Request).url;
      if (urlStr.includes("/auth/refresh")) {
        return new Response(JSON.stringify({ detail: "Session refresh failed" }), { status: 401 });
      }
      return new Response("{}", { status: 200 });
    });

    const { GET } = await loadRoute();

    const res = await GET(
      new NextRequest(`https://workers.floom.dev/api/proxy/workers`),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    expect(res.status).toBe(401);
  });

  // ─── Proxy: no cookie → 401 immediately ──────────────────────────────────

  it("proxy: returns 401 with no session cookie (unchanged behavior)", async () => {
    cookieState.value = "";

    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("{}", { status: 200 }),
    );

    const { GET } = await loadRoute();

    const res = await GET(
      new NextRequest(`https://workers.floom.dev/api/proxy/workers`),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    expect(res.status).toBe(401);
  });
});
