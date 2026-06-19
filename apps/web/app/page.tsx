// Emily-fullscreen HOME — the default landing. Replaces the old Overview
// dashboard. The home is composer-anchored (states: first-worker / active /
// drafting) and reuses the real Emily chat + overview/workers data.
//
// We still server-fetch the overview so the Active pulse hydrates without a
// client round-trip; the workers gate fetches client-side (cache-first).
import { fetchOverview } from "@/lib/server-api";
import { EmilyHome } from "@/components/home/EmilyHome";

// #945: authenticated, per-user data fetch must not be statically cached.
export const dynamic = "force-dynamic";

export default async function HomePage() {
  let initialData: import("@/lib/types").SystemOverview | null = null;
  try {
    initialData = await fetchOverview();
  } catch {
    // Fall through — EmilyHome fetches client-side (cache-first).
  }
  return <EmilyHome initialData={initialData} />;
}
