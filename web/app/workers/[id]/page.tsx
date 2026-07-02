import { redirect } from "next/navigation";
import { withWorkspaceParam } from "@/lib/workspaceHref";

export default async function WorkerDetailRedirectPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const query = await searchParams;
  redirect(withWorkspaceParam(`/workers?sel=${encodeURIComponent(id)}`, query));
}
