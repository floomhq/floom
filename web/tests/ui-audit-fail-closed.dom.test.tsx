import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useMembers } from "@/lib/query/hooks";

const {
  connectionsList,
  secretsList,
  workersList,
  membersList,
  contextsList,
  contextsGet,
  runsList,
  toastError,
  toastSuccess,
} = vi.hoisted(() => ({
  connectionsList: vi.fn(),
  secretsList: vi.fn(),
  workersList: vi.fn(),
  membersList: vi.fn(),
  contextsList: vi.fn(),
  contextsGet: vi.fn(),
  runsList: vi.fn(),
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/connections",
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: toastError, success: toastSuccess }),
}));

vi.mock("@/lib/api", () => ({
  api: {
    connections: {
      list: () => connectionsList(),
      delete: vi.fn(),
      test: vi.fn().mockResolvedValue({ status: "valid", reason: "", tested_at: "" }),
      activity: vi.fn().mockResolvedValue([]),
      peek: vi.fn().mockResolvedValue({ emails: [] }),
      tools: vi.fn().mockResolvedValue({ tools: [] }),
      toolPresets: vi.fn().mockResolvedValue({ app: "gmail", tools: [] }),
      createMcp: vi.fn(),
    },
    secrets: {
      list: () => secretsList(),
      upsert: vi.fn(),
      test: vi.fn(),
      delete: vi.fn(),
    },
    workers: { list: () => workersList() },
    members: { list: () => membersList() },
    contexts: {
      list: () => contextsList(),
      get: (name: string) => contextsGet(name),
      fileUrl: (name: string, path: string) => `/contexts/${name}/${path}`,
    },
    runs: {
      list: (...args: unknown[]) => runsList(...args),
      get: vi.fn(),
      exportBundle: vi.fn(),
    },
  },
}));

const connection = {
  id: "c-gmail",
  app_name: "gmail",
  status: "active",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  display_name: "Gmail",
  account_label: "team@example.com",
  scopes: ["gmail.readonly"],
};

const secret = {
  name: "CRM_TOKEN",
  status: "set",
  used_by: ["Inbox Triage"],
};

const worker = {
  id: "w-inbox",
  name: "Inbox Triage",
  connections: ["gmail"],
};

const folder = {
  name: "company-facts",
  file_count: 1,
  total_size_bytes: 128,
  updated_at: "2026-06-23T00:00:00Z",
  writeable: true,
  read_only: false,
  worker_count: 0,
  visibility: "workspace",
};

const run = {
  id: "run-1",
  worker_id: "w-inbox",
  worker_name: "Inbox Triage",
  status: "completed",
  trigger_source: "manual",
  created_at: "2026-06-23T00:00:00Z",
  duration_ms: 1200,
};

function TestQueryProvider({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function MembersProbe() {
  const query = useMembers();
  if (query.isError) return <div role="alert">members failed</div>;
  if (query.data) return <div>{query.data.length} members</div>;
  return <div>loading</div>;
}

beforeEach(() => {
  vi.clearAllMocks();
  connectionsList.mockResolvedValue([connection]);
  secretsList.mockResolvedValue([]);
  workersList.mockResolvedValue([worker]);
  membersList.mockResolvedValue({ members: [] });
  contextsList.mockResolvedValue([folder]);
  contextsGet.mockResolvedValue({ ...folder, files: [], used_by: [] });
  runsList.mockResolvedValue([run]);
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:export"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("UI audit fail-closed states", () => {
  it("surfaces useMembers failures instead of returning an empty member list", async () => {
    membersList.mockRejectedValueOnce(new Error("members unavailable"));

    render(
      <TestQueryProvider>
        <MembersProbe />
      </TestQueryProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("members failed");
  });

  it("renders the primary connections query error even when secondary side-data is cached", async () => {
    connectionsList.mockRejectedValueOnce(new Error("connections unavailable"));
    secretsList.mockResolvedValueOnce([secret]);

    const { default: ConnectionsCollection } = await import("@/app/connections/ConnectionsCollection");
    render(
      <TestQueryProvider>
        <ConnectionsCollection initialConnections={[]} />
      </TestQueryProvider>,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load connections/i);
    expect(screen.queryByText("No connections yet")).not.toBeInTheDocument();
  });

  it("marks secondary connection metadata failures without hiding primary rows", async () => {
    membersList.mockRejectedValueOnce(new Error("members unavailable"));

    const { default: ConnectionsCollection } = await import("@/app/connections/ConnectionsCollection");
    render(
      <TestQueryProvider>
        <ConnectionsCollection initialConnections={[connection as never]} />
      </TestQueryProvider>,
    );

    expect(await screen.findByText("Gmail")).toBeInTheDocument();
    expect(await screen.findByRole("alert")).toHaveTextContent(/metadata unavailable: members/i);
  });

  it("preserves the selected secret when linking to the Used by tab", async () => {
    secretsList.mockResolvedValueOnce([secret]);

    const { default: ConnectionsCollection } = await import("@/app/connections/ConnectionsCollection");
    render(
      <TestQueryProvider>
        <ConnectionsCollection initialConnections={[]} />
      </TestQueryProvider>,
    );

    fireEvent.click(await screen.findByText("CRM_TOKEN"));
    const overview = await screen.findByRole("tabpanel");
    const usedByLink = within(overview).getByRole("link", { name: /1 worker/i });
    expect(usedByLink).toHaveAttribute("href", "?sel=secret%3ACRM_TOKEN&tab=Used+by");
  });

  it("renders a retryable library detail error instead of a permanent file skeleton", async () => {
    contextsGet.mockRejectedValueOnce(new Error("folder failed"));

    const { default: BrainCollection } = await import("@/app/brain/BrainCollection");
    render(
      <TestQueryProvider>
        <BrainCollection initialFolders={[folder as never]} />
      </TestQueryProvider>,
    );

    fireEvent.click(await screen.findByText("company-facts"));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load folder contents/i);
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();
  });

  it("renders MCP secret loading failure and disables the secret selector", async () => {
    connectionsList.mockResolvedValueOnce([]);
    secretsList.mockRejectedValueOnce(new Error("secrets unavailable"));

    const { default: McpConnectionsPage } = await import("@/app/connections/mcp/page");
    const user = userEvent.setup();
    render(<McpConnectionsPage />);

    await user.click(await screen.findByRole("button", { name: /add mcp server/i }));
    await user.click(screen.getByRole("button", { name: "Form" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(/could not load access keys/i);
    expect(screen.getByLabelText("Access key")).toBeDisabled();
  });

  it("labels CSV export as partial when complete pagination fails", async () => {
    runsList.mockRejectedValue(new Error("runs unavailable"));
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    const { default: RunsCollection } = await import("@/app/runs/RunsCollection");
    const user = userEvent.setup();
    render(
      <TestQueryProvider>
        <RunsCollection initialRuns={[run as never]} />
      </TestQueryProvider>,
    );

    await user.click(await screen.findByRole("button", { name: /export/i }));
    await user.click(await screen.findByRole("menuitem", { name: /export csv/i }));

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("Full export failed. Downloaded 1 loaded runs only.");
    });
    expect(toastSuccess).not.toHaveBeenCalledWith(expect.stringMatching(/Exported 1 runs/));
    clickSpy.mockRestore();
  });
});
