import type { Metadata } from "next";
import { V3Landing } from "./V3Landing";

export const metadata: Metadata = {
  title: "WorkerOS — Hire AI workers for your company",
  description:
    "Jobs that run themselves — on a schedule, from a message, or on demand. You get the output, not the mechanics.",
};

export default function V3Page() {
  return <V3Landing />;
}
