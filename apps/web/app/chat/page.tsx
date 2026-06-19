/**
 * /chat -- full-page Emily chat interface (general "talk to Emily").
 *
 * The AppShell removes the dock and content padding for this route.
 * EmilyChatPage renders its own header + full-height message thread.
 *
 * Create flow (Federico 2026-06-19): creating a worker is NO LONGER a separate
 * full-page surface. "New worker" / the legacy `?mode=create` open the SAME
 * fullscreen Emily as the home (the dock-fullscreen surface), primed for create
 * — `/?create=1` (with `&prime=<text>` seeding the composer). Old `?mode=create`
 * links redirect there so nothing breaks.
 */
import { redirect } from "next/navigation";
import { EmilyChatPage } from "@/components/emily/EmilyChat";

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
    const primeQs = typeof prime === "string" && prime ? `&prime=${encodeURIComponent(prime)}` : "";
    redirect(`/?create=1${primeQs}`);
  }
  return <EmilyChatPage />;
}
