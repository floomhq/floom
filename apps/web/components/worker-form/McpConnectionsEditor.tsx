"use client";

import Link from "next/link";
import { load as parseYaml, dump as dumpYaml } from "js-yaml";
import { Plug } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ConnectionItem } from "@/lib/types";

type McpConnection = ConnectionItem & {
  kind: "mcp";
  mcp_label: string;
};

export function McpConnectionsEditor({
  workerYaml,
  connections,
  onWorkerYamlChange,
}: {
  workerYaml: string;
  connections: ConnectionItem[];
  onWorkerYamlChange: (updatedYaml: string) => void;
}) {
  const mcpConnections = connections.filter(isMcpConnection);
  const selectedLabels = selectedMcpLabels(workerYaml);

  function toggle(connection: McpConnection) {
    const nextYaml = toggleMcpConnection(workerYaml, connection, selectedLabels.has(connection.mcp_label));
    onWorkerYamlChange(nextYaml);
  }

  return (
    <div className="space-y-3">
      <div>
        <h2 className="text-base font-medium text-foreground">MCP servers</h2>
        <p className="text-sm text-muted-foreground mt-0.5">
          Pick saved MCP servers for this worker&apos;s agent runtime.
        </p>
      </div>

      {mcpConnections.length === 0 ? (
        <div className="rounded-[var(--radius-button)] [border:var(--bd-card)] bg-card p-3 text-sm text-muted-foreground">
          <p>No MCP servers saved.</p>
          <Link href="/connections" className="mt-2 inline-flex">
            <Button type="button" size="sm" variant="outline">
              Add MCP server
            </Button>
          </Link>
        </div>
      ) : (
        <div className="rounded-[var(--radius-button)] [border:var(--bd-card)] bg-card overflow-hidden">
          {mcpConnections.map((connection) => {
            const checked = selectedLabels.has(connection.mcp_label);
            return (
              <label
                key={connection.id}
                className="flex cursor-pointer items-start gap-3 [border-bottom:var(--bd-div)] px-3 py-3 last:[border-bottom:0] hover:bg-muted/40"
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(connection)}
                  className="mt-1 size-4 accent-[var(--accent)]"
                />
                <span className="flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--paper)]">
                  <Plug className="size-4 text-muted-foreground" />
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-foreground">{connection.mcp_label}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {connectionSummary(connection)}
                  </span>
                  {connection.mcp_auth_secret ? (
                    <span className="mt-1 block truncate text-xs text-muted-foreground">
                      bearer:{connection.mcp_auth_secret}
                    </span>
                  ) : null}
                </span>
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

function isMcpConnection(connection: ConnectionItem): connection is McpConnection {
  return (
    connection.kind === "mcp" &&
    Boolean(connection.mcp_label?.trim())
  );
}

function selectedMcpLabels(workerYaml: string) {
  const labels = new Set<string>();
  for (const connection of readConnectionSpecs(workerYaml)) {
    const label = readMcpLabel(connection);
    if (label) labels.add(label);
  }
  return labels;
}

function toggleMcpConnection(workerYaml: string, connection: McpConnection, selected: boolean) {
  const current = readConnectionSpecs(workerYaml);
  const next = selected
    ? current.filter((item) => readMcpLabel(item) !== connection.mcp_label)
    : [...current, toWorkerMcpSpec(connection)];

  const block = dumpYaml(
    { connections: next.length > 0 ? next : [] },
    { noRefs: true, lineWidth: -1, sortKeys: false }
  ).trimEnd();

  return replaceTopLevelBlock(workerYaml, "connections", block);
}

function readConnectionSpecs(workerYaml: string): unknown[] {
  try {
    const parsed = parseYaml(workerYaml) as { connections?: unknown } | null;
    return Array.isArray(parsed?.connections) ? parsed.connections : [];
  } catch {
    return [];
  }
}

function readMcpLabel(value: unknown) {
  if (!value || typeof value !== "object" || !("mcp" in value)) return "";
  const mcp = (value as { mcp?: unknown }).mcp;
  if (!mcp || typeof mcp !== "object" || !("label" in mcp)) return "";
  const label = (mcp as { label?: unknown }).label;
  return typeof label === "string" ? label : "";
}

function toWorkerMcpSpec(connection: McpConnection) {
  const mcp: {
    label: string;
    transport?: "streamable_http" | "sse" | "stdio";
    url?: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
    auth?: string;
    allowed_tools?: string[];
    require_approval: "never";
  } = {
    label: connection.mcp_label,
    require_approval: "never",
  };
  const transport = connection.mcp_transport ?? "streamable_http";
  if (transport !== "streamable_http") {
    mcp.transport = transport;
  }
  if (transport === "stdio") {
    if (connection.mcp_command) mcp.command = connection.mcp_command;
    if (connection.mcp_args?.length) mcp.args = connection.mcp_args;
    if (connection.mcp_env && Object.keys(connection.mcp_env).length > 0) mcp.env = connection.mcp_env;
    if (connection.mcp_cwd) mcp.cwd = connection.mcp_cwd;
  } else if (connection.mcp_url) {
    mcp.url = connection.mcp_url;
  }
  if (connection.mcp_auth_secret) {
    mcp.auth = `bearer:${connection.mcp_auth_secret}`;
  }
  if (connection.mcp_allowed_tools?.length) {
    mcp.allowed_tools = connection.mcp_allowed_tools;
  }
  return { mcp };
}

function connectionSummary(connection: McpConnection): string {
  if ((connection.mcp_transport ?? "streamable_http") === "stdio") {
    return [connection.mcp_command, ...(connection.mcp_args ?? [])].filter(Boolean).join(" ");
  }
  return connection.mcp_url ?? "";
}

function replaceTopLevelBlock(yaml: string, key: string, replacement: string): string {
  const lines = yaml.split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*(?:$|\\[)`).test(line));
  if (start === -1) return `${yaml.trimEnd()}\n\n${replacement}\n`;

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^[A-Za-z_][\w_-]*:\s*/.test(lines[i])) {
      end = i;
      break;
    }
  }
  return [...lines.slice(0, start), ...replacement.split("\n"), ...lines.slice(end)].join("\n");
}
