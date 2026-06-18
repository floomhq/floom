import nextDynamic from "next/dynamic";
import { fetchWorkerList } from "@/lib/server-api";

const WorkersCollection = nextDynamic(() => import("@/app/workers/WorkersCollection"));

// TODO(#1098): admin "all workers" view relocated out of top tabs.
// The CloudWorkspaceAdminWorkersView component and the admin membership check
// have been removed from the top-level tab switcher per issue #1098.
// Re-introduce via a settings/admin route when needed, not as a peer tab here.

// perf-F2 mirror: server-fetch the worker list (cloud server-api carries the
// workeros_cloud_session Bearer + x-workeros-workspace header) to eliminate the
// client round-trip on first paint. #945: per-user authed fetch must not be
// baked into a statically-cached shell.
export const dynamic = "force-dynamic";

export default async function CloudWorkersPage() {
  let initialWorkers: import("@/lib/types").WorkerSummary[] = [];
  try {
    initialWorkers = await fetchWorkerList();
  } catch {
    // Fall through — WorkersCollection will fetch on the client side.
  }
  return <WorkersCollection initialWorkers={initialWorkers} />;
}
