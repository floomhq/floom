import { afterEach, describe, expect, it, vi } from "vitest";

describe("fetchPublicWorker", () => {
  afterEach(() => {
    delete process.env.WORKEROS_API_BASE;
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("uses the token-only public API without session auth headers", async () => {
    process.env.WORKEROS_API_BASE = "https://api.example.test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "worker 1",
          name: "Public Worker",
          tags: [],
          trigger_type: "manual",
          connections: [],
          inputs: [],
          outputs: [],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const { fetchPublicWorker } = await import("@/lib/server-api");
    const result = await fetchPublicWorker("worker 1", "share token");

    expect(result.name).toBe("Public Worker");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.example.test/api/workers/public/worker%201?token=share%20token");
    expect(init?.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.stringify(init?.headers)).not.toContain("Authorization");
  });
});
