import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// api.workspace.tokens hits /workspace/tokens with the right method/body.

describe("api.workspace.tokens", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("list GETs /workspace/tokens", async () => {
    const rows = [{ id: "wt1", name: "shared-runner", created_at: "2026-06-01" }];
    fetchMock.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => "application/json" },
      text: async () => JSON.stringify(rows),
      json: async () => rows,
    });
    const { api } = await import("@/lib/api");
    expect(await api.workspace.tokens.list()).toEqual(rows);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workspace/tokens");
    expect(init.method ?? "GET").toBe("GET");
  });

  it("create POSTs name and expires_at", async () => {
    const created = { id: "wt2", name: "ci", token: "wst_x", expires_at: "2027-01-01" };
    fetchMock.mockResolvedValue({
      ok: true, status: 200, headers: { get: () => "application/json" },
      text: async () => JSON.stringify(created),
      json: async () => created,
    });
    const { api } = await import("@/lib/api");
    expect(await api.workspace.tokens.create("ci", "2027-01-01")).toEqual(created);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workspace/tokens");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ name: "ci", expires_at: "2027-01-01" });
  });

  it("revoke DELETEs /workspace/tokens/{id}", async () => {
    fetchMock.mockResolvedValue({
      ok: true, status: 204, headers: { get: () => null },
      text: async () => "", json: async () => null,
    });
    const { api } = await import("@/lib/api");
    await api.workspace.tokens.revoke("wt1");
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/workspace/tokens/wt1");
    expect(init.method).toBe("DELETE");
  });
});
