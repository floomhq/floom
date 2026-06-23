import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

// P0-2 fetch race: a `useRunDetail` fetch that resolves AFTER the consuming
// component unmounts must still write the result into the module cache, so the
// NEXT mount derives its initial state synchronously from that cache and never
// strands the skeleton (`if (!d) return <LoadingState/>`).

let resolveGet: (rd: unknown) => void;
const get = vi.fn(
  () =>
    new Promise((res) => {
      resolveGet = res;
    }),
);

vi.mock("@/lib/api", () => ({
  api: {
    runs: {
      list: vi.fn().mockResolvedValue([]),
      get,
      cancel: vi.fn(),
      logs: vi.fn().mockResolvedValue([]),
      downloadUrl: (id: string) => `/runs/${id}/download`,
      artifactUrl: (id: string, aid: string) => `/runs/${id}/artifacts/${aid}`,
      replay: vi.fn(),
      exportBundle: vi.fn(),
    },
    workers: { list: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/lib/query/hooks", () => ({
  useRuns: () => ({ data: undefined, isLoading: false, refetch: vi.fn() }),
}));

vi.mock("@/lib/useRunLogStream", () => ({
  useRunLogStream: () => ({ logs: [], connected: false, done: true, error: null }),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/runs",
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useRunDetail — cache survives a cancelled (post-unmount) fetch", () => {
  it("populates the cache after unmount so a remount reads it synchronously", async () => {
    const { useRunDetail } = await import("@/app/runs/RunsCollection");
    const detail = { id: "run-cancel-1", status: "completed", output: { ok: true } };

    // First mount: a terminal run with an empty cache → fetch is issued.
    const first = renderHook(() => useRunDetail("run-cancel-1", "completed"));
    expect(first.result.current).toBeUndefined();
    expect(get).toHaveBeenCalledTimes(1);

    // Unmount BEFORE the fetch resolves (the cancel race).
    first.unmount();
    // Fetch resolves after cleanup — must still write the cache.
    resolveGet(detail);
    await Promise.resolve();

    // Remount: initial state must come from the cache synchronously — no skeleton,
    // and NO second fetch is required to render data.
    const second = renderHook(() => useRunDetail("run-cancel-1", "completed"));
    await waitFor(() => expect(second.result.current).toEqual(detail));
  });
});
