// Library: reusable folders of files workers read before they act.
import nextDynamic from "next/dynamic";
import { fetchBrainFolders } from "@/lib/server-api";

const BrainCollection = nextDynamic(() => import("@/app/brain/BrainCollection"));

// #945: authenticated, per-user data must not be baked into a statically-cached
// shell shared across requests.
export const dynamic = "force-dynamic";

// Match Workers/Runs/Connections: do not block the RSC render on the list fetch.
// The client collection renders cache-first, then this promise seeds the cache
// on a true cold start.
export default function LibraryPage() {
  const initialFoldersPromise = fetchBrainFolders().catch(
    () => [] as import("@/lib/types").ContextSummary[],
  );
  return <BrainCollection initialFoldersPromise={initialFoldersPromise} />;
}
