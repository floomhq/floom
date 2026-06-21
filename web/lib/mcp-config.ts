import { getPublicApiBase } from "@/lib/api-base";

/**
 * Build the ready-to-paste MCP server config (the `mcpServers` entry) for this
 * instance's Settings → API tab.
 *
 * - `url` points at THIS instance's API (NEXT_PUBLIC_API_BASE, not a hardcoded host).
 * - `x-floom-secret` carries the token, which is bound to the current user
 *   (member or admin) via the device-auth flow that minted it.
 * - `x-workeros-workspace` is pinned only when a non-default workspace is active,
 *   so MCP calls target the workspace the user is currently viewing. For the
 *   default workspace the header is omitted (not needed).
 */
export function buildMcpServerConfig(
  secret: string,
  workspaceId?: string | null,
): { mcpServers: { floom: { url: string; headers: Record<string, string> } } } {
  const headers: Record<string, string> = { "x-floom-secret": secret };
  if (workspaceId) headers["x-workeros-workspace"] = workspaceId;
  return {
    mcpServers: {
      floom: {
        url: `${getPublicApiBase()}/mcp-tools/serve`,
        headers,
      },
    },
  };
}

/** Pretty-printed JSON of {@link buildMcpServerConfig} for copy-paste. */
export function buildMcpJson(secret: string, workspaceId?: string | null): string {
  return JSON.stringify(buildMcpServerConfig(secret, workspaceId), null, 2);
}
