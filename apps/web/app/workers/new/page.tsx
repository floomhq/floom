import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

export default async function NewWorkerPage({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string; prime?: string }>;
}) {
  const params = await searchParams;
  const initialPrompt =
    (typeof params.prompt === "string" ? params.prompt : "") ||
    (typeof params.prime === "string" ? params.prime : "");
  const target = new URLSearchParams({ create: "1" });
  if (initialPrompt.trim()) target.set("prime", initialPrompt.trim());
  redirect(`/?${target.toString()}`);
}
