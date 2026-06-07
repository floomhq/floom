import type { Metadata } from "next";
import { ApprovalReviewClient } from "./ApprovalReviewClient";

export const metadata: Metadata = {
  title: "Approval request - Workeros",
  robots: {
    index: false,
    follow: false,
  },
};

export default async function ApprovalReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ id?: string; token?: string }>;
}) {
  const params = await searchParams;
  return <ApprovalReviewClient targetId={params.id ?? null} token={params.token ?? null} />;
}
