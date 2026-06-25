import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(path, "utf8");

describe("medium issue batch source guards", () => {
  it("exposes worker row actions beyond Open", () => {
    const source = read("app/workers/WorkersCollection.tsx");

    expect(source).toContain('label: "Run"');
    expect(source).toContain('label: "Duplicate"');
    expect(source).toContain('api.workers.duplicate');
    expect(source).toContain('"Archive"');
    expect(source).toContain("api.workers.archive");
    expect(source).toContain('label: "Delete"');
    expect(source).toContain('confirm: {');
  });

  it("shows Email as a first-class Settings channel backed by the channel endpoint", () => {
    const settings = read("app/settings/page.tsx");
    const api = read("lib/api.ts");

    expect(settings).toContain('TabsTrigger value="email"');
    expect(settings).toContain("EmailChannelStatus");
    expect(settings).toContain("api.system.emailChannel");
    expect(api).toContain('fetchJson<{ connected: boolean; email?: string | null }>("/channels/email")');
  });

  it("renders real MCP client logos for the primary install clients", () => {
    const source = read("components/mcp/McpInstallPanel.tsx");

    expect(source).toContain("MCP_CLIENTS");
    expect(source).toContain('label: "Claude Code"');
    expect(source).toContain('label: "Cursor"');
    expect(source).toContain('label: "Codex"');
    expect(source).toContain('icon: "claude-code"');
    expect(source).toContain('icon: "codex"');
    expect(source).toContain('icon: "vscode"');
    expect(source).toContain("BrandLogo");
    expect(source).not.toContain('icon: "anthropic"');
    expect(source).not.toContain('icon: "openai"');
    expect(source).not.toContain("client.mark");
    expect(source).not.toContain('mark: "C"');
    expect(source).not.toContain("grid-cols-2");
    expect(source).not.toContain("bg-[var(--bg-2)] px-3 py-2.5");
    expect(source).toContain('aria-label="Supported MCP clients"');
    expect(source).toContain('href="/settings?sel=personal_tokens"');
    expect(source).toContain("Manage personal tokens");
    expect(source).toContain('href="/settings?sel=connect&tab=mcp"');
    expect(source).toContain("max-w-full overflow-x-auto");
    expect(source).toContain("min-w-0 overflow-hidden");
  });
});
