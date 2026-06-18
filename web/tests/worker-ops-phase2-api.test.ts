import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Round-09 Phase 2 operator-gap fixes — the new worker api methods:
//  - api.workers.updateInputValues → PATCH /workers/{id} {input_values}  (gap #1)
//  - api.workers.pause / resume     → POST /workers/{id}/pause|/resume    (gap #6)

const okJson = (body: unknown) => ({
  ok: true,
  status: 200,
  headers: { get: () => "application/json" },
  text: async () => JSON.stringify(body),
  json: async () => body,
});

describe("api.workers Phase 2 operator methods", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("updateInputValues PATCHes /workers/{id} with input_values (the recipe column)", async () => {
    const worker = { id: "w1", name: "Digest" };
    fetchMock.mockResolvedValue(okJson(worker));
    const { api } = await import("@/lib/api");
    const result = await api.workers.updateInputValues("w1", { period: "month", currency: "EUR" });
    expect(result).toEqual(worker);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workers/w1");
    expect(String(url)).not.toContain("/workers/w1/");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ input_values: { period: "month", currency: "EUR" } });
  });

  it("pause POSTs /workers/{id}/pause", async () => {
    fetchMock.mockResolvedValue(okJson({ id: "w1", enabled: false }));
    const { api } = await import("@/lib/api");
    const result = await api.workers.pause("w1");
    expect(result).toEqual({ id: "w1", enabled: false });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workers/w1/pause");
    expect(init.method).toBe("POST");
  });

  it("resume POSTs /workers/{id}/resume", async () => {
    fetchMock.mockResolvedValue(okJson({ id: "w1", enabled: true }));
    const { api } = await import("@/lib/api");
    const result = await api.workers.resume("w1");
    expect(result).toEqual({ id: "w1", enabled: true });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workers/w1/resume");
    expect(init.method).toBe("POST");
  });
});
