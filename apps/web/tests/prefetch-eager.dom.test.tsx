import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient } from "@tanstack/react-query";

// Mock the api module so each list/overview call is a counted spy. The eager
// prefetch must hit these exactly once per main route, and be a no-op on a
// second run (cache-first / idempotent).
const calls = {
  overview: vi.fn(async () => ({ ok: true })),
  workers: vi.fn(async () => [] as unknown[]),
  runs: vi.fn(async () => [] as unknown[]),
  connections: vi.fn(async () => [] as unknown[]),
  secrets: vi.fn(async () => [] as unknown[]),
  members: vi.fn(async () => ({ members: [] as unknown[] })),
  contexts: vi.fn(async () => [] as unknown[]),
};

vi.mock("@/lib/api", () => ({
  api: {
    system: { overview: () => calls.overview() },
    workers: { list: () => calls.workers() },
    runs: { list: () => calls.runs() },
    connections: { list: () => calls.connections() },
    secrets: { list: () => calls.secrets() },
    members: { list: () => calls.members() },
    contexts: { list: () => calls.contexts() },
    approvals: { list: async () => [], count: async () => ({ pending: 0 }) },
  },
}));

import { prefetchMainRoutesEager } from "@/lib/query/prefetch";

const MAIN = ["overview", "workers", "runs", "connections", "contexts"] as const;

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 30_000, retry: false } },
  });
}

async function flush(qc: QueryClient) {
  // Let the fire-and-forget prefetchQuery promises settle.
  await Promise.resolve();
  await qc.getQueryCache().getAll().reduce<Promise<void>>(
    (p, q) => p.then(() => (q.promise ?? Promise.resolve()).then(() => {}, () => {})),
    Promise.resolve(),
  );
  await new Promise((r) => setTimeout(r, 0));
}

describe("prefetchMainRoutesEager", () => {
  beforeEach(() => {
    Object.values(calls).forEach((c) => c.mockClear());
  });

  it("warms every main route's data on shell mount (eager, parallel)", async () => {
    const qc = makeClient();
    prefetchMainRoutesEager(qc, "/somewhere-else");
    await flush(qc);

    // Each main route's list/overview fetch fired exactly once.
    expect(calls.overview).toHaveBeenCalledTimes(1);
    expect(calls.workers).toHaveBeenCalledTimes(1);
    expect(calls.runs).toHaveBeenCalledTimes(1);
    expect(calls.connections).toHaveBeenCalledTimes(1);
    expect(calls.contexts).toHaveBeenCalledTimes(1);

    // The warmed entries are present in the cache (so a subsequent tab switch
    // reads from cache instead of refetching).
    for (const root of MAIN) {
      const has = qc
        .getQueryCache()
        .getAll()
        .some((q) => (q.queryKey as unknown[]).join("|").includes(root === "overview" ? "system|overview" : root));
      expect(has, `cache should hold an entry for ${root}`).toBe(true);
    }
  });

  it("skips the current route's own data fetch (its hook owns it)", async () => {
    // /overview is warmed by no other route transitively, so it is the clean
    // probe for the skip-current behaviour. When it is the current route its
    // own fetch must NOT fire; when it is not current, it must.
    const onOverview = makeClient();
    prefetchMainRoutesEager(onOverview, "/overview");
    await flush(onOverview);
    expect(calls.overview).toHaveBeenCalledTimes(0);
    // The other primary routes are still warmed while sitting on /overview.
    expect(calls.runs).toHaveBeenCalledTimes(1);
    expect(calls.contexts).toHaveBeenCalledTimes(1);

    Object.values(calls).forEach((c) => c.mockClear());
    const elsewhere = makeClient();
    prefetchMainRoutesEager(elsewhere, "/runs");
    await flush(elsewhere);
    // Now /overview IS warmed (not the current route) and /runs is skipped.
    expect(calls.overview).toHaveBeenCalledTimes(1);
    expect(calls.runs).toHaveBeenCalledTimes(0);
  });

  it("is idempotent: a second eager run does NOT refetch fresh entries (no thundering herd)", async () => {
    const qc = makeClient();
    prefetchMainRoutesEager(qc, "/x");
    await flush(qc);
    Object.values(calls).forEach((c) => c.mockClear());

    // Second run while the entries are still fresh (within staleTime) — every
    // call must be a cache-first no-op.
    prefetchMainRoutesEager(qc, "/x");
    await flush(qc);

    expect(calls.overview).toHaveBeenCalledTimes(0);
    expect(calls.workers).toHaveBeenCalledTimes(0);
    expect(calls.runs).toHaveBeenCalledTimes(0);
    expect(calls.connections).toHaveBeenCalledTimes(0);
    expect(calls.contexts).toHaveBeenCalledTimes(0);
  });
});
