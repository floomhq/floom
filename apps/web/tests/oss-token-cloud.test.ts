import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMcpServerConfig } from "@/lib/mcp-config";

describe("oss-token cloud seam", () => {
  it("uses NEXT_PUBLIC_API_PROXY_BASE instead of a hardcoded /api/proxy", () => {
    const source = readFileSync("lib/oss-token.ts", "utf8");
    expect(source).toContain("NEXT_PUBLIC_API_PROXY_BASE");
    expect(source).not.toMatch(/const PROXY_BASE = "\/api\/proxy"/);
  });

  it("mints cloud credentials via POST /auth/tokens", () => {
    const source = readFileSync("lib/oss-token.ts", "utf8");
    expect(source).toContain("NEXT_PUBLIC_WORKEROS_DEPLOY");
    expect(source).toContain("/auth/tokens");
    expect(source).toContain("generateCloudPat");
  });
});

describe("MCP server config (cloud deploy)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses workspace-scoped /mcp/{id} and Bearer auth on cloud", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKEROS_DEPLOY", "cloud");
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://workeros-api.floom.dev");
    const cfg = buildMcpServerConfig("floom_test_pat", "ws_abc123");
    expect(cfg.mcpServers.floom.url).toBe("https://workeros-api.floom.dev/mcp/ws_abc123");
    expect(cfg.mcpServers.floom.headers.Authorization).toBe("Bearer floom_test_pat");
    expect(cfg.mcpServers.floom.headers).not.toHaveProperty("x-floom-secret");
  });

  it("shows a workspace placeholder when none is selected on cloud", () => {
    vi.stubEnv("NEXT_PUBLIC_WORKEROS_DEPLOY", "cloud");
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://workeros-api.floom.dev");
    const cfg = buildMcpServerConfig("floom_test_pat", "local-default");
    expect(cfg.mcpServers.floom.url).toBe("https://workeros-api.floom.dev/mcp/<YOUR_WORKSPACE_ID>");
  });
});
