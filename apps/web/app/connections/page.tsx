"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import { IconSprite } from "@/components/IconSprite";
import { ConnectAppRow } from "@/components/connections/ConnectAppRow";
import { ConnectionCard } from "@/components/connections/ConnectionCard";
import { ConnectionSkeleton } from "@/components/connections/ConnectionSkeleton";
import { ConnectionsEmptyState } from "@/components/connections/ConnectionsEmptyState";
import {
  getAuthConfigId,
  getLastUsedByConnection,
  normalizeAppSlug,
  SUPPORTED_APPS,
  toConnectionView,
  type ConnectionRecord,
  type ConnectionView,
} from "@/components/connections/connection-data";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
  const [connectOpen, setConnectOpen] = useState(false);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [lastUsedBySlug, setLastUsedBySlug] = useState<Record<string, string | undefined>>({});
  const [loading, setLoading] = useState(true);
  const [metadataByConnectionId, setMetadataByConnectionId] = useState<
    Record<string, Partial<ConnectionRecord>>
  >({});
  const [refreshing, setRefreshing] = useState<string | null>(null);
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

  const connectionViews = useMemo(
    () =>
      connections.map((connection) =>
        toConnectionView(
          connection,
          scopesByConnectionId,
          metadataByConnectionId,
          lastUsedBySlug
        )
      ),
    [connections, lastUsedBySlug, metadataByConnectionId, scopesByConnectionId]
  );

  const connectedSlugs = useMemo(
    () => new Set(connections.map((connection) => normalizeAppSlug(connection.app_name))),
    [connections]
  );

  async function handleConnect(slug: string) {
    setConnecting(slug);
    try {
      const result = await api.connections.initiate(slug);
      setConnectOpen(false);
      if (result.redirect_url) {
        window.open(result.redirect_url, "_blank", "noopener,noreferrer");
        toast.success(`OAuth opened for ${slug}`);
      } else {
        toast.success(`Connection initiated for ${slug}`);
      }
      void refresh();
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : `Failed to connect ${slug}`);
    } finally {
      setConnecting(null);
    }
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
        <header className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
            <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">
              Connect apps via OAuth so workers can read and write on your behalf.
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-fit"
            onClick={() => setConnectOpen(true)}
          >
            <Plus className="size-3.5" />
            Connect a tool
          </Button>
        </header>

        <section className="space-y-3" aria-label="Connected tools">
          {loading ? (
            Array.from({ length: 3 }).map((_, index) => <ConnectionSkeleton key={index} />)
          ) : connectionViews.length === 0 ? (
            <ConnectionsEmptyState onConnect={() => void handleConnect("gmail")} />
          ) : (
            connectionViews.map((connection) => (
              <ConnectionCard
                key={connection.id}
                connection={connection}
                deleting={deleting === connection.id}
                refreshing={refreshing === connection.id}
                reconnecting={connecting === connection.app_name}
                onDelete={handleDelete}
                onReconnect={handleConnect}
                onRefresh={handleRefresh}
              />
            ))
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

        <Dialog open={connectOpen} onOpenChange={setConnectOpen}>
          <DialogContent className="sm:max-w-lg">
            <DialogHeader>
              <DialogTitle>Connect a tool</DialogTitle>
            </DialogHeader>
            <div className="mt-2 grid gap-2">
              {SUPPORTED_APPS.map((app) => (
                <ConnectAppRow
                  key={app.slug}
                  app={app}
                  connected={connectedSlugs.has(app.slug)}
                  connecting={connecting === app.slug}
                  onConnect={handleConnect}
                />
              ))}
            </div>
          </DialogContent>
        </Dialog>
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
      // Composio not configured: surface via toast once, return undefined
      toast.error("Composio not configured on this server");
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
