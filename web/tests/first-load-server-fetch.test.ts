import { readFileSync } from "node:fs";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      if (name === "workeros_cloud_session") return { value: "cloud-session" };
      if (name === "workeros_active_workspace") return { value: "local-default" };
      if (name === "workeros.activeWorkspaceId") return { value: "local-default" };
      if (name === "wos_session") return { value: "session-token" };
      return undefined;
    },
  }),
}));

vi.mock("@/lib/verify-session", () => ({
  resolveSessionPayload: async () => ({ payload: { access_token: "cloud-access-token" } }),
}));

describe("Workers/Runs first-load server fetches", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("WORKEROS_API_BASE", "https://api.example.test");
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
      "https://api.example.test/api/workers?shape=list&include_archived=true",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer cloud-access-token",
          "x-workeros-workspace": "local-default",
        }),
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
    const libraryPage = readFileSync(
      new URL("../app/library/page.tsx", import.meta.url),
      "utf8",
    );

    expect(workersPage).toContain("fetchWorkerList({ include_archived: true })");
    expect(runsPage).toContain("fetchRuns({ limit: 50, offset: 0 })");
    expect(runsPage).not.toContain("limit: 200");
    expect(libraryPage).toContain("const initialFoldersPromise = fetchBrainFolders().catch");
    expect(libraryPage).not.toContain("await fetchBrainFolders()");
    expect(libraryPage).toContain("<BrainCollection initialFoldersPromise={initialFoldersPromise} />");
  });
});
