import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryProvider } from "@/components/providers/QueryProvider";

// #1679: the embedded per-worker Runs tab showed "No runs yet" while the global
// /runs page showed the worker's full history. Root cause: the tab (and the
// "Runs N" tab badge) read the worker-detail `recent_runs` field, which the
// backend scopes only by `w.owner_id` (runs.list_for_worker) — so a worker whose
// runs were triggered by a non-owner actor came back empty there even though the
// broadly-scoped /runs query (api.runs.list, scoped by actor OR owner) returned
// them. The fix: the tab sources its rows from api.runs.list({ worker_id }) — the
// SAME proven query the global /runs surface uses — via a shared cache the badge
// reads too, so the two surfaces agree and the badge stops flipping 0↔1.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

const WORKER_ID = "shared-worker";
const worker = {
  id: WORKER_ID,
  name: "Shared Reporter",
  description: "Reports shared metrics.",
  tags: ["operations"],
  status: "healthy",
  trigger_type: "manual",
  runner: "e2b",
  triggers: [],
  triggers_spec: [],
  connections: [],
  enabled: true,
  stage: "live",
  visibility: "workspace",
  permissions: { can_edit: true, can_run: true, can_delete: true, can_share: true },
  recent_stats: { last_run_at: "2026-06-16T00:00:00Z", runs_7d: 5 },
};

// The detail's recent_runs is EMPTY (narrow owner-scoped query) — exactly the
// inconsistency that produced "No runs yet" before the fix.
const workerDetail = {
  ...worker,
  config: { id: WORKER_ID, name: "Shared Reporter", trigger: { type: "manual" }, runtime: { type: "python311", entrypoint: "run.py" } },
  files: [{ path: "worker.yml", content: "name: Shared Reporter\n" }],
  recent_runs: [],
};

// The broadly-scoped /runs query DOES return runs for this worker.
const workerScopedRuns = [
  { id: "run-aaa", worker_id: WORKER_ID, status: "completed", trigger_source: "manual", created_at: "2026-06-18T10:00:00Z", duration_ms: 4200 },
  { id: "run-bbb", worker_id: WORKER_ID, status: "completed", trigger_source: "manual", created_at: "2026-06-17T10:00:00Z", duration_ms: 3100 },
];

const runsListMock = vi.fn().mockResolvedValue(workerScopedRuns);

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ is_admin: true, role: "admin" }),
    workers: {
      list: vi.fn().mockResolvedValue([worker]),
      get: vi.fn().mockResolvedValue(workerDetail),
      listVersions: vi.fn().mockResolvedValue([]),
      feedback: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), delete: vi.fn() },
    },
    runs: {
      list: runsListMock,
    },
    contexts: { list: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock("@/lib/useApprovalsSync", () => ({
  notifyApprovalsChanged: vi.fn(),
  useApprovalsListSync: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  // Reset module state so WorkersCollection's module-level caches (detailCache /
  // workerRunsCache) don't leak between the two cases below.
  vi.resetModules();
  runsListMock.mockResolvedValue(workerScopedRuns);
  window.localStorage.clear();
});

async function openRunsTab() {
  const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
  render(
    <QueryProvider>
      <WorkersCollection initialWorkers={[worker as never]} />
    </QueryProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Shared Reporter/i }));
  await waitFor(() => expect(document.querySelector(".c-dtabs")).toBeTruthy());
  // Open the Runs tab (its accessible name may carry a trailing count badge).
  const runsTab = await waitFor(() => {
    const tab = screen
      .getAllByRole("tab")
      .find((t) => /^Runs\b/.test((t.textContent ?? "").trim()));
    if (!tab) throw new Error("Runs tab not found");
    return tab;
  });
  fireEvent.click(runsTab);
  return runsTab;
}

describe("#1679 per-worker Runs tab uses the worker-scoped /runs query", () => {
  it("queries api.runs.list scoped to the worker (not the detail recent_runs field)", async () => {
    await openRunsTab();
    await waitFor(() =>
      expect(runsListMock).toHaveBeenCalledWith(
        expect.objectContaining({ worker_id: WORKER_ID }),
      ),
    );
  });

  it("renders runs returned by /runs even when detail.recent_runs is empty", async () => {
    await openRunsTab();
    // The runs come from api.runs.list, NOT from the empty recent_runs.
    expect(await screen.findByText("#run-aaa")).toBeInTheDocument();
    expect(screen.getByText("#run-bbb")).toBeInTheDocument();
    expect(screen.queryByText("No runs yet.")).toBeNull();
  });
});
