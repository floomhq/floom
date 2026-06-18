"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type {
  SystemOverview,
  WorkerSummary,
  ConnectionItem,
  SecretItem,
  RunSummary,
} from "@/lib/types";

// Stable query keys — one namespace per resource so the cache survives navigation
// and revalidation patches the same entry in place (no skeleton on return).
export const qk = {
  overview: ["system", "overview"] as const,
  workers: (opts?: { include_archived?: boolean }) => ["workers", opts ?? {}] as const,
  connections: ["connections"] as const,
  secrets: ["secrets"] as const,
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
  });
}

export function useWorkers(opts?: { include_archived?: boolean }, initialData?: WorkerSummary[]) {
  return useQuery({
    queryKey: qk.workers(opts),
    queryFn: () => api.workers.list(opts),
    initialData,
  });
}

export function useConnections(initialData?: ConnectionItem[]) {
  return useQuery({
    queryKey: qk.connections,
    queryFn: () => api.connections.list(),
    initialData,
  });
}

export function useSecrets(initialData?: SecretItem[]) {
  return useQuery({
    queryKey: qk.secrets,
    queryFn: () => api.secrets.list(),
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
