import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #770: api.contexts.moveFile issues POST /contexts/{name}/files/{path}/move
// with the destination, encoding each path segment.

describe("api.contexts.moveFile (#770)", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => JSON.stringify({ name: "alpha", files: [] }),
      json: async () => ({ name: "alpha", files: [] }),
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs to the move route with the destination", async () => {
    const { api } = await import("@/lib/api");
    await api.contexts.moveFile("alpha", "sub dir/notes.txt", "renamed.txt");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/contexts/alpha/files/sub%20dir/notes.txt/move");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ to: "renamed.txt" });
  });
});
