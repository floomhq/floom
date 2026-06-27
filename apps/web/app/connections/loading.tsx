import { CollectionRouteLoading } from "@/components/collection/CollectionRouteLoading";

// Static header mirrors ConnectionsCollection's config (title/subtitle, "Add"
// action, grid view toggle, tag filters).
export default function Loading() {
  return (
    <CollectionRouteLoading
      title="Connections"
      subtitle="Apps, MCP servers and secrets your agents can use."
      actionLabel="Add"
      showViewToggle
    />
  );
}
