import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { Toaster } from "@/components/ui/sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Floom — OS for Background Workers",
  description: "Spawn workers, run them, and observe everything.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex bg-[#fafafa] text-[#111]">
        <Sidebar />
        <main className="flex-1 min-w-0">
          <div className="max-w-6xl mx-auto px-6 py-8">{children}</div>
        </main>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
