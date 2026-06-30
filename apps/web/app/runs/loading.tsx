import { CollectionRouteLoading } from "@/components/collection/CollectionRouteLoading";

// Static header mirrors RunsCollection's config (title, subtitle, grid view
// toggle, tag filters; no add button — Export is a toolbar action).
export default function Loading() {
  return (
    <CollectionRouteLoading
      title="Run history"
      subtitle="Every run, on the record."
      showViewToggle
    />
  );
}
