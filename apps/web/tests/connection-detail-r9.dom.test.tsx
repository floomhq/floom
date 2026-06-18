import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// R9: structural proof of the REAL connection detail (not a mockup). Mounts the
// real ConnectionsCollection, opens the detail pane for an OAuth connection and
// an MCP connection, and asserts the shared spine + the worker-detail-matching
// "Advanced ▾" group on the tab row. Build/tsc cannot verify these; this does.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/connections",
}));

const gmail = {
  id: "c-gmail",
  app_name: "gmail",
  status: "active",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  display_name: "Gmail",
  account_label: "team@floom.dev",
  scopes: ["gmail.readonly", "gmail.send"],
  owner_id: null,
  kind: "composio",
};
const linear = {
  id: "c-linear",
  app_name: "linear-mcp",
  status: "active",
  created_at: "2026-01-01",
  updated_at: "2026-01-01",
  kind: "mcp",
  mcp_label: "linear-mcp",
  mcp_url: "https://mcp.linear.app/sse",
  mcp_transport: "sse",
  mcp_allowed_tools: ["create_issue", "list_issues"],
};
const worker = {
  id: "w1",
  name: "Inbox Triage",
  connections: ["gmail"],
};

const listConnections = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    connections: {
      list: (...a: unknown[]) => listConnections(...a),
      delete: vi.fn(),
      test: vi.fn().mockResolvedValue({ status: "valid", reason: "", tested_at: "" }),
      activity: vi.fn().mockResolvedValue([]),
      peek: vi.fn().mockResolvedValue({ emails: [] }),
      tools: vi.fn().mockResolvedValue({ tools: ["create_issue", "list_issues", "search_issues"] }),
      toolPresets: vi.fn().mockResolvedValue({ app: "gmail", tools: ["gmail.readonly"] }),
    },
    secrets: { list: vi.fn().mockResolvedValue([]), upsert: vi.fn(), test: vi.fn(), delete: vi.fn() },
    workers: { list: vi.fn().mockResolvedValue([worker]) },
    members: { list: vi.fn().mockResolvedValue({ members: [] }) },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  listConnections.mockResolvedValue([gmail, linear]);
});

function TestQueryProvider({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

async function openDetail(name: RegExp) {
  const { default: ConnectionsCollection } = await import("@/app/connections/ConnectionsCollection");
  render(
    <TestQueryProvider>
      <ConnectionsCollection initialConnections={[gmail as never, linear as never]} />
    </TestQueryProvider>,
  );
  // Click the resting-list/grid row to open the 70% detail pane.
  const trigger = await screen.findByText(name);
  fireEvent.click(trigger);
}

describe("R9 connection detail (real component)", () => {
  it("OAuth connection shows the shared spine + Advanced group on the tab row", async () => {
    await openDetail(/^Gmail$/);
    // The 5-tab spine.
    for (const tab of ["Overview", "Tools", "Secrets", "Used by", "Activity"]) {
      expect(await screen.findByRole("tab", { name: new RegExp(`^${tab}`) })).toBeInTheDocument();
    }
    // FIX-pattern parity with worker detail: the Advanced group sits INSIDE the
    // tab row (tabsTrailing), not in a header overflow.
    const tablist = screen.getByRole("tablist");
    expect(within(tablist).getByRole("button", { name: /Advanced tabs/i })).toBeInTheDocument();
    // Test + Reconnect are the inline primary actions.
    expect(screen.getByRole("button", { name: /^Test$/ })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /Reconnect/i })).toBeInTheDocument();
  });

  it("OAuth Tools tab is honest about per-worker scope", async () => {
    await openDetail(/^Gmail$/);
    fireEvent.click(await screen.findByRole("tab", { name: /^Tools/ }));
    expect(await screen.findByText(/Default tool scope for new workers/i)).toBeInTheDocument();
    expect(screen.getByText(/Each worker can narrow this further/i)).toBeInTheDocument();
  });

  it("OAuth Used-by lists the worker that declares the connection", async () => {
    await openDetail(/^Gmail$/);
    fireEvent.click(await screen.findByRole("tab", { name: /^Used by/ }));
    expect(await screen.findByText("Inbox Triage")).toBeInTheDocument();
    expect(screen.getByText(/Disconnecting stops 1 worker/i)).toBeInTheDocument();
  });

  it("MCP connection shows the same spine and dials live tools", async () => {
    await openDetail(/^linear-mcp$/);
    for (const tab of ["Overview", "Tools", "Secrets", "Used by", "Activity"]) {
      expect(await screen.findByRole("tab", { name: new RegExp(`^${tab}`) })).toBeInTheDocument();
    }
    fireEvent.click(await screen.findByRole("tab", { name: /^Tools/ }));
    // Allowed-for-workers + the live "available but not allowed" split.
    expect(await screen.findByText(/Allowed for workers/i)).toBeInTheDocument();
    expect(await screen.findByText(/Available but not allowed/i)).toBeInTheDocument();
    // search_issues is live-only (not in mcp_allowed_tools) -> available section.
    expect(await screen.findByText("search_issues")).toBeInTheDocument();
  });
});
