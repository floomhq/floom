import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #785: api.workers.editMeta PATCHes /workers/{id} with title/description.

describe("api.workers.editMeta (#785)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => "application/json" },
      text: async () => "{}", json: async () => ({}),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("PATCHes only the given fields", async () => {
    const { api } = await import("@/lib/api");
    await api.workers.editMeta("alpha", { title: "New" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workers/alpha");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ title: "New" });
  });

  it("can send both title and description", async () => {
    const { api } = await import("@/lib/api");
    await api.workers.editMeta("alpha", { title: "T", description: "D" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ title: "T", description: "D" });
  });
});
