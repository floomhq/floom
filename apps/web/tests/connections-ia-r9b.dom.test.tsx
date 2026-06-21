// Connections IA (Federico 2026-06-19): the four Connections surfaces
// (Connected / Browse apps / MCP / Secrets) share a CHIP-style segmented nav
// (ConnectionsChips) at the top of each route — "the chips to filter are
// enough". This reverts the round-09 batch2 IA (Browse=button on /connections,
// Secrets=sidebar sub-item). Proves:
//   1. ConnectionsCollection renders the chip nav (4 chips, aria-label
//      "Integrations sections") and NO standalone "Browse apps" CTA button.
//   2. The sidebar NavLinks has Integrations as a SINGLE nav row, with NO
//      Secrets sub-item (Secrets lives in the chip nav, not the sidebar).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/connections",
}));

vi.mock("@/lib/api", () => ({
  api: {
    workers: { list: vi.fn().mockResolvedValue([]) },
    connections: { list: vi.fn().mockResolvedValue([]), delete: vi.fn(), test: vi.fn() },
    secrets: { list: vi.fn().mockResolvedValue([]) },
  },
}));

function TestQueryProvider({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe("Connections IA — chip nav, not a tab row or Browse button", () => {
  it("ConnectionsCollection renders the 4-chip surface nav and NO Browse-button CTA", async () => {
    const { default: ConnectionsCollection } = await import(
      "@/app/connections/ConnectionsCollection"
    );
    render(
      <TestQueryProvider>
        <ConnectionsCollection initialConnections={[]} />
      </TestQueryProvider>,
    );

    // The chip nav (aria-label="Connections sections") with all 4 surfaces. (#1707: unified terminology)
    const chipNav = await screen.findByRole("navigation", { name: /connections sections/i });
    const connected = within(chipNav).getByRole("link", { name: /^connected$/i });
    expect(connected).toHaveAttribute("href", "/connections");
    const browse = within(chipNav).getByRole("link", { name: /browse apps/i });
    expect(browse).toHaveAttribute("href", "/connections/browse");
    const mcp = within(chipNav).getByRole("link", { name: /^mcp$/i });
    expect(mcp).toHaveAttribute("href", "/connections/mcp");
    const secrets = within(chipNav).getByRole("link", { name: /^secrets$/i });
    expect(secrets).toHaveAttribute("href", "/connections/secrets");
    expect(within(chipNav).getAllByRole("link")).toHaveLength(4);

    // The active chip ("Connected" on /connections) is emphasized via .on.
    expect(connected.className).toContain("on");

    // The option-A standalone "Browse apps" CTA button is gone — the only
    // "Browse apps" link is the chip inside the surface nav.
    expect(screen.getAllByRole("link", { name: /browse apps/i })).toHaveLength(1);
  });
});

describe("Sidebar IA — Connections is a single nav row, no Secrets sub-item", () => {
  it("NavLinks has no Secrets sidebar sub-item", async () => {
    vi.doMock("@/lib/useApprovalsSync", () => ({ useApprovalsCount: () => 0 }));
    vi.doMock("@/lib/query/prefetch", () => ({
      prefetchRouteData: vi.fn(),
      prefetchIdleRoutes: vi.fn(),
    }));
    const { NavLinks } = await import("@/components/layout/sidebar");
    render(
      <TestQueryProvider>
        <NavLinks pathname="/connections" />
      </TestQueryProvider>,
    );

    /* #1707: sidebar now says "Connections" not "Integrations" */
    const connections = screen.getByRole("link", { name: /^connections$/i });
    expect(connections).toHaveAttribute("href", "/connections");

    // The option-A Secrets sidebar sub-item is reverted: no Secrets link here.
    expect(screen.queryByRole("link", { name: /^secrets$/i })).toBeNull();
  });
});
