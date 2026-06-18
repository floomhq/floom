import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

// Fake fixture value, not a real credential. gitleaks:allow
const SECRET = "fake-test-secret-not-real";

async function validCookie(): Promise<string> {
  const { deriveSessionToken, SESSION_COOKIE } = await import("@/lib/web-session");
  const token = await deriveSessionToken();
  return `${SESSION_COOKIE}=${token}`;
}

function req(path: string, cookie?: string): NextRequest {
  const headers: Record<string, string> = {};
  if (cookie) headers.cookie = cookie;
  return new NextRequest(`https://workers.floom.dev${path}`, { headers });
}

describe("middleware auth gate", () => {
  beforeEach(() => {
    process.env.FLOOM_API_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.FLOOM_API_SECRET;
  });

  it("blocks anonymous /api/proxy/* with 401 JSON", async () => {
    const { middleware } = await import("@/middleware");
    for (const p of [
      "/api/proxy/connections",
      "/api/proxy/secrets",
      "/api/proxy/workers",
      "/api/proxy/approvals",
    ]) {
      const res = await middleware(req(p));
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.detail).toMatch(/Authentication required/i);
    }
  });

  it("forwards /api/proxy/* when a valid session cookie is present", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(req("/api/proxy/connections", await validCookie()));
    // NextResponse.next() carries the rewrite header and is NOT a 401/redirect.
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("rejects /api/proxy/* with a tampered cookie", async () => {
    const { middleware } = await import("@/middleware");
    const { SESSION_COOKIE } = await import("@/lib/web-session");
    const res = await middleware(req("/api/proxy/secrets", `${SESSION_COOKIE}=deadbeef`));
    expect(res.status).toBe(401);
  });

  it("keeps the PUBLIC approvals proxy reachable for signed-link approvers", async () => {
    const { middleware } = await import("@/middleware");
    const paths = [
      "/api/proxy/approvals/public/abc-123?token=xyz",
      "/api/proxy/approvals/public/abc-123/approve?token=xyz",
      "/api/proxy/approvals/public/abc-123/reject?token=xyz",
      "/api/proxy/approvals/public/abc-123/artifacts/a1/download?token=xyz",
    ];
    for (const p of paths) {
      const res = await middleware(req(p));
      expect(res.status).toBe(200);
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("keeps the OAuth callback page and exact proxy callback reachable without login", async () => {
    const { middleware } = await import("@/middleware");

    const page = await middleware(req("/connections/callback?status=success&connection_id=ca_test"));
    expect(page.status).toBe(200);
    expect(page.headers.get("x-middleware-next")).toBe("1");

    const proxy = await middleware(req("/api/proxy/connections/callback?status=success&connection_id=ca_test"));
    expect(proxy.status).toBe(200);
    expect(proxy.headers.get("x-middleware-next")).toBe("1");
  });

  it("does NOT leak the authed approvals proxy through the public prefix", async () => {
    const { middleware } = await import("@/middleware");
    // The plain /api/proxy/approvals list is NOT public.
    const res = await middleware(req("/api/proxy/approvals"));
    expect(res.status).toBe(401);
  });

  it("does NOT leak neighboring connections proxy routes through the callback exception", async () => {
    const { middleware } = await import("@/middleware");
    for (const p of ["/api/proxy/connections", "/api/proxy/connections/callback-extra"]) {
      const res = await middleware(req(p));
      expect(res.status).toBe(401);
    }
  });

  it("lets the auth endpoints through unauthenticated", async () => {
    const { middleware } = await import("@/middleware");
    for (const p of ["/api/auth/login", "/api/auth/logout"]) {
      const res = await middleware(req(p));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("redirects anonymous app pages to /login with next param", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(req("/connections"));
    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/login");
    expect(location).toContain("next=%2Fconnections");
  });

  it("keeps public pages reachable without login", async () => {
    const { middleware } = await import("@/middleware");
    for (const p of [
      "/login",
      "/join?invite=abc",
      "/cli-auth?code=abcd-1234",
      "/start",
      "/install/slack",
      "/auth/magic/token.abc",
      "/workspace/share/share-token",
      "/connections/callback?status=success",
      "/approvals/review?id=x&token=y",
      "/w/abc?token=y",
    ]) {
      const res = await middleware(req(p));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("keeps the exact legal pages /privacy and /terms public (OW-02)", async () => {
    const { middleware } = await import("@/middleware");
    for (const p of ["/privacy", "/terms"]) {
      const res = await middleware(req(p));
      expect(res.headers.get("x-middleware-next")).toBe("1");
    }
  });

  it("does NOT make /privacy* or /terms* public by prefix (footgun guard)", async () => {
    // Exact-match only: a future auth-gated route that merely starts with
    // /privacy or /terms (e.g. /privacy-settings, /terms-admin) must stay behind
    // the login gate, not silently become public.
    const { middleware } = await import("@/middleware");
    for (const p of ["/privacy-settings", "/terms-admin", "/privacyx", "/terms-of-fraud"]) {
      const res = await middleware(req(p));
      expect(res.status).toBe(307);
      expect(res.headers.get("location")).toContain("/login");
    }
  });

  it("keeps the branded claim short-link /c/:token reachable without login", async () => {
    // /c/:token is rewritten to the API /c/{token} redirect (public hop). It
    // must NOT be auth-gated, or the WhatsApp/Slack claim flow bounces to /login.
    const { middleware } = await import("@/middleware");
    const res = await middleware(req("/c/sometoken123"));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("allows authed users into app pages", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(req("/connections", await validCookie()));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("lets authenticated unknown app routes reach the branded not-found page", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(req("/this-does-not-exist-xyz", await validCookie()));
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("keeps anonymous unknown app routes behind the login gate", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(req("/this-does-not-exist-xyz"));
    expect(res.status).toBe(307);
    const location = res.headers.get("location")!;
    expect(location).toContain("/login");
    expect(location).toContain("next=%2Fthis-does-not-exist-xyz");
  });
});

describe("middleware: #974 proxy rejections are never shared-cacheable", () => {
  beforeEach(() => {
    process.env.FLOOM_API_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.FLOOM_API_SECRET;
  });

  it("401 (anonymous) /api/proxy carries private no-store, not the Next public default", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(req("/api/proxy/secrets"));
    expect(res.status).toBe(401);
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
    expect(res.headers.get("cache-control")).not.toMatch(/public/i);
  });

  it("403 (CSRF) /api/proxy carries private no-store", async () => {
    const { middleware } = await import("@/middleware");
    const evil = new NextRequest("https://workers.floom.dev/api/proxy/auth/tokens", {
      method: "POST",
      headers: { origin: "https://evil.com" },
    });
    const res = await middleware(evil);
    expect(res.status).toBe(403);
    expect(res.headers.get("cache-control")).toBe("private, no-store, max-age=0");
  });
});
