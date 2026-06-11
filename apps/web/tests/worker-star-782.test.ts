import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #782: api.workers.star / unstar hit POST/DELETE /workers/{id}/star.

describe("api.workers star/unstar (#782)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 204,
      headers: { get: () => null },
      text: async () => "",
      json: async () => null,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("star POSTs to the star route", async () => {
    const { api } = await import("@/lib/api");
    await api.workers.star("alpha");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workers/alpha/star");
    expect(init.method).toBe("POST");
  });

  it("unstar DELETEs the star route", async () => {
    const { api } = await import("@/lib/api");
    await api.workers.unstar("alpha");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workers/alpha/star");
    expect(init.method).toBe("DELETE");
  });
});
