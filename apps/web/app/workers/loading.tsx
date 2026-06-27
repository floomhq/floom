import { CollectionRouteLoading } from "@/components/collection/CollectionRouteLoading";

// Static header mirrors WorkersCollection's config (title/subtitle, "New worker"
// action, tag filters; list-only view — no grid toggle).
export default function Loading() {
  return (
    <CollectionRouteLoading
      title="Agents"
      subtitle="Your AI agents."
      actionLabel="New agent"
      searchPlaceholder="Search agents or tags..."
    />
  );
}
