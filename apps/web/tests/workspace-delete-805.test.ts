import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #805: api.workspace.remove issues DELETE /workspaces/{id}.

describe("api.workspace.remove (#805)", () => {
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

  it("issues DELETE /workspaces/{id}", async () => {
    const { api } = await import("@/lib/api");
    await api.workspace.remove("ws_42");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workspaces/ws_42");
    expect(init.method).toBe("DELETE");
  });
});
