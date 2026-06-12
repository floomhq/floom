import type { Metadata } from "next";
import { V3TemplatesBody } from "@/app/v3/templates/V3TemplatesBody";

export const metadata: Metadata = {
  title: "Templates — Floom",
  description:
    "Browse ready-to-run AI workers by team. Pick one or describe a new one. Floom hires the worker and runs the work.",
};

export default function TemplatesPage() {
  return <V3TemplatesBody />;
}
