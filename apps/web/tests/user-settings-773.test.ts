import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #773: api.settings.get / set hit /me/settings.

describe("api.settings (#773)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("get reads /me/settings", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ theme: "night" }),
      json: async () => ({ theme: "night" }),
    });
    const { api } = await import("@/lib/api");
    const s = await api.settings.get();
    expect(s).toEqual({ theme: "night" });
    expect(String(fetchMock.mock.calls[0][0])).toContain("/me/settings");
  });

  it("set PUTs the key with the value", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 204, headers: { get: () => null },
      text: async () => "", json: async () => null,
    });
    const { api } = await import("@/lib/api");
    await api.settings.set("theme", "day");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/me/settings/theme");
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body)).toEqual({ value: "day" });
  });
});
