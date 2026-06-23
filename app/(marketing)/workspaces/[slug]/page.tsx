import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WORKSPACES, getWorkspace } from "@/components/landing-ref/data";
import { V3WorkspaceDetailBody } from "@/app/v3/workspaces/[slug]/V3WorkspaceDetailBody";

export function generateStaticParams() {
  return WORKSPACES.map((w) => ({ slug: w.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const w = getWorkspace(slug);
  if (!w) return { title: "Workspace — Floom" };
  return {
    title: `${w.name} — Floom`,
    description: w.pitch,
  };
}

export default async function WorkspaceDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const w = getWorkspace(slug);
  if (!w) notFound();
  return <V3WorkspaceDetailBody w={w} />;
}
