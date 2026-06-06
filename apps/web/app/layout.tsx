import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/layout/AppShell";

// PR S20 polish: Geist Sans + Geist Mono (openchat-v2). Replaces the previous
// Google-Fonts @import of Inter; loaded via next/font for proper inlining
// and no FOUT.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Workeros",
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
      <body className="flex h-screen overflow-hidden flex-col bg-transparent text-foreground md:flex-row">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
