import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./cloud-shell.css";
import { CloudAppChrome } from "@/components/CloudAppChrome";
import { PostHogProvider } from "@/components/PostHogProvider";

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

// #926/#945: render dynamically everywhere — the middleware CSP nonce must be
// stamped onto inline scripts during SSR (impossible at build time), and the
// audit flagged statically pre-rendered protected shells with public cache
// headers. Matches the engine's apps/web root layout.
export const dynamic = "force-dynamic";

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
        <PostHogProvider>
          <CloudAppChrome>{children}</CloudAppChrome>
        </PostHogProvider>
      </body>
    </html>
  );
}
