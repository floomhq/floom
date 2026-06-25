import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const workerRows = [
  { id: "worker-1", name: "Cached Worker", description: "", tags: [] },
] as never[];
const runRows = [
  { id: "run-1", worker_id: "worker-1", worker_name: "Cached Worker", status: "completed" },
] as never[];
const contextRows = [
  { name: "Cached Folder", description: "", file_count: 2, visibility: "private" },
] as never[];
const approvalRows = [
  { id: "approval-1", worker_id: "worker-1", worker_name: "Cached Worker", label: "Send report" },
] as never[];

const calls = {
  workers: vi.fn(async (opts?: unknown) => {
    void opts;
    return workerRows;
  }),
  runs: vi.fn(async (params?: unknown) => {
    void params;
    return runRows;
  }),
  contexts: vi.fn(async () => contextRows),
  approvals: vi.fn(async (status?: unknown) => {
    void status;
    return approvalRows;
  }),
};

vi.mock("@/lib/api", () => ({
  api: {
    workers: { list: (opts?: unknown) => calls.workers(opts) },
    runs: { list: (params?: unknown) => calls.runs(params) },
    contexts: { list: () => calls.contexts() },
    approvals: { list: (status?: unknown) => calls.approvals(status) },
  },
  getActiveWorkspaceId: () => localStorage.getItem("workeros.activeWorkspaceId") || "local-default",
}));

import {
  qk,
  RUNS_FIRST_PAGE_QUERY_PARAMS,
  useApprovals,
  useContexts,
  useRuns,
  useWorkers,
  WORKERS_LIST_QUERY_OPTS,
} from "@/lib/query/hooks";

function makeClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 24 * 60 * 60_000,
        refetchOnMount: false,
        retry: false,
      },
    },
  });
}

function WorkersProbe() {
  const query = useWorkers(WORKERS_LIST_QUERY_OPTS);
  if (query.isLoading && !query.data) return <div data-testid="workers-skeleton" />;
  return <div>{query.data?.[0]?.name}</div>;
}

function RunsProbe() {
  const query = useRuns(RUNS_FIRST_PAGE_QUERY_PARAMS);
  if (query.isLoading && !query.data) return <div data-testid="runs-skeleton" />;
  return <div data-testid="runs-count">{query.data?.length ?? 0}</div>;
}

function ContextsProbe() {
  const query = useContexts();
  if (query.isLoading && !query.data) return <div data-testid="contexts-skeleton" />;
  return <div>{query.data?.[0]?.name}</div>;
}

function ApprovalsProbe() {
  const query = useApprovals("pending");
  if (query.isLoading && !query.data) return <div data-testid="approvals-skeleton" />;
  return <div>{query.data?.[0]?.id}</div>;
}

describe("warm list cache mounts", () => {
  beforeEach(() => {
    calls.workers.mockClear();
    calls.runs.mockClear();
    calls.contexts.mockClear();
    calls.approvals.mockClear();
    localStorage.clear();
  });

  it("renders cached workers on a second mount instead of a skeleton", () => {
    const qc = makeClient();
    qc.setQueryData(qk.workers(WORKERS_LIST_QUERY_OPTS), workerRows);

    const first = render(
      <QueryClientProvider client={qc}>
        <WorkersProbe />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("workers-skeleton")).toBeNull();
    expect(screen.getByText("Cached Worker")).toBeInTheDocument();
    first.unmount();

    render(
      <QueryClientProvider client={qc}>
        <WorkersProbe />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("workers-skeleton")).toBeNull();
    expect(screen.getByText("Cached Worker")).toBeInTheDocument();
    expect(calls.workers).not.toHaveBeenCalled();
  });

  it("renders cached runs on a second mount instead of a skeleton", () => {
    const qc = makeClient();
    qc.setQueryData(qk.runs(RUNS_FIRST_PAGE_QUERY_PARAMS), runRows);

    const first = render(
      <QueryClientProvider client={qc}>
        <RunsProbe />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("runs-skeleton")).toBeNull();
    expect(screen.getByTestId("runs-count").textContent).toBe("1");
    first.unmount();

    render(
      <QueryClientProvider client={qc}>
        <RunsProbe />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("runs-skeleton")).toBeNull();
    expect(screen.getByTestId("runs-count").textContent).toBe("1");
    expect(calls.runs).not.toHaveBeenCalled();
  });

  it("renders cached library folders on a second mount instead of a skeleton", () => {
    const qc = makeClient();
    qc.setQueryData(qk.contexts, contextRows);

    const first = render(
      <QueryClientProvider client={qc}>
        <ContextsProbe />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("contexts-skeleton")).toBeNull();
    expect(screen.getByText("Cached Folder")).toBeInTheDocument();
    first.unmount();

    render(
      <QueryClientProvider client={qc}>
        <ContextsProbe />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("contexts-skeleton")).toBeNull();
    expect(screen.getByText("Cached Folder")).toBeInTheDocument();
    expect(calls.contexts).not.toHaveBeenCalled();
  });

  it("renders cached approvals on a second mount instead of a skeleton", () => {
    const qc = makeClient();
    qc.setQueryData(qk.approvals("pending"), approvalRows);

    const first = render(
      <QueryClientProvider client={qc}>
        <ApprovalsProbe />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("approvals-skeleton")).toBeNull();
    expect(screen.getByText("approval-1")).toBeInTheDocument();
    first.unmount();

    render(
      <QueryClientProvider client={qc}>
        <ApprovalsProbe />
      </QueryClientProvider>,
    );

    expect(screen.queryByTestId("approvals-skeleton")).toBeNull();
    expect(screen.getByText("approval-1")).toBeInTheDocument();
    expect(calls.approvals).not.toHaveBeenCalled();
  });

  it("does not reuse an empty runs cache across workspaces", async () => {
    const qc = makeClient();
    localStorage.setItem("workeros.activeWorkspaceId", "ws_empty");
    qc.setQueryData(qk.runs(RUNS_FIRST_PAGE_QUERY_PARAMS), []);

    localStorage.setItem("workeros.activeWorkspaceId", "ws_nova");

    render(
      <QueryClientProvider client={qc}>
        <RunsProbe />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByTestId("runs-count").textContent).toBe("1"));
    expect(calls.runs).toHaveBeenCalledWith(RUNS_FIRST_PAGE_QUERY_PARAMS);
  });
});
