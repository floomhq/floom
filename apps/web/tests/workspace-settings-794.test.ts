import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #794/#797: api.workspace.getSettings / setSetting hit /workspace/settings.

describe("api.workspace settings (#794)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("getSettings reads /workspace/settings", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ auto_pause: "true" }),
      json: async () => ({ auto_pause: "true" }),
    });
    const { api } = await import("@/lib/api");
    expect(await api.workspace.getSettings()).toEqual({ auto_pause: "true" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/workspace/settings");
  });

  it("setSetting PUTs the key with value", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 204, headers: { get: () => null },
      text: async () => "", json: async () => null,
    });
    const { api } = await import("@/lib/api");
    await api.workspace.setSetting("auto_pause", "false");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workspace/settings/auto_pause");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ value: "false" });
  });
});
