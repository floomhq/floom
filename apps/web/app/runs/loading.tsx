import { CollectionRouteLoading } from "@/components/collection/CollectionRouteLoading";

// Static header mirrors RunsCollection's config (title, grid view toggle, tag
// filters; no subtitle and no add button — Export is a toolbar action).
export default function Loading() {
  return <CollectionRouteLoading title="Run history" showViewToggle />;
}
