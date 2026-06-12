import type { Metadata } from "next";
import { V3Body } from "./V3Body";

export const metadata: Metadata = {
  title: "WorkerOS · Hire AI workers for your company",
  description: "Describe the job. It runs. You approve.",
  robots: { index: false, follow: false },
};

export default function V3Page() {
  return <V3Body />;
}
