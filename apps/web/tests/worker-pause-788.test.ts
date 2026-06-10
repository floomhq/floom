import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #788: api.workers.pause / resume hit POST /workers/{id}/pause|resume.

describe("api.workers pause/resume (#788)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true, status: 204, headers: { get: () => null },
      text: async () => "", json: async () => null,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("pause POSTs the pause route", async () => {
    const { api } = await import("@/lib/api");
    await api.workers.pause("alpha");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workers/alpha/pause");
    expect(init.method).toBe("POST");
  });

  it("resume POSTs the resume route", async () => {
    const { api } = await import("@/lib/api");
    await api.workers.resume("alpha");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workers/alpha/resume");
    expect(init.method).toBe("POST");
  });
});
