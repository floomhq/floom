import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Render the REAL page components (not the generic engine) with mocked data, to
// prove they mount + render rows without client-side crashes. This is the layer
// that build/tsc can't verify. Live/responsive checks still need a backend.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
}));

function TestQueryProvider({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const worker = {
  id: "w1",
  name: "Weekly Update",
  description: "Turns notes into an update",
  tags: ["operations"],
  status: "healthy",
  trigger_type: "manual",
  runner: "e2b",
  triggers: [],
  triggers_spec: [],
  connections: ["github"],
  recent_stats: { last_run_at: "2026-06-08T00:00:00Z", runs_7d: 3 },
  visibility: "workspace",
};
const workerDetail = {
  ...worker,
  config: {
    id: "w1",
    name: "Weekly Update",
    trigger: { type: "manual" },
    runtime: {
      type: "skill",
      entrypoint: "SKILL.md",
      runner: "e2b",
      mode: "agent",
      model: "bedrock/us.anthropic.claude-sonnet-4-6",
    },
    inputs: [],
    outputs: [],
    contexts: [],
    connections: [],
    secrets: [],
  },
  files: [],
  recent_runs: [],
};
const run = {
  id: "r1",
  worker_id: "w1",
  worker_name: "Weekly Update",
  status: "completed",
  trigger_source: "manual",
  created_at: "2026-06-09T08:00:00Z",
  duration_ms: 1200,
};
const connection = {
  id: "c1",
  app_name: "github",
  status: "active",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  display_name: "GitHub",
  account_label: "octocat",
  scopes: ["repo"],
};
const folder = {
  name: "Company facts",
  file_count: 3,
  total_size_bytes: 4096,
  updated_at: "2026-06-08T00:00:00Z",
  writeable: true,
  worker_count: 2,
  visibility: "workspace",
};
const approval = {
  id: "a1",
  run_id: "rr1",
  worker_id: "w1",
  worker_name: "Reverse Match CRM",
  status: "pending",
  label: "wants to update 5 CRM records",
  created_at: "2026-06-09T06:00:00Z",
  decision_input_json: '{"items":[1,2,3,4,5]}',
};

vi.mock("@/lib/api", () => ({
  api: {
    workers: {
      list: vi.fn().mockResolvedValue([worker]),
      get: vi.fn().mockResolvedValue(workerDetail),
      feedback: {
        list: vi.fn().mockResolvedValue([]),
        create: vi.fn(),
        delete: vi.fn(),
      },
    },
    runs: { list: vi.fn().mockResolvedValue([run]), get: vi.fn().mockResolvedValue(run) },
    connections: { list: vi.fn().mockResolvedValue([connection]), delete: vi.fn(), test: vi.fn() },
    secrets: { list: vi.fn().mockResolvedValue([]) },
    contexts: { list: vi.fn().mockResolvedValue([folder]), get: vi.fn().mockResolvedValue({ ...folder, files: [], used_by: [] }), delete: vi.fn() },
    approvals: { list: vi.fn().mockResolvedValue([approval]) },
  },
}));

// Quiet the approvals cross-tab sync hook (uses storage/timers).
vi.mock("@/lib/useApprovalsSync", () => ({
  notifyApprovalsChanged: vi.fn(),
  useApprovalsListSync: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
});

describe("page components render with data (no client crash)", () => {
  it("WorkersCollection renders the worker", async () => {
    const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
    render(<TestQueryProvider><WorkersCollection initialWorkers={[worker as never]} /></TestQueryProvider>);
    expect(await screen.findByText("Weekly Update")).toBeInTheDocument();
  });

  it("WorkersCollection Setup renders friendly runtime labels", async () => {
    const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
    render(<TestQueryProvider><WorkersCollection initialWorkers={[worker as never]} /></TestQueryProvider>);
    fireEvent.click(await screen.findByRole("button", { name: /Weekly Update/i }));
    // R9: Setup is a PRIMARY tab (always visible) — no Advanced dropdown needed.
    fireEvent.click(await screen.findByRole("tab", { name: "Setup" }));
    // Triggers sub-tab label is immediately visible on the Setup second-row tab bar.
    expect(screen.getAllByText("Triggers").length).toBeGreaterThan(0);
    // Navigate to Limits sub-tab to verify runtime labels are shown as friendly strings.
    fireEvent.click(await screen.findByRole("tab", { name: "Limits" }));
    expect(await screen.findByText(/E2B sandbox/)).toBeInTheDocument();
    expect(screen.getByText(/Agent skill/)).toBeInTheDocument();
    // The raw model ID must never appear anywhere (model label display removed from
    // WorkersCollection in R9 — Config dissolved into Setup/Advanced tabs).
    expect(screen.queryByText("bedrock/us.anthropic.claude-sonnet-4-6")).not.toBeInTheDocument();
  });

  it("RunsCollection renders the run + Export action", async () => {
    const { default: RunsCollection } = await import("@/app/runs/RunsCollection");
    render(<TestQueryProvider><RunsCollection initialRuns={[run as never]} /></TestQueryProvider>);
    expect(await screen.findByText("Weekly Update")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /export/i })).toBeInTheDocument();
    expect(screen.queryByText("Export CSV")).not.toBeInTheDocument();
  });

  it("RunsCollection renders runs returned by the client API when server data is empty", async () => {
    const { default: RunsCollection } = await import("@/app/runs/RunsCollection");
    render(<TestQueryProvider><RunsCollection initialRuns={[]} /></TestQueryProvider>);
    expect(await screen.findByText("Weekly Update")).toBeInTheDocument();
    expect(screen.queryByText("No runs yet")).not.toBeInTheDocument();
  });

  it("ConnectionsCollection renders the connection", async () => {
    const { default: ConnectionsCollection } = await import("@/app/connections/ConnectionsCollection");
    render(<TestQueryProvider><ConnectionsCollection initialConnections={[connection as never]} /></TestQueryProvider>);
    expect(await screen.findByText("GitHub")).toBeInTheDocument();
  });

  it("ConnectionsCollection renders connections returned by the client API when server data is empty", async () => {
    const { default: ConnectionsCollection } = await import("@/app/connections/ConnectionsCollection");
    render(<TestQueryProvider><ConnectionsCollection initialConnections={[]} /></TestQueryProvider>);
    expect(await screen.findByText("GitHub")).toBeInTheDocument();
    expect(screen.queryByText("No connections yet")).not.toBeInTheDocument();
  });

  it("BrainCollection renders the folder", async () => {
    const { default: BrainCollection } = await import("@/app/brain/BrainCollection");
    render(<TestQueryProvider><BrainCollection initialFolders={[folder as never]} /></TestQueryProvider>);
    // List view is the default; the folder name appears as the row primary text.
    expect(await screen.findByText("Company facts")).toBeInTheDocument();
    // "3 files" appears as a column cell in list view.
    expect(screen.getByText("3 files")).toBeInTheDocument();
    // BrainVisual (which rendered "Contexts") was removed; collection title is now "Library".
    expect(screen.getByText("Library")).toBeInTheDocument();
  });

  it("ApprovalsCollection fetches + renders the approval", async () => {
    const { default: ApprovalsCollection } = await import("@/app/approvals/ApprovalsCollection");
    render(<TestQueryProvider><ApprovalsCollection /></TestQueryProvider>);
    expect(await screen.findByText("Reverse Match CRM")).toBeInTheDocument();
  });

  it("ApprovalsCollection does not show worker content-tag counts when no approvals are pending", async () => {
    const { api } = await import("@/lib/api");
    vi.mocked(api.approvals.list).mockResolvedValueOnce([]);
    vi.mocked(api.workers.list).mockResolvedValueOnce([{ ...worker, tags: ["email"] }] as never);

    const { default: ApprovalsCollection } = await import("@/app/approvals/ApprovalsCollection");
    render(<TestQueryProvider><ApprovalsCollection /></TestQueryProvider>);

    expect(await screen.findByText("No pending approvals")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /email/i })).not.toBeInTheDocument();
  });

  it("shows loading skeletons, not empty states, while first collection fetches are pending", async () => {
    const { api } = await import("@/lib/api");

    // Use a plain QueryClientProvider (not PersistQueryClientProvider) so the
    // async localStorage-restore phase doesn't suppress isLoading during the test.
    function makeQC() {
      return new QueryClient({ defaultOptions: { queries: { retry: false } } });
    }
    function QP({ children }: { children: React.ReactNode }) {
      return <QueryClientProvider client={makeQC()}>{children}</QueryClientProvider>;
    }

    vi.mocked(api.workers.list).mockReturnValueOnce(new Promise(() => {}) as never);
    const { default: WorkersCollection } = await import("@/app/workers/WorkersCollection");
    const workers = render(<QP><WorkersCollection initialWorkers={[]} /></QP>);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("No workers yet")).not.toBeInTheDocument();
    workers.unmount();

    vi.mocked(api.runs.list).mockReturnValueOnce(new Promise(() => {}) as never);
    const { default: RunsCollection } = await import("@/app/runs/RunsCollection");
    const runs = render(<QP><RunsCollection initialRuns={[]} /></QP>);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("No run history yet")).not.toBeInTheDocument();
    runs.unmount();

    vi.mocked(api.connections.list).mockReturnValueOnce(new Promise(() => {}) as never);
    const { default: ConnectionsCollection } = await import("@/app/connections/ConnectionsCollection");
    const connections = render(<TestQueryProvider><ConnectionsCollection initialConnections={[]} /></TestQueryProvider>);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("No connections yet")).not.toBeInTheDocument();
    connections.unmount();

    vi.mocked(api.contexts.list).mockReturnValueOnce(new Promise(() => {}) as never);
    const { default: BrainCollection } = await import("@/app/brain/BrainCollection");
    const brain = render(<TestQueryProvider><BrainCollection initialFolders={[]} /></TestQueryProvider>);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("No folders yet")).not.toBeInTheDocument();
    brain.unmount();

    vi.mocked(api.approvals.list).mockReturnValueOnce(new Promise(() => {}) as never);
    const { default: ApprovalsCollection } = await import("@/app/approvals/ApprovalsCollection");
    const approvals = render(<TestQueryProvider><ApprovalsCollection /></TestQueryProvider>);
    expect(screen.getByLabelText("Loading")).toBeInTheDocument();
    expect(screen.queryByText("No pending approvals")).not.toBeInTheDocument();
    approvals.unmount();
  });
});
