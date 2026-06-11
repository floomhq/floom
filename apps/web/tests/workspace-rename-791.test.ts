import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #791: api.workspace.rename PATCHes /workspaces/{id} with the new name.

describe("api.workspace.rename (#791)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ id: "ws_1", name: "New name", owner_user_id: "u", created_at: "" }),
      json: async () => ({ id: "ws_1", name: "New name", owner_user_id: "u", created_at: "" }),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("issues PATCH /workspaces/{id} with the name", async () => {
    const { api } = await import("@/lib/api");
    const res = await api.workspace.rename("ws_1", "New name");
    expect(res.name).toBe("New name");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workspaces/ws_1");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(init.body)).toEqual({ name: "New name" });
  });
});
