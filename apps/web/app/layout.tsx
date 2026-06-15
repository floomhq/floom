import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/layout/AppShell";
import { headers } from "next/headers";

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
    icon: "/icon.svg",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // #926/#1357: the per-request CSP nonce (minted in middleware.ts, threaded as
  // the x-nonce request header) must be stamped onto the inline theme script
  // below, or script-src 'self' 'nonce-…' 'strict-dynamic' blocks it.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html
      lang="en"
      className={`h-full antialiased ${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        {/*
          Blocking theme script: runs before first paint so the html element
          gets the correct .dark class immediately, preventing any flash of the
          wrong theme on load or hard refresh.

          Must stay an inline script (no src=) so the browser executes it
          synchronously before painting. suppressHydrationWarning on <html>
          covers the class/data-theme mismatch between SSR (no dark) and
          hydration (dark applied by script).

          #1115: theme also reverted on SPA navigation because Next.js does NOT
          re-run this script, but ThemeModeButton's useEffect re-reads
          localStorage and calls applyMode() which re-sets document.documentElement.
          The script fixes the hard-reload/SSR flash; ThemeModeButton handles
          subsequent navigations.
        */}
        <script
          nonce={nonce}
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var m=localStorage.getItem('floom-theme');var d=window.matchMedia&&window.matchMedia('(prefers-color-scheme:dark)').matches;var isDark=m==='night'||(m!=='day'&&m==='system'&&d)||(!m&&false);document.documentElement.classList.toggle('dark',isDark);document.documentElement.setAttribute('data-theme',m||'day');}catch(e){}})();`,
          }}
        />
      </head>
      <body className="flex h-screen overflow-hidden flex-col bg-transparent text-foreground md:flex-row">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
