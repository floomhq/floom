import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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

export const metadata: Metadata = {
  title: "Workeros: Hire AI workers for your company",
  description:
    "Hire AI workers for your company. Describe the job, connect your tools, and Workeros runs it on a schedule, a webhook, or with your approval. Drive everything from Claude, Codex, Cursor, or any agent that speaks MCP.",
};

// Tell the browser the site supports both schemes so auto-darkening
// extensions don't mangle the light theme.
export const viewport = {
  colorScheme: "light dark" as const,
};

// Apply the saved theme (light/dark/system) before first paint — no flash.
const THEME_INIT = `(function(){try{var m=localStorage.getItem('floom-theme');var d=m==='night'||(m==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark');if(m)document.documentElement.dataset.theme=m;}catch(e){}})();`;

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
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body className="min-h-full bg-transparent text-foreground">
        <Ambient />
        {children}
      </body>
    </html>
  );
}
