import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMcpServerConfig, buildMcpJson } from "@/lib/mcp-config";

describe("MCP server config (Settings → API tab)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the configured API base for the url and embeds the token", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "http://localhost:8000");
    const cfg = buildMcpServerConfig("wos_member_tok");
    expect(cfg.mcpServers.workeros.url).toBe("http://localhost:8000/mcp-tools/serve");
    expect(cfg.mcpServers.workeros.headers["x-floom-secret"]).toBe("wos_member_tok");
  });

  it("omits x-workeros-workspace for the default workspace", () => {
    const cfg = buildMcpServerConfig("tok", null);
    expect(cfg.mcpServers.workeros.headers).not.toHaveProperty("x-workeros-workspace");
    const cfg2 = buildMcpServerConfig("tok"); // undefined
    expect(cfg2.mcpServers.workeros.headers).not.toHaveProperty("x-workeros-workspace");
  });

  it("pins x-workeros-workspace when a non-default workspace is active", () => {
    const cfg = buildMcpServerConfig("tok", "ws_abc123");
    expect(cfg.mcpServers.workeros.headers["x-workeros-workspace"]).toBe("ws_abc123");
  });

  it("buildMcpJson is valid pretty JSON matching the config object", () => {
    vi.stubEnv("NEXT_PUBLIC_API_BASE", "https://api.acme.internal");
    const json = buildMcpJson("tok", "ws_x");
    const parsed = JSON.parse(json);
    expect(parsed).toEqual(buildMcpServerConfig("tok", "ws_x"));
    expect(parsed.mcpServers.workeros.url).toBe("https://api.acme.internal/mcp-tools/serve");
    expect(parsed.mcpServers.workeros.headers["x-workeros-workspace"]).toBe("ws_x");
  });
});
