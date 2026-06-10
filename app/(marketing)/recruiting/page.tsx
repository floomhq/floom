import type { Metadata } from "next";
import { VerticalLanding } from "@/components/VerticalLanding";
import { VERTICALS } from "@/lib/verticals";

const v = VERTICALS.recruiting;

export const metadata: Metadata = {
  title: v.metaTitle,
  description: v.metaDescription,
};

export default function RecruitingPage() {
  return <VerticalLanding slug={v.slug} />;
}
