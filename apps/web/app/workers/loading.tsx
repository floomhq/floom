import { CollectionRouteLoading } from "@/components/collection/CollectionRouteLoading";

// Static header mirrors WorkersCollection's config (title/subtitle, "New worker"
// action, tag filters; list-only view — no grid toggle).
export default function Loading() {
  return (
    <CollectionRouteLoading
      title="Workers"
      subtitle="Your AI workers."
      actionLabel="New worker"
      searchPlaceholder="Search workers or tags…"
    />
  );
}
