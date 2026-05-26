import type { Metadata } from "next";
import "./globals.css";
import { Ambient } from "@/components/Ambient";
import { Sidebar } from "@/components/layout/sidebar";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "Floom: OS for Background Workers",
  description: "Spawn workers, run them, and observe everything.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="h-full antialiased" suppressHydrationWarning>
      <body className="flex min-h-full flex-col bg-transparent text-foreground md:flex-row">
        <Ambient />
        <Sidebar />
        <main className="relative z-10 flex-1 min-w-0">
          <div className="max-w-6xl mx-auto px-4 sm:px-6 py-6 sm:py-8">{children}</div>
        </main>
        <Toaster position="bottom-right" />
      </body>
    </html>
  );
}
