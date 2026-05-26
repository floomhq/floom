/* eslint-disable @next/next/no-img-element */
"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { IconSprite } from "@/components/IconSprite";
import { ConnectionCard } from "@/components/connections/ConnectionCard";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { api } from "@/lib/api";
import type { IntegrationCatalogItem, IntegrationCatalogResponse, WorkerDetail } from "@/lib/types";

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

const CATALOG_PAGE_SIZE = 30;

const CATEGORY_FILTERS = [
  { value: "", label: "All" },
  { value: "popular", label: "Popular" },
  { value: "productivity", label: "Productivity" },
  { value: "email", label: "Email" },
  { value: "crm", label: "CRM" },
  { value: "social", label: "Social" },
  { value: "marketing", label: "Marketing" },
  { value: "data-&-analytics", label: "Data" },
  { value: "collaboration-&-communication", label: "Collaboration" },
];

function CatalogRowSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-2">
      <Skeleton className="h-8 w-8 shrink-0 rounded-md" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Skeleton className="h-3.5 w-28" />
        <Skeleton className="h-3 w-20" />
      </div>
      <Skeleton className="h-7 w-20 shrink-0 rounded-md" />
    </div>
  );
}

function CatalogRow({
  item,
  connecting,
  connected,
  onConnect,
}: {
  item: IntegrationCatalogItem;
  connecting: boolean;
  connected: boolean;
  onConnect: (slug: string) => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md px-2 py-2 transition-colors hover:bg-[var(--bg-2)]">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-line bg-[var(--paper-2)]">
        <img
          src={item.logo_url}
          alt={`${item.name} logo`}
          className="h-5 w-5 object-contain"
          loading="eager"
          decoding="async"
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-ink">{item.name}</p>
        {item.categories[0] ? (
          <Badge variant="outline" className="mt-0.5 text-[10px]">
            {item.categories[0].replaceAll("-", " ")}
          </Badge>
        ) : (
          <p className="mt-0.5 truncate text-xs text-[var(--ink-mute)]">{item.slug}</p>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant={connected ? "outline" : "default"}
        className="h-7 shrink-0"
        disabled={connecting}
        onClick={() => onConnect(item.slug)}
      >
        {connecting ? <Loader2 className="animate-spin" /> : <ExternalLink className="h-3 w-3" />}
        {connecting ? "Opening..." : connected ? "Reconnect" : "Connect"}
      </Button>
    </div>
  );
}

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
  const [testing, setTesting] = useState<string | null>(null);
  const [scopesByConnectionId, setScopesByConnectionId] = useState<Record<string, string[]>>({});
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Marketplace modal state
  const [catalog, setCatalog] = useState<IntegrationCatalogResponse | null>(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [marketSearch, setMarketSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [marketCategory, setMarketCategory] = useState("");
  const [marketPage, setMarketPage] = useState(1);

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

  // Debounce search input
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(marketSearch.trim());
      setMarketPage(1);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [marketSearch]);

  // Load catalog when modal opens or filters change
  const loadCatalog = useCallback(async () => {
    setCatalogLoading(true);
    try {
      const nextCatalog = await api.integrations.catalog({
        page: marketPage,
        limit: CATALOG_PAGE_SIZE,
        search: debouncedSearch,
        category: marketCategory,
      });
      setCatalog(nextCatalog);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load integrations");
    } finally {
      setCatalogLoading(false);
    }
  }, [marketPage, debouncedSearch, marketCategory]);

  useEffect(() => {
    if (connectOpen) {
      void loadCatalog();
    }
  }, [connectOpen, loadCatalog]);

  // Reset modal state when it closes
  useEffect(() => {
    if (!connectOpen) {
      setMarketSearch("");
      setDebouncedSearch("");
      setMarketCategory("");
      setMarketPage(1);
      setCatalog(null);
    }
  }, [connectOpen]);

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

  const catalogPageSummary = useMemo(() => {
    if (!catalog) return null;
    const start = catalog.total_items === 0 ? 0 : (catalog.page - 1) * catalog.limit + 1;
    const end = Math.min(catalog.page * catalog.limit, catalog.total_items);
    return `${start}-${end} of ${catalog.total_items.toLocaleString()}`;
  }, [catalog]);

  async function handleConnect(slug: string) {
    setConnecting(slug);
    const oauthTab = window.open("", "_blank");
    if (oauthTab) oauthTab.opener = null;
    try {
      const result = await api.connections.initiate(slug);
      setConnectOpen(false);
      if (result.redirect_url) {
        if (oauthTab) {
          oauthTab.location.href = result.redirect_url;
        } else {
          window.open(result.redirect_url, "_blank", "noopener,noreferrer");
        }
        toast.success(`OAuth opened for ${slug}`);
      } else {
        oauthTab?.close();
        toast.success(`Connection initiated for ${slug}`);
      }
      void refresh();
    } catch (error: unknown) {
      oauthTab?.close();
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
                testing={testing === connection.id}
                onDelete={handleDelete}
                onReconnect={handleConnect}
                onRefresh={handleRefresh}
                onTest={handleTest}
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
          <DialogContent className="flex max-h-[80vh] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
            {/* Pinned header with search and filters */}
            <div className="shrink-0 border-b border-line px-5 pb-3 pt-5">
              <DialogHeader className="mb-3">
                <div className="flex items-baseline justify-between gap-2">
                  <DialogTitle>Connect a tool</DialogTitle>
                  {catalogPageSummary ? (
                    <span className="text-xs text-[var(--ink-mute)]">{catalogPageSummary} integrations</span>
                  ) : null}
                </div>
              </DialogHeader>

              {/* Search box */}
              <div className="relative mb-3">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-mute)]" />
                <Input
                  value={marketSearch}
                  onChange={(event) => setMarketSearch(event.target.value)}
                  placeholder="Search Gmail, Slack, Notion..."
                  className="h-9 bg-[var(--paper)] pl-8 pr-8"
                  aria-label="Search integrations"
                />
                {marketSearch ? (
                  <button
                    type="button"
                    className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--ink-mute)] hover:bg-[var(--bg-2)] hover:text-ink"
                    onClick={() => setMarketSearch("")}
                    aria-label="Clear search"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                ) : null}
              </div>

              {/* Category chips */}
              <div className="flex gap-1.5 overflow-x-auto pb-0.5">
                {CATEGORY_FILTERS.map((filter) => (
                  <Button
                    key={filter.value || "all"}
                    type="button"
                    size="sm"
                    variant={marketCategory === filter.value ? "default" : "outline"}
                    className="h-6 whitespace-nowrap px-2 text-xs"
                    onClick={() => {
                      setMarketCategory(filter.value);
                      setMarketPage(1);
                    }}
                  >
                    {filter.label}
                  </Button>
                ))}
              </div>
            </div>

            {/* Scrollable list */}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              {catalogLoading ? (
                <div className="space-y-1">
                  {Array.from({ length: 8 }).map((_, index) => (
                    <CatalogRowSkeleton key={index} />
                  ))}
                </div>
              ) : catalog?.items.length ? (
                <div className="space-y-0.5">
                  {catalog.items.map((item) => (
                    <CatalogRow
                      key={item.slug}
                      item={item}
                      connecting={connecting === item.slug}
                      connected={connectedSlugs.has(item.slug)}
                      onConnect={handleConnect}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center py-12 text-center">
                  <p className="text-sm font-medium text-ink">No integrations found</p>
                  <p className="mt-1 text-sm text-[var(--ink-soft)]">
                    Clear filters or try a broader search.
                  </p>
                </div>
              )}
            </div>

            {/* Pinned pagination footer */}
            <div className="flex shrink-0 items-center justify-between border-t border-line px-4 py-2.5">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={catalogLoading || marketPage <= 1}
                onClick={() => setMarketPage((current) => Math.max(1, current - 1))}
              >
                <ChevronLeft />
                Previous
              </Button>
              <span className="text-xs text-[var(--ink-mute)]">
                Page {catalog?.page ?? marketPage} of {catalog?.total_pages ?? "..."}
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={catalogLoading || !catalog?.next_page}
                onClick={() => setMarketPage((current) => current + 1)}
              >
                Next
                <ChevronRight />
              </Button>
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
