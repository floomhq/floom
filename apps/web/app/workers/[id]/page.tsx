import { redirect } from "next/navigation";
import { appPath } from "@/lib/app-path";

export default async function WorkerDetailRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  redirect(appPath(`/workers?sel=${encodeURIComponent(id)}`));
}
