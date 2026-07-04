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
  status: "healthy",
  missing_connections: [],
};

const workerDetail = {
  ...workerWithMissingConnections,
  config: {
    id: WORKER_ID,
    name: "My Gmail Digest",
    trigger: { type: "schedule" },
    runtime: { type: "python311", entrypoint: "run.py", runner: "e2b", mode: "agent" },
    inputs: [],
    outputs: [],
    contexts: [],
    connections: [{ app_name: "gmail" }, { app_name: "slack" }],
    secrets: [],
  },
  files: [{ path: "worker.yml", content: "name: My Gmail Digest\n" }],
  recent_runs: [],
};

vi.mock("@/lib/api", () => ({
  getPersistedActiveWorkspaceId: vi.fn(() => "local-default"),
  setActiveWorkspaceId: vi.fn(),
  api: {
    workers: {
      list: vi.fn().mockResolvedValue([workerWithMissingConnections]),
      get: vi.fn().mockResolvedValue(workerDetail),
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
  fireEvent.click(await screen.findByRole("button", { name: /My Gmail Digest/i }));
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
    const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
    cleanup();
    const client = makeQueryClient();
    render(
      <QueryClientProvider client={client}>
        <WorkersCollection initialWorkers={[workerAllConnected as never]} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole("button", { name: /My Gmail Digest/i }));
    await waitFor(() => expect(document.querySelector(".c-dhead")).toBeTruthy());
    expect(screen.queryByText(/connect your tools to bring this worker to life/i)).not.toBeInTheDocument();
  });
});
