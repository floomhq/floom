import { redirect } from "next/navigation";

export default async function WorkerDetailRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(`/workers?sel=${encodeURIComponent(id)}`);
}
