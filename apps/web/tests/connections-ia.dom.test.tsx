// Connections IA (Federico 2026-06-19, transplanted onto main): the
// Integrations surface is renamed "Connections" and reworked to the SHARED
// collection pattern used by Workers/Runs:
//   1. Title is "Connections" (not "Integrations").
//   2. NO bespoke count-chip stat row (the "0 connections · 48 secrets · …" tiles
//      are removed).
//   3. NO bespoke "Browse apps" section chip — Browse apps is the Add button's
//      add-app action, reachable from the Add panel.
//   4. Connected / MCP / Secrets are TYPE filters behind the standard `filters`
//      affordance (the collapsible filter button), not a top chip-row.
//   5. The sidebar nav label is "Connections" (route stays /connections).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
    members: { list: vi.fn().mockResolvedValue([]) },
  },
}));

function TestQueryProvider({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

beforeEach(() => vi.clearAllMocks());

describe("Connections IA — renamed, no count chips, standard filters, Browse=Add", () => {
  it("renders the 'Connections' title and NO count-chip stat row", async () => {
    const { default: ConnectionsCollection } = await import(
      "@/app/connections/ConnectionsCollection"
    );
    render(
      <TestQueryProvider>
        <ConnectionsCollection initialConnections={[]} />
      </TestQueryProvider>,
    );

    // Renamed: "Connections", not "Integrations".
    expect(await screen.findByText("Connections")).toBeInTheDocument();
    expect(screen.queryByText("Integrations")).toBeNull();

    // The bespoke count-chip stat row is gone: no "<n> connections" / "secrets"
    // tiles rendered as span.ct.
    const tileTexts = Array.from(document.querySelectorAll("span.ct")).map((el) =>
      (el.textContent || "").replace(/\s+/g, " ").trim(),
    );
    expect(tileTexts.some((t) => /connections$|secrets$|active$|reauth$|error$/.test(t))).toBe(false);

    // No bespoke chip section-nav (Connected / Browse apps / MCP / Secrets row).
    expect(screen.queryByRole("navigation", { name: /integrations sections/i })).toBeNull();
  });

  it("exposes Connected / MCP / Secrets through the standard `filters` affordance, no Browse chip", async () => {
    const { default: ConnectionsCollection } = await import(
      "@/app/connections/ConnectionsCollection"
    );
    render(
      <TestQueryProvider>
        <ConnectionsCollection initialConnections={[]} />
      </TestQueryProvider>,
    );

    // The shared TagBar filter toggle (same primitive Workers/Runs use).
    const filterToggle = await screen.findByRole("button", { name: /filters/i });
    fireEvent.click(filterToggle);

    // Type filters are present as standard tag chips.
    expect(screen.getByRole("button", { name: /^connected$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^mcp$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^secrets$/i })).toBeInTheDocument();

    // "Browse apps" is NOT a filter chip (it is the Add button's add-app action).
    expect(screen.queryByRole("button", { name: /browse apps/i })).toBeNull();
  });
});

describe("Sidebar IA — nav label is 'Connections'", () => {
  it("NavLinks labels /connections as Connections, not Integrations", async () => {
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

    const connections = screen.getByRole("link", { name: /connections/i });
    expect(connections).toHaveAttribute("href", "/connections");
    expect(screen.queryByRole("link", { name: /integrations/i })).toBeNull();
    // Secrets is not a sidebar sub-item (it is a type filter on /connections).
    expect(screen.queryByRole("link", { name: /^secrets$/i })).toBeNull();
  });
});
