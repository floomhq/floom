// Round-09 batch2 (Federico 2026-06-18): drop the Connections in-page tab row;
// proper IA — Browse=button on /connections, Secrets=sidebar sub-item, MCP=the
// existing sidebar popup (no duplicate nav). Proves:
//   1. ConnectionsCollection renders a primary "Browse apps" CTA (→
//      /connections/browse) and NO in-page tab nav ("Integrations sections").
//   2. The sidebar NavLinks renders a Secrets sub-item under Integrations
//      (→ /connections/secrets).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
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

describe("Connections IA — no tab row, Browse is a button", () => {
  it("ConnectionsCollection shows a Browse apps CTA and NO in-page tab nav", async () => {
    const { default: ConnectionsCollection } = await import(
      "@/app/connections/ConnectionsCollection"
    );
    render(
      <TestQueryProvider>
        <ConnectionsCollection initialConnections={[]} />
      </TestQueryProvider>,
    );

    // Primary discovery CTA → the catalogue.
    const browse = await screen.findByRole("link", { name: /browse apps/i });
    expect(browse).toHaveAttribute("href", "/connections/browse");

    // The old shared tab strip (aria-label="Integrations sections") is gone.
    expect(screen.queryByRole("navigation", { name: /integrations sections/i })).toBeNull();
  });
});

describe("Sidebar IA — Secrets is a sub-item under Integrations", () => {
  it("NavLinks renders a Secrets sub-item linking to /connections/secrets", async () => {
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

    const integrations = screen.getByRole("link", { name: /integrations/i });
    expect(integrations).toHaveAttribute("href", "/connections");

    const secrets = screen.getByRole("link", { name: /secrets/i });
    expect(secrets).toHaveAttribute("href", "/connections/secrets");
  });
});
