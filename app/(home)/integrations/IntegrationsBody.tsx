"use client";

/**
 * /integrations — the full catalog (~1,000+ tools) in the curated card grammar.
 *
 * Every entry from catalog.json renders as a flat card (logo + name), in the
 * same card style as /v3/templates: 16px radius, hover bg shift. A small set of
 * featured tools carry a category chip + one-line detail; the rest show logo +
 * name. Searchable across the full catalog. Hero + close keep the product-page
 * polish (Reveal motion, one <Hl>).
 */

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { X } from "lucide-react";
import { Hl, V3Shell } from "@/app/v3/V3Shell";
import "@/app/v3/theme.css";
import catalog from "./catalog.json";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.1, margin: "0px 0px -8% 0px" }}
      transition={{ duration: 0.55, delay, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

type CatalogEntry = { slug: string; name: string; logo: string };

const CATALOG = catalog as CatalogEntry[];

/* Featured tools carry a category chip + one-line detail. Matched by slug so the
   curated grammar surfaces for the tools workers reach for most; everything else
   in the catalog renders as a clean logo + name card. */
const FEATURED: Record<string, { category: string; detail: string }> = {
  granola_mcp: { category: "Knowledge", detail: "Meeting notes and call context" },
  gmail: { category: "Google Workspace", detail: "Read, draft, and send email" },
  googlecalendar: { category: "Google Workspace", detail: "Meetings, schedules, and prep" },
  googledrive: { category: "Google Workspace", detail: "Docs, files, and shared context" },
  slack: { category: "Communication", detail: "Ask, approve, and receive finished work" },
  notion: { category: "Knowledge", detail: "Pages, playbooks, and internal docs" },
  linear: { category: "Product", detail: "Issues, projects, and status updates" },
  github: { category: "Product", detail: "Repos, PRs, issues, and engineering reports" },
  hubspot: { category: "CRM", detail: "Contacts, companies, deals, and notes" },
  salesforce: { category: "CRM", detail: "Accounts, opportunities, and CRM updates" },
  linkedin: { category: "CRM", detail: "Prospect research and sales context" },
  apollo: { category: "Data", detail: "Lead enrichment and prospect lists" },
  googlesheets: { category: "Google Workspace", detail: "Reports, lists, and structured outputs" },
  googledocs: { category: "Google Workspace", detail: "Briefs, drafts, and source documents" },
};

function CardLogo({ entry }: { entry: CatalogEntry }) {
  const [imgError, setImgError] = useState(false);
  const handleError = useCallback(() => setImgError(true), []);
  return (
    <span className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-background">
      {imgError || !entry.logo ? (
        <span
          className="flex h-6 w-6 items-center justify-center rounded-[6px] bg-secondary text-[11px] font-semibold text-muted-foreground"
          aria-hidden="true"
        >
          {entry.name.charAt(0).toUpperCase()}
        </span>
      ) : (
        <img
          src={entry.logo}
          alt=""
          aria-hidden="true"
          width={24}
          height={24}
          loading="lazy"
          decoding="async"
          onError={handleError}
          className="h-6 w-6 object-contain"
        />
      )}
    </span>
  );
}

function IntegrationCard({
  entry,
  onOpen,
}: {
  entry: CatalogEntry;
  onOpen: (entry: CatalogEntry) => void;
}) {
  const meta = FEATURED[entry.slug];
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className="flex min-h-[120px] flex-col rounded-[16px] bg-card p-5 text-left transition-colors hover:bg-secondary/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--v3-accent)]"
      aria-label={`View ${entry.name} details`}
    >
      <div className="flex w-full items-center justify-between gap-4">
        <CardLogo entry={entry} />
        {meta ? (
          <span className="rounded-full bg-secondary px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground">
            {meta.category}
          </span>
        ) : null}
      </div>
      <h2 className="mt-4 w-full truncate text-[15px] font-semibold tracking-[-0.012em]" title={entry.name}>
        {entry.name}
      </h2>
      {meta ? (
        <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">{meta.detail}</p>
      ) : null}
    </button>
  );
}

/* Detail popover — flat, hairline, squircle, near-black close, backdrop closes.
   Shows the catalog data that exists (name, logo, category + one-line detail for
   featured tools) and an honest note that triggers/endpoints surface on connect:
   the catalog has no trigger/endpoint data, so we don't invent any. */
function IntegrationModal({
  entry,
  onClose,
}: {
  entry: CatalogEntry;
  onClose: () => void;
}) {
  const meta = FEATURED[entry.slug];

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/28 px-4 py-8 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label={`${entry.name} details`}
      onClick={onClose}
    >
      <motion.div
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.22, ease: EASE }}
        className="w-full max-w-[420px] rounded-[20px] bg-[var(--bg-app)] p-5 text-left"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <CardLogo entry={entry} />
            <div>
              <h2 className="text-[18px] font-semibold tracking-[-0.018em]">{entry.name}</h2>
              {meta ? (
                <span className="mt-1 inline-flex rounded-full bg-secondary px-2.5 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                  {meta.category}
                </span>
              ) : null}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-foreground text-background transition-opacity hover:opacity-85"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {meta ? (
          <p className="mt-4 text-[13.5px] leading-relaxed text-muted-foreground">{meta.detail}</p>
        ) : (
          <p className="mt-4 text-[13.5px] leading-relaxed text-muted-foreground">
            Connect {entry.name} so a worker can read the right context and act on your behalf, with approval gates.
          </p>
        )}

        <div className="mt-5 border-t border-[rgba(16,17,20,.08)] pt-4">
          <p className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            Triggers &amp; endpoints
          </p>
          <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
            Available once connected. Floom exposes {entry.name}&apos;s actions to a worker after you
            link it from the connections page, scoped to what that worker needs.
          </p>
        </div>
      </motion.div>
    </div>
  );
}

