// #902 (punchlist A1): the standalone create-worker form is gone — creating a
// worker IS a conversation with Emily. Federico 2026-06-19: that conversation is
// the SAME fullscreen Emily as the home (the dock-fullscreen surface), primed for
// create — `/?create=1` — not a separate /chat page with its own header. This
// route survives only as a redirect so old links keep working; ?prompt= text
// carries into the composer via `&prime=`.
import { redirect } from "next/navigation";

export default async function NewWorkerRedirect({
  searchParams,
}: {
  searchParams: Promise<{ prompt?: string }>;
}) {
  const { prompt } = await searchParams;
  const prime = typeof prompt === "string" && prompt ? `&prime=${encodeURIComponent(prompt)}` : "";
  redirect(`/?create=1${prime}`);
}
