import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { fetchPublicWorkerPermalink } from "@/lib/server-api";
import { getPublicSiteOrigin } from "@/lib/api-base";
import { isAuthenticated } from "@/lib/server-auth";
import { WorkerShareCard } from "@/components/share/WorkerShareCard";
import { ShareNav } from "@/components/share/ShareCardShell";

// Absolute, basePath-aware permalink URL for a public worker card.
//
// Next resolves relative metadata URLs against `metadataBase`, which defaults to
// the raw platform deployment origin (e.g. r9-detail…floom.dev) AND drops the
// hosted `/app` basePath from co-located `opengraph-image` routes (#1022) — so
// both og:image and canonical pointed at an unfetchable 404 URL. We build the
// absolute URL explicitly instead: real public host + basePath + %40-encoded
// handle/slug. Returns { page, image } with no trailing slash.
function permalinkUrls(
  card: { workspace: { handle: string }; public_slug: string },
  requestHost: string | null,
): { page: string; image: string } {
  const origin = getPublicSiteOrigin(requestHost);
  const basePath = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, "");
  const handleSeg = encodeURIComponent(`@${card.workspace.handle}`);
  const slugSeg = encodeURIComponent(card.public_slug);
  const page = `${origin}${basePath}/${handleSeg}/${slugSeg}`;
  return { page, image: `${page}/opengraph-image` };
}

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
  searchParams: Promise<{ share?: string }>;
};

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export async function generateMetadata({ params, searchParams }: Props): Promise<Metadata> {
  const { handle: rawHandle, workerSlug: rawSlug } = await params;
  const { share } = await searchParams;
  const handle = decode(rawHandle);
  const workerSlug = decode(rawSlug);
  const card = await fetchPublicWorkerPermalink(handle, workerSlug, share).catch(() => null);
  if (!card) {
    return { title: "Floom worker", robots: { index: false, follow: false } };
  }
  const title = `${card.worker.name} | Floom`;
  const description =
    card.description ||
    card.worker.description ||
    `${card.worker.name}, a Floom AI worker template you can add to your workspace.`;
  // An unguessable ?share= link is deliberately unlisted (Fede 2026-07-06):
  // noindex, and skip the OG/canonical/image build entirely rather than bake
  // the secret token into a canonical URL or a second unauthenticated
  // og-image fetch this page hasn't audited for token handling.
  if (card.access && card.access !== "public") {
    return { title, description, robots: { index: false, follow: false } };
  }
  const hdrs = await headers();
  const requestHost = hdrs.get("x-forwarded-host") ?? hdrs.get("host");
  const { page: pageUrl, image: imageUrl } = permalinkUrls(card, requestHost);
  return {
    title,
    description,
    alternates: { canonical: pageUrl },
    openGraph: {
      type: "website",
      title,
      description,
      url: pageUrl,
      images: [{ url: imageUrl, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [imageUrl],
    },
  };
}

export default async function WorkerPermalinkPage({ params, searchParams }: Props) {
  const { handle: rawHandle, workerSlug: rawSlug } = await params;
  const { share } = await searchParams;
  const handle = decode(rawHandle);
  const workerSlug = decode(rawSlug);

  // A handle segment must start with '@' (the canonical public form). A bare
  // /{handle}/{slug} without the '@' is not a permalink -> 404.
  if (!handle.startsWith("@")) notFound();

  // Visibility is a property of the worker, not the URL (Fede 2026-07-06):
  // bare renders a public worker; ?share=<token> renders a non-public one iff
  // the token is valid for it. Both paths 404 identically otherwise — the
  // permalink never confirms a private worker's existence.
  const card = await fetchPublicWorkerPermalink(handle, workerSlug, share);
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
