import { describe, expect, it } from "vitest";
import { buildMcpServerConfig, buildMcpJson } from "@/lib/mcp-config";

describe("MCP server config", () => {
  it("is a token-free npx command snippet using the stdio server binary", () => {
    const cfg = buildMcpServerConfig();
    expect(cfg.mcpServers.floom.command).toBe("npx");
    expect(cfg.mcpServers.floom.args).toEqual(["-y", "-p", "@floomhq/floom", "floom-mcp"]);
    // nothing to leak/rotate: no url, headers, secret, or workspace embedded.
    expect(cfg.mcpServers.floom).not.toHaveProperty("url");
    expect(cfg.mcpServers.floom).not.toHaveProperty("headers");
  });

  it("buildMcpJson is valid pretty JSON matching the config object", () => {
    const json = buildMcpJson();
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(buildMcpServerConfig());
    expect(parsed.mcpServers.floom.command).toBe("npx");
  });
});
