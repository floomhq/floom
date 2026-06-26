import RunDetailPageClient from "./RunDetailPageClient";

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string }>;
}) {
  const { id } = await params;
  const { tab } = await searchParams;

  return <RunDetailPageClient runId={id} initialTab={tab} />;
}
