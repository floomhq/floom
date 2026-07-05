import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchPublicWorkerPermalink } from "@/lib/server-api";
import { isAuthenticated } from "@/lib/server-auth";
import { WorkerShareCard } from "@/components/share/WorkerShareCard";
import { ShareNav } from "@/components/share/ShareCardShell";

// L4 permalink page: /@{handle}/{worker_slug}.
//
// The `@` is a literal path char captured by the [handle] dynamic segment
// (params.handle arrives as "%40fede" and decodes to "@fede") — NOT an @handle
// parallel-route folder, so no middleware rewrite is used. The permalink is a
// PUBLIC, INDEXABLE page (no noindex) so shared worker templates surface in
// search + unfurl on social. The data fetch is cached (revalidate) and reads
// only public card fields for a worker with visibility='public'; anything
// non-public / unknown -> 404 (never confirms a private worker exists).

type Props = {
  params: Promise<{ handle: string; workerSlug: string }>;
};

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle: rawHandle, workerSlug: rawSlug } = await params;
  const handle = decode(rawHandle);
  const workerSlug = decode(rawSlug);
  const card = await fetchPublicWorkerPermalink(handle, workerSlug).catch(() => null);
  if (!card) {
    return { title: "Floom worker", robots: { index: false, follow: false } };
  }
  const title = `${card.worker.name} | Floom`;
  const description =
    card.description ||
    card.worker.description ||
    `${card.worker.name}, a Floom AI worker template you can add to your workspace.`;
  const permalink = card.permalink; // /@handle/slug
  return {
    title,
    description,
    alternates: { canonical: permalink },
    openGraph: {
      type: "website",
      title,
      description,
      url: permalink,
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export default async function WorkerPermalinkPage({ params }: Props) {
  const { handle: rawHandle, workerSlug: rawSlug } = await params;
  const handle = decode(rawHandle);
  const workerSlug = decode(rawSlug);

  // A handle segment must start with '@' (the canonical public form). A bare
  // /{handle}/{slug} without the '@' is not a permalink -> 404.
  if (!handle.startsWith("@")) notFound();

  const card = await fetchPublicWorkerPermalink(handle, workerSlug);
  if (!card) notFound();

  const authed = await isAuthenticated();
  const bareHandle = card.workspace.handle;

  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--ink)]">
      <ShareNav />
      <div className="mx-auto w-full max-w-4xl">
        <WorkerShareCard
          worker={card.worker}
          authed={authed}
          sharedBy={card.shared_by ?? undefined}
          permalink={{
            handle: bareHandle,
            workerSlug: card.public_slug,
            path: card.permalink,
          }}
        />
      </div>
    </main>
  );
}
