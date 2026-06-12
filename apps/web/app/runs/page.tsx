// S44: RSC — fetch initial runs + workers list on the server.
// RunsClient handles filtering, pagination, and export interactivity.
import { Suspense } from "react";
import { fetchRuns } from "@/lib/server-api";
import RunsCollection from "./RunsCollection";
import { Skeleton } from "@/components/ui/skeleton";

// #945: was `revalidate = N` (ISR) — an authenticated, per-user data fetch
// must not be baked into a statically-cached shell shared across requests.
export const dynamic = "force-dynamic";

export default async function RunsPage() {
  return (
    <Suspense fallback={<RunsLoadingSkeleton />}>
      <RunsFetcher />
    </Suspense>
  );
}

async function RunsFetcher() {
  let initialRuns: import("@/lib/types").RunSummary[] = [];
  try {
    initialRuns = await fetchRuns({ limit: 200, offset: 0 });
  } catch {
    // Fall through — RunsCollection will fetch on the client side
  }
  return <RunsCollection initialRuns={initialRuns} />;
}

// FL8: full-page Runs skeleton — header + Export action, the worker-filter +
// status-tab row, then the runs table — so it matches the loaded layout.
function RunsLoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-4 w-64 mt-2" />
        </div>
        <Skeleton className="h-8 w-28" />
      </div>
      <div className="flex gap-3 flex-wrap items-center">
        <Skeleton className="h-8 w-[220px]" />
        <div className="flex items-center gap-3 flex-wrap">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-16" />
          ))}
        </div>
      </div>
      <div className="rounded-xl [border:var(--bd-card)] bg-[var(--bg-card)] overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-11 w-full rounded-none [border-bottom:var(--bd-div)] last:[border-bottom:0]" />
        ))}
      </div>
    </div>
  );
}
