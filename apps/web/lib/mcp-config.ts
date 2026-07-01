/**
 * Build the ready-to-paste MCP server config (the `mcpServers` entry).
 *
 * One clean, token-free snippet that works for OSS and Cloud alike: the
 * `floom-mcp` stdio server uses the same saved credentials as the Floom CLI, so
 * the config never has to embed a URL, workspace id, or secret.
 */
export function buildMcpServerConfig(): {
  mcpServers: { floom: { command: string; args: string[] } };
} {
  return {
    mcpServers: {
      floom: {
        command: "npx",
        args: ["-y", "-p", "@floomhq/floom", "floom-mcp"],
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
