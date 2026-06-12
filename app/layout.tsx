import type { Metadata } from "next";
import { Geist, Geist_Mono, Source_Serif_4 } from "next/font/google";
import "./globals.css";
import { Ambient } from "@/components/Ambient";

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
  title: "WorkerOS: Hire AI workers for your company",
  description:
    "Hire AI workers for your company. Describe the job, connect your tools, and WorkerOS runs it on a schedule, a webhook, or with your approval. Drive everything from Claude, Codex, Cursor, or any agent that speaks MCP.",
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
        <Ambient />
        {children}
      </body>
    </html>
  );
}
