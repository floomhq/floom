// Library — reusable folders of files workers read before they act.
import nextDynamic from "next/dynamic";
import { fetchBrainFolders } from "@/lib/server-api";

const BrainCollection = nextDynamic(() => import("@/app/brain/BrainCollection"));

// #945: authenticated, per-user data must not be baked into a statically-cached
// shell shared across requests.
export const dynamic = "force-dynamic";

export default async function LibraryPage() {
  let initialFolders: import("@/lib/types").ContextSummary[] = [];
  try {
    initialFolders = await fetchBrainFolders();
  } catch {
    // Fall through — BrainCollection will fetch on the client side
  }
  return <BrainCollection initialFolders={initialFolders} />;
}
