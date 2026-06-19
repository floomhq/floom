// #1044 — open redirect: the proxy forwarded the upstream `Location` header
// verbatim. An attacker who can make the backend emit a 3xx to an external URL
// could redirect users off-site. safeProxyLocation now keeps relative/same-app
// locations, rewrites backend-origin redirects to a relative path, and drops
// anything external (incl. protocol-relative and scheme-downgrade).
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const APP_ORIGIN = "https://localhost:3000";
const API_BASE = "https://localhost:8000";

async function proxyWithLocation(location: string) {
  process.env.FLOOM_API_BASE = API_BASE;
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(null, { status: 302, headers: { location } }),
  );
  const { GET } = await import("@/app/api/proxy/[...path]/route");
  const res = await GET(
    new NextRequest(`${APP_ORIGIN}/api/proxy/connections/callback`),
    { params: Promise.resolve({ path: ["connections", "callback"] }) },
  );
  return res;
}

describe("#1044 proxy Location header validation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FLOOM_API_BASE;
  });

  it("preserves same-app-origin absolute redirects", async () => {
    const res = await proxyWithLocation(`${APP_ORIGIN}/dashboard?x=1`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${APP_ORIGIN}/dashboard?x=1`);
  });

  it("preserves relative-path redirects", async () => {
    const res = await proxyWithLocation("/connections?connected=1");
    expect(res.headers.get("location")).toBe("/connections?connected=1");
  });

  it("rewrites backend-origin redirects to an app-relative path", async () => {
    const res = await proxyWithLocation(`${API_BASE}/connections?connected=1`);
    expect(res.headers.get("location")).toBe("/connections?connected=1");
  });

  it("drops external (cross-origin) redirects", async () => {
    const res = await proxyWithLocation("https://evil.example/phishing");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBeNull();
  });

  it("drops protocol-relative redirects (//evil.com)", async () => {
    const res = await proxyWithLocation("//evil.example/phishing");
    expect(res.headers.get("location")).toBeNull();
  });

  it("drops scheme-downgrade same-host redirects", async () => {
    const res = await proxyWithLocation("http://localhost:3000/callback");
    expect(res.headers.get("location")).toBeNull();
  });
});
