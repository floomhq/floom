import type { Metadata } from "next";
import { V2DocsBody } from "./V2DocsBody";

export const metadata: Metadata = {
  title: "Docs · Workeros v2 preview",
  robots: { index: false, follow: false },
};

export default function V2DocsPage() {
  return <V2DocsBody />;
}
