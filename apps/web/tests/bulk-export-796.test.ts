import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// #796: api.runs.exportBundle POSTs run_ids to /runs/export and returns a blob.

describe("api.runs.exportBundle (#796)", () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("POSTs run_ids and returns the zip blob", async () => {
    const blob = new Blob(["zip"], { type: "application/zip" });
    fetchMock.mockResolvedValue({ ok: true, status: 200, blob: async () => blob });
    const { api } = await import("@/lib/api");
    const out = await api.runs.exportBundle(["run-1", "run-2"]);
    expect(out).toBe(blob);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain("/runs/export");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ run_ids: ["run-1", "run-2"] });
  });

  it("throws on a non-ok response", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 404, json: async () => ({ detail: "No exportable runs found" }) });
    const { api } = await import("@/lib/api");
    await expect(api.runs.exportBundle(["ghost"])).rejects.toThrow();
  });
});
