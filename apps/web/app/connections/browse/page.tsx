/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  X,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { ConnectionsTabs } from "@/components/connections/ConnectionsTabs";
import type { CatalogToolItem, IntegrationCatalogItem, IntegrationCatalogResponse } from "@/lib/types";

const PAGE_SIZE = 30;

// Curated list of popular app slugs for the "Popular" filter.
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

// Outcome-oriented copy: what can a worker DO with this integration?
// Falls back to the Composio description, then a generic phrase.
const OUTCOME_OVERRIDES: Record<string, string> = {
  gmail: "Read, send and organize email on behalf of any worker.",
  slack: "Post messages, read channels and react to mentions.",
  notion: "Create, search and update pages and databases.",
  github: "Open issues, review PRs and push code changes.",
  googlecalendar: "Schedule meetings, check availability and create events.",
  hubspot: "Create contacts, update deals and log activities.",
  linear: "Create issues, update project status and read cycles.",
  googlesheets: "Read and write rows, formulas and named ranges.",
  salesforce: "Query records, create leads and update opportunities.",
  discord: "Send messages, read channels and manage roles.",
  linkedin: "Post updates and pull profile or company data.",
  stripe: "Check balances, list charges and manage subscriptions.",
  googledrive: "Upload, download and search files across Drive.",
  airtable: "Create, update and query records across bases.",
  jira: "Create tickets, transition issues and query backlogs.",
  dropbox: "Upload, download and share files and folders.",
};

function outcomeText(item: IntegrationCatalogItem): string {
  const override = OUTCOME_OVERRIDES[item.slug.toLowerCase()];
  if (override) return override;
  if (item.description && item.description.length > 0) return item.description;
  return `Connect ${item.name} so your workers can take action.`;
}

function CatalogSkeleton() {
  return (
    <>
      {Array.from({ length: PAGE_SIZE }).map((_, index) => (
        <div
          key={index}
          className="grid h-[172px] grid-rows-[auto_1fr_auto] rounded-[var(--radius-ui)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-card)]"
        >
          <div className="flex items-center gap-3">
            <Skeleton className="h-10 w-10 rounded-[var(--radius-ui)]" />
            <div className="min-w-0 flex-1 space-y-2">
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-3 w-14" />
            </div>
          </div>
          <div className="pt-4">
            <Skeleton className="h-3 w-full" />
            <Skeleton className="mt-2 h-3 w-2/3" />
          </div>
          <Skeleton className="h-7 w-full rounded-[var(--radius-ui)]" />
        </div>
      ))}
    </>
  );
}

// Module-level cache: fetched tools per slug, shared across card instances.const _toolsCache: Map<string, CatalogToolItem[]> = new Map();

