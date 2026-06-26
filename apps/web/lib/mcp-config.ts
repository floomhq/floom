/**
 * Build the ready-to-paste MCP server config (the `mcpServers` entry).
 *
 * One clean, token-free snippet that works for OSS and Cloud alike: the
 * `@floomhq/floom` CLI runs the MCP server over stdio and, on first run, does
 * the device-auth login itself (Floom asks for a workspace token), so the
 * config never has to embed a URL, workspace id, or secret. Cloud vs OSS is
 * resolved by the CLI's own `auth login` (`--cloud`) flow.
 */
export function buildMcpServerConfig(): {
  mcpServers: { floom: { command: string; args: string[] } };
} {
  return {
    mcpServers: {
      floom: {
        command: "npx",
        args: ["-y", "@floomhq/floom", "mcp"],
      },
    },
  };
}

/** Pretty-printed JSON of {@link buildMcpServerConfig} for copy-paste. */
export function buildMcpJson(): string {
  return JSON.stringify(buildMcpServerConfig(), null, 2);
}
