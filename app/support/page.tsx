import type { Metadata } from "next";
import { VerticalLanding } from "@/components/VerticalLanding";
import { VERTICALS } from "@/lib/verticals";

const v = VERTICALS.support;

export const metadata: Metadata = {
  title: v.metaTitle,
  description: v.metaDescription,
};

export default function SupportPage() {
  return <VerticalLanding slug={v.slug} />;
}
