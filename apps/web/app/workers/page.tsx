import nextDynamic from "next/dynamic";
import { fetchWorkerList } from "@/lib/server-api";

const WorkersCollection = nextDynamic(() => import("./WorkersCollection"));

// #945: was `revalidate = N` (ISR) — an authenticated, per-user data fetch
// must not be baked into a statically-cached shell shared across requests.
export const dynamic = "force-dynamic";

export default async function WorkersPage() {
  let initialWorkers: import("@/lib/types").WorkerSummary[] = [];
  try {
    initialWorkers = await fetchWorkerList();
  } catch {
    // Fall through — WorkersCollection will fetch on the client side
  }
  return <WorkersCollection initialWorkers={initialWorkers} />;
}