// ToolsModal: opens on "What can it do?" click; lazy-fetches with search + scroll.
function ToolsModal({
  item,
  open,
  onClose,
  onConnect,
  connecting,
}: {
  item: IntegrationCatalogItem;
  open: boolean;
  onClose: () => void;
  onConnect: (slug: string) => void;
  connecting: boolean;
}) {
  const [tools, setTools] = useState<CatalogToolItem[] | null>(null);
  const [loadingTools, setLoadingTools] = useState(false);
  const [toolSearch, setToolSearch] = useState("");

  useEffect(() => {
    if (!open) return;
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
  }, [open, item.slug]);

  useEffect(() => {
    if (!open) setToolSearch("");
  }, [open]);

  const filteredTools = useMemo(() => {
    if (!tools) return [];
    const q = toolSearch.trim().toLowerCase();
    if (!q) return tools;
    return tools.filter(
      (t) =>
        t.name.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q))
    );
  }, [tools, toolSearch]);

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        className="flex max-h-[80vh] w-full max-w-md flex-col gap-0 p-0"
        showCloseButton={true}
      >
        {/* Header: logo + name */}
        <DialogHeader className="flex-row items-center gap-3 [border-bottom:var(--bd-div)] px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-ui)] bg-[var(--bg-2)]">            <img
              src={item.logo_url}
              alt={`${item.name} logo`}
              className="h-6 w-6 object-contain"
              loading="eager"
              decoding="async"
            />
          </div>
          <div className="min-w-0">
            <DialogTitle className="truncate text-sm font-semibold text-ink">
              {item.name}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              {item.tools_count} action{item.tools_count !== 1 ? "s" : ""} available
            </p>
          </div>
        </DialogHeader>

        {/* Search */}
        <div className="[border-bottom:var(--bd-div)] px-4 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={toolSearch}
              onChange={(e) => setToolSearch(e.target.value)}
              placeholder="Filter tools..."
              className="h-8 w-full rounded-[var(--radius-ui)] bg-[var(--bg-2)] pl-8 pr-3 text-xs text-ink placeholder:text-muted-foreground focus:outline-none"            />
            {toolSearch ? (
              <button
                type="button"
                onClick={() => setToolSearch("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-ink"
                aria-label="Clear filter"
              >
                <X className="h-3 w-3" />
              </button>
            ) : null}
          </div>
        </div>

        {/* Scrollable tool list */}
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          {loadingTools ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              Loading actions…
            </div>
          ) : filteredTools.length > 0 ? (
            <ul className="space-y-3">
              {filteredTools.map((tool) => (
                <li key={tool.name} className="flex items-start gap-2.5">
                  <Zap className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--accent)]" />
                  <div className="min-w-0">
                    <p className="text-xs font-medium text-ink">{tool.name}</p>
                    {tool.description ? (
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                        {tool.description}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          ) : tools !== null ? (
            <p className="py-6 text-center text-xs text-muted-foreground">
              {toolSearch ? "No actions match your filter." : "No action details available."}
            </p>
          ) : null}
        </div>

        {/* Footer: Connect CTA */}
        <DialogFooter className="[border-top:var(--bd-div)] px-4 py-3" showCloseButton={false}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={connecting}
            onClick={() => {
              onClose();
              onConnect(item.slug);
            }}
            className="w-full sm:w-auto"
          >
            {connecting ? <Loader2 className="animate-spin" /> : <ExternalLink />}
            {connecting ? "Opening..." : "Connect"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// CatalogSkeleton: row-style loading placeholders.
function CatalogSkeleton({ count = PAGE_SIZE }: { count?: number }) {
  return (
    <>
      {Array.from({ length: Math.min(count, 12) }).map((_, index) => (
        <div key={index} className="flex items-center gap-4 py-3.5">
          <Skeleton className="h-10 w-10 shrink-0 rounded-xl" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-56" />
          </div>
          <Skeleton className="h-7 w-20 shrink-0" />
        </div>
      ))}
    </>
  );
}

// CatalogRow: a single integration as a horizontal list row.
function CatalogRow({
  item,
  connecting,
  isConnected,
  onConnect,
}: {
  item: IntegrationCatalogItem;
  connecting: boolean;
  isConnected: boolean;
  onConnect: (slug: string) => void;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <>
      <article className="grid h-[172px] grid-rows-[auto_1fr_auto] rounded-[var(--radius-ui)] bg-[var(--bg-card)] p-4 shadow-[var(--shadow-card)] transition-[background-color,box-shadow] duration-150 ease-[var(--ease)] hover:bg-[var(--bg-2)]">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-[var(--radius-ui)] bg-[var(--bg-2)]">
            <img
              src={item.logo_url}
              alt={`${item.name} logo`}
              className="h-6 w-6 object-contain"
              loading="eager"
              decoding="async"
            />
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="line-clamp-2 text-sm font-semibold text-ink">{item.name}</h2>
          </div>        </div>

        {/* Name + outcome text */}
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-sm font-semibold text-ink">{item.name}</h2>
          <p className="line-clamp-1 mt-0.5 text-xs text-muted-foreground">
            {outcomeText(item)}
          </p>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 items-center gap-2">
          {item.tools_count > 0 ? (
            <button
              type="button"
              onClick={() => setModalOpen(true)}
              className="mt-2 inline-flex items-center gap-1 rounded-[var(--radius-ui)] px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-[var(--accent)]"
              title="View tools in this integration"            >
              {item.tools_count} actions
            </button>
          ) : null}

          {isConnected ? (
            <>
              <span className="flex items-center gap-1 text-xs font-medium text-green-600">
                <CheckCircle2 className="h-3.5 w-3.5" />
                Connected
              </span>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => onConnect(item.slug)}
              >
                <Plus className="h-3 w-3" />
                Add account
              </Button>
            </>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-7 whitespace-nowrap px-3 text-xs"
              disabled={connecting}
              onClick={() => onConnect(item.slug)}
            >
              {connecting ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <ExternalLink className="h-3 w-3" />
              )}
              {connecting ? "Opening..." : "Connect"}
            </Button>
          )}
        </div>
      </article>

      {modalOpen ? (
        <ToolsModal
          item={item}
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onConnect={onConnect}
          connecting={connecting}
        />
      ) : null}
    </>
  );
}

// ConnectedSection: the top strip showing already-connected integrations.
function ConnectedSection({
  items,
  connecting,
  onConnect,
}: {
  items: IntegrationCatalogItem[];
  connecting: string | null;
  onConnect: (slug: string) => void;
}) {
  if (items.length === 0) return null;

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Connected
        </h2>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </div>
      <div className="divide-y divide-[var(--line-soft,rgba(0,0,0,0.06))]">
        {items.map((item) => (
          <CatalogRow
            key={item.slug}
            item={item}
            connecting={connecting === item.slug}
            isConnected={true}
            onConnect={onConnect}
          />
        ))}
      </div>
    </section>
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
  const [connectedSlugs, setConnectedSlugs] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.connections.list()
      .then((list) => {
        const active = new Set(
          list
            .filter((c) => c.status === "active")
            .map((c) => (c.app_name ?? "").toLowerCase())
        );
        setConnectedSlugs(active);
      })
      .catch(() => { /* non-fatal */ });
  }, []);

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

  // Split catalog items into connected vs available.
  const { connectedItems, availableItems } = useMemo(() => {
    const items = catalog?.items ?? [];
    const connected = items.filter((i) => connectedSlugs.has(i.slug.toLowerCase()));
    const available = items.filter((i) => !connectedSlugs.has(i.slug.toLowerCase()));
    return { connectedItems: connected, availableItems: available };
  }, [catalog, connectedSlugs]);

  const pageSummary = useMemo(() => {
    if (loading) return "";
    if (loadError) return "";
    if (!catalog) return "";
    const start = catalog.total_items === 0 ? 0 : (catalog.page - 1) * catalog.limit + 1;
    const end = Math.min(catalog.page * catalog.limit, catalog.total_items);
    return `${start}–${end} of ${catalog.total_items.toLocaleString()}`;
  }, [catalog, loading, loadError]);

  function handleConnect(slug: string) {
    setConnecting(slug);
    router.push(
      `/connections/redirect?app=${encodeURIComponent(slug)}&return_to=${encodeURIComponent("/connections/browse")}`
    );
  }

  const isFiltering = debouncedSearch.length > 0 || category !== "";

  return (
    <div className="space-y-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Connections</h1>
        <p className="mt-1 max-w-2xl text-sm text-[var(--ink-soft)]">
          Connect the apps your workers need to take action, email, calendar, CRM, code and more.
        </p>
      </header>

      <ConnectionsTabs />

      {/* Search + category filter */}
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

      <section className="grid grid-cols-[repeat(auto-fill,minmax(176px,1fr))] gap-3">
        {loading ? (
          <CatalogSkeleton />
        ) : loadError ? (
          <div className="col-span-full space-y-3 rounded-[var(--radius-ui)] bg-[var(--bg-card)] px-4 py-12 text-center">
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
              isConnected={connectedSlugs.has(item.slug.toLowerCase())}
              onConnect={handleConnect}
            />
          ))
        ) : (
          // S24: when Composio catalog returns no match for the search,
          // bridge to the manual path: store a raw API key as a Secret.
          // Many apps that lack Composio OAuth still expose a simple key.
          <div className="col-span-full rounded-[var(--radius-ui)] bg-[var(--bg-card)] px-6 py-10 text-center">
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
                  className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-ui)] bg-[var(--accent-soft)] px-3 text-xs font-medium text-[var(--accent)] transition-opacity hover:opacity-90"
                >
                  Add {search.trim()} as a secret
                </Link>
              </div>
            )}
          </div>
        )}
      </section>
          {/* Browse / Available section */}
          <section>
            {!isFiltering && availableItems.length > 0 ? (
              <div className="mb-1 flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  Available
                </h2>
                {pageSummary ? (
                  <span className="text-xs text-muted-foreground">{pageSummary}</span>
                ) : null}
              </div>
            ) : isFiltering && pageSummary ? (
              <div className="mb-1 flex items-center justify-end">
                <span className="text-xs text-muted-foreground">{pageSummary}</span>
              </div>
            ) : null}

            <div className="divide-y divide-[var(--line-soft,rgba(0,0,0,0.06))]">
              {(isFiltering ? catalog.items : availableItems).map((item) => (
                <CatalogRow
                  key={item.slug}
                  item={item}
                  connecting={connecting === item.slug}
                  isConnected={connectedSlugs.has(item.slug.toLowerCase())}
                  onConnect={handleConnect}
                />
              ))}
            </div>
          </section>
        </div>
      ) : (
        // Empty state — bridge to secrets for apps not in Composio catalog
        <div className="rounded-[var(--radius-card)] bg-[var(--bg-2)] px-6 py-12 text-center">
          <p className="text-sm font-medium text-ink">No integrations found</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Clear filters or try a broader search.
          </p>
          {search.trim().length > 0 && (
            <div className="mt-5 inline-flex flex-col items-center gap-2">
              <p className="text-xs text-muted-foreground">
                Does {search.trim()} expose an API key? Add it as a secret and any worker can use it.
              </p>
              <Link
                href={`/connections/secrets?prefill=${encodeURIComponent(search.trim().toUpperCase().replace(/[^A-Z0-9_]+/g, "_") + "_API_KEY")}`}
                className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--accent-soft)] px-3 text-xs font-medium text-[var(--accent)] transition-opacity hover:opacity-90"
              >
                Add {search.trim()} as a secret
              </Link>
            </div>
          )}
        </div>
      )}

      {/* Pagination — only shown when there are results */}
      {!loading && !loadError && (catalog?.total_pages ?? 0) > 1 ? (
        <div className="flex items-center justify-between [border-top:var(--bd-div)] pt-4">
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
          <span className="text-sm text-muted-foreground">
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
      ) : null}
    </div>
  );
}
