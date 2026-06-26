import { CollectionRouteLoading } from "@/components/collection/CollectionRouteLoading";

// Static header mirrors BrainCollection's config (title/subtitle, grid view
// toggle, tag filters). The Library has no prominent toolbar add button —
// dropping files is the primary affordance — so no actionLabel.
export default function Loading() {
  return (
    <CollectionRouteLoading
      title="Library"
      subtitle="Reusable folders of files your workers can read before they act."
      showViewToggle
    />
  );
}
