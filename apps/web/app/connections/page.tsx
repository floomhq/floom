import { fetchConnections } from "@/lib/server-api";
import ConnectionsCollection from "./ConnectionsCollection";

// #945: was `revalidate = N` (ISR) — an authenticated, per-user data fetch
// must not be baked into a statically-cached shell shared across requests.
export const dynamic = "force-dynamic";

export default async function ConnectionsPage() {
  let initialConnections: import("@/lib/types").ConnectionItem[] = [];
  try {
    initialConnections = await fetchConnections();
  } catch {
    // Fall through — client will fetch on mount
  }
  return <ConnectionsCollection initialConnections={initialConnections} />;
}
