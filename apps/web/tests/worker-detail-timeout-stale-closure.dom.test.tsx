import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryProvider } from "@/components/providers/QueryProvider";

// Regression test for the stale-closure P0 bug in useWorkerDetail:
//
//   The 25 s safety timeout closed over the INITIAL `detail` state value
//   (=== undefined). After api.workers.get() resolved successfully and set
//   `detail` to the loaded WorkerDetail, the timeout still fired and checked
//   `detail === undefined` — but this used the captured initial value, not
//   the current state. So it always evaluated to true and called
//   setDetail(null), flipping a successfully-loaded detail panel to
//   "Could not load details" after 25 seconds.
//
//   Fix: a `settled` flag is set to true in both the success and failure
//   paths; the timeout callback bails out if `settled` is already true.
//
//   This test MUST FAIL on the unfixed code and PASS after the fix.
//   Key: the mock API is controlled so the detail resolves AFTER the component
//   already mounted (ensuring the timeout is active), and then we advance fake
//   timers to verify the timeout does not overwrite the loaded detail.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

vi.mock("@/lib/useApprovalsSync", () => ({
  notifyApprovalsChanged: vi.fn(),
  useApprovalsListSync: vi.fn(),
}));

const WORKER_ID = "timeout-test-worker";

const worker = {
  id: WORKER_ID,
  name: "Timeout Test Worker",
  description: "Worker used to verify the stale-closure timeout fix.",
  tags: [],
  status: "healthy",
  trigger_type: "manual",
  runner: "e2b",
  triggers: [],
  triggers_spec: [],
  connections: [],
  enabled: true,
  stage: "live",
  visibility: "workspace" as const,
  permissions: { can_edit: true, can_run: true, can_delete: true, can_share: true },
  recent_stats: { last_run_at: "2026-06-18T00:00:00Z", runs_7d: 1 },
};

const workerDetail = {
  ...worker,
  config: {
    id: WORKER_ID,
    name: "Timeout Test Worker",
    trigger: { type: "manual" },
    runtime: { type: "skill", entrypoint: "SKILL.md", runner: "e2b", mode: "agent", model: "claude-sonnet-4-6" },
    inputs: [],
    outputs: [],
    contexts: [],
    connections: [],
    secrets: [],
  },
  files: [{ path: "worker.yml", content: "name: Timeout Test Worker\n" }],
  recent_runs: [],
};

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  window.localStorage.clear();
  // Clear the module-level detailCache between tests by resetting the module.
  vi.resetModules();
});

describe("useWorkerDetail stale-closure timeout bug (P0)", () => {
  it(
    "detail stays loaded after 25 s — safety timeout must NOT overwrite a resolved detail",
    async () => {
      // We need the detailCache to be empty when the component mounts so the
      // useEffect runs and sets up the 25 s timeout. We also need to control
      // WHEN api.workers.get() resolves to ensure the timeout is active while
      // the detail is in-flight, then resolves, then the timer fires.

      let resolveDetail!: (d: typeof workerDetail) => void;
      const pendingDetail = new Promise<typeof workerDetail>((resolve) => {
        resolveDetail = resolve;
      });

      vi.doMock("@/lib/api", () => ({
        api: {
          workers: {
            list: vi.fn().mockResolvedValue([worker]),
            // Detail does NOT resolve immediately — we control when it resolves.
            get: vi.fn().mockReturnValue(pendingDetail),
            listVersions: vi.fn().mockResolvedValue([]),
            feedback: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), delete: vi.fn() },
          },
          contexts: { list: vi.fn().mockResolvedValue([]) },
        },
      }));

      // Use fake timers so we can advance past the 25 s safety timeout.
      // shouldAdvanceTime: true keeps microtask/promise resolution working.
      vi.useFakeTimers({ shouldAdvanceTime: true });

      // Import the component AFTER doMock so it gets the controlled mock.
      const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");

      render(
        <QueryProvider>
          <WorkersCollection initialWorkers={[worker as never]} />
        </QueryProvider>,
      );

      // Open the worker detail panel. This causes OverviewTab (the default tab)
      // to mount and call useWorkerDetail(WORKER_ID). The mock is still pending,
      // so the useEffect sets up the 25 s safety timeout.
      fireEvent.click(await screen.findByRole("button", { name: /Timeout Test Worker/i }));

      // Navigate to the Setup tab → Alerts & webhooks.
      // OpsAlertsPanel also calls useWorkerDetail(WORKER_ID). At this point:
      //   - OverviewTab is UNMOUNTED (tabs render lazily — only the active tab renders)
      //   - OpsAlertsPanel is MOUNTED and also has a pending 25 s timeout
      //   - The detail cache is still empty (mock not yet resolved)
      // Both conditions hold: the timeout is active and `settled = false`.
      fireEvent.click(await screen.findByRole("tab", { name: "Setup" }));
      fireEvent.click(await screen.findByRole("tab", { name: "Alerts & webhooks" }));

      // While the API is still pending, the panel shows a loading state (spinner).
      // "Alerts (email on event)" is NOT yet shown.
      expect(
        screen.queryByText("Alerts (email on event)"),
      ).not.toBeInTheDocument();

      // Now resolve the detail. This simulates the API returning after 1-2 seconds
      // (well within the 25 s window). The hook should call setDetail(d) and
      // set settled = true.
      await act(async () => {
        resolveDetail(workerDetail);
      });

      // After resolution, the loaded alert content should appear.
      await waitFor(
        () => {
          expect(screen.getByText("Alerts (email on event)")).toBeInTheDocument();
        },
        { timeout: 5_000 },
      );

      // Sanity: no error message while the detail is loaded.
      expect(
        screen.queryByText("Could not load details. Check your connection and try again."),
      ).not.toBeInTheDocument();

      // Now advance fake timers past the 25 s safety timeout and flush React.
      // On the UNFIXED code: the timeout callback checks `detail === undefined`
      // (the stale closure value from before the promise resolved) and calls
      // setDetail(null), which causes "Could not load details" to appear.
      // On the FIXED code: `settled = true` was set in the success path, so
      // the callback bails out and the loaded content stays.
      await act(async () => {
        vi.advanceTimersByTime(26_000);
      });

      // After the fix: content still shown, no error.
      expect(
        screen.queryByText("Could not load details. Check your connection and try again."),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Alerts (email on event)")).toBeInTheDocument();
    },
    30_000,
  );
});
