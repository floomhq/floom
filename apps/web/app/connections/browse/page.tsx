/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectionsTabs } from "@/components/connections/ConnectionsTabs";
import type { IntegrationCatalogItem, IntegrationCatalogResponse } from "@/lib/types";

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
  return item.description || `${item.name} integration for Workeros workers.`;
}

function CatalogSkeleton() {
  return (
    <>
      {Array.from({ length: PAGE_SIZE }).map((_, index) => (
        <div
          key={index}
          className="grid h-[172px] grid-rows-[auto_1fr_auto] rounded-lg border border-line bg-[var(--paper)] p-4 shadow-sm"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-md" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-14" />
            </div>
          </div>
          <div className="pt-4">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-2/3" />
          </div>
          <Skeleton className="h-7 w-full rounded-md" />
        </div>
      ))}
    </>
  );
}

function CatalogCard({
  item,
  connecting,
  onConnect,
}: {
  item: IntegrationCatalogItem;
  connecting: boolean;
  onConnect: (slug: string) => void;
}) {
  return (
    <article className="grid h-[172px] grid-rows-[auto_1fr_auto] rounded-lg border border-line bg-[var(--paper)] p-4 shadow-sm transition-[border-color,box-shadow,transform] duration-150 ease-[var(--ease)] hover:-translate-y-px hover:border-[var(--accent-line)] hover:shadow-md">
      <div className="flex min-w-0 items-center gap-3">
        <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md border border-line bg-[var(--paper-2)]">
          <img
            src={item.logo_url}
            alt={`${item.name} logo`}
            className="h-6 w-6 object-contain"
            loading="eager"
            decoding="async"
          />
        </div>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-ink">{item.name}</h2>
          <p className="mt-0.5 truncate text-xs text-[var(--ink-mute)]">{item.slug}</p>
        </div>
      </div>

      <div className="min-w-0 pt-4">
        <p className="truncate text-sm text-[var(--ink-soft)]">{shortDescription(item)}</p>
        {item.categories[0] ? (
          <Badge variant="outline" className="mt-3 max-w-full truncate text-[11px]">
            {item.categories[0].replaceAll("-", " ")}
          </Badge>
        ) : null}
      </div>

      <Button
        type="button"
        size="sm"
        className="w-full"
        disabled={connecting}
        onClick={() => onConnect(item.slug)}
      >
        {connecting ? <Loader2 className="animate-spin" /> : <ExternalLink />}
        {connecting ? "Opening..." : "Connect"}
      </Button>
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

  async function handleConnect(slug: string) {
    setConnecting(slug);
    const oauthTab = window.open("", "_blank");
    if (oauthTab) oauthTab.opener = null;
    try {
      const result = await api.connections.initiate(slug);
      if (result.redirect_url) {
        if (oauthTab) {
          oauthTab.location.href = result.redirect_url;
        } else {
          window.open(result.redirect_url, "_blank");
        }
        toast.success(`OAuth opened for ${slug}`);
      } else {
        oauthTab?.close();
        toast.success(`Connection initiated for ${slug}`);
      }
    } catch (error) {
      oauthTab?.close();
      const msg = error instanceof Error ? error.message : `Failed to connect ${slug}`;
      // Backend returns "api_key_only: ..." when the app uses API-key auth, not OAuth.
      // Redirect to secrets so the user can add the key there instead.
      if (msg.startsWith("api_key_only:")) {
        toast.info(`${slug} uses an API key, not OAuth. Add the key in Secrets.`, {
          action: {
            label: "Go to Secrets",
            onClick: () => router.push("/secrets"),
          },
          duration: 8000,
        });
      } else {
        toast.error(msg);
      }
    } finally {
      setConnecting(null);
    }
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

      <section className="space-y-3 rounded-lg border border-line bg-[var(--glass-bg)] p-3 shadow-sm backdrop-blur-[10px]">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-[var(--ink-mute)]" />
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search Gmail, Slack, Notion..."
            className="h-10 bg-[var(--paper)] pl-8 pr-8"
            aria-label="Search integrations"
          />
          {search ? (
            <button
              type="button"
              className="absolute right-2 top-1/2 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-[var(--ink-mute)] hover:bg-[var(--bg-2)] hover:text-ink"
              onClick={() => setSearch("")}
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {CATEGORY_FILTERS.map((filter) => (
            <Button
              key={filter.value || "all"}
              type="button"
              size="sm"
              variant={category === filter.value ? "default" : "outline"}
              className="h-7 whitespace-nowrap"
              onClick={() => {
                setCategory(filter.value);
                setPage(1);
              }}
            >
              {filter.label}
            </Button>
          ))}
        </div>
      </section>

      <section className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3">
        {loading ? (
          <CatalogSkeleton />
        ) : loadError ? (
          <div className="col-span-full rounded-lg border border-dashed border-line bg-[var(--paper)] px-4 py-12 text-center space-y-3">
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
          <div className="col-span-full rounded-lg border border-dashed border-line bg-[var(--paper)] px-4 py-12 text-center">
            <p className="text-sm font-medium text-ink">No integrations found</p>
            <p className="mt-1 text-sm text-[var(--ink-soft)]">Clear filters or try a broader search.</p>
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
