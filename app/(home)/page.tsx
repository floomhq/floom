import type { Metadata } from "next";
import { V3Body } from "../v3/V3Body";

export const metadata: Metadata = {
  title: "WorkerOS · Hire AI workers for your company",
  description:
    "Describe the job. WorkerOS hires the worker and runs it for your team, with your approval before anything ships.",
};

export default function HomePage() {
  return <V3Body />;
}
