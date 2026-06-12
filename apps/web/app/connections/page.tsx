// S44: RSC — fetch initial connections list on the server.
// ConnectionsClient handles polling, OAuth flow, and mutations.
import { Suspense } from "react";
import { fetchConnections } from "@/lib/server-api";
import ConnectionsCollection from "./ConnectionsCollection";
import { Skeleton } from "@/components/ui/skeleton";

// #945: was `revalidate = N` (ISR) — an authenticated, per-user data fetch
// must not be baked into a statically-cached shell shared across requests.
export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  return (
    <Suspense fallback={<ConnectionsLoadingSkeleton />}>
      <ConnectionsFetcher />
    </Suspense>
  );
}

async function ConnectionsFetcher() {
  let initialConnections: import("@/lib/types").ConnectionItem[] = [];
  try {
    initialConnections = await fetchConnections();
  } catch {
    // Fall through — client will fetch on mount
  }
  return <ConnectionsCollection initialConnections={initialConnections} />;
}

function ConnectionsLoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div>
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-80 mt-2" />
      </div>
      <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-14 w-full rounded-none border-b border-[var(--border-default)] last:border-b-0" />
        ))}
      </div>
    </div>
  );
}
