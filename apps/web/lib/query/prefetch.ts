"use client";

import type { QueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { qk } from "@/lib/query/hooks";

// Data prefetch for the primary sidebar routes. Each entry warms the SAME
// TanStack cache entry (key + fn) that the destination route's hook reads, so
// arriving on that route renders instantly from cache with no skeleton.
//
// prefetchQuery is cache-first and respects the global staleTime (30s): if the
// entry is already cached and fresh, it is a no-op (no duplicate network call).
// We pass a small extra staleTime so back-to-back hovers never restart a fetch.
//
// Only the four routes backed by a `qk` hook are warmed (Overview, Workers,
// Runs, Connections). Library and Approvals have no shared query key, so they
// get Next.js route (JS/RSC) prefetch from the Link only, no data prefetch.
type PrefetchFn = (qc: QueryClient) => Promise<unknown>;

const PREFETCH_STALE = 30_000;

const ROUTE_PREFETCH: Record<string, PrefetchFn> = {
  "/overview": (qc) =>
    qc.prefetchQuery({
      queryKey: qk.overview,
      queryFn: () => api.system.overview(),
      staleTime: PREFETCH_STALE,
    }),
  "/workers": (qc) =>
    qc.prefetchQuery({
      queryKey: qk.workers(),
      queryFn: () => api.workers.list(),
      staleTime: PREFETCH_STALE,
    }),
  "/runs": (qc) =>
    qc.prefetchQuery({
      queryKey: qk.runs(),
      queryFn: () => api.runs.list(),
      staleTime: PREFETCH_STALE,
    }),
  "/connections": (qc) =>
    qc.prefetchQuery({
      queryKey: qk.connections,
      queryFn: () => api.connections.list(),
      staleTime: PREFETCH_STALE,
    }),
};

/** Warm the cache for one route, if it has a prefetchable data surface. */
export function prefetchRouteData(qc: QueryClient, href: string): void {
  const fn = ROUTE_PREFETCH[href];
  if (!fn) return;
  // Fire-and-forget; prefetchQuery swallows its own errors and never throws.
  void fn(qc);
}

/**
 * After first paint, warm the highest-value next routes once when the browser
 * is idle. Conservative: each is a single cache-first prefetch (no-op if the
 * persisted cache already restored a fresh entry), no polling, no refetch loop.
 */
export function prefetchIdleRoutes(qc: QueryClient, current: string): void {
  // Workers and Runs are the most-visited destinations after Overview; warm
  // them (skipping whichever route the operator is already on).
  const targets = ["/overview", "/workers", "/runs"].filter((href) => href !== current);
  const run = () => targets.forEach((href) => prefetchRouteData(qc, href));
  if (typeof window === "undefined") return;
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) {
    ric(run);
  } else {
    window.setTimeout(run, 1200);
  }
}
