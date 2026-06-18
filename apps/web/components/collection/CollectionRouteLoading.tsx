import { LoadingState } from "@/components/collection/CollectionStates";

export function CollectionRouteLoading() {
  return (
    <main className="c-collection">
      <LoadingState rows={6} />
    </main>
  );
}
