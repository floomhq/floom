import { afterEach, describe, expect, it, vi } from "vitest";

function stubBrowserLocation(pathname = "/app/runs/run_123", search = "?tab=approval") {
  const assign = vi.fn();
  vi.stubGlobal("window", {
    location: { pathname, search, assign },
    localStorage: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
  });
  return assign;
}

describe("api session expiry handling", () => {
  afterEach(() => {
    delete process.env.NEXT_PUBLIC_BASE_PATH;
    delete process.env.NEXT_PUBLIC_API_PROXY_BASE;
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("redirects to login once when authed API calls return 401", async () => {
    process.env.NEXT_PUBLIC_BASE_PATH = "/app";
    process.env.NEXT_PUBLIC_API_PROXY_BASE = "/app/api/proxy";
    const assign = stubBrowserLocation();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => (
      new Response(JSON.stringify({ detail: "Authentication required." }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      })
    ));

    const { api } = await import("@/lib/api");

    await expect(api.approvals.count()).rejects.toThrow("Authentication required.");
    await expect(api.runs.get("run_123")).rejects.toThrow("Authentication required.");

    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith("/app/login?next=%2Fapp%2Fruns%2Frun_123%3Ftab%3Dapproval");
  });

  it("does not redirect signed public approval calls on 401", async () => {
    const assign = stubBrowserLocation("/approvals/review", "?id=a&token=t");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ detail: "Invalid approval token." }), {
        status: 401,
        statusText: "Unauthorized",
        headers: { "content-type": "application/json" },
      }),
    );

    const { api } = await import("@/lib/api");

    await expect(api.approvals.publicGet("approval_1", "token_1")).rejects.toThrow("Invalid approval token.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("sends the local-default workspace header when no browser workspace is stored", async () => {
    stubBrowserLocation("/runs", "");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { api, getActiveWorkspaceId } = await import("@/lib/api");

    expect(getActiveWorkspaceId()).toBe("local-default");
    await api.runs.list({ limit: 50 });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("x-workeros-workspace")).toBe("local-default");
  });
});
