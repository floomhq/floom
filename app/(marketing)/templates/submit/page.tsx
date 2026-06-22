import type { Metadata } from "next";
import { V3SubmitBody } from "@/app/v3/templates/submit/V3SubmitBody";

export const metadata: Metadata = {
  title: "Publish a worker — Floom",
  description: "Describe a worker you've built. We review every submission before it goes live.",
};

export default function SubmitPage() {
  return <V3SubmitBody />;
}
