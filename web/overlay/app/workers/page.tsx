import nextDynamic from "next/dynamic";
import { fetchWorkerList } from "@/lib/server-api";

const WorkersCollection = nextDynamic(() => import("@/app/workers/WorkersCollection"));

// TODO(#1098): admin "all workers" view relocated out of top tabs.
// The CloudWorkspaceAdminWorkersView component and the admin membership check
// have been removed from the top-level tab switcher per issue #1098.
// Re-introduce via a settings/admin route when needed, not as a peer tab here.

// perf-F2 mirror: server-fetch the worker list (cloud server-api carries the
// workeros_cloud_session Bearer + x-workeros-workspace header). #945: per-user
// authed fetch must not be baked into a statically-cached shell.
export const dynamic = "force-dynamic";

// perf: do NOT `await` the list here. On cloud the fetch is a ~0.7-1s round-trip
// (backend query + proxy/Railway hops); awaiting it blocks the RSC and shows the
// route's loading.tsx skeleton for that whole window on EVERY navigation, which
// defeats the cache-first client (persisted localStorage cache + 30s staleTime +
// eager prefetch). Stream the fetch as an unawaited promise instead: the client
// renders cache-first immediately and seeds from this promise only on a true
// cold start (useStreamedInitialData). Mirrors the engine pages
// (engine/apps/web/app/{workers,runs,connections}/page.tsx).
export default function CloudWorkersPage() {
  const initialWorkersPromise = fetchWorkerList({ include_archived: true }).catch(
    () => [] as import("@/lib/types").WorkerSummary[],
  );
  return <WorkersCollection initialWorkersPromise={initialWorkersPromise} />;
}
