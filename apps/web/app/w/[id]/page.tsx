// Public, read-only worker share page (v6). Standalone: rendered WITHOUT the
// app sidebar / command palette (AppShell standalonePrefixes includes "/w").
// The worker is resolved server-side via a signed HMAC token and the API
// returns a strict allow-list (PublicWorker) — never secrets, source, or run
// history. v6: ONE fixed-height Floom-native card that flips to a top
// tab-bar file view (see WorkerShareCard). noindex.
import Link from "next/link";
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { fetchPublicWorker } from "@/lib/server-api";
import { isAuthenticated } from "@/lib/server-auth";
import { WorkerShareCard } from "@/components/share/WorkerShareCard";
import { ShareCardShell } from "@/components/share/ShareCardShell";
import type { PublicWorker } from "@/lib/types";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function PublicWorkerPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ token?: string }>;
}) {
  const { id } = await params;
  const { token } = await searchParams;
  if (!token) notFound();

  let worker: PublicWorker;
  try {
    worker = await fetchPublicWorker(id, token);
  } catch {
    // Bad/missing token -> 401, unknown worker -> 404. Both render as not-found
    // on the public surface (no detail leaked about why).
    notFound();
  }

  // FL4: a signed-in visitor gets a "Dashboard" affordance back to the app
  // instead of being treated as a logged-out prospect ("Browse workers" / a
  // CTA that bounces through /login).
  const authed = await isAuthenticated();

  return (
    <ShareCardShell
      navRight={
        authed ? (
          <Link href="/" className="text-sm text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]">
            Dashboard
          </Link>
        ) : (
          <Link href="/workers" className="text-sm text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]">
            Browse workers
          </Link>
        )
      }
    >
      <WorkerShareCard worker={worker} authed={authed} />
      <div className="px-7 pb-5 pt-1">
        <p className="text-xs text-[var(--ink-soft)]">
          Built with{" "}
          <Link href="/" className="font-medium text-[var(--ink)] no-underline hover:underline">
            Floom
          </Link>{" "}
          AI workers that use your tools and run on a schedule, webhook, or on demand.
        </p>
      </div>
    </ShareCardShell>
  );
}
