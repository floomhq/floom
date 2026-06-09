import type { WorkerSummary } from "./types";

function workerActivityTimestamp(worker: WorkerSummary): number {
  const timestamps = [
    worker.recent_stats?.last_run_at ||
    worker.last_run?.started_at ||
    worker.last_run?.created_at,
    worker.updated_at,
    worker.created_at,
  ]
    .map((iso) => (iso ? new Date(iso).getTime() : Number.NaN))
    .filter((ts) => Number.isFinite(ts));
  return timestamps.length > 0 ? Math.max(...timestamps) : 0;
}

export function sortWorkersByRecentActivity(workers: WorkerSummary[]): WorkerSummary[] {
  return workers
    .map((worker, index) => ({ worker, index, time: workerActivityTimestamp(worker) }))
    .sort((a, b) => {
      const delta = b.time - a.time;
      if (delta !== 0) return delta;
      return a.index - b.index;
    })
    .map(({ worker }) => worker);
}
