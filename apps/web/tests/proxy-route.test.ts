import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

describe("api proxy route", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes OAuth callback redirects through to the browser", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        new Response(null, {
          status: 307,
          headers: {
            location: "https://workers.floom.dev/connections?connected=1&connection_id=local_123",
          },
        }),
      );
    const { GET } = await import("@/app/api/proxy/[...path]/route");

    const res = await GET(
      new NextRequest("https://workers.floom.dev/api/proxy/connections/callback?connection_id=ca_123&status=success"),
      { params: Promise.resolve({ path: ["connections", "callback"] }) },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://workers-api.floom.dev/connections/callback?connection_id=ca_123&status=success",
      expect.objectContaining({ redirect: "manual" }),
    );
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe(
      "https://workers.floom.dev/connections?connected=1&connection_id=local_123",
    );
  });
});
