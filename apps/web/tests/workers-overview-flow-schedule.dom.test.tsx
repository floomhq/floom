import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  searchParams: "",
}));

const apiMocks = vi.hoisted(() => ({
  get: vi.fn(),
  list: vi.fn(),
  listVersions: vi.fn(),
  listContexts: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(router.searchParams),
  useRouter: () => router,
  usePathname: () => "/",
}));

vi.mock("@/lib/api", () => ({
  getPersistedActiveWorkspaceId: vi.fn(() => "local-default"),
  api: {
    workers: {
      list: apiMocks.list,
      get: apiMocks.get,
      listVersions: apiMocks.listVersions,
      alerts: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), remove: vi.fn() },
      feedback: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), delete: vi.fn() },
    },
    contexts: { list: apiMocks.listContexts },
  },
}));

vi.mock("@/lib/useApprovalsSync", () => ({
  notifyApprovalsChanged: vi.fn(),
  useApprovalsListSync: vi.fn(),
}));

const WORKER_ID = "mac-disk-guard";
const worker = {
  id: WORKER_ID,
  name: "Mac Disk Guard",
  description: "Keeps the Mac disk from filling up.",
  tags: ["ops"],
  status: "healthy",
  trigger_type: "cron",
  runner: "e2b",
  runtime: "python311",
  triggers: [],
  triggers_spec: [{ type: "cron", cron: "0 */6 * * *", timezone: "Europe/Berlin" }],
  connections: [],
  inputs: [],
  enabled: true,
  stage: "draft",
  visibility: "private",
  permissions: { can_edit: true, can_run: true, can_delete: true, can_share: true },
  recent_stats: { last_run_at: "2026-06-21T09:00:00Z", runs_7d: 5, success_rate_7d: 1 },
};

const workerDetail = {
  ...worker,
  last_run: {
    id: "fresh-schedule-run",
    worker_id: WORKER_ID,
    status: "completed",
    trigger_source: "schedule",
    created_at: "2026-06-22T12:00:00Z",
  },
  recent_stats: { last_run_at: "2026-06-22T12:00:00Z", runs_7d: 6, success_rate_7d: 1 },
  next_run_at: "2026-06-22T18:00:00Z",
  last_fired_at: "2026-06-22T12:00:00Z",
  config: {
    id: WORKER_ID,
    name: "Mac Disk Guard",
    trigger: { type: "cron", cron: "0 */6 * * *", timezone: "Europe/Berlin" },
    runtime: {
      type: "python311",
      entrypoint: "run.py",
      runner: "e2b",
      mode: "agent",
      model: "claude-sonnet-4-5",
      limits: { max_cost_usd: 1, timeout_seconds: 300, max_retries: 1 },
    },
    inputs: [
      { name: "dry_run", label: "Dry run", type: "boolean", required: false },
      { name: "minimum_free_gb", label: "Minimum free GB", type: "number", required: true },
      { name: "force_clean", label: "Force clean", type: "boolean", required: false },
    ],
    outputs: [{ name: "cleanup_report", label: "Cleanup report", type: "text" }],
    contexts: [],
    connections: [],
    secrets: [],
  },
  files: [{ path: "worker.yml", content: "name: Mac Disk Guard\n" }],
  recent_runs: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  router.searchParams = "";
  window.localStorage.clear();
  apiMocks.list.mockResolvedValue([worker]);
  apiMocks.listVersions.mockResolvedValue([]);
  apiMocks.listContexts.mockResolvedValue([]);
});

function renderWorkers() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return import("@/app/workers/WorkersCollection").then(({ default: WorkersCollection }) => {
    render(
      <QueryClientProvider client={client}>
        <WorkersCollection initialWorkers={[worker as never]} />
      </QueryClientProvider>,
    );
    return client;
  });
}

describe("Worker Overview flow and schedule state", () => {
  it("shows a skeleton instead of the placeholder flow until the manifest detail loads", async () => {
    const stalePlaceholder = ["score", "(candi", "date, rub", "ric)"].join("");
    let resolveDetail!: (detail: typeof workerDetail) => void;
    const detailPromise = new Promise<typeof workerDetail>((resolve) => {
      resolveDetail = resolve;
    });
    apiMocks.get.mockReturnValue(detailPromise);

    await renderWorkers();
    fireEvent.click(await screen.findByRole("button", { name: /Mac Disk Guard/i }));

    await waitFor(() => expect(screen.getByLabelText("Loading")).toBeInTheDocument());
    const pendingSummary = document.querySelector(".c-dsum");
    expect(pendingSummary?.textContent).toContain("Loading");
    expect(pendingSummary?.textContent).not.toMatch(/5\s*Runs/);
    expect(document.body.textContent).not.toContain(stalePlaceholder);
    expect(screen.queryByText("Result")).not.toBeInTheDocument();

    resolveDetail(workerDetail);

    expect(await screen.findByText("Dry run")).toBeInTheDocument();
    expect(screen.getByText("Minimum free GB")).toBeInTheDocument();
    expect(screen.getByText("Force clean")).toBeInTheDocument();
    expect(screen.getByText("Cleanup report")).toBeInTheDocument();
    expect(document.body.textContent).toContain("run(dry_run, minimum_free_gb, force_clean)");
    expect(document.body.textContent).not.toContain(stalePlaceholder);
  });

  it("labels scheduled draft workers as active draft schedules and uses fresh detail stats", async () => {
    apiMocks.get.mockResolvedValue(workerDetail);
    const client = await renderWorkers();

    fireEvent.click(await screen.findByRole("button", { name: /Mac Disk Guard/i }));

    await waitFor(() => {
      const summary = document.querySelector(".c-dsum");
      expect(summary?.textContent).toMatch(/6\s*Runs/);
      expect(summary?.textContent).toMatch(/Active - draft\s*Schedule/);
    });

    fireEvent.click(screen.getByRole("tab", { name: "Setup" }));
    fireEvent.click(await screen.findByRole("tab", { name: /^Triggers/ }));
    expect(await screen.findByText("Schedule status")).toBeInTheDocument();
    expect(screen.getAllByText("Active - draft").length).toBeGreaterThan(0);

    await waitFor(() => {
      const cached = client
        .getQueriesData<typeof worker[]>({ queryKey: ["workers"] })
        .map(([, data]) => data)
        .find((data) => Array.isArray(data) && data[0]?.id === WORKER_ID);
      expect(cached?.[0]?.recent_stats?.runs_7d).toBe(6);
      expect(cached?.[0]?.last_run?.id).toBe("fresh-schedule-run");
    });
  });
});
