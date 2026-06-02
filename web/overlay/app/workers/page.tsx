import { Suspense } from "react";
import WorkersClient from "@/app/workers/WorkersClient";
import WorkersLoadingSkeleton from "@/app/workers/WorkersLoadingSkeleton";

export default async function WorkersPage() {
  return (
    <Suspense fallback={<WorkersLoadingSkeleton />}>
      <WorkersClient initialWorkers={[]} />
    </Suspense>
  );
}
