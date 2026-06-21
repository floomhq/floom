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
// Only routes backed by `qk` hooks are warmed. Each route may warm supporting
// lists too when that is what the destination needs for first paint.
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
    Promise.all([
      qc.prefetchQuery({
        queryKey: qk.connections,
        queryFn: () => api.connections.list(),
        staleTime: PREFETCH_STALE,
      }),
      qc.prefetchQuery({
        queryKey: qk.secrets,
        queryFn: () => api.secrets.list(),
        staleTime: PREFETCH_STALE,
      }),
      qc.prefetchQuery({
        queryKey: qk.workers(),
        queryFn: () => api.workers.list(),
        staleTime: PREFETCH_STALE,
      }),
      qc.prefetchQuery({
        queryKey: qk.members,
        queryFn: () =>
          (api.members?.list?.() ?? Promise.resolve({ members: [] }))
            .then((r) => r.members)
            .catch(() => []),
        staleTime: PREFETCH_STALE,
      }),
    ]),
  "/approvals": (qc) =>
    Promise.all([
      qc.prefetchQuery({
        queryKey: qk.approvals("pending"),
        queryFn: () => api.approvals.list("pending"),
        staleTime: PREFETCH_STALE,
      }),
      qc.prefetchQuery({
        queryKey: qk.workers(),
        queryFn: () => api.workers.list(),
        staleTime: PREFETCH_STALE,
      }),
      qc.prefetchQuery({
        queryKey: qk.approvalsCount,
        queryFn: () => api.approvals.count(),
        staleTime: PREFETCH_STALE,
      }),
    ]),
  "/library": (qc) =>
    qc.prefetchQuery({
      queryKey: qk.contexts,
      queryFn: () => api.contexts.list(),
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

// The primary tabs whose data we warm eagerly on shell mount. Ordered by how
// likely the operator is to open them, but all fire in parallel.
const MAIN_ROUTES = ["/overview", "/workers", "/runs", "/connections", "/library"] as const;

/**
 * Eagerly warm every main route's data the moment the authed shell mounts, in
 * PARALLEL — do NOT wait for idle. Within ~1s of landing every primary tab's
 * cache entry is populated, so the first tab switch hits the cache and is
 * instant instead of losing the race to the ~0.68s backend query.
 *
 * Safe to fire as a burst: each call is `prefetchRouteData` →
 * `qc.prefetchQuery`, which is cache-first and respects the 30s staleTime, so
 * a route already hydrated from the persisted localStorage cache (or warmed by
 * a hover) is a no-op — no duplicate network call, no thundering herd. We skip
 * the current route since its own hook already owns that fetch.
 *
 * ~5 routes is a small, bounded burst; cache-first dedup keeps it from
 * hammering the backend on revisits.
 */
export function prefetchMainRoutesEager(qc: QueryClient, current: string): void {
  if (typeof window === "undefined") return;
  for (const href of MAIN_ROUTES) {
    if (href === current) continue;
    prefetchRouteData(qc, href);
  }
}

/**
 * After the eager burst, warm the remaining secondary routes once the browser
 * is idle. Conservative: each is a single cache-first prefetch (no-op if the
 * persisted cache or the eager burst already populated a fresh entry), no
 * polling, no refetch loop.
 */
export function prefetchIdleRoutes(qc: QueryClient, current: string): void {
  const targets = ["/approvals"].filter((href) => href !== current);
  const run = () => targets.forEach((href) => prefetchRouteData(qc, href));
  if (typeof window === "undefined") return;
  const ric = (window as Window & { requestIdleCallback?: (cb: () => void) => void }).requestIdleCallback;
  if (ric) {
    ric(run);
  } else {
    window.setTimeout(run, 1200);
  }
}
