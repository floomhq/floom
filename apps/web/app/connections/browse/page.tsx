/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Search,
  Wrench,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectionsTabs } from "@/components/connections/ConnectionsTabs";
import type { CatalogToolItem, IntegrationCatalogItem, IntegrationCatalogResponse } from "@/lib/types";

const PAGE_SIZE = 30;

// Curated list of popular app slugs for the "Popular" filter.
// Shown when no Composio category matches the friendly label.
const POPULAR_APP_SLUGS = new Set([
  "gmail",
  "slack",
  "notion",
  "github",
  "googlecalendar",
  "hubspot",
  "linear",
  "googlesheets",
  "salesforce",
  "discord",
  "linkedin",
  "stripe",
  "googledrive",
  "airtable",
  "jira",
  "dropbox",
]);

// Maps friendly UI labels to Composio category slugs.
// Composio's actual categories differ from the friendly names shown in the UI.
// Sending a comma-separated list asks the backend to OR-filter across all of them.
// Slugs verified against GET /integrations/catalog on 2026-05-26.
const CATEGORY_MAP: Record<string, string[]> = {
  Productivity: ["productivity", "notes", "documents", "project-management", "task-management", "calendar"],
  Email: ["email", "communication"],
  CRM: ["crm", "contact-management"],
  Social: ["social-media-accounts", "social-media-marketing"],
  Marketing: ["marketing", "marketing-automation"],
  Data: ["databases", "spreadsheets", "analytics"],
  Collaboration: ["team-chat", "team-collaboration", "video-conferencing"],
};

const CATEGORY_FILTERS = [
  { value: "", label: "All" },
  { value: "popular", label: "Popular" },
  ...Object.keys(CATEGORY_MAP).map((label) => ({
    value: CATEGORY_MAP[label].join(","),
    label,
  })),
];

function shortDescription(item: IntegrationCatalogItem) {
  return item.description || `${item.name} integration for your Floom Workers.`;
}

function CatalogSkeleton() {
  return (
    <>
      {Array.from({ length: PAGE_SIZE }).map((_, index) => (
        <div
          key={index}
          className="flex min-h-[172px] flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-card)]"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-[var(--radius-button)]" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-14" />
            </div>
          </div>
          <div className="flex-1 pt-4">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-2/3" />
          </div>
          <div className="pt-4">
            <Skeleton className="h-7 w-full rounded-[var(--radius-button)]" />
          </div>
        </div>
      ))}
    </>
  );
}

// Cache fetched tools per slug to avoid re-fetching on re-render.
const _toolsCache: Map<string, CatalogToolItem[]> = new Map();

