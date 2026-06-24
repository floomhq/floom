import nextDynamic from "next/dynamic";
import { fetchRuns } from "@/lib/server-api";

const RunsCollection = nextDynamic(() => import("./RunsCollection"));

// #945: was `revalidate = N` (ISR) — an authenticated, per-user data fetch
// must not be baked into a statically-cached shell shared across requests.
export const dynamic = "force-dynamic";

// perf: stream the first-page fetch instead of awaiting it (see workers/page.tsx
// + useStreamedInitialData). Awaiting blocked first paint behind the backend
// round-trip and showed loading.tsx on every navigation.
export default function RunsPage() {
  const initialRunsPromise = fetchRuns({ limit: 50, offset: 0 }).catch(
    () => [] as import("@/lib/types").RunSummary[],
  );
  return <RunsCollection initialRunsPromise={initialRunsPromise} />;
}
