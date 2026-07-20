"use client";

import { useEffect } from "react";
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { safeStorageGet } from "@/lib/safe-storage";
import type {
  ApprovalRow,
  ContextSummary,
  SystemOverview,
  WorkerSummary,
  WorkerDetail,
  WorkerSpend,
  ConnectionItem,
  SecretItem,
  RunSummary,
  VersionSummary,
  WorkspaceMember,
} from "@/lib/types";

// Stable query keys — one namespace per resource so the cache survives navigation
// and revalidation patches the same entry in place (no skeleton on return).
export const WORKERS_LIST_QUERY_OPTS = { include_archived: true } as const;
export const RUNS_FIRST_PAGE_QUERY_PARAMS = { limit: 50, offset: 0 } as const;

function workspaceScope(): string {
  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search || "");
    const urlWorkspace = params.get("workspace_id") || params.get("ws");
    if (urlWorkspace) return urlWorkspace;
    return safeStorageGet("local", "workeros.activeWorkspaceId") || "local-default";
  }
  return "local-default";
}

function scopedParams<T extends Record<string, unknown>>(params?: T): T & { workspace_id: string } {
  return { ...(params ?? {} as T), workspace_id: workspaceScope() };
}

export const qk = {
  get overview() {
    return ["system", "overview", workspaceScope()] as const;
  },
  workers: (opts?: { include_archived?: boolean }) => ["workers", scopedParams(opts)] as const,
  get connections() {
    return ["connections", { workspace_id: workspaceScope() }] as const;
  },
  get secrets() {
    return ["secrets", { workspace_id: workspaceScope() }] as const;
  },
  get contexts() {
    return ["contexts", { workspace_id: workspaceScope() }] as const;
  },
  approvals: (status = "pending") => ["approvals", status, workspaceScope()] as const,
  get approvalsCount() {
    return ["approvals", "count", workspaceScope()] as const;
  },
  get members() {
    return ["workspace", "members", workspaceScope()] as const;
  },
  runs: (params?: Record<string, unknown>) => ["runs", scopedParams(params)] as const,
  // Per-worker detail-pane surfaces. workspaceId defaults to the active
  // workspace, but callers viewing a specific worker (e.g. a cross-workspace
  // admin list) pass its OWN workspace_id explicitly so the cache never mixes
  // detail from one workspace into another ("identities never bleed").
  workerDetail: (id: string, workspaceId?: string | null) =>
    ["worker-detail", id, workspaceId || workspaceScope()] as const,
  workerRuns: (workerId: string, limit = 20) => ["worker-runs", workerId, limit] as const,
  workerVersions: (workerId: string) => ["worker-versions", workerId] as const,
  // #1201: this worker's month-to-date spend + configured cap.
  workerSpend: (workerId: string) => ["worker-spend", workerId] as const,
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
  });
}

export function useConnections(initialData?: ConnectionItem[]) {
  return useQuery({
    queryKey: qk.connections,
    queryFn: () => api.connections.list(),
    initialData,
  });
}

export function useSecrets(initialData?: SecretItem[], enabled = true) {
  return useQuery({
    queryKey: qk.secrets,
    queryFn: () => api.secrets.list(),
    initialData,
    enabled,
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
  });
}

export function useApprovals(status = "pending", initialData?: ApprovalRow[]) {
  return useQuery({
    queryKey: qk.approvals(status),
    queryFn: () => api.approvals.list(status),
    initialData,
  });
}

export function useApprovalsCountQuery(initialData?: { pending: number }) {
  return useQuery({
    queryKey: qk.approvalsCount,
    queryFn: () => api.approvals.count(),
    initialData,
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
  });
}

export function useRuns(params?: Parameters<typeof api.runs.list>[0], initialData?: RunSummary[]) {
  return useQuery({
    queryKey: qk.runs(params as Record<string, unknown>),
    queryFn: () => api.runs.list(params),
    initialData,
  });
}

// ---- worker-detail pane: detail / runs / versions ----
//
// The worker-detail split pane (app/workers/WorkersCollection.tsx) used to
// hand-roll its own Map-based caches with a 250ms "freshness" window, so every
// re-open of the SAME worker within a session re-fetched the (expensive: 6-8s
// warm on Cloud, per api.workers.get's shape=run comment) full detail payload
// and blocked on a fresh spinner. These queryOptions/hooks route the same
// fetches through the shared cache-first TanStack Query client (30s staleTime,
// refetchOnMount:false, see QueryProvider) so a revisit within a session
// renders instantly from cache, concurrent consumers of the same worker id
// share (dedupe) one in-flight request instead of firing N, and the detail /
// runs / versions fetches for a newly-opened worker run in PARALLEL instead of
// a serial "click tab -> wait" waterfall.

export function workerDetailQueryOptions(id: string, workspaceId?: string | null) {
  return {
    queryKey: qk.workerDetail(id, workspaceId),
    queryFn: () => api.workers.get(id),
  };
}

export function useWorkerDetailQuery(id: string, workspaceId?: string | null) {
  return useQuery<WorkerDetail>({
    ...workerDetailQueryOptions(id, workspaceId),
    enabled: Boolean(id),
  });
}

// #1201: month-to-date spend + configured cap for one worker. Cache-first,
// same defaults as the rest of the detail pane (see QueryProvider) — failing
// soft (react-query surfaces isError, no thrown render) is fine here since
// this is a supplementary stat, not blocking detail render.
export function useWorkerSpendQuery(id: string) {
  return useQuery<WorkerSpend>({
    queryKey: qk.workerSpend(id),
    queryFn: () => api.workers.getSpend(id),
    enabled: Boolean(id),
  });
}

export function workerRunsQueryOptions(workerId: string, limit = 20) {
  return {
    queryKey: qk.workerRuns(workerId, limit),
    queryFn: () => api.runs.list({ worker_id: workerId, limit }),
  };
}

export function useWorkerRunsQuery(workerId: string, limit = 20) {
  return useQuery<RunSummary[]>({
    ...workerRunsQueryOptions(workerId, limit),
    enabled: Boolean(workerId),
  });
}

export function workerVersionsQueryOptions(workerId: string) {
  return {
    queryKey: qk.workerVersions(workerId),
    queryFn: () => api.workers.listVersions(workerId),
  };
}

export function useWorkerVersionsQuery(workerId: string) {
  return useQuery<VersionSummary[]>({
    ...workerVersionsQueryOptions(workerId),
    enabled: Boolean(workerId),
  });
}
