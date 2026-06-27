import {
  CollectionSkeleton,
  type CollectionSkeletonProps,
} from "@/components/collection/CollectionStates";

/**
 * Route-level loading shell. Renders the page's REAL static header (title,
 * subtitle, search box, view-toggle, filter, action button — matching the real
 * CollectionView header) and skeletons ONLY the list content rows, so a
 * cache-miss tab switch shows the real header instantly with no full-page flash.
 *
 * Each route's `loading.tsx` threads its own header info (title/subtitle/action
 * label + which controls show) through these props so the skeleton represents
 * the specific page that is loading. The app-shell already provides the page
 * <main>, so this is a plain wrapper (no nested <main>).
 */
export function CollectionRouteLoading(props: CollectionSkeletonProps) {
  return <CollectionSkeleton rows={6} {...props} />;
}
