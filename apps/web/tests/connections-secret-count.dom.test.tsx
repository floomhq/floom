import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Round-09 #6 — render the REAL ConnectionsCollection with the live bug data
// (0 connections + 43 secrets) and prove the headline count tiles never read as
// "43 active connections". This exercises the full render path, not just the
// pure collectionCounts() helper.

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/connections",
}));

const secrets = Array.from({ length: 43 }, (_, i) => ({
  name: `SECRET_${i}`,
  status: "set" as const,
  used_by: [],
}));

vi.mock("@/lib/api", () => ({
  api: {
    workers: { list: vi.fn().mockResolvedValue([]) },
    connections: { list: vi.fn().mockResolvedValue([]), delete: vi.fn(), test: vi.fn() },
    secrets: { list: vi.fn().mockResolvedValue(secrets) },
  },
}));

beforeEach(() => vi.clearAllMocks());

function TestQueryProvider({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("ConnectionsCollection count tiles (round-09 #6)", () => {
  it("does not count 43 secrets as active connections", async () => {
    const { default: ConnectionsCollection } = await import(
      "@/app/connections/ConnectionsCollection"
    );
    render(<TestQueryProvider><ConnectionsCollection initialConnections={[]} /></TestQueryProvider>);

    // First secret renders → the unified list mounted.
    expect(await screen.findByText("SECRET_0")).toBeInTheDocument();

    // The count tiles render as <span class="ct"><b>{value}</b> {label}</span>.
    // Normalise each tile's text to "<value> <label>".
    const tileTexts = Array.from(document.querySelectorAll("span.ct")).map((el) =>
      (el.textContent || "").replace(/\s+/g, " ").trim(),
    );

    // The page must report 0 connections and 43 secrets — secrets are NOT
    // connections.
    expect(tileTexts).toContain("0 connections");
    expect(tileTexts).toContain("43 secrets");

    // CRITICAL: no tile pairs 43 with "active" — the live "43 active
    // connections" bug. The active tile (if shown) reflects real connections (0).
    expect(tileTexts).not.toContain("43 active");
    const activeTile = tileTexts.find((t) => t.endsWith(" active"));
    if (activeTile) expect(activeTile).toBe("0 active");
  });
});
