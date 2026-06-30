// Home ("/") — the EXISTING Emily shown FULLSCREEN (Federico 2026-06-19).
//
// The home is NOT a separate composer. The EmilyDock (mounted in AppShell)
// detects the home route, forces Emily into TRUE fullscreen (the page pane
// hides, the sidebar stays), and renders the home greeting + lean pulse + pills
// in Emily's OWN empty state — seeding Emily's real composer. This page only
// renders a quiet placeholder for the pane (hidden once Emily goes fullscreen).
import { HomePane } from "@/components/home/HomePane";
import { fetchOverview } from "@/lib/server-api";

// #945: authenticated, per-user dashboard must not be statically cached.
export const dynamic = "force-dynamic";

export default function HomePage() {
  // perf: the home pulse ("N done this week · M need attention") reads the
  // ['system','overview'] query. On a cold start (fresh tab, no persisted cache)
  // that pulse blocked on a cold client fetch of the HEAVY GET /system/overview
  // composite, leaving a long blank. Mirror the runs/workers pattern: stream the
  // overview fetch as an UNAWAITED promise (never `await` it — that would block
  // the whole RSC behind the backend round-trip) and seed the same query cache
  // client-side via useStreamedInitialData, so the pulse paints immediately.
  // Errors degrade to null → the pulse stays hidden exactly as before.
  const overviewPromise = fetchOverview().catch(
    () => null as import("@/lib/types").SystemOverview | null,
  );
  return <HomePane overviewPromise={overviewPromise} />;
}
