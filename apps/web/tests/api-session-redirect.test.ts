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

function stubWorkspaceCookieBrowser(protocol: "http:" | "https:") {
  const written: string[] = [];
  vi.stubGlobal("window", {
    location: { protocol },
    localStorage: {
      getItem: vi.fn(() => null),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    },
    document: {
      set cookie(value: string) {
        written.push(value);
      },
    },
  });
  return written;
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

  it("prefers workspace_id from the current URL over stored workspace", async () => {
    const assign = vi.fn();
    const storedGet = vi.fn(() => "ws_stored");
    vi.stubGlobal("window", {
      location: { pathname: "/workers", search: "?sel=w1&workspace_id=ws_url", assign },
      localStorage: {
        getItem: storedGet,
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { api, getActiveWorkspaceId, getPersistedActiveWorkspaceId } = await import("@/lib/api");

    expect(getActiveWorkspaceId()).toBe("ws_url");
    expect(getPersistedActiveWorkspaceId()).toBe("ws_stored");
    await api.workers.list();

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("x-workeros-workspace")).toBe("ws_url");
  });

  it("accepts ws as a workspace_id alias in legacy inbound links", async () => {
    stubBrowserLocation("/workers", "?sel=w1&ws=ws_alias");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { api, getActiveWorkspaceId } = await import("@/lib/api");

    expect(getActiveWorkspaceId()).toBe("ws_alias");
    await api.workers.list();

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("x-workeros-workspace")).toBe("ws_alias");
  });

  it("marks the active workspace cookie Secure on HTTPS only", async () => {
    let written = stubWorkspaceCookieBrowser("https:");
    let mod = await import("@/lib/api");
    mod.setActiveWorkspaceId("ws secure");
    expect(written.at(-1)).toBe(
      "workeros.activeWorkspaceId=ws%20secure; Path=/; Max-Age=31536000; SameSite=Lax; Secure",
    );

    vi.resetModules();
    vi.unstubAllGlobals();
    written = stubWorkspaceCookieBrowser("http:");
    mod = await import("@/lib/api");
    mod.setActiveWorkspaceId("ws local");
    expect(written.at(-1)).toBe(
      "workeros.activeWorkspaceId=ws%20local; Path=/; Max-Age=31536000; SameSite=Lax",
    );
  });

  it("clears persisted query data when the active workspace changes", async () => {
    const removeItem = vi.fn();
    const setItem = vi.fn();
    vi.stubGlobal("window", {
      location: { protocol: "https:", search: "" },
      localStorage: {
        getItem: vi.fn((key: string) => key === "workeros.activeWorkspaceId" ? "ws_old" : null),
        setItem,
        removeItem,
      },
      document: {
        set cookie(_value: string) {},
      },
    });

    const { setActiveWorkspaceId } = await import("@/lib/api");

    setActiveWorkspaceId("ws_new");

    expect(removeItem).toHaveBeenCalledWith("floom-query-cache");
    expect(setItem).toHaveBeenCalledWith("workeros.activeWorkspaceId", "ws_new");
  });

  it("uses the newly selected workspace header on following API calls", async () => {
    const store = new Map<string, string>([["workeros.activeWorkspaceId", "ws_old"]]);
    vi.stubGlobal("window", {
      location: { protocol: "https:", search: "" },
      localStorage: {
        getItem: vi.fn((key: string) => store.get(key) ?? null),
        setItem: vi.fn((key: string, value: string) => store.set(key, value)),
        removeItem: vi.fn((key: string) => store.delete(key)),
      },
      document: {
        set cookie(_value: string) {},
      },
    });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { api, setActiveWorkspaceId } = await import("@/lib/api");

    setActiveWorkspaceId("ws_new");
    await api.workers.list();

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.get("x-workeros-workspace")).toBe("ws_new");
  });

  it("keeps persisted query data when the active workspace is unchanged", async () => {
    const removeItem = vi.fn();
    vi.stubGlobal("window", {
      location: { protocol: "https:", search: "" },
      localStorage: {
        getItem: vi.fn((key: string) => key === "workeros.activeWorkspaceId" ? "ws_same" : null),
        setItem: vi.fn(),
        removeItem,
      },
      document: {
        set cookie(_value: string) {},
      },
    });

    const { setActiveWorkspaceId } = await import("@/lib/api");

    setActiveWorkspaceId("ws_same");

    expect(removeItem).not.toHaveBeenCalledWith("floom-query-cache");
  });
});
