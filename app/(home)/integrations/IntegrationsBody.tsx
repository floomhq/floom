"use client";

/**
 * /integrations — the full catalog (~1,000+ tools) in the curated card grammar.
 *
 * Cards carry logo + name + primary category + a one-line blurb, in the same
 * flat card style as /v3/templates (16px radius, hover bg shift). Curated,
 * operator-focused category pills + search narrow the grid. Each card opens a
 * quick-preview popover with the real catalog detail — full description, every
 * category, action/trigger counts, auth scheme, and a product link — which is
 * lazy-loaded so the grid stays light. All data comes from catalog.json /
 * catalog-detail.json (sourced from the Composio /toolkits API); nothing is
 * invented.
 */

import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { ArrowUpRight, Search, X } from "lucide-react";
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

type CatalogEntry = {
  slug: string;
  name: string;
  logo: string;
  categories: string[];
  blurb: string;
};

type EntryDetail = {
  description: string;
  toolsCount: number;
  triggersCount: number;
  auth: string;
  appUrl: string;
};

const CATALOG = catalog as CatalogEntry[];

/* Detail records live in a separate file, imported on demand so the grid stays
   light. Cache the module after the first modal open. */
let detailCache: Record<string, EntryDetail> | null = null;
async function loadDetailMap(): Promise<Record<string, EntryDetail> | null> {
  try {
    if (!detailCache) {
      const mod = await import("./catalog-detail.json");
      detailCache = (mod.default ?? mod) as Record<string, EntryDetail>;
    }
    return detailCache;
  } catch {
    // Detail chunk failed to load — callers fall back to the slim list data.
    return null;
  }
}
async function loadDetail(slug: string): Promise<EntryDetail | null> {
  return (await loadDetailMap())?.[slug] ?? null;
}

