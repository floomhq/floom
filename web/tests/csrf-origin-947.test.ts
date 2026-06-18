// #947 — cloud overlay middleware must reject cross-site mutations on
// /api/proxy/* (the cloud proxy forwards the victim's Supabase Bearer token).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const HOST = "workeros.floom.dev";

function req(
  path: string,
  {
    method = "POST",
    origin,
    referer,
    host = HOST,
    xForwardedHost,
  }: {
    method?: string;
    origin?: string;
    referer?: string;
    host?: string;
    xForwardedHost?: string;
  } = {},
): NextRequest {
  const headers: Record<string, string> = { host };
  if (origin) headers.origin = origin;
  if (referer) headers.referer = referer;
  if (xForwardedHost) headers["x-forwarded-host"] = xForwardedHost;
  return new NextRequest(`https://${host}${path}`, { method, headers });
}

beforeEach(() => {
  // Supabase configured so verifySession has a JWKS to (fail to) check, but
  // CSRF is enforced before any session logic for the proxy.
  vi.stubEnv("SUPABASE_URL", "https://test-project.supabase.co");
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(JSON.stringify({ keys: [] }), { status: 200 }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("#947 cloud CSRF origin validation on /api/proxy", () => {
  it("blocks cross-site POST to the proxy (both /api/proxy and /app/api/proxy)", async () => {
    const { middleware } = await import("@/middleware");
    for (const p of ["/api/proxy/auth/tokens", "/app/api/proxy/auth/tokens"]) {
      const res = await middleware(req(p, { origin: "https://evil.com" }));
      expect(res.status, p).toBe(403);
      expect((await res.json()).detail).toMatch(/cross-origin/i);
    }
  });

  it("allows same-origin POST through (passes CSRF; then hits the public-proxy path)", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(
      req("/api/proxy/workers", { origin: `https://${HOST}` }),
    );
    expect(res.status).not.toBe(403);
    expect(res.headers.get("x-middleware-next")).toBe("1");
  });

  it("blocks a mutation with neither Origin nor Referer", async () => {
    const { middleware } = await import("@/middleware");
    expect((await middleware(req("/api/proxy/workers"))).status).toBe(403);
  });

  it("does not block GET", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(
      req("/api/proxy/workers", { method: "GET", origin: "https://evil.com" }),
    );
    expect(res.status).not.toBe(403);
  });

  it("does not trust x-forwarded-host as a CSRF allow-list source", async () => {
    const { middleware } = await import("@/middleware");
    const res = await middleware(
      req("/api/proxy/workers", {
        host: "workeros-cloud-dashboard.vercel.app",
        xForwardedHost: HOST,
        origin: `https://${HOST}`,
      }),
    );
    expect(res.status).toBe(403);
  });
});
