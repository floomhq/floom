import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./cloud-shell.css";
import { Ambient } from "@/components/Ambient";
import { Sidebar } from "@/components/layout/sidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { Toaster } from "@/components/ui/sonner";
import { IconSprite } from "@/components/IconSprite";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Floom Workers",
  description: "Workers that use your tools. Run them on schedule, webhook, or approval.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`h-full antialiased ${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <body className="cloud-app-shell bg-transparent text-foreground">
        {/* Cloud overlay: keep the engine app shell, but use explicit CSS for
            the desktop flex direction so the hosted Cloud build cannot stack
            the sidebar above the app body through Tailwind utility ordering. */}
        <IconSprite />
        <Ambient />
        <Sidebar />
        <main className="relative z-10 flex-1 min-w-0">
          <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</div>
        </main>
        <CommandPalette />
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
