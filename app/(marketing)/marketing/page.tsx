import type { Metadata } from "next";
import { VerticalLanding } from "@/components/VerticalLanding";
import { VERTICALS } from "@/lib/verticals";

const v = VERTICALS.marketing;

export const metadata: Metadata = {
  title: v.metaTitle,
  description: v.metaDescription,
};

export default function MarketingPage() {
  return <VerticalLanding slug={v.slug} />;
}
