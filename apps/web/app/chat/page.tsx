/**
 * /chat -- full-page Emily chat interface (general "talk to Emily").
 *
 * AppShell keeps the persistent Emily dock mounted for this route.
 * ChatPage opens that same dock in fullscreen instead of mounting a second
 * stream instance, so navigation does not abort an active response.
 *
 * Create flow: legacy `?mode=create` links redirect to the in-Emily create
 * flow (`/?create=1`, via createWorkerHref) — see EmilyDock's `?create=1`
 * effect. They no longer open the separate /workers/new page.
 */
import { redirect } from "next/navigation";
import { EmilyChatRouteFullscreen } from "@/components/emily/EmilyChat";
import { createWorkerHref } from "@/lib/create-worker-nav";

export const metadata = {
  title: "Emily - Floom",
  description: "Chat with Emily, your AI chief of staff.",
};

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; prime?: string }>;
}) {
  const { mode, prime } = await searchParams;
  if (mode === "create") {
    redirect(createWorkerHref(typeof prime === "string" ? prime : undefined));
  }
  return <EmilyChatRouteFullscreen />;
}
