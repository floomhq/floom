import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const NO_STORE = "private, no-store, max-age=0";

describe("magic-link preview routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env.FLOOM_API_BASE;
  });

  it("issues magic links through the configured preview API and forwards the web origin", async () => {
    process.env.FLOOM_API_BASE = "https://workeros-api-preview.example.test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          url: "https://workeros-git-fix-1262-floomhq.vercel.app/auth/magic/token",
          expires_in: 900,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const { POST } = await import("@/app/api/auth/magic-link/route");

    const res = await POST(
      new NextRequest("https://workeros-git-fix-1262-floomhq.vercel.app/api/auth/magic-link", {
        method: "POST",
        headers: { cookie: "wos_session=session_123" },
      }),
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://workeros-api-preview.example.test/auth/magic-link",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-workeros-public-origin": "https://workeros-git-fix-1262-floomhq.vercel.app",
          cookie: "wos_session=session_123",
        }),
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("consumes magic links through the configured preview API and forwards set-cookie", async () => {
    process.env.FLOOM_API_BASE = "https://workeros-api-preview.example.test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, redirect_to: "/overview" }), {
        status: 200,
        headers: {
          "content-type": "application/json",
          "set-cookie": "wos_session=new_session; Path=/; HttpOnly; SameSite=Lax",
        },
      }),
    );
    const { GET } = await import("@/app/api/auth/magic/[token]/route");

    const res = await GET(
      new NextRequest("https://workeros-git-fix-1262-floomhq.vercel.app/api/auth/magic/abc.def"),
      { params: Promise.resolve({ token: "abc.def" }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://workeros-api-preview.example.test/auth/magic/abc.def",
      expect.objectContaining({
        headers: {
          "x-workeros-public-origin": "https://workeros-git-fix-1262-floomhq.vercel.app",
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    expect(res.headers.get("set-cookie")).toContain("wos_session=new_session");
    expect(res.headers.get("set-cookie")).toContain("Secure");
  });

  it("returns a visible deployment error instead of falling back to production", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unused", { status: 200 }),
    );
    const { POST } = await import("@/app/api/auth/magic-link/route");

    const res = await POST(
      new NextRequest("https://workeros-git-fix-1262-floomhq.vercel.app/api/auth/magic-link", {
        method: "POST",
      }),
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      detail:
        "FLOOM_API_BASE is required for /api/auth/magic-link. Set it to the API origin for this deployment.",
    });
  });

  it("allows unauthenticated users to open the magic-link page", async () => {
    const { middleware } = await import("@/middleware");

    const res = await middleware(
      new NextRequest("https://workeros-git-fix-1262-floomhq.vercel.app/auth/magic/abc.def"),
    );

    expect(res.headers.get("location")).toBeNull();
    expect(res.status).toBe(200);
  });
});
