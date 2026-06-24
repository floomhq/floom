/**
 * /chat -- full-page Emily chat interface (general "talk to Emily").
 *
 * The AppShell removes the dock and content padding for this route.
 * EmilyChatPage renders its own header + full-height message thread.
 *
 * Create flow: legacy `?mode=create` links redirect to /workers/new.
 */
import { redirect } from "next/navigation";
import { EmilyChatPage } from "@/components/emily/EmilyChat";
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
  return <EmilyChatPage />;
}
