import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

// FIX 1 (round-09 detail roast): a FAILED list fetch must render an explicit
// error/retry state, NOT the old "ghost zebra rows" skeleton that hangs
// forever and looks identical to an empty list.

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/connections/mcp",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}));

const listMock = vi.fn();
const secretsListMock = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
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
    listMock.mockReset();
    secretsListMock.mockReset();
    secretsListMock.mockResolvedValue([]);
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
});
