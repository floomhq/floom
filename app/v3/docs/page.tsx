import type { Metadata } from "next";
import { V3DocsBody } from "./V3DocsBody";

export const metadata: Metadata = {
  title: "Docs — Floom",
  description:
    "Hire your first Floom worker, connect channels, add MCP, load company brain, and keep approvals on the record.",
};

export default function V3DocsPage() {
  return <V3DocsBody />;
}
