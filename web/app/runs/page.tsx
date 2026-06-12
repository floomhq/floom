import { fetchRuns } from "@/lib/server-api";
import RunsCollection from "./RunsCollection";

// #945: was `revalidate = N` (ISR) — an authenticated, per-user data fetch
// must not be baked into a statically-cached shell shared across requests.
export const dynamic = "force-dynamic";

export default async function RunsPage() {
  let initialRuns: import("@/lib/types").RunSummary[] = [];
  try {
    initialRuns = await fetchRuns({ limit: 200, offset: 0 });
  } catch {
    // Fall through — RunsCollection will fetch on the client side
  }
  return <RunsCollection initialRuns={initialRuns} />;
}
