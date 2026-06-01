// S44: RSC — fetch initial runs + workers list on the server.
// RunsClient handles filtering, pagination, and export interactivity.
import { Suspense } from "react";
import { fetchRuns, fetchWorkerList } from "@/lib/server-api";
import RunsClient from "./RunsClient";
import { Skeleton } from "@/components/ui/skeleton";

export const revalidate = 10;

export default async function RunsPage() {
  return (
    <Suspense fallback={<RunsLoadingSkeleton />}>
      <RunsFetcher />
    </Suspense>
  );
}

async function RunsFetcher() {
  let initialRuns: import("@/lib/types").RunSummary[] = [];
  let initialWorkers: import("@/lib/types").WorkerSummary[] = [];
  try {
    [initialRuns, initialWorkers] = await Promise.all([
      fetchRuns({ limit: 20, offset: 0 }),
      fetchWorkerList(),
    ]);
  } catch {
    // Fall through — RunsClient will fetch on the client side
  }
  return <RunsClient initialRuns={initialRuns} initialWorkers={initialWorkers} />;
}

function RunsLoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-64 mt-2" />
      </div>
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-none border-b border-[var(--border-default)] last:border-b-0" />
        ))}
      </div>
    </div>
  );
}
