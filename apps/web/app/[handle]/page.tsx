import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { FloomMark } from "@/components/share/ShareCardShell";
import { fetchPublicWorkspaceProfile } from "@/lib/server-api";
import type { PublicWorkspaceAsset } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

function formatCount(value: number, noun: string) {
  return `${value} ${noun}${value === 1 ? "" : "s"}`;
}

function AssetCard({ asset }: { asset: PublicWorkspaceAsset }) {
  const worker = asset.worker;
  return (
    <article className="w-full min-w-0 rounded-lg bg-[var(--bg-card)] p-5 shadow-[inset_0_0_0_1px_var(--border),0_1px_2px_rgba(15,23,42,0.08)]">
      <div className="flex min-w-0 flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <span className="rounded-md bg-[var(--bg-subtle)] px-2 py-1 text-xs font-medium uppercase tracking-[0.08em] text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--border)]">
              Worker
            </span>
            <span className="text-xs text-[var(--ink-soft)]">{worker.trigger_type}</span>
          </div>
          <h2 className="text-xl font-semibold text-[var(--ink)]">{asset.title}</h2>
          {asset.description ? (
            <p className="mt-2 max-w-2xl break-words text-sm leading-6 text-[var(--ink-soft)]">{asset.description}</p>
          ) : null}
        </div>
        {asset.share_path ? (
          <Link
            href={asset.share_path}
            className="self-start rounded-md bg-[var(--ink)] px-3 py-2 text-sm font-medium text-[var(--bg-card)] no-underline hover:opacity-90 sm:shrink-0"
          >
            View
          </Link>
        ) : null}
      </div>
      <div className="mt-5 flex flex-wrap gap-2 text-xs text-[var(--ink-soft)]">
        {worker.runtime ? <span className="rounded-md bg-[var(--bg-subtle)] px-2 py-1">{worker.runtime}</span> : null}
        {worker.connections.slice(0, 4).map((connection) => (
          <span key={connection} className="rounded-md bg-[var(--bg-subtle)] px-2 py-1">
            {connection}
          </span>
        ))}
      </div>
    </article>
  );
}

export default async function PublicWorkspacePage({
  params,
}: {
  params: Promise<{ handle: string }>;
}) {
  const { handle: rawHandle } = await params;
  const handle = decodeURIComponent(rawHandle);
  if (!handle.startsWith("@")) notFound();

  const slug = handle.slice(1);
  let profile;
  try {
    profile = await fetchPublicWorkspaceProfile(slug);
  } catch {
    notFound();
  }

  const sharer = profile.shared_by?.label || profile.workspace.name;

  return (
    <main className="min-h-screen overflow-x-hidden bg-[var(--bg)] text-[var(--ink)]">
      <header className="bg-[var(--bg-card)] shadow-[inset_0_-1px_0_var(--border)]">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-5 py-4">
          <FloomMark />
          <Link href="/login" className="text-sm font-medium text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]">
            Sign in
          </Link>
        </div>
      </header>

      <section className="ml-5 mr-auto w-[calc(100vw-2.5rem)] max-w-[350px] px-0 py-10 sm:mx-auto sm:w-full sm:max-w-6xl sm:px-5 md:py-14">
        <div className="max-w-3xl">
          <p className="text-sm font-medium uppercase tracking-[0.12em] text-[var(--ink-soft)]">Public workspace</p>
          <h1 className="mt-3 text-4xl font-semibold leading-tight text-[var(--ink)] md:text-6xl">
            {profile.workspace.name}
          </h1>
          <p className="mt-4 break-words text-lg leading-8 text-[var(--ink-soft)]">
            {sharer} is sharing {formatCount(profile.counts.assets, "public Floom asset")} with you.
          </p>
        </div>

        <div className="mt-8 flex flex-wrap gap-3 text-sm text-[var(--ink-soft)]">
          <span className="rounded-md bg-[var(--bg-card)] px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
            {formatCount(profile.counts.workers, "worker")}
          </span>
          <span className="rounded-md bg-[var(--bg-card)] px-3 py-2 shadow-[inset_0_0_0_1px_var(--border)]">
            @{profile.workspace.handle}
          </span>
        </div>

        {profile.assets.length > 0 ? (
          <div className="mt-10 grid min-w-0 gap-4 md:grid-cols-2">
            {profile.assets.map((asset) => (
              <AssetCard key={`${asset.type}:${asset.id}`} asset={asset} />
            ))}
          </div>
        ) : (
          <div className="mt-10 rounded-lg bg-[var(--bg-card)] p-6 text-[var(--ink-soft)] shadow-[inset_0_0_0_1px_var(--border)]">
            No public assets are listed in this workspace.
          </div>
        )}
      </section>
    </main>
  );
}
