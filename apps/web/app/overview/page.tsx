// S45: overview page — AlertsBell in top-right, OverviewDashboard below.
// #1292: the alerts bell is now global (rendered in AppShell, top-right of the
// content pane on every page), so the overview page no longer mounts its own
// bell or bubbles attention items up to it.
import { Suspense } from "react";
import { fetchOverview } from "@/lib/server-api";
import { OverviewDashboard } from "@/components/overview/OverviewDashboard";
import { OverviewSkeleton } from "@/components/overview/OverviewSkeleton";

// #945: was `revalidate = N` (ISR) — an authenticated, per-user data fetch
// must not be baked into a statically-cached shell shared across requests.
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
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
