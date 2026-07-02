// /overview — alias of the home so old links (and the mobile top-bar logo) keep
// working. Like "/", it is the EXISTING Emily shown FULLSCREEN (the EmilyDock
// detects the route and takes over). Renders the same quiet pane placeholder.
import { HomePane } from "@/components/home/HomePane";
import { fetchOverview } from "@/lib/server-api";

// #945: authenticated, per-user dashboard must not be statically cached.
export const dynamic = "force-dynamic";

export default function OverviewPage() {
  // perf: stream the overview as an unawaited promise so the home pulse paints
  // from a seeded cache on cold start instead of blocking on the heavy
  // GET /system/overview fetch (see app/page.tsx for the full rationale).
  const overviewPromise = fetchOverview().catch(
    () => null as import("@/lib/types").SystemOverview | null,
  );
  return <HomePane overviewPromise={overviewPromise} />;
}
