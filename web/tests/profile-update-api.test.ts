import { afterEach, describe, expect, it, vi } from "vitest";

describe("api.updateMe", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
    vi.unstubAllGlobals();
  });

  it("updates the signed-in profile through the cloud self-service auth route", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          user_id: "u1",
          display_name: "Federico",
          role: "admin",
          is_admin: true,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const { api } = await import("@/lib/api");
    const result = await api.updateMe("Federico", "u1");

    expect(result.display_name).toBe("Federico");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("/api/proxy/auth/profile");
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({ display_name: "Federico" });
  });
});
