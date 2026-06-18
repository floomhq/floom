import type { Metadata } from "next";
import { PrivacyBody } from "./PrivacyBody";

export const metadata: Metadata = {
  title: "Privacy — Floom",
  description:
    "How Floom handles your data, your worker runs, and the tools you connect.",
};

export default function PrivacyPage() {
  return <PrivacyBody />;
}
