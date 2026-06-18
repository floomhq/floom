import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

// Round-09 Phase 2 gap N2 — Cancel an in-progress run from the UI, wired to the
// real api.runs.cancel endpoint (previously invoked by zero components).
//   - isCancellableRunStatus gates running/queued only.
//   - the run-detail header shows "Cancel run" only for in-progress runs and
//     calls api.runs.cancel(id).
//   - terminal (completed/failed) runs expose no Cancel.

const cancel = vi.fn().mockResolvedValue({ status: "cancelling" });
const list = vi.fn();
const get = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    runs: {
      list,
      get,
      cancel,
      logs: vi.fn().mockResolvedValue([]),
      downloadUrl: (id: string) => `/runs/${id}/download`,
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

function makeRun(over: Record<string, unknown>) {
  return {
    id: "run-1",
    worker_id: "w1",
    worker_name: "Revenue Reconciler",
    status: "running",
    trigger_source: "manual",
    created_at: "2026-06-17T08:00:00Z",
    started_at: "2026-06-17T08:00:00Z",
    duration_ms: null,
    ...over,
  };
}

let selId = "run-1";
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(`sel=${selId}`),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/runs",
}));

beforeEach(() => {
  vi.clearAllMocks();
  selId = "run-1";
});

describe("isCancellableRunStatus (gap N2)", () => {
  it("is true only for running / queued", async () => {
    const { isCancellableRunStatus } = await import("@/app/runs/RunsCollection");
    expect(isCancellableRunStatus("running")).toBe(true);
    expect(isCancellableRunStatus("queued")).toBe(true);
    expect(isCancellableRunStatus("completed")).toBe(false);
    expect(isCancellableRunStatus("failed")).toBe(false);
    expect(isCancellableRunStatus("cancelled")).toBe(false);
    expect(isCancellableRunStatus(undefined)).toBe(false);
  });
});

describe("Run detail Cancel action (gap N2)", () => {
  it("an in-progress run shows Cancel run and clicking it calls api.runs.cancel", async () => {
    const run = makeRun({ status: "running" });
    list.mockResolvedValue([run]);
    get.mockResolvedValue({ ...run, config: {}, recent_runs: [] });
    vi.spyOn(window, "confirm").mockReturnValue(true);

    const { default: RunsCollection } = await import("@/app/runs/RunsCollection");
    render(<RunsCollection initialRuns={[run as never]} />);

    const cancelBtn = await screen.findByRole("button", { name: /Cancel run/i });
    fireEvent.click(cancelBtn);
    await waitFor(() => expect(cancel).toHaveBeenCalledWith("run-1"));
  });

  it("a completed run shows NO Cancel action", async () => {
    const run = makeRun({ status: "completed", duration_ms: 4200 });
    list.mockResolvedValue([run]);
    get.mockResolvedValue({ ...run, config: {}, recent_runs: [] });

    const { default: RunsCollection } = await import("@/app/runs/RunsCollection");
    render(<RunsCollection initialRuns={[run as never]} />);

    // The detail header renders (Replay is always present), but no Cancel.
    await waitFor(() => expect(screen.getByText(/Replay/i)).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Cancel run/i })).toBeNull();
    expect(cancel).not.toHaveBeenCalled();
  });
});
