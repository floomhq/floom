import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/posthog", () => ({ capturePostHogEvent: vi.fn() }));

function stubWindow(protocol: "https:" | "http:") {
  const writes: string[] = [];
  const document = {};
  Object.defineProperty(document, "cookie", {
    get: () => writes[writes.length - 1] ?? "",
    set: (value: string) => writes.push(value),
  });
  vi.stubGlobal("window", {
    location: { protocol },
    localStorage: {
      setItem: vi.fn(),
      removeItem: vi.fn(),
      getItem: vi.fn(),
    },
    document,
  });
  return writes;
}

describe("#362 active workspace cookie Secure flag", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("adds Secure on HTTPS", async () => {
    const writes = stubWindow("https:");
    const { setActiveWorkspaceId } = await import("@/lib/api");

    setActiveWorkspaceId("ws_123");
    setActiveWorkspaceId(null);

    expect(writes[0]).toContain("; Secure");
    expect(writes[1]).toContain("; Secure");
  });

  it("does not add Secure on HTTP localhost/dev", async () => {
    const writes = stubWindow("http:");
    const { setActiveWorkspaceId } = await import("@/lib/api");

    setActiveWorkspaceId("ws_123");

    expect(writes[0]).not.toContain("; Secure");
  });
});
