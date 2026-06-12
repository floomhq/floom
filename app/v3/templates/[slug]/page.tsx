import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { TEMPLATES, getTemplate, getTemplateDetail } from "@/components/landing-ref/data";
import { V3TemplateDetailBody } from "./V3TemplateDetailBody";

export function generateStaticParams() {
  return TEMPLATES.map((t) => ({ slug: t.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const t = getTemplate(slug);
  return {
    title: t ? `${t.name} · WorkerOS` : "Template · WorkerOS",
    robots: { index: false, follow: false },
  };
}

export default async function V3TemplateDetailPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const t = getTemplate(slug);
  if (!t) notFound();
  const d = getTemplateDetail(t);
  return <V3TemplateDetailBody t={t} d={d} />;
}
