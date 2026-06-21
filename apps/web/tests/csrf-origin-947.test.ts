// #947 — the /api/proxy/* surface must reject cross-site state-changing
// requests (CSRF defence-in-depth beyond SameSite=lax). The documented attack
// hit POST /api/proxy/auth/tokens with Origin: https://evil.com.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

// Fake fixture value, not a real credential. gitleaks:allow
const SECRET = "fake-test-secret-not-real";
const HOST = "workers.floom.dev";

async function validCookie(): Promise<string> {
  const { deriveSessionToken, SESSION_COOKIE } = await import("@/lib/web-session");
  return `${SESSION_COOKIE}=${await deriveSessionToken()}`;
}

function req(
  path: string,
  {
    method = "POST",
    origin,
    referer,
    cookie,
    forwardedHost,
    xForwardedHost,
  }: {
    method?: string;
    origin?: string;
    referer?: string;
    cookie?: string;
    forwardedHost?: string;
    xForwardedHost?: string;
  } = {},
): NextRequest {
  const headers: Record<string, string> = { host: forwardedHost ?? HOST };
  if (origin) headers.origin = origin;
  if (referer) headers.referer = referer;
  if (cookie) headers.cookie = cookie;
  if (xForwardedHost) headers["x-forwarded-host"] = xForwardedHost;
  return new NextRequest(`https://${HOST}${path}`, { method, headers });
}

describe("#947 CSRF origin validation on /api/proxy", () => {
  beforeEach(() => {
    process.env.FLOOM_API_SECRET = SECRET;
  });
  afterEach(() => {
    delete process.env.FLOOM_API_SECRET;
    delete process.env.CSRF_TRUSTED_ORIGINS;
  });

  it("blocks the documented attack: cross-site POST to auth/tokens", async () => {
    const { proxy: middleware } = await import("@/proxy");
    const res = await middleware(
      req("/api/proxy/auth/tokens", {
        origin: "https://evil.com",
        cookie: await validCookie(),
      }),
    );
    expect(res.status).toBe(403);
    expect((await res.json()).detail).toMatch(/cross-origin/i);
  });

  it("allows a same-origin POST", async () => {
    const { proxy: middleware } = await import("@/proxy");
    const res = await middleware(
      req("/api/proxy/auth/tokens", {
        origin: `https://${HOST}`,
        cookie: await validCookie(),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("blocks a mutating request with NO Origin and NO Referer", async () => {
    const { proxy: middleware } = await import("@/proxy");
    const res = await middleware(
      req("/api/proxy/workers", { cookie: await validCookie() }),
    );
    expect(res.status).toBe(403);
  });

  it("#986: BLOCKS a mutating request with a correct Referer but NO Origin", async () => {
    // Referer is spoofable and modern browsers always send Origin on a
    // mutating cross-site request, so an absent Origin is treated as
    // cross-origin and blocked regardless of Referer.
    const { proxy: middleware } = await import("@/proxy");
    const res = await middleware(
      req("/api/proxy/workers", {
        referer: `https://${HOST}/workers`,
        cookie: await validCookie(),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("#986: a forged same-origin Referer cannot bypass the Origin check", async () => {
    const { proxy: middleware } = await import("@/proxy");
    const res = await middleware(
      req("/api/proxy/auth/tokens", {
        referer: `https://${HOST}/settings`, // attacker spoofs Referer, omits Origin
        cookie: await validCookie(),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("does NOT block safe methods (GET) regardless of Origin", async () => {
    const { proxy: middleware } = await import("@/proxy");
    const res = await middleware(
      req("/api/proxy/workers", {
        method: "GET",
        origin: "https://evil.com",
        cookie: await validCookie(),
      }),
    );
    // GET is not CSRF-relevant here; the auth gate passes it through.
    expect(res.status).toBe(200);
  });

  it("blocks cross-site mutations even on public token-gated endpoints", async () => {
    const { proxy: middleware } = await import("@/proxy");
    const res = await middleware(
      req("/api/proxy/approvals/public/abc/approve", {
        origin: "https://evil.com",
      }),
    );
    expect(res.status).toBe(403);
  });

  it("allows same-origin POST to public token-gated approval endpoints", async () => {
    const { proxy: middleware } = await import("@/proxy");
    const res = await middleware(
      req("/api/proxy/approvals/public/abc/approve", {
        origin: `https://${HOST}`,
      }),
    );
    expect(res.status).toBe(200);
  });

  it("honors x-forwarded-host (platform rewrite/proxy in front of the function)", async () => {
    const { proxy: middleware } = await import("@/proxy");
    const res = await middleware(
      req("/api/proxy/workers", {
        forwardedHost: "internal-deploy.vercel.app",
        xForwardedHost: "workeros.floom.dev",
        origin: "https://workeros.floom.dev",
        cookie: await validCookie(),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("honors CSRF_TRUSTED_ORIGINS allowlist", async () => {
    process.env.CSRF_TRUSTED_ORIGINS = "https://trusted.partner.example";
    const { proxy: middleware } = await import("@/proxy");
    const res = await middleware(
      req("/api/proxy/workers", {
        origin: "https://trusted.partner.example",
        cookie: await validCookie(),
      }),
    );
    expect(res.status).toBe(200);
  });

  it("still blocks unauthenticated same-origin mutations (auth gate intact)", async () => {
    const { proxy: middleware } = await import("@/proxy");
    const res = await middleware(
      req("/api/proxy/workers", { origin: `https://${HOST}` }),
    );
    expect(res.status).toBe(401);
  });
});
