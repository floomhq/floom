/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { IconSprite } from "@/components/IconSprite";
import { ConnectionRow } from "@/components/connections/ConnectionRow";
import { ConnectionsTabs } from "@/components/connections/ConnectionsTabs";
import { ConnectionSkeleton } from "@/components/connections/ConnectionSkeleton";
import { ConnectionsEmptyState } from "@/components/connections/ConnectionsEmptyState";
import { BrandLogo } from "@/components/connections/BrandLogo";
import {
  getLastUsedByConnection,
  toConnectionView,
  type ConnectionRecord,
  type ConnectionView,
} from "@/components/connections/connection-data";
import { api } from "@/lib/api";
import type { ConnectionItem, SecretItem, WorkerDetail } from "@/lib/types";

type ConnectedAccountMetadata = {
  connected_at?: string;
  email?: string;
  scopes?: string[];
};

export default function ConnectionsClient({
  initialConnections,
}: {
  initialConnections: ConnectionItem[];
}) {
  // S44: start with server-fetched data; no loading flash on initial render.
  const [connections, setConnections] = useState<ConnectionRecord[]>(
    initialConnections as ConnectionRecord[]
  );
  const [connecting, setConnecting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [lastUsedBySlug, setLastUsedBySlug] = useState<Record<string, string | undefined>>({});
  // Only show skeleton if initialConnections was empty (API unavailable)
  const [loading, setLoading] = useState(initialConnections.length === 0);
  const [metadataByConnectionId, setMetadataByConnectionId] = useState<
    Record<string, Partial<ConnectionRecord>>
  >({});
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [scopesByConnectionId, setScopesByConnectionId] = useState<Record<string, string[]>>({});
  const [connectionSearch, setConnectionSearch] = useState("");
  const [secrets, setSecrets] = useState<SecretItem[]>([]);
  const [mcpFormOpen, setMcpFormOpen] = useState(false);
  const [mcpLabel, setMcpLabel] = useState("");
  const [mcpUrl, setMcpUrl] = useState("");
  const [mcpAuthSecret, setMcpAuthSecret] = useState("");
  const [mcpAllowedTools, setMcpAllowedTools] = useState("");
  const [savingMcp, setSavingMcp] = useState(false);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hydrateOneConnection = useCallback(async (record: ConnectionRecord) => {
    const account = await fetchConnectedAccount(record.composio_connection_id);
    if (account) {
      setMetadataByConnectionId((previous) => ({
        ...previous,
        [record.id]: {
          ...previous[record.id],
          email: account.email,
          scopes: account.scopes,
        },
      }));
      if (account.scopes) {
        setScopesByConnectionId((previous) => ({
          ...previous,
          [record.id]: account.scopes ?? [],
        }));
      }
    }
  }, []);

  const hydrateConnectionMetadata = useCallback(
    (records: ConnectionRecord[]) => {
      records.filter((record) => (record.kind ?? "composio") === "composio").forEach((record) => {
        void hydrateOneConnection(record);
      });
    },
    [hydrateOneConnection]
  );

  const refresh = useCallback(async () => {
    try {
      const list = await api.connections.list();
      const records = list as ConnectionRecord[];
      setConnections(records);
      hydrateConnectionMetadata(records);
      loadWorkerDetails()
        .then((workers) => getLastUsedByConnection(workers))
        .then(setLastUsedBySlug)
        .catch(() => {
          setLastUsedBySlug({});
        });
    } catch {
      toast.error("Failed to load connections");
    } finally {
      setLoading(false);
    }
  }, [hydrateConnectionMetadata]);

  // S44: if initial data was provided, hydrate metadata but don't re-fetch list.
  // If initial data was empty (API unavailable), do a full refresh.
  useEffect(() => {
    if (initialConnections.length > 0) {
      hydrateConnectionMetadata(initialConnections as ConnectionRecord[]);
      // Still load last-used data and secrets in background
      loadWorkerDetails()
        .then((workers) => getLastUsedByConnection(workers))
        .then(setLastUsedBySlug)
        .catch(() => setLastUsedBySlug({}));
    } else {
      void refresh();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    api.secrets.list().then(setSecrets).catch(() => setSecrets([]));
  }, []);

  useEffect(() => {
    const hasInitiated = connections.some(
      (connection) => (connection.kind ?? "composio") === "composio" && connection.status === "initiated"
    );
    if (hasInitiated && !pollIntervalRef.current) {
      pollIntervalRef.current = setInterval(() => {
        void refresh();
      }, 3000);
    } else if (!hasInitiated && pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
    return () => {
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, [connections, refresh]);

  const connectionViews = useMemo(() => {
    const views = connections.map((connection) =>
      toConnectionView(
        connection,
        scopesByConnectionId,
        metadataByConnectionId,
        lastUsedBySlug
      )
    );
    const labelByApp: Record<string, Set<string>> = {};
    for (const v of views) {
      const key = v.app_name?.toLowerCase() ?? "";
      if (!labelByApp[key]) labelByApp[key] = new Set();
      labelByApp[key].add(v.accountLabel);
    }
    return views.map((v) => {
      const key = v.app_name?.toLowerCase() ?? "";
      const labelsForApp = labelByApp[key];
      if (labelsForApp && labelsForApp.size < views.filter((x) => (x.app_name?.toLowerCase() ?? "") === key).length) {
        const suffix = v.id.slice(-6);
        return { ...v, accountLabel: `${v.accountLabel} (…${suffix})` };
      }
      return v;
    });
  }, [connections, lastUsedBySlug, metadataByConnectionId, scopesByConnectionId]);

  const filteredConnections = useMemo(() => {
    const q = connectionSearch.trim().toLowerCase();
    if (!q) return connectionViews;
    return connectionViews.filter((v) =>
      [v.displayName, v.accountLabel, v.app_name, v.mcp_url].filter(Boolean).some((s) => s!.toLowerCase().includes(q))
    );
  }, [connectionViews, connectionSearch]);

  const oauthConnections = filteredConnections.filter((connection) => (connection.kind ?? "composio") === "composio");
  const mcpConnections = filteredConnections.filter((connection) => connection.kind === "mcp");

  function handleConnect(slug: string) {
    window.location.href = `/connections/connect/${encodeURIComponent(slug)}?return_to=${encodeURIComponent("/connections")}`;
  }

  async function handleRefresh(connection: ConnectionView) {
    setRefreshing(connection.id);
    try {
      const updated = await api.connections.status(connection.id);
      setConnections((previous) =>
        previous.map((item) => (item.id === connection.id ? (updated as ConnectionRecord) : item))
      );
      hydrateConnectionMetadata([updated as ConnectionRecord]);
      toast.success(`${connection.displayName} status refreshed`);
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Refresh failed");
    } finally {
      setRefreshing(null);
    }
  }

  async function handleTest(connection: ConnectionView) {
    setTesting(connection.id);
    try {
      const result = await api.connections.test(connection.id);
      if (result.status === "valid") {
        toast.success(`${connection.displayName}: connection is valid`);
      } else if (result.status === "expired") {
        toast.warning(`${connection.displayName}: connection expired. Reconnect to restore access.`);
      } else {
        toast.error(`${connection.displayName}: connection test failed. ${result.reason}`);
      }
      void refresh();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Test failed");
    } finally {
      setTesting(null);
    }
  }

  async function handleDelete(connection: ConnectionView) {
    setDeleting(connection.id);
    try {
      await api.connections.delete(connection.id);
      toast.success(`${connection.displayName} disconnected`);
      setMetadataByConnectionId((previous) => removeKey(previous, connection.id));
      setScopesByConnectionId((previous) => removeKey(previous, connection.id));
      void refresh();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to disconnect");
    } finally {
      setDeleting(null);
    }
  }

  async function handleCreateMcp() {
    setSavingMcp(true);
    try {
      const created = await api.connections.createMcp({
        label: mcpLabel,
        url: mcpUrl,
        auth_secret: mcpAuthSecret || null,
        allowed_tools: parseAllowedTools(mcpAllowedTools),
      });
      toast.success(`${created.mcp_label || created.app_name} MCP server saved`);
      setMcpLabel("");
      setMcpUrl("");
      setMcpAuthSecret("");
      setMcpAllowedTools("");
      setMcpFormOpen(false);
      await refresh();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to save MCP server");
    } finally {
      setSavingMcp(false);
    }
  }

  return (
    <>
      <IconSprite />
      <div className="space-y-6">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
          <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">
            Connect apps via OAuth so workers can read and write on your behalf.
          </p>
        </header>
        <ConnectionsTabs />

        <section aria-label="MCP servers" className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-medium text-foreground">MCP servers</h2>
              <p className="text-sm text-muted-foreground">Custom tool servers available to agent workers.</p>
            </div>
            <Button type="button" size="sm" onClick={() => setMcpFormOpen((open) => !open)}>
              <Plus className="size-4" />
              Add MCP server
            </Button>
          </div>

          {mcpFormOpen && (
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4">
              <div className="grid gap-3 md:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-label" className="text-xs text-muted-foreground">Label</Label>
                  <Input
                    id="mcp-label"
                    value={mcpLabel}
                    onChange={(event) => setMcpLabel(event.target.value)}
                    placeholder="github"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="mcp-auth-secret" className="text-xs text-muted-foreground">Auth secret</Label>
                  <select
                    id="mcp-auth-secret"
                    value={mcpAuthSecret}
                    onChange={(event) => setMcpAuthSecret(event.target.value)}
                    className="flex h-9 w-full rounded-lg border border-line-strong bg-paper px-3 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/30"
                  >
                    <option value="">No bearer token</option>
                    {secrets.map((secret) => (
                      <option key={secret.name} value={secret.name}>{secret.name}</option>
                    ))}
                  </select>
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="mcp-url" className="text-xs text-muted-foreground">URL</Label>
                  <Input
                    id="mcp-url"
                    value={mcpUrl}
                    onChange={(event) => setMcpUrl(event.target.value)}
                    placeholder="https://example.com/mcp"
                  />
                </div>
                <div className="space-y-1.5 md:col-span-2">
                  <Label htmlFor="mcp-tools" className="text-xs text-muted-foreground">Allowed tools</Label>
                  <Textarea
                    id="mcp-tools"
                    value={mcpAllowedTools}
                    onChange={(event) => setMcpAllowedTools(event.target.value)}
                    placeholder="list_pull_requests, get_repo"
                    className="min-h-20"
                  />
                </div>
              </div>
              <div className="mt-4 flex items-center gap-2">
                <Button type="button" size="sm" onClick={handleCreateMcp} disabled={savingMcp}>
                  {savingMcp ? "Saving..." : "Save MCP server"}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => setMcpFormOpen(false)}
                  disabled={savingMcp}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
            <div className="hidden md:grid grid-cols-[40px_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,.9fr)_minmax(0,1fr)_auto] gap-4 px-3 py-2 border-b border-[var(--border-default)] bg-[var(--bg-2)] text-[11px] font-medium text-muted-foreground">
              <span />
              <span>Label</span>
              <span>URL</span>
              <span>Auth</span>
              <span>Tools</span>
              <span className="text-right pr-1">Actions</span>
            </div>
            {mcpConnections.length > 0 ? (
              mcpConnections.map((connection) => (
                <div
                  key={connection.id}
                  className="grid grid-cols-[40px_1fr_auto] md:grid-cols-[40px_minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,.9fr)_minmax(0,1fr)_auto] gap-3 md:gap-4 items-center px-3 py-2.5 border-b border-[var(--border-default)] last:border-b-0 hover:bg-[var(--active-nav-bg)] transition-colors"
                >
                  <div className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)]">
                    <BrandLogo icon="" className="size-4" />
                  </div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate text-foreground">{connection.displayName}</p>
                    <p className="md:hidden text-xs text-muted-foreground truncate">{connection.mcp_url}</p>
                  </div>
                  <span className="hidden md:inline text-xs text-muted-foreground truncate">{connection.mcp_url}</span>
                  <span className="hidden md:inline text-xs text-muted-foreground truncate">
                    {connection.mcp_auth_secret ? `bearer:${connection.mcp_auth_secret}` : "None"}
                  </span>
                  <span className="hidden md:inline text-xs text-muted-foreground truncate">
                    {(connection.mcp_allowed_tools ?? []).length > 0
                      ? (connection.mcp_allowed_tools ?? []).join(", ")
                      : "All tools"}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    onClick={() => void handleDelete(connection)}
                    disabled={deleting === connection.id}
                    title="Delete MCP server"
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))
            ) : (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {connectionSearch ? "No MCP servers match the search." : "No MCP servers saved."}
              </div>
            )}
          </div>
        </section>

        <section aria-label="Connected tools">
          {loading ? (
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
              {Array.from({ length: 4 }).map((_, index) => (
                <ConnectionSkeleton key={index} />
              ))}
            </div>
          ) : connectionViews.filter((connection) => (connection.kind ?? "composio") === "composio").length === 0 ? (
            <ConnectionsEmptyState onConnect={() => { window.location.href = "/connections/browse"; }} />
          ) : (
            <>
              <div className="mb-3 relative max-w-sm">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
                <Input
                  placeholder="Search connections..."
                  value={connectionSearch}
                  onChange={(e) => setConnectionSearch(e.target.value)}
                  className="pl-9 h-9"
                />
              </div>
              <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
                <div className="hidden md:grid grid-cols-[40px_minmax(0,1.5fr)_minmax(0,1fr)_120px_140px_auto] gap-4 px-3 py-2 border-b border-[var(--border-default)] bg-[var(--bg-2)] text-[11px] font-medium text-muted-foreground">
                  <span />
                  <span>App / Account</span>
                  <span>Scopes</span>
                  <span>Last used</span>
                  <span>Status</span>
                  <span className="text-right pr-1">Actions</span>
                </div>
                {oauthConnections.map((connection) => (
                  <ConnectionRow
                    key={connection.id}
                    connection={connection}
                    deleting={deleting === connection.id}
                    refreshing={refreshing === connection.id}
                    reconnecting={connecting === connection.app_name}
                    testing={testing === connection.id}
                    onDelete={handleDelete}
                    onReconnect={handleConnect}
                    onRefresh={handleRefresh}
                    onTest={handleTest}
                  />
                ))}
                {oauthConnections.length === 0 && connectionSearch && (
                  <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                    No connections match &quot;{connectionSearch}&quot;.
                  </div>
                )}
              </div>
            </>
          )}
        </section>

        <div className="rounded-lg border border-[var(--line)] bg-[var(--glass-bg)] p-5 text-sm text-[var(--ink-soft)] shadow-sm">
          Connections use OAuth. Workers that declare a connection in their{" "}
          <code className="rounded bg-[var(--paper)] px-1 py-0.5 font-mono text-xs text-[var(--ink)]">
            worker.yml
          </code>{" "}
          list it as part of their declared capabilities. Workers that read it
          will see an error from the upstream API if the connection isn&apos;t valid.
        </div>
      </div>
    </>
  );
}

function parseAllowedTools(value: string) {
  return value
    .split(/[,\n]/g)
    .map((tool) => tool.trim())
    .filter(Boolean);
}

async function loadWorkerDetails() {
  const workers = await api.workers.list();
  const details = await Promise.allSettled(
    workers.map((worker) => api.workers.get(worker.id))
  );
  return details.flatMap((result) =>
    result.status === "fulfilled" ? [result.value as WorkerDetail] : []
  );
}

async function fetchConnectedAccount(id: string): Promise<ConnectedAccountMetadata | undefined> {
  try {
    const response = await fetch(`/connections/connected-accounts/${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (response.status === 503) {
      toast.error("Connections backend not configured on this server");
      return undefined;
    }
    if (!response.ok) return undefined;
    return (await response.json()) as ConnectedAccountMetadata;
  } catch {
    return undefined;
  }
}

function removeKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}
