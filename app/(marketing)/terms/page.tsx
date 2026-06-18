import type { Metadata } from "next";
import { TermsBody } from "./TermsBody";

export const metadata: Metadata = {
  title: "Terms — Floom",
  description:
    "The rules that govern how you use Floom and what you can expect from us.",
};

export default function TermsPage() {
  return <TermsBody />;
}
