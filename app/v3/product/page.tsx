import type { Metadata } from "next";
import { V3ProductBody } from "./V3ProductBody";

export const metadata: Metadata = {
  title: "Product — Floom",
  description:
    "See how Floom workers run on the record: approvals, tool use, company brain, and every run logged for review.",
};

export default function V3ProductPage() {
  return <V3ProductBody />;
}
