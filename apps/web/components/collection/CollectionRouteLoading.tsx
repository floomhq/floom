import { CollectionSkeleton } from "@/components/collection/CollectionStates";

export function CollectionRouteLoading() {
  // Route-level loading shell: mirrors the real CollectionView layout (header +
  // search/toolbar + list) so the skeleton represents the page that is loading,
  // not a bare stack of bars. The app-shell already provides the page <main>,
  // so this is a plain wrapper (no nested <main>).
  return <CollectionSkeleton rows={6} />;
}
