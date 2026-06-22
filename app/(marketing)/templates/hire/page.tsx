import { redirect } from "next/navigation";
import { readSession } from "@/lib/session";
import { getTemplate, getWorkspace } from "@/components/landing-ref/data";
import { V3HireBody } from "@/app/v3/templates/hire/V3HireBody";

export const dynamic = "force-dynamic";

export default async function HirePage({
  searchParams,
}: {
  searchParams: Promise<{ worker?: string; workspace?: string }>;
}) {
  const sp = await searchParams;
  const kind: "worker" | "workspace" = sp.workspace ? "workspace" : "worker";
  const slug = (sp.workspace ?? sp.worker ?? "").trim();

  const session = await readSession();
  if (!session?.accessToken) {
    redirect(`/login?next=${encodeURIComponent(`/templates/hire?${kind}=${slug}`)}`);
  }

  const item = kind === "workspace" ? getWorkspace(slug) : getTemplate(slug);
  if (!item) redirect("/templates");

  return <V3HireBody kind={kind} slug={slug} name={item.name} />;
}
