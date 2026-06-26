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

/**
 * Pretty-printed JSON for copy-paste, with the `args` array kept INLINE (one
 * line) to match the compact Agent-install card. Still valid JSON that parses
 * back to {@link buildMcpServerConfig}.
 */
export function buildMcpJson(): string {
  const { command, args } = buildMcpServerConfig().mcpServers.floom;
  const argsInline = `[${args.map((a) => JSON.stringify(a)).join(", ")}]`;
  return [
    "{",
    '  "mcpServers": {',
    '    "floom": {',
    `      "command": ${JSON.stringify(command)},`,
    `      "args": ${argsInline}`,
    "    }",
    "  }",
    "}",
  ].join("\n");
}
