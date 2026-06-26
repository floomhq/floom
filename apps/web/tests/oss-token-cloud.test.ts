import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
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

describe("MCP server config", () => {
  it("is a token-free npx command (no URL/Bearer/secret to leak on cloud)", () => {
    const cfg = buildMcpServerConfig();
    expect(cfg.mcpServers.floom.command).toBe("npx");
    expect(cfg.mcpServers.floom).not.toHaveProperty("url");
    expect(cfg.mcpServers.floom).not.toHaveProperty("headers");
  });
});
