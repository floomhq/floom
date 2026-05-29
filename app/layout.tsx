import type { Metadata } from "next";
import "./globals.css";
import { Ambient } from "@/components/Ambient";

export const metadata: Metadata = {
  title: "Workeros — Hire AI workers for your company",
  description:
    "Hire AI workers for your company. Describe the job, connect your tools, and Workeros runs it on a schedule, a webhook, or with your approval. Drive everything from Claude, Codex, Cursor, or any agent that speaks MCP.",
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
