// S44: RSC — fetch worker list on the server (eliminates client-side round-trip).
// Interactive shell (search, tabs, favorites) lives in WorkersClient below.
import { Suspense } from "react";
import { fetchWorkerList } from "@/lib/server-api";
import WorkersCollection from "./WorkersCollection";
import WorkersLoadingSkeleton from "./WorkersLoadingSkeleton";

export const revalidate = 30;

export default async function WorkersPage() {
  return (
    <Suspense fallback={<WorkersLoadingSkeleton />}>
      <WorkersFetcher />
    </Suspense>
  );
}

async function WorkersFetcher() {
  let workers: import("@/lib/types").WorkerSummary[] = [];
  try {
    workers = await fetchWorkerList();
  } catch {
    // API unavailable: render empty state; client can retry via its own fetch
    workers = [];
  }
  return <WorkersCollection initialWorkers={workers} />;
}
