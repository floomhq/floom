import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #779: api.workers.list forwards a trimmed ?q= for server-side search, and
// omits it when blank.

describe("api.workers.list q param (#779)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => "[]",
      json: async () => [],
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  function calledUrl(): string {
    return String(fetchMock.mock.calls[0][0]);
  }

  it("includes q when provided", async () => {
    const { api } = await import("@/lib/api");
    await api.workers.list({ q: "  sales  " });
    const url = calledUrl();
    expect(url).toContain("shape=list");
    expect(url).toContain("q=sales");
  });

  it("omits q when blank", async () => {
    const { api } = await import("@/lib/api");
    await api.workers.list({ q: "   " });
    expect(calledUrl()).not.toContain("q=");
  });
});
