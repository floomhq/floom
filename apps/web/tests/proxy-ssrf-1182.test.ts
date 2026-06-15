// #1182 — /api/proxy must NOT follow backend redirects server-side.
//
// Before the fix: redirect:"follow" was used for every non-OAuth request.
// When the backend returned a 3xx to an internal host the Next.js function
// fetched that host server-side — carrying the user's JWT/cookie — and streamed
// the result back.  safeProxyLocation() was never reached because redirect:"follow"
// consumed the redirect before our code could inspect it.
//
// After the fix: redirect:"manual" is used unconditionally.  The 3xx is returned
// to the browser; safeProxyLocation() sanitises the Location header before it
// leaves; internal/external Location values are stripped so the browser never
// gets an instruction to follow them.
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const APP_ORIGIN = "https://workers.floom.dev";
const API_BASE = "https://workers-api.floom.dev";

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FLOOM_API_BASE;
});

describe("#1182 proxy redirect SSRF — redirect:manual for all requests", () => {
  it("uses redirect:manual for a regular (non-OAuth) GET request", async () => {
    process.env.FLOOM_API_BASE = API_BASE;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const { GET } = await import("@/app/api/proxy/[...path]/route");
    await GET(
      new NextRequest(`${APP_ORIGIN}/api/proxy/workers`),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/workers`,
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("uses redirect:manual for a POST request (not an OAuth callback)", async () => {
    process.env.FLOOM_API_BASE = API_BASE;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(JSON.stringify({ id: "x" }), { status: 200 }));

    const { POST } = await import("@/app/api/proxy/[...path]/route");
    await POST(
      new NextRequest(`${APP_ORIGIN}/api/proxy/workers`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test" }),
      }),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `${API_BASE}/workers`,
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("strips an internal-host Location on a non-OAuth redirect (SSRF exploit blocked)", async () => {
    // Before fix: redirect:"follow" would have made the proxy server fetch
    // http://169.254.169.254 and stream the response back.
    // After fix: redirect:"manual" means we see the 302, safeProxyLocation
    // drops the internal Location (it's not the app or api origin), and the
    // browser receives a 302 with no Location header — it does not follow it.
    process.env.FLOOM_API_BASE = API_BASE;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://169.254.169.254/latest/meta-data/" },
      }),
    );

    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const res = await GET(
      new NextRequest(`${APP_ORIGIN}/api/proxy/workers`),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    expect(res.status).toBe(302);
    // The dangerous Location must be stripped — not forwarded to the browser.
    expect(res.headers.get("location")).toBeNull();
  });

  it("strips an external-host Location on a non-OAuth redirect (open-redirect blocked)", async () => {
    process.env.FLOOM_API_BASE = API_BASE;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 301,
        headers: { location: "https://evil.attacker.com/phishing" },
      }),
    );

    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const res = await GET(
      new NextRequest(`${APP_ORIGIN}/api/proxy/workers`),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBeNull();
  });

  it("still passes through a safe relative Location on a non-OAuth redirect", async () => {
    // Legitimate redirects to app-relative paths should still work.
    process.env.FLOOM_API_BASE = API_BASE;
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "/workers?after=1" },
      }),
    );

    const { GET } = await import("@/app/api/proxy/[...path]/route");
    const res = await GET(
      new NextRequest(`${APP_ORIGIN}/api/proxy/workers`),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/workers?after=1");
  });
});
