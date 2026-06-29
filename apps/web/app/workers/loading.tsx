import { CollectionRouteLoading } from "@/components/collection/CollectionRouteLoading";

// Static header mirrors WorkersCollection's config: title/subtitle, tag filters,
// and list-only view with no create action.
export default function Loading() {
  return (
    <CollectionRouteLoading
      title="Workers"
      subtitle="Your AI workers."
      searchPlaceholder="Search workers or tags..."
    />
  );
}
