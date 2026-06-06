// Public, read-only "skill card" page for a shared worker.
//
// Standalone: rendered WITHOUT the app sidebar / command palette (AppShell
// standalonePrefixes includes "/w"). Adapted from skills-neo's
// app/s/[token]/page.tsx public share page, but the worker is resolved server
// side via a signed HMAC token (the Floom approvals public-link pattern), and
// the API returns a strict allow-list (PublicWorker) — never secrets, source,
// or run history. The brand icon sprite (#brand-*) is mounted globally by
// AppShell, so logos resolve here without a local <IconSprite>.
import Link from "next/link";
import { notFound } from "next/navigation";
import { Clock, Webhook, Zap, MousePointerClick } from "lucide-react";
import { fetchPublicWorker } from "@/lib/server-api";
import { WorkerAvatar } from "@/components/WorkerAvatar";
import { BrandLogo } from "@/components/connections/BrandLogo";
import type { PublicWorker } from "@/lib/types";

export const dynamic = "force-dynamic";

// Mirror of the worker-card slug normalization (keeps BrandLogo lookup happy).
const SLUG_ALIASES: Record<string, string> = {
  googlecalendar: "google-calendar",
  googledrive: "google-drive",
  googledocs: "google-docs",
  googlesheets: "google-sheets",
  googlemeet: "google-meet",
};
function normalizeSlug(slug: string): string {
  const lower = slug.toLowerCase();
  return SLUG_ALIASES[lower] ?? lower;
}

function FloomMark({ size = 22 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Workeros"
      style={{ borderRadius: "22%" }}
    >
      <rect width="100" height="100" rx="22" fill="var(--primary)" />
      <path
        d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
        fill="var(--bg-app)"
      />
    </svg>
  );
}

function triggerLabel(type: string): { label: string; Icon: typeof Clock } {
  switch (type) {
    case "schedule":
      return { label: "Runs on a schedule", Icon: Clock };
    case "webhook":
      return { label: "Runs on a webhook", Icon: Webhook };
    case "composio":
      return { label: "Runs on an event", Icon: Zap };
    default:
      return { label: "Runs on demand", Icon: MousePointerClick };
  }
}

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

  const { label: trigger, Icon: TriggerIcon } = triggerLabel(worker.trigger_type);
  const tools = (worker.connections ?? []).map(normalizeSlug);

  return (
    <>
      <nav className="flex items-center justify-between border-b border-[var(--border-soft)] px-5 py-3">
        <Link href="/" className="flex items-center gap-2">
          <FloomMark size={22} />
          <span className="font-semibold text-base tracking-tight">Workeros</span>
        </Link>
        <Link
          href="/workers"
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          Browse workers
        </Link>
      </nav>

      <main className="mx-auto max-w-2xl px-4 sm:px-6 py-10 sm:py-14 space-y-8">
        {/* Header */}
        <header className="flex items-start gap-4">
          <WorkerAvatar seed={worker.id} name={worker.name} size="size-14" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-2xl font-semibold tracking-tight">{worker.name}</h1>
              {worker.is_example && (
                <span className="inline-flex items-center rounded-[var(--radius-button)] border border-border bg-muted/40 px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">
                  Example
                </span>
              )}
            </div>
            {worker.description && (
              <p className="text-sm text-muted-foreground leading-relaxed">
                {worker.description}
              </p>
            )}
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground pt-0.5">
              <TriggerIcon className="size-3.5" />
              <span>{trigger}</span>
            </div>
          </div>
        </header>

        {/* Tools / powered by */}
        {tools.length > 0 && (
          <section className="space-y-2.5">
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Tools it uses
            </h2>
            <div className="flex flex-wrap items-center gap-2">
              {tools.map((slug) => (
                <span
                  key={slug}
                  className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-xs text-foreground"
                >
                  <span className="inline-flex size-4 items-center justify-center">
                    <BrandLogo icon={slug} className="size-3.5" />
                  </span>
                  <span className="capitalize">{slug.replace(/-/g, " ")}</span>
                </span>
              ))}
            </div>
          </section>
        )}

        {/* About */}
        {worker.long_description && (
          <section className="space-y-2">
            <h2 className="text-base font-semibold text-foreground">About</h2>
            <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">
              {worker.long_description}
            </p>
          </section>
        )}

        {/* Use cases */}
        {worker.use_cases && worker.use_cases.length > 0 && (
          <section className="space-y-2">
            <h2 className="text-base font-semibold text-foreground">Use cases</h2>
            <ul className="space-y-1.5">
              {worker.use_cases.map((uc) => (
                <li key={uc} className="flex gap-2.5 text-sm text-foreground leading-relaxed">
                  <span className="mt-2 size-1 rounded-full bg-muted-foreground shrink-0" aria-hidden="true" />
                  <span>{uc}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* How it works */}
        {worker.how_it_works && (
          <section className="space-y-2">
            <h2 className="text-base font-semibold text-foreground">How it works</h2>
            <p className="text-sm text-foreground leading-relaxed whitespace-pre-line">
              {worker.how_it_works}
            </p>
          </section>
        )}

        {/* Inputs */}
        {worker.inputs.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">Inputs</h2>
            <ul className="divide-y divide-[var(--border-soft)] rounded-xl border border-[var(--border-soft)] overflow-hidden">
              {worker.inputs.map((inp) => (
                <li key={inp.name} className="flex items-start justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-foreground">
                      {inp.label}
                      {inp.required && <span className="ml-1 text-xs text-muted-foreground">(required)</span>}
                    </p>
                    {inp.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">{inp.description}</p>
                    )}
                  </div>
                  <span className="shrink-0 text-xs font-mono text-muted-foreground">{inp.type}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Outputs */}
        {worker.outputs.length > 0 && (
          <section className="space-y-3">
            <h2 className="text-base font-semibold text-foreground">Outputs</h2>
            <ul className="divide-y divide-[var(--border-soft)] rounded-xl border border-[var(--border-soft)] overflow-hidden">
              {worker.outputs.map((out) => (
                <li key={out.name} className="flex items-center justify-between gap-4 px-4 py-3">
                  <span className="text-sm font-medium text-foreground">{out.label}</span>
                  <span className="shrink-0 text-xs font-mono text-muted-foreground">{out.type}</span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* Footer CTA */}
        <footer className="border-t border-[var(--border-soft)] pt-6">
          <p className="text-sm text-muted-foreground">
            Built with{" "}
            <Link href="/" className="font-medium text-foreground hover:underline">
              Workeros
            </Link>
            {" "}— AI workers that use your tools and run on a schedule, webhook, or on demand.
          </p>
        </footer>
      </main>
    </>
  );
}
