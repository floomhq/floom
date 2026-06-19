// /overview — kept as an alias of the home so old links (and the mobile top-bar
// logo) keep working. Renders the same Emily-fullscreen HOME as "/".
import { fetchOverview } from "@/lib/server-api";
import { EmilyHome } from "@/components/home/EmilyHome";

// #945: authenticated, per-user data fetch must not be statically cached.
export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  let initialData: import("@/lib/types").SystemOverview | null = null;
  try {
    initialData = await fetchOverview();
  } catch {
    // Fall through — EmilyHome fetches client-side (cache-first).
  }
  return <EmilyHome initialData={initialData} />;
}
