import type { Metadata } from "next";
import "./globals.css";
import { Ambient } from "@/components/Ambient";

export const metadata: Metadata = {
  title: "Workeros — The cockpit for background work",
  description:
    "Workers, triggers, and connections in one place. Driven by Claude, Codex, Cursor, or any agent that speaks MCP. One operating layer.",
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
