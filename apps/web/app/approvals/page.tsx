"use client";

// Approvals — migrated to the <Collection> model (SPEC §5). The list + split
// detail (Request / Items / Run + Approve/Reject) live in ApprovalsCollection;
// the multi-kind decision dispatch is reused from lib/approvals/decision.ts.
import dynamic from "next/dynamic";

const ApprovalsCollection = dynamic(() => import("./ApprovalsCollection"));

export default function ApprovalsPage() {
  return <ApprovalsCollection />;
}
