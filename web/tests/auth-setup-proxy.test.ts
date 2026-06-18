import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

describe("auth setup proxy", () => {
  afterEach(() => {
    delete process.env.FLOOM_API_BASE;
    delete process.env.FLOOM_API_SECRET;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("returns setup-required responses with no-store headers", async () => {
    process.env.FLOOM_API_BASE = "https://api.example.test";
    process.env.FLOOM_API_SECRET = "secret";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ required: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const { GET } = await import("@/app/api/auth/setup/route");

    const res = await GET(new NextRequest("https://web.example.test/api/auth/setup"));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ required: false });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.test/auth/setup-required");
    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({ "x-floom-secret": "secret" });
  });

  it("returns a bounded 502 JSON error when the upstream setup probe fails", async () => {
    process.env.FLOOM_API_BASE = "https://broken.example.test";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect failed"));
    const { GET } = await import("@/app/api/auth/setup/route");

    const res = await GET(new NextRequest("https://web.example.test/api/auth/setup"));

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      detail: "Setup service unavailable.",
      upstream: "https://broken.example.test",
    });
    expect(res.headers.get("cache-control")).toContain("no-store");
  });
});
