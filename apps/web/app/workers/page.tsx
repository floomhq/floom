import nextDynamic from "next/dynamic";
import { fetchWorkerList } from "@/lib/server-api";

const WorkersCollection = nextDynamic(() => import("./WorkersCollection"));

// #945: was `revalidate = N` (ISR) — an authenticated, per-user data fetch
// must not be baked into a statically-cached shell shared across requests.
export const dynamic = "force-dynamic";

// perf: do NOT `await` the list here. Awaiting blocks the RSC behind a ~0.7-1s
// backend round-trip (query + proxy/Railway hops) and shows loading.tsx for that
// whole window on EVERY navigation, defeating the cache-first client. Stream the
// fetch as an unawaited promise instead; the client renders cache-first
// immediately and seeds from this promise only on a true cold start
// (useStreamedInitialData). Keeps the #654 cold-start SSR benefit, drops the
// per-navigation skeleton.
export default function WorkersPage() {
  const initialWorkersPromise = fetchWorkerList({ include_archived: true }).catch(
    () => [] as import("@/lib/types").WorkerSummary[],
  );
  return <WorkersCollection initialWorkersPromise={initialWorkersPromise} />;
}
