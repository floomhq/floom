"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { ArrowLeft, Check, Copy, Server, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { ConnectionItem, ConnectionTestResult } from "@/lib/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type McpConnection = ConnectionItem & {
  kind: "mcp";
  mcp_label: string;
};

function StatusPill({ status }: { status: string }) {
  const isActive = status === "active";
  const label =
    status === "active" ? "Connected" :
    status === "expired" ? "Expired" :
    status === "failed" ? "Failed" :
    status === "initiated" ? "Connecting" : "Inactive";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium ${
        isActive
          ? "border-[color-mix(in_srgb,var(--positive)_24%,var(--line))] bg-[color-mix(in_srgb,var(--positive)_10%,transparent)] text-[var(--positive)]"
          : "border-[color-mix(in_srgb,var(--negative)_24%,var(--line))] bg-[color-mix(in_srgb,var(--negative)_10%,transparent)] text-[var(--negative)]"
      }`}
    >
      {label}
    </span>
  );
}

function CodeBlock({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  function handleCopy() {
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div className="relative rounded-lg border border-[var(--border-default)] bg-[var(--bg-app)]">
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 inline-flex size-7 items-center justify-center rounded border border-[var(--border-default)] bg-[var(--bg-card)] text-muted-foreground hover:text-foreground transition-colors"
        title="Copy"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
      <pre className="overflow-x-auto p-4 pr-12 text-xs leading-5 text-[var(--ink)]">
        <code>{value}</code>
      </pre>
    </div>
  );
}

function buildJsonConfig(conn: McpConnection): string {
  const entry: Record<string, unknown> = {};
  if ((conn.mcp_transport ?? "streamable_http") === "stdio") {
    if (conn.mcp_command) entry.command = conn.mcp_command;
    if (conn.mcp_args?.length) entry.args = conn.mcp_args;
    if (conn.mcp_env && Object.keys(conn.mcp_env).length) entry.env = conn.mcp_env;
    if (conn.mcp_cwd) entry.cwd = conn.mcp_cwd;
  } else {
    entry.url = conn.mcp_url;
    if (conn.mcp_transport && conn.mcp_transport !== "streamable_http") {
      entry.transport = conn.mcp_transport;
    }
    if (conn.mcp_auth_secret) entry.auth_secret = conn.mcp_auth_secret;
  }
  if (conn.mcp_allowed_tools?.length) entry.allowed_tools = conn.mcp_allowed_tools;

  return JSON.stringify({ mcpServers: { [conn.mcp_label]: entry } }, null, 2);
}

export default function McpConnectionDetailPage() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const id = params.id;

  const [connection, setConnection] = useState<McpConnection | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<ConnectionTestResult | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const all = await api.connections.list();
        const found = all.find((c) => c.id === id && c.kind === "mcp");
        if (!found) {
          setError("MCP server not found.");
        } else {
          setConnection(found as McpConnection);
        }
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Failed to load MCP server");
      } finally {
        setLoading(false);
      }
    })();
  }, [id]);

  async function handleTest() {
    setTesting(true);
    setTestResult(null);
    try {
      const result = await api.connections.test(id);
      setTestResult(result);
      if (result.status === "valid") {
        toast.success("MCP server connection is valid");
      } else {
        toast.error(`Test failed: ${result.reason || result.status}`);
      }
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Test failed");
    } finally {
      setTesting(false);
    }
  }

  async function handleDelete() {
    setDeleting(true);
    try {
      await api.connections.delete(id);
      toast.success("MCP server removed");
      router.push("/connections/mcp");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to remove");
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-4 w-32" />
        <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6 space-y-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64" />
          <Skeleton className="h-4 w-32" />
        </div>
      </div>
    );
  }

  if (error || !connection) {
    return (
      <div className="space-y-4">
        <button
          type="button"
          onClick={() => router.push("/connections/mcp")}
          className="inline-flex items-center gap-1.5 text-sm text-[var(--ink-soft)] hover:text-[var(--ink)] transition-colors"
        >
          <ArrowLeft className="size-4" />
          MCP servers
        </button>
        <p className="text-sm text-[var(--negative)]">{error ?? "MCP server not found."}</p>
      </div>
    );
  }

  const transport = connection.mcp_transport ?? "streamable_http";
  const isStdio = transport === "stdio";
  const endpoint = isStdio
    ? [connection.mcp_command, ...(connection.mcp_args ?? [])].filter(Boolean).join(" ")
    : connection.mcp_url ?? "";
  const tools = connection.mcp_allowed_tools ?? [];

  return (
    <>
      <div className="space-y-6">
        {/* Back link */}
        <button
          type="button"
          onClick={() => router.push("/connections/mcp")}
          className="inline-flex items-center gap-1.5 text-sm text-[var(--ink-soft)] hover:text-[var(--ink)] transition-colors"
        >
          <ArrowLeft className="size-4" />
          MCP servers
        </button>

        {/* Header card — Status */}
        <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex items-center gap-3">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-xl border border-[var(--border-default)] bg-[var(--bg-app)]">
                <Server className="size-5 text-muted-foreground" />
              </div>
              <div>
                <h1 className="text-xl font-semibold text-[var(--ink)]">{connection.mcp_label}</h1>
                <p className="mt-0.5 text-xs font-mono text-[var(--ink-soft)] truncate max-w-sm">{endpoint}</p>
              </div>
            </div>
            <StatusPill status={connection.status} />
          </div>

          {/* Actions */}
          <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[var(--border-default)] pt-5">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={handleTest}
              disabled={testing}
            >
              <Zap className={`size-3.5 ${testing ? "animate-pulse" : ""}`} />
              {testing ? "Testing..." : "Test connection"}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="text-[var(--negative)] hover:bg-[color-mix(in_srgb,var(--negative)_8%,transparent)] hover:text-[var(--negative)]"
              onClick={() => setConfirmDelete(true)}
              disabled={deleting}
            >
              <Trash2 className="size-3.5" />
              Remove
            </Button>
          </div>

          {/* Test result */}
          {testResult && (
            <div
              className={`mt-4 rounded-lg border px-4 py-3 text-sm ${
                testResult.status === "valid"
                  ? "border-[color-mix(in_srgb,var(--positive)_24%,var(--line))] bg-[color-mix(in_srgb,var(--positive)_8%,transparent)] text-[var(--positive)]"
                  : "border-[color-mix(in_srgb,var(--negative)_24%,var(--line))] bg-[color-mix(in_srgb,var(--negative)_8%,transparent)] text-[var(--negative)]"
              }`}
            >
              {testResult.status === "valid"
                ? "Connection is valid and responding."
                : `Test failed: ${testResult.reason || testResult.status}`}
            </div>
          )}
        </div>

        {/* Config card */}
        <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6">
          <h2 className="text-sm font-medium text-[var(--ink)] mb-4">Configuration</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex gap-3">
              <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Transport</dt>
              <dd className="font-mono text-xs text-[var(--ink)]">{transport}</dd>
            </div>
            {isStdio ? (
              <>
                {connection.mcp_command && (
                  <div className="flex gap-3">
                    <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Command</dt>
                    <dd className="font-mono text-xs text-[var(--ink)]">{connection.mcp_command}</dd>
                  </div>
                )}
                {(connection.mcp_args ?? []).length > 0 && (
                  <div className="flex gap-3">
                    <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Arguments</dt>
                    <dd className="font-mono text-xs text-[var(--ink)]">{(connection.mcp_args ?? []).join(" ")}</dd>
                  </div>
                )}
                {connection.mcp_cwd && (
                  <div className="flex gap-3">
                    <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Working dir</dt>
                    <dd className="font-mono text-xs text-[var(--ink)]">{connection.mcp_cwd}</dd>
                  </div>
                )}
                {connection.mcp_env && Object.keys(connection.mcp_env).length > 0 && (
                  <div className="flex gap-3">
                    <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Environment</dt>
                    <dd className="space-y-1">
                      {Object.entries(connection.mcp_env).map(([k, v]) => (
                        <div key={k} className="font-mono text-xs text-[var(--ink)]">
                          {k}=<span className="text-[var(--ink-soft)]">{v}</span>
                        </div>
                      ))}
                    </dd>
                  </div>
                )}
              </>
            ) : (
              <>
                {connection.mcp_url && (
                  <div className="flex gap-3">
                    <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Endpoint</dt>
                    <dd className="font-mono text-xs text-[var(--ink)] break-all">{connection.mcp_url}</dd>
                  </div>
                )}
                {connection.mcp_auth_secret && (
                  <div className="flex gap-3">
                    <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Auth secret</dt>
                    <dd>
                      <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-[var(--ink)]">
                        {connection.mcp_auth_secret}
                      </code>
                    </dd>
                  </div>
                )}
              </>
            )}
            <div className="flex gap-3">
              <dt className="w-32 shrink-0 text-[var(--ink-soft)]">Allowed tools</dt>
              <dd className="text-[var(--ink-soft)] text-xs">
                {tools.length > 0 ? `${tools.length} tool${tools.length === 1 ? "" : "s"} specified` : "All tools (unrestricted)"}
              </dd>
            </div>
          </dl>
        </div>

        {/* Tools list */}
        {tools.length > 0 && (
          <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6">
            <h2 className="text-sm font-medium text-[var(--ink)] mb-3">
              Tools
              <span className="ml-2 text-[var(--ink-soft)] font-normal">({tools.length})</span>
            </h2>
            <div className="flex flex-wrap gap-1.5">
              {tools.map((tool) => (
                <span
                  key={tool}
                  className="inline-block rounded bg-[var(--bg-app)] border border-[var(--border-default)] px-2 py-1 font-mono text-xs text-[var(--ink-soft)]"
                >
                  {tool}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* JSON config */}
        <div className="rounded-[var(--radius-card)] border border-[var(--border-default)] bg-[var(--bg-card)] p-6">
          <h2 className="text-sm font-medium text-[var(--ink)] mb-3">JSON config</h2>
          <p className="mb-3 text-xs text-[var(--ink-soft)]">
            Paste this into your Claude Desktop, Cursor, or VS Code <code className="rounded bg-muted px-1 py-0.5 font-mono">settings.json</code>.
          </p>
          <CodeBlock value={buildJsonConfig(connection)} />
        </div>
      </div>

      {/* Remove confirmation */}
      <Dialog open={confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(false); }}>
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Remove {connection.mcp_label}?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            Workers using this MCP server will stop having access to its tools.
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDelete(false)}>Cancel</Button>
            <Button variant="destructive" onClick={() => void handleDelete()} disabled={deleting}>
              {deleting ? "Removing..." : "Remove"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
