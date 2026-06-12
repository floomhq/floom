import type { Metadata } from "next";
import { V3AboutBody } from "./V3AboutBody";

export const metadata: Metadata = {
  title: "About · WorkerOS",
  description:
    "WorkerOS is a worker runtime for founders and operators. Describe the job, approve the result. Open source, backed by Founders Inc.",
};

export default function AboutPage() {
  return <V3AboutBody />;
}
