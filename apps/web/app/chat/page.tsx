/**
 * /chat -- full-page Emily chat interface.
 *
 * The AppShell removes the dock and content padding for this route.
 * EmilyChatPage renders its own header + full-height message thread.
 */
import { EmilyChatPage } from "@/components/emily/EmilyChat";

export const metadata = {
  title: "Emily - Workeros",
  description: "Chat with Emily, your AI Chief of Staff.",
};

export default function ChatPage() {
  return <EmilyChatPage />;
}
