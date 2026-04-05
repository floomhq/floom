import type { Metadata } from "next";
import { Inter, DM_Serif_Display, JetBrains_Mono, Geist } from "next/font/google";
import "./globals.css";
import { cn } from "@/lib/utils";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const dmSerif = DM_Serif_Display({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-dm-serif",
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jetbrains",
});

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
    <html
      lang="en"
      className={cn("h-full", inter.variable, dmSerif.variable, jetbrainsMono.variable, "font-sans", geist.variable)}
      style={
        {
          "--font-body": inter.style.fontFamily,
          "--font-brand": dmSerif.style.fontFamily,
          "--font-mono": jetbrainsMono.style.fontFamily,
        } as React.CSSProperties
      }
    >
      <body className={`${inter.className} min-h-full antialiased`}>
        {children}
      </body>
    </html>
  );
}
