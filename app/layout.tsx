import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import { ConvexClientProvider } from "./ConvexClientProvider";
import "./globals.css";
import { FeedbackWidget } from "./components/FeedbackWidget";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Floom",
  description: "Deploy and share Python automations with your team",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="h-full">
      <body className={`${inter.className} min-h-full antialiased`}>
        <ClerkProvider>
          <ConvexClientProvider>{children}<FeedbackWidget /></ConvexClientProvider>
        </ClerkProvider>
      </body>
    </html>
  );
}
