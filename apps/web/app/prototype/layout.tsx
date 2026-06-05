import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Emily — Chief of Staff · Prototype",
  description: "Emily chat prototype with real Vercel AI Elements components",
};

/**
 * /prototype layout — AppShell already provides Sidebar + full-height main.
 * This layout just provides metadata and passes through children.
 */
export default function PrototypeLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
