import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

describe("api proxy route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.FLOOM_API_BASE;
  });

  it("passes OAuth callback redirects through to the browser", async () => {
    process.env.FLOOM_API_BASE = "https://localhost:8000";
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(null, {
          status: 307,
          headers: {
            location: "https://localhost:3000/connections?connected=1&connection_id=local_123",
          },
        }),
      );
    const { GET } = await import("@/app/api/proxy/[...path]/route");

    const res = await GET(
      new NextRequest("https://localhost:3000/api/proxy/connections/callback?connection_id=ca_123&status=success"),
      { params: Promise.resolve({ path: ["connections", "callback"] }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://localhost:8000/connections/callback?connection_id=ca_123&status=success",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://localhost:3000/connections?connected=1&connection_id=local_123",
    );
  });

  it("returns a visible config error when FLOOM_API_BASE is unset", async () => {
    delete process.env.FLOOM_API_BASE;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("unused", { status: 200 }));
    const { GET } = await import("@/app/api/proxy/[...path]/route");

    const res = await GET(
      new NextRequest("https://localhost:3000/api/proxy/workers"),
      { params: Promise.resolve({ path: ["workers"] }) },
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toEqual({
      detail:
        "FLOOM_API_BASE is required for /api/proxy. Set it to the API origin for this deployment.",
    });
  });
});
