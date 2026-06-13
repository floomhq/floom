import WorkersCollection from "./WorkersCollection";

// #945: was `revalidate = N` (ISR) — an authenticated, per-user data fetch
// must not be baked into a statically-cached shell shared across requests.
export const dynamic = "force-dynamic";

export default async function WorkersPage() {
  return <WorkersCollection initialWorkers={[]} />;
}
