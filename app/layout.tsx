import type { Metadata } from "next";
import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import { Ambient } from "@/components/Ambient";
import { PostHogProvider } from "@/components/PostHogProvider";

// Geist Sans + Geist Mono (openchat-v2 / dashboard parity). Loaded via
// next/font for proper inlining and no FOUT. Matches web/app/layout.tsx.
const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});
// Source Serif 4 — italic emphasis on key brand words (e.g. "workers").
// Stock Linux/Android lack Iowan/Garamond/Baskerville so a webfont is required
// for the intended editorial italic to render cross-platform.
const sourceSerif = Source_Serif_4({
  variable: "--font-serif",
  subsets: ["latin"],
  style: ["italic", "normal"],
  weight: ["400", "500", "600"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://design.floom.dev"),
  title: "Floom",
  description:
    "Hire AI workers for your company. Describe the job, connect your tools, and Floom runs it on a schedule, a webhook, or with your approval. Drive everything from Claude, Codex, Cursor, or any agent that speaks MCP.",
  openGraph: {
    title: "Floom",
    description:
      "Hire AI workers for your company. Describe the job, connect your tools, and Floom runs it on a schedule, a webhook, or with your approval.",
    url: "https://design.floom.dev",
    siteName: "Floom",
    images: [
      {
        url: "/marketing/og-image-v3.png",
        width: 1200,
        height: 630,
        alt: "Floom - Hire AI workers for your company",
      },
    ],
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Floom",
    description:
      "Hire AI workers for your company. Describe the job, connect your tools, and Floom runs it on a schedule, a webhook, or with your approval.",
    images: ["/marketing/og-image-v3.png"],
  },
  icons: {
    icon: [
      { url: "/floom-mark.svg", type: "image/svg+xml", media: "(prefers-color-scheme: light)" },
      { url: "/floom-icon.svg", type: "image/svg+xml", media: "(prefers-color-scheme: dark)" },
    ],
    apple: [{ url: "/floom-icon.svg", type: "image/svg+xml" }],
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
      className={`h-full antialiased ${geistSans.variable} ${geistMono.variable} ${sourceSerif.variable}`}
      suppressHydrationWarning
    >
      <body className="min-h-full bg-transparent text-foreground">
        <Script id="floom-theme-init" strategy="beforeInteractive">
          {`try{var m=localStorage.getItem("floom-theme");document.documentElement.classList.toggle("floom-night",m==="night");document.documentElement.classList.toggle("floom-day",m==="day")}catch(e){}`}
        </Script>
        <PostHogProvider>
          <Ambient />
          {children}
        </PostHogProvider>
      </body>
    </html>
  );
}
