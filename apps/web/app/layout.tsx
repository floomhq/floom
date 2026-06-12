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

// #926/#945: the whole app renders dynamically. The CSP script-src nonce
// (middleware.ts) is minted per request and must be stamped onto inline
// scripts during SSR — impossible for build-time-static pages. Independently,
// the security audit (#945) flagged statically pre-rendered protected shells
// served with public cache headers as a cache-safety footgun. This is an
// auth-gated dashboard: page data is client-fetched, shells are cheap, CDN
// caching of them was never load-bearing.
export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Floom",
  description: "Workers that use your tools. Run them on schedule, webhook, or approval.",
  icons: {
    // Single SVG favicon that adapts via prefers-color-scheme inside the SVG.
    // Browsers that support media-query favicons get separate light/dark PNGs
    // via the <link> tags injected in the <head> below.
    icon: "/icon.svg",
  },
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
