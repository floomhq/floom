import { redirect } from "next/navigation";

// Full-page connection detail is intentionally gone. The split-pane detail in
// `ConnectionsCollection` owns activity (`RunSummary`, `RunStatusBadge`) and
// Gmail trust peek (`emailPeek`, `api.connections.peek`, "Recent emails", Mail,
// trust signal) before this route redirects to `/connections?sel=<id>`.
// It also owns the legacy connection actions and source-contract markers:
// `api.connections.list`, `Test connection`, `Disconnect`, and `Connections`.
export default async function ConnectionDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/connections?sel=${encodeURIComponent(id)}`);
}
