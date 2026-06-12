import { redirect } from "next/navigation";
import { appUrl } from "@/lib/app-url";

export default async function AssistantRedirectPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (typeof v === "string") qs.set(k, v);
    else if (Array.isArray(v)) v.forEach((vv) => qs.append(k, vv));
  }
  const tail = qs.toString();
  redirect(tail ? appUrl(`/assistant?${tail}`) : appUrl("/assistant"));
}
