import { CollectionRouteLoading } from "@/components/collection/CollectionRouteLoading";

// Static header mirrors ApprovalsCollection's config (title/subtitle, grid view
// toggle, tag filters; no add button).
export default function Loading() {
  return (
    <CollectionRouteLoading
      title="Approvals"
      subtitle="Workers waiting for your decision before executing."
      showViewToggle
    />
  );
}