/* Title-case a raw category string ("ai web scraping" -> "AI Web Scraping"). */
const SMALL = new Set(["and", "or", "the", "of", "to", "for", "&"]);
const ACRONYMS = new Set(["ai", "crm", "sms", "api", "seo", "hr", "it"]);
function titleCase(s: string): string {
  return s
    .split(" ")
    .map((w) => {
      const lw = w.toLowerCase();
      if (ACRONYMS.has(lw)) return lw.toUpperCase();
      if (SMALL.has(lw)) return lw;
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

/* Human label for an auth scheme (covers every value present in the catalog). */
const AUTH_LABELS: Record<string, string> = {
  OAUTH2: "OAuth",
  OAUTH1: "OAuth",
  S2S_OAUTH2: "OAuth (S2S)",
  DCR_OAUTH: "OAuth (DCR)",
  API_KEY: "API key",
  BASIC: "Basic auth",
  BEARER_TOKEN: "Bearer token",
  SAML: "SAML",
  NO_AUTH: "No auth",
};
function authLabel(auth: string): string | null {
  if (!auth) return null;
  return AUTH_LABELS[auth] ?? titleCase(auth.replace(/_/g, " ").toLowerCase());
}

/* Curated, operator-focused filter buckets. Each maps a set of the raw Composio
   categories onto the kind of work founders / sales / ops actually browse for,
   so the pills lead with Sales/Marketing/Support rather than "Developer Tools".
   An entry matches a bucket if any of its categories falls in that bucket. */
const BUCKETS: { label: string; cats: string[] }[] = [
  { label: "Sales & CRM", cats: ["crm", "sales & crm", "contact management", "ai sales tools", "fundraising"] },
  { label: "Marketing", cats: ["marketing automation", "marketing", "social media marketing", "social media accounts", "ads & conversion", "drip emails"] },
  { label: "Email", cats: ["email", "email newsletters", "transactional email"] },
  { label: "Support", cats: ["customer support", "ai chatbots", "reviews", "customer appreciation"] },
  { label: "Productivity", cats: ["productivity", "project management", "task management", "scheduling & booking", "calendar", "time tracking software", "notes", "productivity & project management", "product management", "event management"] },
  { label: "Docs & Files", cats: ["documents", "file management & storage", "spreadsheets", "signatures", "content & files", "forms & surveys"] },
  { label: "Communication", cats: ["communication", "team chat", "team collaboration", "phone & sms", "video conferencing", "notifications", "video & audio", "webinars"] },
  { label: "Analytics", cats: ["analytics", "business intelligence", "dashboards"] },
  { label: "Finance", cats: ["accounting", "payment processing", "proposal & invoice management", "taxes"] },
  { label: "Commerce", cats: ["ecommerce", "e-commerce", "commerce"] },
  { label: "HR & People", cats: ["hr talent & recruitment", "human resources", "education", "online courses"] },
  { label: "Design", cats: ["images & design"] },
  { label: "AI", cats: ["artificial intelligence", "ai models", "ai agents", "ai content generation", "ai web scraping", "ai document extraction", "ai assistants", "ai meeting assistants", "model context protocol", "transcription", "video generation"] },
  { label: "Security", cats: ["security & identity tools"] },
  { label: "Developer", cats: ["developer tools", "developer tools & devops", "databases", "server monitoring", "it operations", "app builder", "website builders", "internet of things"] },
];

const BUCKET_SETS: Record<string, Set<string>> = Object.fromEntries(
  BUCKETS.map((b) => [b.label, new Set(b.cats)]),
);

function inBucket(entry: CatalogEntry, label: string): boolean {
  const set = BUCKET_SETS[label];
  return set ? entry.categories.some((c) => set.has(c)) : false;
}

/* Only show pills that actually match something in the current catalog. */
const PILL_LABELS: string[] = BUCKETS.filter((b) =>
  CATALOG.some((e) => inBucket(e, b.label)),
).map((b) => b.label);

/* Business tools workers reach for most lead the grid; the rest follow
   alphabetically (catalog order). */
const FEATURED = new Set([
  "gmail",
  "googlecalendar",
  "googledrive",
  "googlesheets",
  "googledocs",
  "slack",
  "notion",
  "hubspot",
  "salesforce",
  "linear",
  "github",
  "linkedin",
  "apollo",
]);

const SORTED = [...CATALOG].sort((a, b) => {
  const af = FEATURED.has(a.slug) ? 0 : 1;
  const bf = FEATURED.has(b.slug) ? 0 : 1;
  if (af !== bf) return af - bf;
  return a.name.localeCompare(b.name);
});

function CardLogo({ entry, size = 24 }: { entry: CatalogEntry; size?: number }) {
  const [imgError, setImgError] = useState(false);
  const handleError = useCallback(() => setImgError(true), []);
  const box = size + 16;
  return (
    <span
      className="flex items-center justify-center rounded-[10px] bg-background"
      style={{ height: box, width: box }}
    >
      {imgError || !entry.logo ? (
        <span
          className="flex items-center justify-center rounded-[6px] bg-secondary font-semibold text-muted-foreground"
          style={{ height: size, width: size, fontSize: size * 0.46 }}
          aria-hidden="true"
        >
          {entry.name.charAt(0).toUpperCase()}
        </span>
      ) : (
        <img
          src={entry.logo}
          alt=""
          aria-hidden="true"
          width={size}
          height={size}
          loading="lazy"
          decoding="async"
          onError={handleError}
          className="object-contain"
          style={{ height: size, width: size }}
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
  const category = entry.categories[0];
  return (
    <button
      type="button"
      onClick={() => onOpen(entry)}
      className="flex min-h-[124px] flex-col rounded-[16px] bg-card p-5 text-left transition-colors hover:bg-secondary/60 focus:outline-none focus-visible:ring-1 focus-visible:ring-[var(--v3-accent)]"
      aria-label={`View ${entry.name} details`}
    >
      <div className="flex w-full items-center justify-between gap-4">
        <CardLogo entry={entry} />
        {category ? (
          <span className="truncate rounded-full bg-secondary px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground">
            {titleCase(category)}
          </span>
        ) : null}
      </div>
      <h2
        className="mt-4 w-full truncate text-[15px] font-semibold tracking-[-0.012em]"
        title={entry.name}
      >
        {entry.name}
      </h2>
      {entry.blurb ? (
        <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">
          {entry.blurb}
        </p>
      ) : null}
    </button>
  );
}

/* Detail popover — flat, hairline, squircle, near-black close, backdrop closes.
   Real catalog data, lazy-loaded. Focus is moved in on open, trapped while open,
   and restored to the triggering card on close; body scroll is locked. */
function IntegrationModal({
  entry,
  onClose,
}: {
  entry: CatalogEntry;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  const [detail, setDetail] = useState<EntryDetail | null>(null);

  useEffect(() => {
    let active = true;
    loadDetail(entry.slug).then((d) => {
      if (active) setDetail(d);
    });
    return () => {
      active = false;
    };
  }, [entry.slug]);

  // Focus management + scroll lock + focus trap.
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const focusables = () =>
      Array.from(
        panelRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

    // Move focus into the dialog (close button is first).
    focusables()[0]?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const activeEl = document.activeElement;
      if (e.shiftKey && activeEl === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [onClose]);

  const auth = detail ? authLabel(detail.auth) : null;
  const stats: { label: string; value: string }[] = [];
  if (detail) {
    if (detail.toolsCount > 0)
      stats.push({ label: detail.toolsCount === 1 ? "Action" : "Actions", value: String(detail.toolsCount) });
    if (detail.triggersCount > 0)
      stats.push({ label: detail.triggersCount === 1 ? "Trigger" : "Triggers", value: String(detail.triggersCount) });
    if (auth) stats.push({ label: "Auth", value: auth });
  }

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/28 px-4 py-8 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-labelledby="integration-modal-title"
      aria-describedby="integration-modal-desc"
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        initial={{ opacity: 0, y: 8, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.22, ease: EASE }}
        className="w-full max-w-[440px] rounded-[20px] bg-[var(--bg-app)] p-5 text-left"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <CardLogo entry={entry} size={28} />
            <div>
              <h2 id="integration-modal-title" className="text-[18px] font-semibold tracking-[-0.018em]">
                {entry.name}
              </h2>
              {entry.categories.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {entry.categories.map((c) => (
                    <span
                      key={c}
                      className="inline-flex rounded-full bg-secondary px-2.5 py-0.5 text-[10.5px] font-medium text-muted-foreground"
                    >
                      {titleCase(c)}
                    </span>
                  ))}
                </div>
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

        <p id="integration-modal-desc" className="mt-4 text-[13.5px] leading-relaxed text-muted-foreground">
          {detail?.description ||
            entry.blurb ||
            `Connect ${entry.name} so a worker can read the right context and act on your behalf, with approval gates.`}
        </p>

        {stats.length ? (
          <div className="mt-5">
            <p className="mb-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              In the Composio catalog
            </p>
            <div className="grid grid-cols-3 gap-2.5">
              {stats.map((s) => (
                <div key={s.label} className="rounded-[12px] bg-secondary px-3 py-2.5">
                  <div className="text-[15px] font-semibold tracking-[-0.01em] text-foreground">{s.value}</div>
                  <div className="mt-0.5 text-[11px] text-muted-foreground">{s.label}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mt-5 border-t border-[rgba(16,17,20,.08)] pt-4">
          <p className="text-[13px] leading-relaxed text-muted-foreground">
            Link {entry.name} from the connections page and a worker gets a scoped subset of
            these actions — only what it needs, with approval gates on anything that ships.
          </p>
          {detail?.appUrl ? (
            <a
              href={detail.appUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-3 inline-flex items-center gap-1 text-[13px] font-medium text-[var(--v3-accent)] hover:underline"
            >
              Visit {entry.name}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          ) : null}
        </div>
      </motion.div>
    </div>
  );
}

// Render an initial batch; reveal the rest on demand to keep first paint fast
// across large result sets (including filtered buckets).
const INITIAL_VISIBLE = 90;

export function IntegrationsBody() {
  const [query, setQuery] = useState("");
  const [cat, setCat] = useState<string>("All");
  const [showAll, setShowAll] = useState(false);
  const [selected, setSelected] = useState<CatalogEntry | null>(null);
  // Full descriptions live in the lazy detail file; loaded on first search so
  // search can match them without shipping them in the initial payload.
  const [detailMap, setDetailMap] = useState<Record<string, EntryDetail> | null>(detailCache);
  const openEntry = useCallback((entry: CatalogEntry) => setSelected(entry), []);

  // Read initial filter state from URL on client mount.
  // useEffect is SSR-safe (runs only in the browser); window guard is therefore
  // redundant but kept for clarity.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sp = new URLSearchParams(window.location.search);
    const rawCat = sp.get("category") ?? "All";
    const safeCat = PILL_LABELS.includes(rawCat) ? rawCat : "All";
    const rawQ = sp.get("q") ?? "";
    if (safeCat !== "All") setCat(safeCat);
    if (rawQ) setQuery(rawQ);
  }, []); // runs once on mount

  // Sync cat + query → URL without a navigation (preserves back-button history).
  useEffect(() => {
    const params = new URLSearchParams();
    if (cat !== "All") params.set("category", cat);
    if (query.trim()) params.set("q", query.trim());
    const qs = params.toString();
    const newUrl = qs ? `?${qs}` : window.location.pathname;
    window.history.replaceState(null, "", newUrl);
  }, [cat, query]);

  // Any change to the filters resets pagination back to the first batch.
  useEffect(() => {
    setShowAll(false);
  }, [query, cat]);

  // Pull the detail map in once the user starts searching, so full-description
  // matches light up as soon as the chunk lands.
  useEffect(() => {
    if (query.trim() && !detailMap) {
      loadDetailMap().then((m) => {
        if (m) setDetailMap(m);
      });
    }
  }, [query, detailMap]);

  const filtered = useMemo(() => {
    let list = SORTED;
    if (cat !== "All") list = list.filter((e) => inBucket(e, cat));
    const q = query.trim().toLowerCase();
    if (q) {
      // Match the slim list fields immediately; once the lazy detail map has
      // loaded, also match the full description so tail-of-text terms surface.
      list = list.filter(
        (e) =>
          e.name.toLowerCase().includes(q) ||
          e.slug.toLowerCase().includes(q) ||
          e.blurb.toLowerCase().includes(q) ||
          e.categories.some((c) => c.toLowerCase().includes(q)) ||
          (detailMap?.[e.slug]?.description.toLowerCase().includes(q) ?? false),
      );
    }
    return list;
  }, [query, cat, detailMap]);

  const isNarrowed = query.trim().length > 0 || cat !== "All";
  const visible = showAll ? filtered : filtered.slice(0, INITIAL_VISIBLE);
  const hasMore = !showAll && filtered.length > INITIAL_VISIBLE;

  const clearFilters = useCallback(() => {
    setQuery("");
    setCat("All");
  }, []);

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
          Connects to {CATALOG.length.toLocaleString()}+ tools — reads context, produces
          output, asks for approval where your team works.
        </motion.p>
      </div>

      {/* controls: count + search, then category pills */}
      <div className="mb-6 flex flex-col gap-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-[13px] text-muted-foreground">
            {isNarrowed ? (
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
          {/* same search grammar as /templates: leading lucide icon, secondary
              pill, 12.5px transparent input */}
          <div className="flex w-full items-center gap-2 rounded-[10px] bg-secondary px-3 py-2 sm:w-72">
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search integrations…"
              aria-label="Search integrations"
              className="w-full bg-transparent text-[12.5px] text-foreground placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        </div>
        {/* Mobile: single horizontally-scrollable row (pills never wrap / clip).
            Desktop (sm+): wrap normally, exactly as before. */}
        <div className="-mx-4 flex flex-nowrap gap-1.5 overflow-x-auto px-4 [scrollbar-width:none] [-webkit-overflow-scrolling:touch] [&::-webkit-scrollbar]:hidden sm:mx-0 sm:flex-wrap sm:overflow-visible sm:px-0">
          {(["All", ...PILL_LABELS] as const).map((c) => (
            <button
              key={c}
              type="button"
              aria-pressed={cat === c}
              onClick={() => setCat(c as string)}
              className="shrink-0 rounded-full px-3 py-1.5 text-[12.5px] font-medium transition-colors"
              style={
                cat === c
                  ? { background: "var(--v3-accent)", color: "#fff" }
                  : { background: "var(--bg-2)", color: "var(--text-muted)" }
              }
            >
              {c}
            </button>
          ))}
        </div>
      </div>

      {/* card grid — templates-page grammar, full catalog */}
      {filtered.length === 0 ? (
        <div className="flex flex-col items-center gap-3 py-16 text-center">
          <p className="text-[14px] text-muted-foreground">
            {query.trim() && cat !== "All" ? (
              <>
                No <span className="text-foreground">{cat}</span>{" "}
                integrations match &ldquo;{query.trim()}&rdquo;.
              </>
            ) : query.trim() ? (
              <>No integrations match &ldquo;{query.trim()}&rdquo;.</>
            ) : (
              <>No integrations in {cat} yet.</>
            )}
          </p>
          <button
            type="button"
            onClick={clearFilters}
            className="inline-flex h-9 items-center rounded-[10px] bg-secondary px-4 text-[13px] font-medium text-foreground transition-colors hover:bg-[var(--bg-3)]"
          >
            Clear filters
          </button>
        </div>
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
                Show all {filtered.length.toLocaleString()}
                {isNarrowed ? "" : " integrations"}
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