function CatalogCard({
  item,
  connecting,
  onConnect,
}: {
  item: IntegrationCatalogItem;
  connecting: boolean;
  onConnect: (slug: string) => void;
}) {
  const [showTools, setShowTools] = useState(false);
  const [tools, setTools] = useState<CatalogToolItem[] | null>(null);
  const [loadingTools, setLoadingTools] = useState(false);
  const fetchedRef = useRef(false);

  function handleToggleTools(e: React.MouseEvent) {
    e.stopPropagation();
    const next = !showTools;
    setShowTools(next);
    // Fetch once on first open
    if (next && !fetchedRef.current) {
      fetchedRef.current = true;
      const cached = _toolsCache.get(item.slug);
      if (cached) {
        setTools(cached);
        return;
      }
      setLoadingTools(true);
      api.integrations
        .catalogTools(item.slug)
        .then((data) => {
          _toolsCache.set(item.slug, data);
          setTools(data);
        })
        .catch(() => setTools([]))
        .finally(() => setLoadingTools(false));
    }
  }

  return (
    <article className="flex flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-card)] transition-[border-color,box-shadow,transform] duration-150 ease-[var(--ease)] hover:-translate-y-px hover:border-[var(--accent-line)] hover:shadow-md">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg border border-[var(--border-default)] bg-[var(--bg-2)]">
          <img
            src={item.logo_url}
            alt={`${item.name} logo`}
            className="h-6 w-6 object-contain"
            loading="eager"
            decoding="async"
          />
        </div>
        <div className="min-w-0">
          {/* P2-8 (audit 2026-05-29): dropped the dev-facing Composio toolkit
              slug. The human name now gets two lines so it no longer truncates. */}
          <h2 className="line-clamp-2 text-sm font-semibold text-ink">{item.name}</h2>
        </div>
      </div>

      <div className="min-w-0 flex-1 pt-3">
        <p className="line-clamp-2 text-sm text-[var(--ink-soft)]">{shortDescription(item)}</p>

        {/* Tool preview (G6) — shown when expanded */}
        {showTools && (
          <div className="mt-3 space-y-1.5">
            {loadingTools ? (
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                Loading tools…
              </div>
            ) : tools && tools.length > 0 ? (
              tools.map((tool) => (
                <div key={tool.name} className="flex items-start gap-1.5">
                  <Wrench className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                  <span className="text-xs leading-snug text-[var(--ink-soft)]">
                    <span className="font-medium text-ink">{tool.name}</span>
                    {tool.description ? (
                      <span className="ml-1 text-muted-foreground">
                        — {tool.description.slice(0, 80)}{tool.description.length > 80 ? "…" : ""}
                      </span>
                    ) : null}
                  </span>
                </div>
              ))
            ) : tools !== null ? (
              <p className="text-xs text-muted-foreground">No tool details available.</p>
            ) : null}
          </div>
        )}
      </div>

      {/* Footer: category badge + tools toggle + connect button */}
      <div className="pt-3 space-y-2">
        <div className="flex items-center gap-2 flex-wrap">
          {item.categories[0] ? (
            <Badge variant="outline" className="max-w-full truncate text-[11px]">
              {item.categories[0].replaceAll("-", " ")}
            </Badge>
          ) : null}
          {item.tools_count > 0 ? (
            <button
              type="button"
              onClick={handleToggleTools}
              className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium transition-colors ${
                showTools
                  ? "border-[var(--accent-line)] bg-[var(--accent-soft)] text-[var(--accent)]"
                  : "border-[var(--border-default)] text-muted-foreground hover:border-[var(--accent-line)] hover:text-[var(--accent)]"
              }`}
              title={showTools ? "Hide tools" : "Preview tools"}
            >
              <Wrench className="h-2.5 w-2.5" />
              {item.tools_count} tools
            </button>
          ) : null}
        </div>

        {/* S29p: outline variant keeps grid-of-peers visual weight balanced */}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="w-full"
          disabled={connecting}
          onClick={() => onConnect(item.slug)}
        >
          {connecting ? <Loader2 className="animate-spin" /> : <ExternalLink />}
          {connecting ? "Opening..." : "Connect"}
        </Button>
      </div>
    </article>
  );
}

export default function ConnectionsBrowsePage() {
  const router = useRouter();
  const [catalog, setCatalog] = useState<IntegrationCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [category, setCategory] = useState("");
  const [page, setPage] = useState(1);
  const [connecting, setConnecting] = useState<string | null>(null);

  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(search.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [search]);

  const loadCatalog = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      if (category === "popular") {
        // Fetch all (unfiltered) and filter client-side to popular slugs.
        // Popular is a curated list, not a Composio category.
        const nextCatalog = await api.integrations.catalog({
          page: 1,
          limit: 100,
          search: debouncedSearch,
          category: "",
        });
        const filtered = nextCatalog.items.filter((item) =>
          POPULAR_APP_SLUGS.has(item.slug.toLowerCase())
        );
        setCatalog({
          ...nextCatalog,
          items: filtered,
          total_items: filtered.length,
          total_pages: 1,
          page: 1,
          next_page: null,
        });
      } else {
        const nextCatalog = await api.integrations.catalog({
          page,
          limit: PAGE_SIZE,
          search: debouncedSearch,
          category,
        });
        setCatalog(nextCatalog);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Failed to load integrations";
      setLoadError(msg);
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  }, [category, debouncedSearch, page]);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  const pageSummary = useMemo(() => {
    if (loading) return "Loading...";
    if (loadError) return "Load failed";
    if (!catalog) return "";
    const start = catalog.total_items === 0 ? 0 : (catalog.page - 1) * catalog.limit + 1;
    const end = Math.min(catalog.page * catalog.limit, catalog.total_items);
    return `${start}-${end} of ${catalog.total_items.toLocaleString()} integrations`;
  }, [catalog, loading, loadError]);

  function handleConnect(slug: string) {
    setConnecting(slug);
    router.push(
      `/connections/redirect?app=${encodeURIComponent(slug)}&return_to=${encodeURIComponent("/connections/browse")}`
    );
  }

  return (
    <div className="space-y-6">
      {/* S23: shared header + tabs match /connections so the two pages read as
          one surface. Back-arrow dropped (tabs cover the nav). */}
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">
          Search the full integration catalog and connect any of 1000+ apps for your workers.
        </p>
      </header>
      <ConnectionsTabs />
      <div className="text-sm text-[var(--ink-mute)]">{pageSummary}</div>

      {/* S29x (score walk): was wrapped in a bordered backdrop-blur section
          with the category row rendered as saturated-blue pills on active.
          Now flat: bare search input + quiet underline-style category row
          matching the /runs status filter rhythm (S29q). */}
      <section className="space-y-3">
        <div className="relative max-w-md">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Gmail, Slack, Notion..."
            className="h-11 pl-8 pr-8 sm:h-9"
            aria-label="Search integrations"
          />
          {search ? (
            <button
              type="button"
              className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center text-muted-foreground hover:bg-muted hover:text-foreground"
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-4 flex-wrap overflow-x-auto pb-1">
          {CATEGORY_FILTERS.map((filter) => (
            <button
              key={filter.value || "all"}
              type="button"
              onClick={() => {
                setCategory(filter.value);
                setPage(1);
              }}
              className={`relative pb-1.5 text-sm whitespace-nowrap transition-colors ${
                category === filter.value
                  ? "text-foreground font-medium after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] items-start gap-3">
        {loading ? (
          <CatalogSkeleton />
        ) : loadError ? (
          <div className="col-span-full rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-card)] px-4 py-12 text-center space-y-3">
            <p className="text-sm font-medium text-ink">Could not load integrations</p>
            <p className="mt-1 text-sm text-[var(--ink-soft)]">{loadError}</p>
            <button
              type="button"
              onClick={() => void loadCatalog()}
              className="text-xs underline text-[var(--ink-soft)] hover:text-ink transition-colors"
            >
              Try again
            </button>
          </div>
        ) : catalog?.items.length ? (
          catalog.items.map((item) => (
            <CatalogCard
              key={item.slug}
              item={item}
              connecting={connecting === item.slug}
              onConnect={handleConnect}
            />
          ))
        ) : (
          // S24: when Composio catalog returns no match for the search,
          // bridge to the manual path: store a raw API key as a Secret.
          // Many apps that lack Composio OAuth still expose a simple key.
          <div className="col-span-full rounded-xl border border-dashed border-[var(--border-default)] bg-[var(--bg-card)] px-6 py-10 text-center">
            <p className="text-sm font-medium text-ink">No integrations found</p>
            <p className="mt-1 text-sm text-[var(--ink-soft)]">
              Clear filters or try a broader search.
            </p>
            {search.trim().length > 0 && (
              <div className="mt-5 inline-flex flex-col items-center gap-2">
                <p className="text-xs text-[var(--ink-mute)]">
                  Does the app you need expose an API key? Add it as a secret and any worker can read it.
                </p>
                <Link
                  href={`/connections/secrets?prefill=${encodeURIComponent(search.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_") + "_API_KEY")}`}
                  className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--accent)] bg-[var(--accent-soft)] px-3 text-xs font-medium text-[var(--accent)] hover:opacity-90 transition-opacity"
                >
                  Add {search.trim()} as a secret
                </Link>
              </div>
            )}
          </div>
        )}
      </section>

      <div className="flex items-center justify-between border-t border-line pt-4">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || page <= 1}
          onClick={() => setPage((current) => Math.max(1, current - 1))}
        >
          <ChevronLeft />
          Previous
        </Button>
        <span className="text-sm text-[var(--ink-mute)]">
          Page {catalog?.page ?? page} of {catalog?.total_pages ?? "..."}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={loading || !catalog?.next_page}
          onClick={() => setPage((current) => current + 1)}
        >
          Next
          <ChevronRight />
        </Button>
      </div>
    </div>
  );
}
