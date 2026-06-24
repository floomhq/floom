import { getPublicApiBase } from "@/lib/api-base";

function isCloudDeploy(): boolean {
  return process.env.NEXT_PUBLIC_WORKEROS_DEPLOY === "cloud";
}

function cloudWorkspaceSegment(workspaceId?: string | null): string {
  const ws = workspaceId?.trim();
  if (ws && ws !== "local-default") return ws;
  return "<YOUR_WORKSPACE_ID>";
}

/**
 * Build the ready-to-paste MCP server config (the `mcpServers` entry) for this
 * instance's Settings → API tab.
 *
 * OSS:
 * - `url` → `{API_BASE}/mcp-tools/serve`
 * - `x-floom-secret` carries the device-auth secret
 * - `x-workeros-workspace` when a non-default workspace is active
 *
 * Cloud:
 * - `url` → `{API_BASE}/mcp/{workspace_id}` (workspace is path-scoped)
 * - `Authorization: Bearer {pat}` carries the Personal Access Token
 */
export function buildMcpServerConfig(
  secret: string,
  workspaceId?: string | null,
): { mcpServers: { floom: { url: string; headers: Record<string, string> } } } {
  if (isCloudDeploy()) {
    return {
      mcpServers: {
        floom: {
          url: `${getPublicApiBase()}/mcp/${cloudWorkspaceSegment(workspaceId)}`,
          headers: { Authorization: `Bearer ${secret}` },
        },
      },
    };
  }

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
