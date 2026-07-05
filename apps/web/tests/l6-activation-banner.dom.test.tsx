/**
 * L6 activation: MissingConnectionsBanner and workspace-id pickup tests.
 * Tests the connect banner shown on the Overview tab of a newly imported
 * worker that has unsatisfied connections.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { WorkerSummary } from "@/lib/types";

const router = vi.hoisted(() => ({
  push: vi.fn(),
  replace: vi.fn(),
  searchParams: "",
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(router.searchParams),
  useRouter: () => router,
  usePathname: () => "/",
}));

const WORKER_ID = "freshly-imported-worker";

const workerWithMissingConnections: WorkerSummary = {
  id: WORKER_ID,
  name: "My Gmail Digest",
  description: "Sends a morning email digest.",
  tags: [],
  status: "needs_attention",
  trigger_type: "schedule",
  runner: "e2b",
  runtime: "python311",
  triggers: [],
  triggers_spec: [],
  connections: ["gmail", "slack"],
  missing_connections: ["gmail", "slack"],
  enabled: true,
  visibility: "shared",
  permissions: { can_edit: true, can_run: true, can_delete: true, can_share: true },
};

const workerAllConnected: WorkerSummary = {
  ...workerWithMissingConnections,
  id: "connected-worker",
  name: "My Slack Notifier",
  status: "healthy",
  missing_connections: [],
};

function makeWorkerDetail(w: WorkerSummary) {
  return {
    ...w,
    config: {
      id: w.id,
      name: w.name,
      trigger: { type: "schedule" },
      runtime: { type: "python311", entrypoint: "run.py", runner: "e2b", mode: "agent" },
      inputs: [],
      outputs: [],
      contexts: [],
      connections: (w.connections ?? []).map((c) => ({ app_name: c })),
      secrets: [],
    },
    files: [{ path: "worker.yml", content: `name: ${w.name}\n` }],
    recent_runs: [],
  };
}

// workerListMock is mutable so per-test cases can override which worker the
// background refresh returns (prevents cache pollution when testing the
// "no missing connections" case alongside the "has missing connections" case).
const { workerListMock } = vi.hoisted(() => ({ workerListMock: vi.fn() }));

vi.mock("@/lib/api", () => ({
  getPersistedActiveWorkspaceId: vi.fn(() => "local-default"),
  setActiveWorkspaceId: vi.fn(),
  api: {
    workers: {
      list: workerListMock,
      // get returns minimal shape; banner reads from WorkerSummary (w), not detail.
      get: vi.fn().mockResolvedValue({ config: { connections: [], contexts: [], inputs: [], outputs: [], secrets: [] }, files: [], recent_runs: [] }),
      listVersions: vi.fn().mockResolvedValue([]),
      alerts: { list: vi.fn().mockResolvedValue([]), create: vi.fn(), remove: vi.fn() },
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
  // Default: list returns the worker with missing connections.
  workerListMock.mockResolvedValue([workerWithMissingConnections]);
  router.searchParams = "";
  window.localStorage.clear();
  window.sessionStorage.clear();
  cleanup();
});

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function renderWithWorker(worker: WorkerSummary) {
  router.searchParams = "";
  const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
  const client = makeQueryClient();
  render(
    <QueryClientProvider client={client}>
      <WorkersCollection initialWorkers={[worker as never]} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole("button", { name: new RegExp(worker.name, "i") }));
  await waitFor(() => expect(document.querySelector(".c-dhead")).toBeTruthy());
}

describe("MissingConnectionsBanner (L6 activation)", () => {
  it("shows the connect banner when worker has missing_connections", async () => {
    await renderWithWorker(workerWithMissingConnections);
    expect(screen.getByText(/connect your tools to bring this worker to life/i)).toBeInTheDocument();
  });

  it("shows a connect button per missing connection slug", async () => {
    await renderWithWorker(workerWithMissingConnections);
    expect(screen.getByRole("link", { name: /connect gmail/i })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /connect slack/i })).toBeInTheDocument();
  });

  it("links each connection button to /connections/connect/<slug> with return_to", async () => {
    await renderWithWorker(workerWithMissingConnections);
    const gmailLink = screen.getByRole("link", { name: /connect gmail/i }) as HTMLAnchorElement;
    expect(gmailLink.href).toContain("/connections/connect/gmail");
    expect(gmailLink.href).toContain("return_to=");
  });

  it("shows a disabled 'Run a test' button when connections are missing", async () => {
    await renderWithWorker(workerWithMissingConnections);
    const runBtn = screen.getByRole("button", { name: /run a test/i });
    expect(runBtn).toBeDisabled();
  });

  it("dismisses the banner when X is clicked", async () => {
    await renderWithWorker(workerWithMissingConnections);
    const dismiss = screen.getByRole("button", { name: /dismiss/i });
    fireEvent.click(dismiss);
    expect(screen.queryByText(/connect your tools to bring this worker to life/i)).not.toBeInTheDocument();
  });

  it("does NOT show the banner when missing_connections is empty", async () => {
    workerListMock.mockResolvedValue([workerAllConnected]);
    await renderWithWorker(workerAllConnected);
    expect(screen.queryByText(/connect your tools to bring this worker to life/i)).not.toBeInTheDocument();
  });
});
