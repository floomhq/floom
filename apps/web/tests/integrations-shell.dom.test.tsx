import fs from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { IntegrationsShell } from "@/components/connections/IntegrationsShell";

vi.mock("next/navigation", () => ({
  usePathname: () => "/connections/mcp",
}));

describe("IntegrationsShell", () => {
  it("keeps the collection-style page header and section nav above page content", () => {
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
    const nav = screen.getByRole("navigation", { name: "Connections sections" });
    const subheading = screen.getByRole("heading", { level: 2, name: "MCP servers your workers can use" });

    expect(heading.compareDocumentPosition(nav) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(nav.compareDocumentPosition(subheading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByText("Use Floom as an MCP server in your AI client.")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "MCP" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Add secret" })).toBeInTheDocument();
  });

  it("is used by standalone Integrations section pages", () => {
    const appRoot = path.resolve(__dirname, "..", "app");

    for (const relativePath of ["connections/mcp/page.tsx", "connections/secrets/page.tsx"]) {
      const source = fs.readFileSync(path.join(appRoot, relativePath), "utf8");
      expect(source).toContain("IntegrationsShell");
      expect(source).not.toContain("ConnectionsChips");
    }
  });
});
