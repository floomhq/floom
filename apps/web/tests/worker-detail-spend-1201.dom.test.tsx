import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryProvider } from "@/components/providers/QueryProvider";

// #1201: the worker-detail Overview tab renders a "Spend (mo)" stat sourced
// from GET /workers/{id}/spend (api.workers.getSpend), alongside the existing
// Last run / Runs / Success stats.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

const WORKER_ID = "spend-stat-worker";
const worker = {
  id: WORKER_ID,
  name: "Spend Stat Worker",
  description: "d",
  tags: [],
  status: "healthy",
  trigger_type: "manual",
  runner: "e2b",
  triggers: [],
  triggers_spec: [],
  connections: [],
  inputs: [],
  enabled: true,
  stage: "live",
  visibility: "private",
  permissions: { can_edit: true, can_run: true, can_delete: true, can_share: true },
  recent_stats: { last_run_at: "2026-06-16T00:00:00Z", runs_7d: 4 },
};
const workerDetail = {
  ...worker,
  config: {
    id: WORKER_ID,
    name: worker.name,
    trigger: { type: "manual" },
    runtime: { type: "python311", entrypoint: "run.py", runner: "e2b", mode: "pure-script" },
    inputs: [],
    outputs: [],
    contexts: [],
    connections: [],
    secrets: [],
  },
  files: [{ path: "worker.yml", content: "name: Spend Stat Worker\n" }],
  recent_runs: [],
};

const { getSpend } = vi.hoisted(() => ({ getSpend: vi.fn() }));

vi.mock("@/lib/api", () => ({
  getPersistedActiveWorkspaceId: vi.fn(() => "local-default"),
  api: {
    workers: {
      list: vi.fn().mockResolvedValue([worker]),
      get: vi.fn().mockResolvedValue(workerDetail),
      listVersions: vi.fn().mockResolvedValue([]),
      getSpend,
      feedback: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), delete: vi.fn() },
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
  window.localStorage.clear();
});

async function openDetail() {
  const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
  render(
    <QueryProvider>
      <WorkersCollection initialWorkers={[worker as never]} />
    </QueryProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: /Spend Stat Worker/i }));
  await waitFor(() => expect(document.querySelector(".c-dtabs")).toBeTruthy());
}

describe("worker-detail spend stat (#1201)", () => {
  it("renders spend against the worker's configured cap", async () => {
    getSpend.mockResolvedValue({ worker_id: WORKER_ID, month_spend_usd: 4.2, monthly_cap_usd: 25 });
    await openDetail();
    expect(await screen.findByText("Spend (mo)")).toBeInTheDocument();
    expect(await screen.findByText("$4.20 / $25.00")).toBeInTheDocument();
    expect(getSpend).toHaveBeenCalledWith(WORKER_ID);
  });

  it("renders spend alone when the worker has no configured cap", async () => {
    getSpend.mockResolvedValue({ worker_id: WORKER_ID, month_spend_usd: 0, monthly_cap_usd: null });
    await openDetail();
    expect(await screen.findByText("Spend (mo)")).toBeInTheDocument();
    expect(await screen.findByText("$0.00")).toBeInTheDocument();
  });

  it("omits the spend stat entirely if the fetch fails, without crashing", async () => {
    getSpend.mockRejectedValue(new Error("boom"));
    await openDetail();
    // Other stats still render.
    expect(await screen.findByText("Last run")).toBeInTheDocument();
    expect(screen.queryByText("Spend (mo)")).not.toBeInTheDocument();
  });
});
