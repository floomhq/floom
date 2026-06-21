// #1784: the Integrations→Connections rename (#1751) was incomplete. The
// connections-tool group in the MCP/CLI tool catalog (Settings -> API access)
// still grouped the `connections.*` tools under a header literally labeled
// "Integrations". This guards the completed rename: the group that lists the
// `connections.*` tools is labeled "Connections", and there is no bare
// "Integrations" group header. (The page H1 + sidebar nav are covered by
// connections-ia.dom.test.tsx.)
import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// next/link only touches the router on navigation, not on render, but mock it
// to match repo test conventions and stay isolated from the App Router runtime.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/settings",
  useSearchParams: () => new URLSearchParams(),
}));

describe("Connections rename (#1784): MCP tool catalog group label", () => {
  it("labels the connections.* tool group 'Connections', not 'Integrations'", async () => {
    const { McpToolCatalog } = await import("@/components/McpToolCatalog");
    render(<McpToolCatalog />);

    // Group headers render as buttons regardless of expansion state. The
    // connections.* group header now starts with "Connections" (e.g.
    // "Connections (5)").
    expect(
      screen.getByRole("button", { name: /^connections\b/i }),
    ).toBeInTheDocument();

    // There is no standalone "Integrations" group header anymore. (The
    // "Triggers & Integrations" header, for triggers.* / integrations.catalog,
    // starts with "Triggers", so /^integrations/ does not match it.)
    expect(
      screen.queryByRole("button", { name: /^integrations\b/i }),
    ).toBeNull();
  });
});
