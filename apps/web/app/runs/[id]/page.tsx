import { redirect } from "next/navigation";

// Full-page run detail is intentionally gone. The split-pane run detail owns
// stream recovery (`streamUnavailable`) and refresh wiring (`onRefresh={refresh}`)
// before this route redirects to `/runs?sel=<id>`.
export default async function RunDetailRedirect({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/runs?sel=${encodeURIComponent(id)}`);
}
