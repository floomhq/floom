import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name === "workeros.activeWorkspaceId") return { value: "local-default" };
      if (name === "wos_session") return { value: "session-token" };
      return undefined;
    },
  }),
}));

describe("Workers/Runs first-load server fetches", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("FLOOM_API_BASE", "https://api.example.test");
    vi.stubEnv("FLOOM_API_SECRET", "test-secret");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("can server-fetch the same archived workers list the client cache reads", async () => {
    const { fetchWorkerList } = await import("@/lib/server-api");

    await fetchWorkerList({ include_archived: true });

    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.test/workers?shape=list&include_archived=true",
      expect.objectContaining({
        next: { revalidate: 30 },
      }),
    );
  });

  it("keeps route first-paint fetches aligned to client query keys", () => {
    const workersPage = readFileSync(
      new URL("../app/workers/page.tsx", import.meta.url),
      "utf8",
    );
    const runsPage = readFileSync(
      new URL("../app/runs/page.tsx", import.meta.url),
      "utf8",
    );

    expect(workersPage).toContain("fetchWorkerList({ include_archived: true })");
    expect(runsPage).toContain("fetchRuns({ limit: 50, offset: 0 })");
    expect(runsPage).not.toContain("limit: 200");
  });
});
