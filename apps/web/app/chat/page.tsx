/**
 * /chat -- full-page Emily chat interface.
 *
 * The AppShell removes the dock and content padding for this route.
 * EmilyChatPage renders its own header + full-height message thread.
 *
 * #902: ?mode=create opens the create-worker flow (create-primed composer,
 * wireframe newWorker()); ?prime=<text> pre-fills the composer (used by the
 * legacy /workers/new?prompt= deep-link redirect).
 */
import { EmilyChatPage } from "@/components/emily/EmilyChat";

export const metadata = {
  title: "Emily - WorkerOS",
  description: "Chat with Emily, your AI Chief of Staff.",
};

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; prime?: string }>;
}) {
  const { mode, prime } = await searchParams;
  return (
    <EmilyChatPage
      createMode={mode === "create"}
      primeInput={typeof prime === "string" && prime ? prime : undefined}
    />
  );
}
