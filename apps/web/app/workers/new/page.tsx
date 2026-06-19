// #902 (punchlist A1): the standalone create-worker form is gone — creating a
// worker IS a conversation with Emily. This route survives only as a redirect
// so old links keep working; ?prompt= text carries into the composer.
import { redirect } from "next/navigation";

export default async function NewWorkerRedirect({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string }>;
}) {
  const { prompt } = await searchParams;
  const prime = typeof prompt === "string" && prompt ? `&prime=${encodeURIComponent(prompt)}` : "";
  redirect(`/chat?mode=create${prime}`);
}
