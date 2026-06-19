import { readFile } from "node:fs/promises";
import open from "open";
import { createAuthenticatedClient } from "../lib/api.js";
import { handleAuthError } from "../lib/cli-errors.js";
import { log, printJson, renderTable } from "../lib/output.js";

type McpTransport = "streamable_http" | "sse" | "stdio";

type ParsedMcpServer = {
  label: string;
  transport: McpTransport;
  url?: string | null;
  command?: string | null;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string | null;
};

type ConnectionInitResponse = {
  id: string;
  app_name: string;
  redirect_url: string;
  composio_connection_id?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeImportedEnv(env: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    const placeholder = value.match(/^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?$/);
    result[key] = value.startsWith("secret:")
      ? value
      : placeholder
        ? `secret:${placeholder[1]}`
        : `secret:${key}`;
  }
  return result;
}

export function parseMcpClientConfig(raw: string): ParsedMcpServer[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) throw new Error("MCP config must be a JSON object");
  const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : parsed;
  return Object.entries(servers).map(([label, value]) => {
    if (!isRecord(value)) throw new Error(`MCP server "${label}" must be an object`);
    const command = typeof value.command === "string" && value.command.trim() ? value.command.trim() : null;
    const args = Array.isArray(value.args)
      ? value.args.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
      : [];
    const url =
      typeof value.url === "string" && value.url.trim()
        ? value.url.trim()
        : typeof value.endpoint === "string" && value.endpoint.trim()
          ? value.endpoint.trim()
          : null;
    const transport: McpTransport = command || args.length
      ? "stdio"
      : String(value.transport || "").toLowerCase() === "sse"
        ? "sse"
        : "streamable_http";
    const rawEnv = isRecord(value.env) ? value.env : {};
    const env: Record<string, string> = {};
    for (const [key, nested] of Object.entries(rawEnv)) {
      if (typeof nested === "string") env[key] = nested;
    }
    return {
      label,
      transport,
      url,
      command,
      args,
      env: normalizeImportedEnv(env),
      cwd: typeof value.cwd === "string" && value.cwd.trim() ? value.cwd.trim() : null,
    };
  });
}

export async function connectionsListCommand(options: { json?: boolean }): Promise<number> {
  try {
    const { client } = await createAuthenticatedClient();
    const rows = (await client.requestJson("GET", "/connections")) as Record<string, unknown>[];
    if (options.json) {
      printJson(rows);
      return 0;
    }
    process.stdout.write(renderTable(
      rows.map((row) => ({
        kind: row.kind || "composio",
        app: row.kind === "mcp" ? row.mcp_label || row.app_name : row.app_name,
        account: row.account_label || row.display_name || row.mcp_url || "-",
        status: row.status,
        last_used_by: row.last_used_by || "-",
      })),
      [
        { key: "kind", label: "Kind" },
        { key: "app", label: "App" },
        { key: "account", label: "Account" },
        { key: "status", label: "Status" },
        { key: "last_used_by", label: "Last used by" },
      ],
    ) + "\n");
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function connectionsAddCommand(
  appName: string,
  options: { json?: boolean; open?: boolean } = {},
): Promise<number> {
  try {
    const normalized = appName.trim().toLowerCase();
    if (!normalized) {
      log.err("app name is required");
      return 1;
    }
    const { client } = await createAuthenticatedClient();
    const created = (await client.requestJson("POST", "/connections", {
      body: { app_name: normalized },
    })) as ConnectionInitResponse;
    if (options.open) {
      try {
        await open(created.redirect_url);
      } catch {
        log.warn("Could not open browser automatically.");
      }
    }
    if (options.json) {
      printJson(created);
    } else {
      log.ok(`Started ${created.app_name} connection (${created.id}).`);
      log.kv("Authorize", created.redirect_url);
      log.step("Complete the OAuth flow in the browser, then run `floom connections list`.");
    }
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}

export async function connectionsImportMcpConfigCommand(path: string, options: { json?: boolean }): Promise<number> {
  try {
    const raw = await readFile(path, "utf8");
    const servers = parseMcpClientConfig(raw);
    const { client } = await createAuthenticatedClient();
    const created = [];
    for (const server of servers) {
      if (server.transport === "stdio" && !server.command) continue;
      if (server.transport !== "stdio" && !server.url) continue;
      created.push(await client.requestJson("POST", "/connections/mcp", { body: server }));
    }
    if (options.json) {
      printJson(created);
    } else {
      log.ok(`Imported ${created.length} MCP server${created.length === 1 ? "" : "s"}`);
      for (const server of created as Record<string, unknown>[]) {
        log.kv(String(server.mcp_label || server.app_name || "mcp"), String(server.mcp_transport || "streamable_http"));
      }
    }
    return 0;
  } catch (error) {
    const handled = handleAuthError(error);
    if (handled !== null) return handled;
    throw error;
  }
}
