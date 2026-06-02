import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import "./cloud-shell.css";
import { AppShell } from "@/components/layout/AppShell";
import { TelemetryProvider } from "@/components/TelemetryProvider";

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
      <body className="cloud-app-shell flex min-h-full flex-col bg-transparent text-foreground md:flex-row">
        <AppShell>{children}</AppShell>
        <TelemetryProvider />
      </body>
    </html>
  );
}
