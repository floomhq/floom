import fs from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IntegrationsShell } from "@/components/connections/IntegrationsShell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/connections/mcp",
}));

describe("IntegrationsShell", () => {
  it("keeps the collection-style page header and a back link to Connections above page content", () => {
    render(
      <IntegrationsShell
        title="MCP"
        subtitle="Use Floom as an MCP server in your AI client."
        actions={<button type="button">Add secret</button>}
      >
        <section>
          <h2>MCP servers your workers can use</h2>
        </section>
      </IntegrationsShell>,
    );

    const heading = screen.getByRole("heading", { level: 1, name: "MCP" });
    // The old bespoke chip section-nav is gone — these standalone add/manage
    // pages link BACK to the unified Connections list (Connected / MCP / Secrets
    // are now type filters on that one surface).
    const back = screen.getByRole("link", { name: /connections/i });
    const subheading = screen.getByRole("heading", { level: 2, name: "MCP servers your workers can use" });

    expect(back).toHaveAttribute("href", "/connections");
    expect(back.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(heading.compareDocumentPosition(subheading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Use Floom as an MCP server in your AI client.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add secret" })).toBeInTheDocument();

    // The removed chip section-nav must not reappear.
    expect(screen.queryByRole("navigation", { name: /integrations sections/i })).toBeNull();
  });

  it("is used by standalone Connections section pages, with no chip section-nav", () => {
    const appRoot = path.resolve(__dirname, "..", "app");

    for (const relativePath of ["connections/mcp/page.tsx", "connections/secrets/page.tsx"]) {
      const source = fs.readFileSync(path.join(appRoot, relativePath), "utf8");
      expect(source).toContain("IntegrationsShell");
      expect(source).not.toContain("ConnectionsChips");
    }
  });
});
