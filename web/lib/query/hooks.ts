"use client";

import { useEffect } from "react";
import { keepPreviousData, useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  ApprovalRow,
  ContextSummary,
  SystemOverview,
  WorkerSummary,
  ConnectionItem,
  SecretItem,
  RunSummary,
  WorkspaceMember,
} from "@/lib/types";

// Stable query keys — one namespace per resource so the cache survives navigation
// and revalidation patches the same entry in place (no skeleton on return).
export const WORKERS_LIST_QUERY_OPTS = { include_archived: true } as const;
export const RUNS_FIRST_PAGE_QUERY_PARAMS = { limit: 50, offset: 0 } as const;

export const qk = {
  overview: ["system", "overview"] as const,
  workers: (opts?: { include_archived?: boolean }) => ["workers", opts ?? {}] as const,
  connections: ["connections"] as const,
  secrets: ["secrets"] as const,
  contexts: ["contexts"] as const,
  approvals: (status = "pending") => ["approvals", status] as const,
  approvalsCount: ["approvals", "count"] as const,
  members: ["workspace", "members"] as const,
  runs: (params?: Record<string, unknown>) => ["runs", params ?? {}] as const,
};

// Each hook is cache-first (see QueryProvider defaults: staleTime 30s,
// refetchOnMount:false). `initialData` lets a server-rendered first paint hydrate
// the cache so there is no skeleton even on the very first render of a surface.

// perf: a route's page server-component must NOT block first paint on a slow
// backend list fetch. If it `await`s the fetch before returning JSX, the route's
// loading.tsx skeleton is shown for the ENTIRE server round-trip (~0.7-1s on
// cloud: backend query + proxy/Railway hops) on EVERY navigation — which defeats
// the whole cache-first client (persisted localStorage + 30s staleTime +
// refetchOnMount:false + eager prefetch). Instead the page streams the fetch as
// an unawaited PROMISE and renders the client surface immediately. This hook
// drains that promise in the background and seeds the matching query cache only
// when it is still empty (true cold start). On a warm cache the surface already
// rendered from cache and this seed is a harmless no-op — no skeleton, no
// blocking server hop. Keeps the cold-start SSR benefit (#654) without the
// per-navigation skeleton it introduced.
export function useStreamedInitialData<T>(
  queryKey: QueryKey,
  promise?: Promise<T> | T,
): void {
  const qc = useQueryClient();
  useEffect(() => {
    if (promise == null) return;
    let alive = true;
    Promise.resolve(promise)
      .then((data) => {
        if (!alive || data == null) return;
        if (Array.isArray(data) && data.length === 0) return;
        qc.setQueryData(queryKey, (prev: unknown) => prev ?? data);
      })
      .catch(() => {
        /* SSR seed is best-effort; the query's own fetch is the source of truth */
      });
    return () => {
      alive = false;
    };
    // queryKey is a stable literal per surface; promise identity drives this.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [promise]);
}

export function useOverview(initialData?: SystemOverview | null) {
  return useQuery({
    queryKey: qk.overview,
    queryFn: () => api.system.overview(),
    initialData: initialData ?? undefined,
    placeholderData: keepPreviousData,
  });
}

export function useWorkers(
  opts?: { include_archived?: boolean },
  initialData?: WorkerSummary[],
  enabled = true,
) {
  return useQuery({
    queryKey: qk.workers(opts),
    queryFn: () => api.workers.list(opts),
    initialData,
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useConnections(initialData?: ConnectionItem[]) {
  return useQuery({
    queryKey: qk.connections,
    queryFn: () => api.connections.list(),
    initialData,
    placeholderData: keepPreviousData,
  });
}

export function useSecrets(initialData?: SecretItem[], enabled = true) {
  return useQuery({
    queryKey: qk.secrets,
    queryFn: () => api.secrets.list(),
    initialData,
    enabled,
    placeholderData: keepPreviousData,
  });
}

export function useContexts(initialData?: ContextSummary[]) {
  return useQuery({
    queryKey: qk.contexts,
    queryFn: async () => {
      const rows = await api.contexts.list();
      return Array.isArray(rows) ? rows : [];
    },
    initialData: Array.isArray(initialData) ? initialData : undefined,
    placeholderData: keepPreviousData,
  });
}

export function useApprovals(status = "pending", initialData?: ApprovalRow[]) {
  return useQuery({
    queryKey: qk.approvals(status),
    queryFn: () => api.approvals.list(status),
    initialData,
    placeholderData: keepPreviousData,
  });
}

export function useApprovalsCountQuery(initialData?: { pending: number }) {
  return useQuery({
    queryKey: qk.approvalsCount,
    queryFn: () => api.approvals.count(),
    initialData,
    placeholderData: keepPreviousData,
  });
}

export function useMembers(initialData?: WorkspaceMember[]) {
  return useQuery({
    queryKey: qk.members,
    queryFn: () =>
      (api.members?.list?.() ?? Promise.resolve({ members: [] as WorkspaceMember[] }))
        .then((r) => r.members)
        .catch(() => [] as WorkspaceMember[]),
    initialData,
    placeholderData: keepPreviousData,
  });
}

export function useRuns(params?: Parameters<typeof api.runs.list>[0], initialData?: RunSummary[]) {
  return useQuery({
    queryKey: qk.runs(params as Record<string, unknown>),
    queryFn: () => api.runs.list(params),
    initialData,
    placeholderData: keepPreviousData,
  });
}
