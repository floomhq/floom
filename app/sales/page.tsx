import type { Metadata } from "next";
import { VerticalLanding } from "@/components/VerticalLanding";
import { VERTICALS } from "@/lib/verticals";

const v = VERTICALS.sales;

export const metadata: Metadata = {
  title: v.metaTitle,
  description: v.metaDescription,
};

export default function SalesPage() {
  return <VerticalLanding slug={v.slug} />;
}
