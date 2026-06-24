import nextDynamic from "next/dynamic";
import { fetchConnections } from "@/lib/server-api";

const ConnectionsCollection = nextDynamic(() => import("./ConnectionsCollection"));

// #945: was `revalidate = N` (ISR) — an authenticated, per-user data fetch
// must not be baked into a statically-cached shell shared across requests.
export const dynamic = "force-dynamic";

// perf: stream the connections fetch instead of awaiting it (see
// workers/page.tsx + useStreamedInitialData). Awaiting blocked first paint
// behind the backend round-trip and showed loading.tsx on every navigation.
export default function ConnectionsPage() {
  const initialConnectionsPromise = fetchConnections().catch(
    () => [] as import("@/lib/types").ConnectionItem[],
  );
  return <ConnectionsCollection initialConnectionsPromise={initialConnectionsPromise} />;
}
