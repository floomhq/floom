// Single source of truth for the HOME's "first-worker" gate.
//
// FIX (Federico 2026-06-19): the old OverviewDashboard derived the empty state
// from `active_workers_count === 0 && completedThisWeek === 0` on a NULLABLE
// overview. When the stats fetch FAILED (or was loading) `data` was null, the
// counts read 0, and the create-only launcher showed on a 500 — telling an
// existing customer they have no workers. That is the exact regression this
// gate forbids.
//
// Rules:
//   - First-worker (create-only) shows ONLY when the workers list loaded
//     SUCCESSFULLY and the real worker total is 0.
//   - NEVER on a fetch error (isError) and NEVER while loading.
//   - "real worker" = a non-archived, non-system, non-example worker (an
//     actual employee, not the engine's worker-author or a stock template).

import type { WorkerSummary } from "@/lib/types";

export type WorkersGate = {
  /** True only when the workers list loaded and the real total is 0. */
  isFirstWorker: boolean;
  /** Real "employee" worker count (non-archived, non-system, non-example). */
  realWorkerCount: number;
};

/** Count workers that represent an actual employee in the workspace. */
export function countRealWorkers(workers: readonly WorkerSummary[] | null | undefined): number {
  if (!workers) return 0;
  return workers.filter((w) => !w.archived && !w.system && !w.is_example).length;
}

/**
 * Decide whether to show the create-only "first worker" home.
 *
 * @param workers   the workers list (null/undefined when not yet loaded)
 * @param isLoading the workers query is in its first load (no data yet)
 * @param isError   the workers query failed
 */
export function resolveWorkersGate({
  workers,
  isLoading,
  isError,
}: {
  workers: readonly WorkerSummary[] | null | undefined;
  isLoading: boolean;
  isError: boolean;
}): WorkersGate {
  const realWorkerCount = countRealWorkers(workers);
  // The ONLY path to the create-only launcher: a successful load with zero
  // real workers. A failed fetch or an in-flight first load NEVER qualifies —
  // we fall back to the Active home (cached data) or a skeleton instead.
  const loaded = !isLoading && !isError && workers != null;
  const isFirstWorker = loaded && realWorkerCount === 0;
  return { isFirstWorker, realWorkerCount };
}
