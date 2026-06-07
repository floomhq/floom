import { afterEach, describe, expect, it, vi } from "vitest";

describe("workspace base persona API", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("falls back to /workspace/base when /workspace/base/state is not deployed", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ detail: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response("# Emily\n\nDefault persona", {
          status: 200,
          headers: { "content-type": "text/markdown" },
        }),
      );

    const { api } = await import("@/lib/api");
    const result = await api.system.workspaceBasePersona();

    expect(result).toEqual({
      content: "# Emily\n\nDefault persona",
      is_custom: false,
      default: "# Emily\n\nDefault persona",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/proxy/workspace/base/state",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/proxy/workspace/base",
      expect.objectContaining({ headers: expect.any(Headers) }),
    );
  });
});
