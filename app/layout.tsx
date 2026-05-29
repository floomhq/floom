import type { Metadata } from "next";
import "./globals.css";
import { Ambient } from "@/components/Ambient";

export const metadata: Metadata = {
  title: "Workeros — Hire AI workers that actually run",
  description:
    "Hire AI workers for your company. Give them a job, a trigger, and their tools — they run on cron, webhook, or on demand. Drive everything from Claude, Codex, Cursor, or any agent that speaks MCP.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full bg-transparent text-foreground">
        <Ambient />
        {children}
      </body>
    </html>
  );
}
