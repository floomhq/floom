import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function src(rel: string) {
  return readFileSync(join(__dirname, "..", rel), "utf8");
}

describe("launch legal and CLI auth copy", () => {
  it("terms are hosted-aware and no longer self-hosted-only", () => {
    const terms = src("app/terms/page.tsx");
    expect(terms).toContain("Floom Cloud");
    expect(terms).toContain("CLI");
    expect(terms).toContain("MCP server");
    expect(terms).toContain("Workers and outputs");
    expect(terms).not.toContain("This instance is operated by its deployer for their own use.");
  });

  it("privacy covers hosted data, CLI/MCP tokens, and analytics without stale single-tenant copy", () => {
    const privacy = src("app/privacy/page.tsx");
    expect(privacy).toContain("Floom Cloud");
    expect(privacy).toContain("CLI and MCP access");
    expect(privacy).toContain("Analytics and diagnostics");
    expect(privacy).toContain("Conversations and Library folders");
    expect(privacy).not.toContain("single-tenant deployment");
  });

  it("CLI device approval links terms and privacy before connecting", () => {
    const cliAuth = src("app/cli-auth/page.tsx");
    expect(cliAuth).toContain("By approving, you connect this CLI/MCP client");
    expect(cliAuth).toContain('href="/terms"');
    expect(cliAuth).toContain('href="/privacy"');
  });
});
