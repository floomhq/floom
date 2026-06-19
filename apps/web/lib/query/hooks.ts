"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
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
    queryFn: () => api.contexts.list(),
    initialData,
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
