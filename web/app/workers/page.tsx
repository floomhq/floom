"use client";

import WorkersCollection from "@/app/workers/WorkersCollection";

// TODO(#1098): admin "all workers" view relocated out of top tabs.
// The CloudWorkspaceAdminWorkersView component and the admin membership check
// have been removed from the top-level tab switcher per issue #1098.
// Re-introduce via a settings/admin route when needed, not as a peer tab here.

export default function CloudWorkersPage() {
  return <WorkersCollection initialWorkers={[]} />;
}
