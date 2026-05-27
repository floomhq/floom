/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { IconSprite } from "@/components/IconSprite";
import { ConnectionRow } from "@/components/connections/ConnectionRow";
import { ConnectionsTabs } from "@/components/connections/ConnectionsTabs";
import { ConnectionSkeleton } from "@/components/connections/ConnectionSkeleton";
import { ConnectionsEmptyState } from "@/components/connections/ConnectionsEmptyState";
import {
  getAuthConfigId,
  getLastUsedByConnection,
  normalizeAppSlug,
  toConnectionView,
  type ConnectionRecord,
  type ConnectionView,
} from "@/components/connections/connection-data";
import { api } from "@/lib/api";
import type { WorkerDetail } from "@/lib/types";

type ConnectedAccountMetadata = {
  auth_config_id?: string;
  email?: string;
  scopes?: string[];
  user_id?: string;
};

type AuthConfigMetadata = {
  id?: string;
  scopes?: string[];
};

export default function ConnectionsPage() {
  const [connections, setConnections] = useState<ConnectionRecord[]>([]);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [lastUsedBySlug, setLastUsedBySlug] = useState<Record<string, string | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [metadataByConnectionId, setMetadataByConnectionId] = useState<
    Record<string, Partial<ConnectionRecord>>
  >({});
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [scopesByConnectionId, setScopesByConnectionId] = useState<Record<string, string[]>>({});
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const hydrateOneConnection = useCallback(async (record: ConnectionRecord) => {
    const account = await fetchConnectedAccount(record.composio_connection_id);
    if (account) {
      setMetadataByConnectionId((previous) => ({
        ...previous,
        [record.id]: {
          ...previous[record.id],
          auth_config_id: account.auth_config_id,
          email: account.email,
          scopes: account.scopes,
          user_id: account.user_id,
        },
      }));
    }

    const authConfigId =
      account?.auth_config_id || getAuthConfigId(record) || normalizeAppSlug(record.app_name);
    const authConfig = await fetchAuthConfig(authConfigId);
    if (authConfig?.scopes) {
      setScopesByConnectionId((previous) => ({
        ...previous,
        [record.id]: authConfig.scopes ?? [],
      }));
      setMetadataByConnectionId((previous) => ({
        ...previous,
        [record.id]: {
          ...previous[record.id],
          auth_config_id: authConfig.id,
        },
      }));
    }
  }, []);

  const hydrateConnectionMetadata = useCallback(
    (records: ConnectionRecord[]) => {
      records.forEach((record) => {
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
      // Worker details are auxiliary; load independently so a failure
      // never blanks the connections list.
      loadWorkerDetails()
        .then((workers) => getLastUsedByConnection(workers))
        .then(setLastUsedBySlug)
        .catch(() => {
          // workers API unavailable: show "last used: unavailable" per card
          setLastUsedBySlug({});
        });
    } catch {
      toast.error("Failed to load connections");
    } finally {
      setLoading(false);
    }
  }, [hydrateConnectionMetadata]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const hasInitiated = connections.some((connection) => connection.status === "initiated");
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
    // N10 fix: when two connections for the same app share the same accountLabel
    // (e.g. both come back as "federico" from Composio), append the short
    // connection ID suffix so each card is visually distinct.
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
        // Labels not unique — append ID suffix
        const suffix = v.id.slice(-6);
        return { ...v, accountLabel: `${v.accountLabel} (…${suffix})` };
      }
      return v;
    });
  }, [connections, lastUsedBySlug, metadataByConnectionId, scopesByConnectionId]);

  function handleConnect(slug: string) {
    // PR S17: route through our pre-confirm page instead of going straight to OAuth.
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
      // Refresh list to pick up updated last_checked_at
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

        <section aria-label="Connected tools">
          {loading ? (
            <div className="rounded-md border border-border bg-card overflow-hidden">
              {Array.from({ length: 4 }).map((_, index) => (
                <ConnectionSkeleton key={index} />
              ))}
            </div>
          ) : connectionViews.length === 0 ? (
            <ConnectionsEmptyState onConnect={() => { window.location.href = "/connections/browse"; }} />
          ) : (
            // S27: compact row list (was a vertical list of 116px-tall cards).
            // Single bordered container, rows separated by line. Header row
            // with column labels on >=md. Mobile collapses to a 3-line row.
            <div className="rounded-md border border-border bg-card overflow-hidden">
              <div className="hidden md:grid grid-cols-[40px_minmax(0,1.5fr)_minmax(0,1fr)_120px_140px_auto] gap-4 px-3 py-2 border-b border-line bg-[var(--bg-2)] text-[11px] uppercase tracking-wider font-medium text-muted-foreground">
                <span />
                <span>App / Account</span>
                <span>Scopes</span>
                <span>Last used</span>
                <span>Status</span>
                <span className="text-right pr-1">Actions</span>
              </div>
              {connectionViews.map((connection) => (
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
            </div>
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
      // Connections backend not configured: surface via toast once, return undefined
      toast.error("Connections backend not configured on this server");
      return undefined;
    }
    if (!response.ok) return undefined;
    return (await response.json()) as ConnectedAccountMetadata;
  } catch {
    return undefined;
  }
}

async function fetchAuthConfig(id: string): Promise<AuthConfigMetadata | undefined> {
  try {
    const response = await fetch(`/connections/auth-configs/${encodeURIComponent(id)}`, {
      cache: "no-store",
    });
    if (response.status === 503) {
      return undefined;
    }
    if (!response.ok) return undefined;
    return (await response.json()) as AuthConfigMetadata;
  } catch {
    return undefined;
  }
}

function removeKey<T>(record: Record<string, T>, key: string) {
  const next = { ...record };
  delete next[key];
  return next;
}
