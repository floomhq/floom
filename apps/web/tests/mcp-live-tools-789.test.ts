import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #789: api.connections.test surfaces the live-enumerated MCP tools list.

describe("api.connections.test tools (#789)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns the live tools array from the test result", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ status: "valid", reason: "ok", tested_at: "t", tools: ["search", "fetch"] }),
      json: async () => ({ status: "valid", reason: "ok", tested_at: "t", tools: ["search", "fetch"] }),
    });
    const { api } = await import("@/lib/api");
    const res = await api.connections.test("conn_1");
    expect(res.tools).toEqual(["search", "fetch"]);
  });
});
