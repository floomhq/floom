import type { Metadata } from "next";
import { V3DocsBody } from "./V3DocsBody";

export const metadata: Metadata = {
  title: "Docs · WorkerOS",
  robots: { index: false, follow: false },
};

export default function V3DocsPage() {
  return <V3DocsBody />;
}
