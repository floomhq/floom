/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Plus, Search } from "lucide-react";
import { toast } from "sonner";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConnectionRow } from "@/components/connections/ConnectionRow";
import { ConnectionsTabs } from "@/components/connections/ConnectionsTabs";
import { ConnectionSkeleton } from "@/components/connections/ConnectionSkeleton";
import { ConnectionsEmptyState } from "@/components/connections/ConnectionsEmptyState";
import {
  getLastUsedByConnection,
  toConnectionView,
  SUPPORTED_APPS,
  type ConnectionRecord,
  type ConnectionView,
} from "@/components/connections/connection-data";
import { api } from "@/lib/api";
import type { ConnectedAccountMetadata, ConnectionItem, WorkerDetail } from "@/lib/types";

export default function ConnectionsClient({
  initialConnections,
}: {
  initialConnections: ConnectionItem[];
}) {
  const router = useRouter();
  // S44: start with server-fetched data; no loading flash on initial render.
  const [connections, setConnections] = useState<ConnectionRecord[]>(
    initialConnections as ConnectionRecord[]
  );
  const [connecting, setConnecting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmDeleteConn, setConfirmDeleteConn] = useState<ConnectionView | null>(null);
  const [lastUsedBySlug, setLastUsedBySlug] = useState<Record<string, string | undefined>>({});
  // N13: track whether last-used async load has completed so we can show a
  // skeleton in the "Last used" column instead of a misleading "—" for all rows.
  const [lastUsedLoaded, setLastUsedLoaded] = useState(false);
  // Only show skeleton if initialConnections was empty (API unavailable)
  const [loading, setLoading] = useState(initialConnections.length === 0);
  const [metadataByConnectionId, setMetadataByConnectionId] = useState<
    Record<string, Partial<ConnectionRecord>>
  >({});
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [scopesByConnectionId, setScopesByConnectionId] = useState<Record<string, string[]>>({});
  // #565: map app slug -> worker count that uses that connection
  const [usedByCountBySlug, setUsedByCountBySlug] = useState<Record<string, number>>({});
  // #556: map connection slug -> worker names that require it but it's not connected yet
  const [missingBySlug, setMissingBySlug] = useState<Record<string, string[]>>({});
  const [connectionSearch, setConnectionSearch] = useState("");
  // #565: track which row is expanded for the in-place peek
  const [expandedId, setExpandedId] = useState<string | null>(null);
  // X9: floom UUID of the connection that was just added/reconnected, so the
  // Connected tab can highlight + scroll to it instead of silently dropping the
  // user on an unchanged-looking table.
  const [highlightId, setHighlightId] = useState<string | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const postConnectHandledRef = useRef(false);

  const hydrateOneConnection = useCallback(async (record: ConnectionRecord) => {
    const account = await fetchConnectedAccount(record.id);
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
        .then((workers) => {
          void getLastUsedByConnection(workers).then((data) => { setLastUsedBySlug(data); setLastUsedLoaded(true); });
          setUsedByCountBySlug(computeUsedByCount(workers));
          setMissingBySlug(computeMissingBySlug(workers));
        })
        .catch(() => {
          setLastUsedBySlug({});
          setLastUsedLoaded(true);
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
        .then((workers) => {
          void getLastUsedByConnection(workers).then((data) => { setLastUsedBySlug(data); setLastUsedLoaded(true); });
          setUsedByCountBySlug(computeUsedByCount(workers));
          setMissingBySlug(computeMissingBySlug(workers));
        })
        .catch(() => { setLastUsedBySlug({}); setLastUsedLoaded(true); });
    } else {
      void refresh();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // X9 post-connect feedback: when the OAuth callback bounces back to
  // /connections?connected=1&app=<slug>&connection_id=<floom-uuid>, confirm
  // exactly what changed (account identity + tools), highlight the new row,
  // then strip the params so a refresh doesn't re-fire the toast.
  useEffect(() => {
    if (postConnectHandledRef.current) return;
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    if (url.searchParams.get("connected") !== "1") return;
    postConnectHandledRef.current = true;

    const connectionId = url.searchParams.get("connection_id") || "";
    const appSlug = url.searchParams.get("app") || "";

    // Clean the URL immediately so reloads / shares don't replay the toast.
    url.searchParams.delete("connected");
    url.searchParams.delete("connection_id");
    url.searchParams.delete("app");
    window.history.replaceState({}, "", url.pathname + (url.search || ""));

    void (async () => {
      // Pull the freshest list so the new/merged row is present.
      await refresh();

      const appName = appSlug
        ? SUPPORTED_APPS.find((a) => a.slug === appSlug.toLowerCase())?.displayName ||
          appSlug.charAt(0).toUpperCase() + appSlug.slice(1)
        : "your app";

      let accountLabel = "";
      let toolsCount = 0;
      if (connectionId) {
        const [account, toolsN] = await Promise.all([
          fetchConnectedAccount(connectionId).catch(() => undefined),
          appSlug ? fetchToolsCount(appSlug).catch(() => 0) : Promise.resolve(0),
        ]);
        accountLabel = account?.email || "";
        toolsCount = toolsN;
        setHighlightId(connectionId);
        // Defer scroll until the row has rendered.
        window.setTimeout(() => {
          document
            .getElementById(`connection-${connectionId}`)
            ?.scrollIntoView({ behavior: "smooth", block: "center" });
        }, 250);
        // Fade the highlight after a few seconds.
        window.setTimeout(() => setHighlightId(null), 6000);
      }

      const who = accountLabel ? ` as ${accountLabel}` : "";
      const tools = toolsCount > 0 ? ` — ${toolsCount} tools now available to your workers` : "";
      toast.success(`Connected ${appName}${who}${tools}`);
    })();
  }, [refresh]);

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
    const isPlaceholder = (label: string) =>
      label === "Expired — reconnect to see account" || label.startsWith("account …");

    // G5 rescore4 P2 (2026-05-29): two EXPIRED grants of the same app render as
    // identical "Google Calendar (Expired)" rows — indistinguishable noise the
    // operator can't act on differently (both just need a reconnect). Collapse
    // duplicate placeholder rows per app to a single entry. Real, distinctly
    // labelled accounts (different emails) are always kept and disambiguated.
    const seenPlaceholderApp = new Set<string>();
    const deduped = views.filter((v) => {
      const key = v.app_name?.toLowerCase() ?? "";
      if (!isPlaceholder(v.accountLabel)) return true;
      if (seenPlaceholderApp.has(key)) return false;
      seenPlaceholderApp.add(key);
      return true;
    });

    const labelByApp: Record<string, Set<string>> = {};
    for (const v of deduped) {
      const key = v.app_name?.toLowerCase() ?? "";
      if (!labelByApp[key]) labelByApp[key] = new Set();
      labelByApp[key].add(v.accountLabel);
    }
    return deduped.map((v) => {
      const key = v.app_name?.toLowerCase() ?? "";
      const labelsForApp = labelByApp[key];
      // Do not append an ID-suffix disambiguator to a placeholder label — it is
      // not a real account label. Disambiguate only real, distinct accounts of
      // the same app that happen to share a display label.
      if (
        !isPlaceholder(v.accountLabel) &&
        labelsForApp &&
        labelsForApp.size < deduped.filter((x) => (x.app_name?.toLowerCase() ?? "") === key).length
      ) {
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
      [v.displayName, v.accountLabel, v.app_name].filter(Boolean).some((s) => s!.toLowerCase().includes(q))
    );
  }, [connectionViews, connectionSearch]);

  const oauthConnections = filteredConnections.filter((connection) => (connection.kind ?? "composio") === "composio");

  function handleConnect(slug: string) {
    setConnecting(slug);
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

  function handleDelete(connection: ConnectionView) {
    setConfirmDeleteConn(connection);
  }

  async function confirmDelete() {
    if (!confirmDeleteConn) return;
    const connection = confirmDeleteConn;
    setConfirmDeleteConn(null);
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

  return (
    <>
      <div className="space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
            <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">
              Connect apps via OAuth so workers can read and write on your behalf.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            onClick={() => router.push("/connections/browse")}
          >
            <Plus className="size-4" />
            Add connection
          </Button>
        </header>
        <ConnectionsTabs />

        {/* #556: setup-required callout — connections needed by workers but not yet connected */}
        {Object.keys(missingBySlug).length > 0 && (
          <div className="rounded-[var(--radius-card)] border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-4 space-y-2">
            <p className="text-xs font-medium text-amber-800 dark:text-amber-300">Setup required</p>
            {Object.entries(missingBySlug).map(([slug, workerNames]) => (
              <div key={slug} className="flex items-center justify-between gap-3">
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  <span className="font-medium capitalize">{slug}</span>
                  {" — required by "}
                  {workerNames.slice(0, 2).join(", ")}
                  {workerNames.length > 2 ? ` +${workerNames.length - 2} more` : ""}
                </p>
                <a
                  href={`/connections/browse?search=${encodeURIComponent(slug)}`}
                  className="shrink-0 text-xs font-medium text-amber-800 dark:text-amber-300 underline underline-offset-2 hover:opacity-80"
                >
                  Connect
                </a>
              </div>
            ))}
          </div>
        )}

        <section aria-label="Connected tools">
          {loading ? (
            <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
              {Array.from({ length: 4 }).map((_, index) => (
                <ConnectionSkeleton key={index} />
              ))}
            </div>
          ) : connectionViews.filter((connection) => (connection.kind ?? "composio") === "composio").length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-4 py-16 text-center rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)]">
              <p className="text-sm font-medium text-foreground">No connections yet</p>
              <p className="text-sm text-muted-foreground">Browse 1,000+ apps to connect.</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => router.push("/connections/browse")}
              >
                <Plus className="size-4" />
                Add connection
              </Button>
            </div>
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
                    highlighted={highlightId === connection.id}
                    lastUsedLoading={!lastUsedLoaded}
                    expanded={expandedId === connection.id}
                    usedByCount={usedByCountBySlug[connection.app_name?.toLowerCase() ?? ""] ?? 0}
                    onDelete={handleDelete}
                    onReconnect={handleConnect}
                    onRefresh={handleRefresh}
                    onTest={handleTest}
                    onToggle={() => setExpandedId((prev) => prev === connection.id ? null : connection.id)}
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

      {/* Disconnect confirmation dialog */}
      <Dialog
        open={!!confirmDeleteConn}
        onOpenChange={(open) => { if (!open) setConfirmDeleteConn(null); }}
      >
        <DialogContent showCloseButton={false} className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Disconnect {confirmDeleteConn?.displayName}?</DialogTitle>
          </DialogHeader>
          <DialogDescription>
            {confirmDeleteConn?.accountLabel
              ? `${confirmDeleteConn.accountLabel} will lose access. Workers using this connection will stop working.`
              : "Workers using this connection will stop working."}
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteConn(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()}>
              Disconnect
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
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

async function fetchToolsCount(appSlug: string): Promise<number> {
  try {
    const result = await api.integrations.catalog({ search: appSlug, limit: 10 });
    const match =
      result.items.find((it) => it.slug.toLowerCase() === appSlug.toLowerCase()) ||
      result.items[0];
    return match?.tools_count ?? 0;
  } catch {
    return 0;
  }
}

async function fetchConnectedAccount(id: string): Promise<ConnectedAccountMetadata | undefined> {
  try {
    return await api.connections.accountInfo(id);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("Composio is not configured")) {
      toast.error("Connections backend not configured on this server");
    }
    return undefined;
  }
}

function removeKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}

function computeUsedByCount(workers: WorkerDetail[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const worker of workers) {
    const connections = worker.config?.connections ?? [];
    for (const appName of connections) {
      if (typeof appName !== "string") continue;
      const slug = appName.toLowerCase();
      counts[slug] = (counts[slug] ?? 0) + 1;
    }
  }
  return counts;
}

// #556: slug -> worker names that require it but haven't connected it yet.
function computeMissingBySlug(workers: WorkerDetail[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const worker of workers) {
    for (const slug of worker.missing_connections ?? []) {
      const key = slug.toLowerCase();
      result[key] = [...(result[key] ?? []), worker.name];
    }
  }
  return result;
}
