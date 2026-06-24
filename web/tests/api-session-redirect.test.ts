import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog", () => ({
  capturePostHogEvent: vi.fn(),
}));

function createStorage(initial: Record<string, string> = {}): Storage {
  const values = new Map(Object.entries(initial));
  return {
    get length() {
      return values.size;
    },
    clear: vi.fn(() => values.clear()),
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(values.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      values.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    }),
  };
}

function stubBrowserLocation(pathname = "/app/runs/run_123", search = "?tab=approval") {
  const assign = vi.fn();
  const localStorage = createStorage();
  vi.stubGlobal("window", {
    location: { href: `http://localhost:3000${pathname}${search}`, pathname, search, protocol: "http:", assign },
    localStorage,
  });
  vi.stubGlobal("localStorage", localStorage);
  return assign;
}

function stubWorkspaceCookieBrowser(protocol: "http:" | "https:") {
  const written: string[] = [];
  const localStorage = createStorage();
  vi.stubGlobal("window", {
    location: { href: `${protocol}//localhost:3000/app`, pathname: "/app", search: "", protocol },
    localStorage,
    document: {
      set cookie(value: string) {
        written.push(value);
      },
    },
  });
  vi.stubGlobal("localStorage", localStorage);
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

  it("sends the local-default workspace header in OSS when no browser workspace is stored", async () => {
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

  it("does not send local-default as a cloud workspace header", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKEROS_DEPLOY", "cloud");
    stubBrowserLocation("/app/runs", "");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { api, getActiveWorkspaceId } = await import("@/lib/api");

    expect(getActiveWorkspaceId()).toBeNull();
    await api.runs.list({ limit: 50 });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.has("x-workeros-workspace")).toBe(false);
  });

  it("does not send stale local-default as a cloud workspace header", async () => {
    vi.stubEnv("NEXT_PUBLIC_WORKEROS_DEPLOY", "cloud");
    stubBrowserLocation("/app/runs", "");
    localStorage.setItem("workeros.activeWorkspaceId", "local-default");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const { api, getActiveWorkspaceId } = await import("@/lib/api");

    expect(getActiveWorkspaceId()).toBeNull();
    await api.runs.list({ limit: 50 });

    const headers = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(headers.has("x-workeros-workspace")).toBe(false);
  });

  it("marks the active workspace cookie Secure on HTTPS only", async () => {
    let written = stubWorkspaceCookieBrowser("https:");
    let mod = await import("@/lib/api");
    mod.setActiveWorkspaceId("ws secure");
    expect(written.at(-1)).toBe(
      "workeros.activeWorkspaceId=ws%20secure; Path=/; SameSite=Lax; Secure; Max-Age=31536000",
    );

    vi.resetModules();
    vi.unstubAllGlobals();
    written = stubWorkspaceCookieBrowser("http:");
    mod = await import("@/lib/api");
    mod.setActiveWorkspaceId("ws local");
    expect(written.at(-1)).toBe(
      "workeros.activeWorkspaceId=ws%20local; Path=/; SameSite=Lax; Max-Age=31536000",
    );
  });
});