/* Featured tools lead the grid; the rest follow alphabetically (catalog order). */
const SORTED = [...CATALOG].sort((a, b) => {
  const af = FEATURED[a.slug] ? 0 : 1;
  const bf = FEATURED[b.slug] ? 0 : 1;
  if (af !== bf) return af - bf;
  return a.name.localeCompare(b.name);
});

// Render an initial batch; reveal the full catalog on demand (and always when
// searching) to keep first paint fast across 1,000+ cards.
const INITIAL_VISIBLE = 90;

export function IntegrationsBody() {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  const openEntry = useCallback((entry: CatalogEntry) => setSelected(entry), []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return SORTED;
    return SORTED.filter(
      (e) => e.name.toLowerCase().includes(q) || e.slug.toLowerCase().includes(q),
    );
  }, [query]);

  const isSearching = query.trim().length > 0;
  const visible =
    isSearching || showAll ? filtered : filtered.slice(0, INITIAL_VISIBLE);
  const hasMore = !isSearching && !showAll && filtered.length > INITIAL_VISIBLE;

  return (
    <V3Shell active="integrations">
      {/* hero — centered, one highlight, product type scale */}
      <div className="pb-10 pt-20 text-center">
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, ease: EASE }}
          className="text-[34px] font-semibold leading-[1.03] tracking-[-0.032em] sm:text-[48px]"
        >
          Plugs into the stack you <Hl>already</Hl> use.
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.08, ease: EASE }}
          className="mx-auto mt-4 max-w-[460px] text-[15.5px] text-muted-foreground"
        >
          Floom connects to {CATALOG.length.toLocaleString()}+ tools so a worker can read the
          right context, produce the output, and ask for approval where your team already works.
        </motion.p>
      </div>

      {/* search + count */}
      <div className="mb-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-[13px] text-muted-foreground">
          {isSearching ? (
            <>
              <span className="font-semibold text-foreground">{filtered.length.toLocaleString()}</span>{" "}
              {filtered.length === 1 ? "result" : "results"}
            </>
          ) : (
            <>
              <span className="font-semibold text-foreground">{CATALOG.length.toLocaleString()}+</span>{" "}
              integrations
            </>
          )}
        </p>
        <div className="relative w-full sm:w-72">
          <svg
            className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
          >
            <circle cx="6.5" cy="6.5" r="4.5" />
            <path d="M10.5 10.5l3 3" strokeLinecap="round" />
          </svg>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search integrations…"
            aria-label="Search integrations"
            className="h-9 w-full rounded-[10px] bg-secondary pl-8 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-[var(--v3-accent)]"
          />
        </div>
      </div>

      {/* card grid — templates-page grammar, full catalog */}
      {filtered.length === 0 ? (
        <p className="py-16 text-center text-[14px] text-muted-foreground">
          No integrations found for &ldquo;{query}&rdquo;.
        </p>
      ) : (
        <div className="pb-12">
          <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((entry) => (
              <IntegrationCard key={entry.slug} entry={entry} onOpen={openEntry} />
            ))}
          </div>
          {hasMore ? (
            <div className="mt-8 flex justify-center">
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="inline-flex h-10 items-center rounded-[10px] bg-secondary px-5 text-[13px] font-medium text-foreground transition-colors hover:bg-[var(--bg-3)]"
              >
                Show all {CATALOG.length.toLocaleString()} integrations
              </button>
            </div>
          ) : null}
        </div>
      )}

      {/* close — product-style centered CTA */}
      <Reveal className="flex flex-col items-center gap-4 pb-10 text-center">
        <h2 className="text-[27px] font-semibold leading-[1.06] tracking-[-0.025em] sm:text-[34px]">
          Bring one job. Connect only what it needs.
        </h2>
        <p className="max-w-[420px] text-[15px] leading-relaxed text-muted-foreground">
          Each worker gets scoped tools and approval gates. You can expand access
          later from the connections page.
        </p>
        <Link
          href="/templates"
          className="mt-1 inline-flex items-center rounded-[12px] px-6 py-3 text-[14.5px] font-medium text-white"
          style={{ background: "var(--v3-accent)" }}
        >
          Browse workers
        </Link>
      </Reveal>

      {selected ? (
        <IntegrationModal entry={selected} onClose={() => setSelected(null)} />
      ) : null}
    </V3Shell>
  );
}
