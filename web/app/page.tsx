// S44: RSC — fetch overview on the server to eliminate client-side fetch round-trip.
import { Suspense } from "react";
import { fetchOverview } from "@/lib/server-api";
import { OverviewDashboard } from "@/components/overview/OverviewDashboard";
import { OverviewSkeleton } from "@/components/overview/OverviewSkeleton";

// #945: was `revalidate = N` (ISR) — an authenticated, per-user data fetch
// must not be baked into a statically-cached shell shared across requests.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <OverviewFetcher />
    </Suspense>
  );
}

async function OverviewFetcher() {
  let initialData: import("@/lib/types").SystemOverview | null = null;
  try {
    initialData = await fetchOverview();
  } catch {
    // Fall through — OverviewDashboard will fetch client-side
  }
  return <OverviewDashboard initialData={initialData} />;
}
