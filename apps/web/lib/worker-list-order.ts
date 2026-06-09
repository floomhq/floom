import type { WorkerSummary } from "./types";

function workerActivityTimestamp(worker: WorkerSummary): number {
  const iso =
    worker.recent_stats?.last_run_at ||
    worker.last_run?.started_at ||
    worker.last_run?.created_at ||
    "";
  const ts = iso ? new Date(iso).getTime() : Number.NaN;
  return Number.isFinite(ts) ? ts : 0;
}

export function sortWorkersByRecentActivity(workers: WorkerSummary[]): WorkerSummary[] {
  return [...workers].sort((a, b) => {
    const delta = workerActivityTimestamp(b) - workerActivityTimestamp(a);
    if (delta !== 0) return delta;
    return a.name.localeCompare(b.name);
  });
}
