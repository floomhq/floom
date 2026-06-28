/**
 * /chat -- full-page Emily chat interface (general "talk to Emily").
 *
 * AppShell keeps the persistent Emily dock mounted for this route.
 * ChatPage opens that same dock in fullscreen instead of mounting a second
 * stream instance, so navigation does not abort an active response.
 *
 * Create flow: legacy `?mode=create` links fall back to Workers. Natural
 * language worker creation is not exposed from the dashboard.
 */
import { redirect } from "next/navigation";
import { EmilyChatRouteFullscreen } from "@/components/emily/EmilyChat";

export const metadata = {
  title: "Emily - Floom",
  description: "Chat with Emily, your AI chief of staff.",
};

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ mode?: string; prime?: string }>;
}) {
  const { mode } = await searchParams;
  if (mode === "create") {
    redirect("/workers");
  }
  return <EmilyChatRouteFullscreen />;
}
