import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

// FIX 1 (round-09 detail roast): a FAILED list fetch must render an explicit
// error/retry state, NOT the old "ghost zebra rows" skeleton that hangs
// forever and looks identical to an empty list.

let mockSearchParams = "";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/connections/mcp",
  useSearchParams: () => new URLSearchParams(mockSearchParams),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const listMock = vi.fn();
const secretsListMock = vi.fn();
const personalTokensListMock = vi.fn();
const workspaceTokensListMock = vi.fn();
const workspaceTokensCreateMock = vi.fn();

vi.mock("@/components/connections/BrandLogo", () => ({
  BrandLogo: ({ icon }: { icon: string }) => <span data-testid={`brand-${icon}`} />,
}));

vi.mock("@/lib/api", () => ({
  api: {
    tokens: {
      list: () => personalTokensListMock(),
    },
    workspace: {
      tokens: {
        list: () => workspaceTokensListMock(),
        create: () => workspaceTokensCreateMock(),
      },
    },
    connections: {
      list: () => listMock(),
      delete: vi.fn(),
      test: vi.fn(),
      createMcp: vi.fn(),
    },
    secrets: {
      list: () => secretsListMock(),
    },
  },
}));

import McpConnectionsPage from "@/app/connections/mcp/page";

describe("MCP connections list — load states", () => {
  beforeEach(() => {
    mockSearchParams = "";
    listMock.mockReset();
    secretsListMock.mockReset();
    personalTokensListMock.mockReset();
    workspaceTokensListMock.mockReset();
    workspaceTokensCreateMock.mockReset();
    secretsListMock.mockResolvedValue([]);
    personalTokensListMock.mockResolvedValue([]);
    workspaceTokensListMock.mockResolvedValue([]);
  });

  it("renders an error + retry state (not a perpetual skeleton) when the fetch fails", async () => {
    listMock.mockRejectedValue(new Error("500 Internal Server Error"));
    const { container } = render(<McpConnectionsPage />);

    // Explicit, accessible error state with a retry affordance.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toBeInTheDocument();
    });
    expect(screen.getByText(/could not load/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /retry/i })).toBeInTheDocument();

    // The failure must NOT read as "no MCP servers yet" (empty), and must NOT
    // leave a loading skeleton mounted.
    expect(screen.queryByText(/no mcp servers yet/i)).not.toBeInTheDocument();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
  });

  it("renders the empty state (not the error state) when the fetch succeeds with no servers", async () => {
    listMock.mockResolvedValue([]);
    render(<McpConnectionsPage />);

    await waitFor(() => {
      expect(screen.getByText(/no mcp servers yet/i)).toBeInTheDocument();
    });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("opens the install panel when routed from an install CTA", async () => {
    mockSearchParams = "from_install=workers-empty";
    listMock.mockResolvedValue([]);
    render(<McpConnectionsPage />);

    const installToggle = screen.getByRole("button", { name: /use floom in your ai client/i });
    expect(installToggle).toHaveAttribute("aria-expanded", "true");
    expect(screen.getAllByText(/Codex/i).length).toBeGreaterThan(0);
  });

  it("expands MCP setup with personal tokens, workspace tokens, and CLI login copy", async () => {
    const user = userEvent.setup();
    listMock.mockResolvedValue([]);
    personalTokensListMock.mockResolvedValue([
      {
        id: "pat_1",
        name: "personal-cli",
        created_at: "2026-06-01T00:00:00Z",
        last_used_at: null,
        expires_at: null,
        revoked_at: null,
      },
    ]);
    workspaceTokensListMock.mockResolvedValue([]);

    render(<McpConnectionsPage />);

    await user.click(screen.getByRole("button", { name: /Use Floom in your AI client/i }));

    expect(await screen.findByText(/MCP setup uses your saved CLI login/i)).toBeInTheDocument();
    expect(screen.getByText(/same saved login as the CLI/i)).toBeInTheDocument();
    expect(screen.getByText("floom login")).toBeInTheDocument();
    expect(await screen.findByText(/Personal tokens/i)).toBeInTheDocument();
    expect(screen.getByText(/Existing tokens: 1/i)).toBeInTheDocument();
    expect(screen.getByText(/Workspace tokens/i)).toBeInTheDocument();
  });
});
