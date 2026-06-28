import { NewWorkerClient } from "./NewWorkerClient";

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
  return <NewWorkerClient initialPrompt={initialPrompt} />;
}
