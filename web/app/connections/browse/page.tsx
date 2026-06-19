/* eslint-disable @next/next/no-img-element */
"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  Loader2,
  Plus,
  Search,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { HIDDEN_CHANNEL_SLUGS } from "@/components/connections/connection-data";
import { CollectionView } from "@/components/collection/CollectionView";
import { LoadingState } from "@/components/collection/CollectionStates";
import {
  parseCollectionState,
  serializeCollectionState,
} from "@/lib/collection/url-state";
import type {
  CollectionConfig,
  CollectionState,
  TagFamilyKey,
} from "@/lib/collection/types";
import type {
  CatalogToolItem,
  IntegrationCatalogItem,
  IntegrationCatalogResponse,
} from "@/lib/types";

// 25 = the global CollectionView LIST_PAGE_SIZE window. Keeping the server page
// at exactly this size means a fully-loaded page never exceeds the window, so
// CollectionView's internal client pager never fires and we drive the single
// global-styled numbered pager against SERVER pages (the 1,046-app catalog is
// server-paginated). Matching the global window is the consistent choice over
// forcing a 30 that would split into a second client page + a duplicate pager.
const PAGE_SIZE = 25;

// The category facet drives a SERVER refetch (the 1,046-app catalog is
// server-paginated + server-filtered), so it lives in its own tag family.
const CATEGORY_FAMILY: TagFamilyKey = "content";

// Curated list of popular app slugs for the "Popular" filter.
// HIDDEN_CHANNEL_SLUGS are excluded so they don't surface in the popular tab.
const POPULAR_APP_SLUGS = new Set(
  [
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
  ].filter((slug) => !HIDDEN_CHANNEL_SLUGS.has(slug))
);

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

// TagBar options for the category facet. Value "" = All, "popular" = Popular,
// the rest carry the comma-joined Composio category slugs the server filters on.
const CATEGORY_OPTIONS = [
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

// Module-level cache: fetched tools per slug, shared across detail instances.
const _toolsCache: Map<string, CatalogToolItem[]> = new Map();

// CatalogLogo: the integration logo in the shared .c-logo chip used across the
// Collection surfaces, so Browse rows read with the same register as Connected.
function CatalogLogo({ item }: { item: IntegrationCatalogItem }) {
  return (
    <span className="c-logo">
      <img
        src={item.logo_url}
        alt={`${item.name} logo`}
        style={{ width: 18, height: 18, objectFit: "contain" }}
        loading="lazy"
        decoding="async"
      />
    </span>
  );
}

// CatalogToolsPanel: the per-app "what can it do?" preview, now the Tools tab of
// the global detail split (replacing the bespoke modal). Lazy-fetches + filters.
function CatalogToolsPanel({ item }: { item: IntegrationCatalogItem }) {
  const [tools, setTools] = useState<CatalogToolItem[] | null>(
    () => _toolsCache.get(item.slug) ?? null
  );
  const [loadingTools, setLoadingTools] = useState(false);
  const [toolSearch, setToolSearch] = useState("");

  useEffect(() => {
    const cached = _toolsCache.get(item.slug);
    if (cached) {
      setTools(cached);
      return;
    }
    let alive = true;
    setLoadingTools(true);
    api.integrations
      .catalogTools(item.slug)
      .then((data) => {
        _toolsCache.set(item.slug, data);
        if (alive) setTools(data);
      })
      .catch(() => {
        if (alive) setTools([]);
      })
      .finally(() => {
        if (alive) setLoadingTools(false);
      });
    return () => {
      alive = false;
    };
  }, [item.slug]);

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

  if (loadingTools) return <LoadingState rows={4} />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      <div className="c-srch" style={{ maxWidth: "none", padding: "8px 11px" }}>
        <Search size={14} />
        <input
          type="search"
          aria-label="Filter actions"
          placeholder="Filter actions…"
          value={toolSearch}
          onChange={(e) => setToolSearch(e.target.value)}
        />
      </div>
      {filteredTools.length > 0 ? (
        <ul style={{ display: "flex", flexDirection: "column", gap: 12, margin: 0, padding: 0, listStyle: "none" }}>
          {filteredTools.map((tool) => (
            <li key={tool.name} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
              <Zap size={14} style={{ marginTop: 2, flexShrink: 0, color: "var(--accent)" }} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 12.5, fontWeight: 500, color: "var(--ink)" }}>{tool.name}</div>
                {tool.description ? (
                  <div style={{ marginTop: 2, fontSize: 12, lineHeight: 1.5, color: "var(--muted-foreground)" }}>
                    {tool.description}
                  </div>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      ) : tools !== null ? (
        <p style={{ padding: "8px 2px", fontSize: 12.5, color: "var(--muted-foreground)" }}>
          {toolSearch ? "No actions match your filter." : "No action details available."}
        </p>
      ) : null}
    </div>
  );
}

// Numbered server pager, styled identically to the global CollectionView pager
// (same chevrons + numbered buttons + range summary). Drives SERVER pages.
function CatalogPager({
  page,
  totalPages,
  rangeFrom,
  rangeTo,
  total,
  onPage,
}: {
  page: number;
  totalPages: number;
  rangeFrom: number;
  rangeTo: number;
  total: number;
  onPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  // Compact window of page buttons around the current page (1-based).
  const windowSize = 7;
  let start = Math.max(1, page - Math.floor(windowSize / 2));
  const end = Math.min(totalPages, start + windowSize - 1);
  start = Math.max(1, end - windowSize + 1);
  const pages = Array.from({ length: end - start + 1 }, (_, i) => start + i);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        marginTop: 16,
        fontSize: 12.5,
        color: "var(--muted-foreground)",
      }}
    >
      <span>
        {rangeFrom}–{rangeTo} of {total.toLocaleString()}
      </span>
      <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(Math.max(1, page - 1))}
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "4px 8px",
            borderRadius: "var(--radius-button)",
            border: "var(--bd-card)",
            background: "var(--bg-2)",
            color: page <= 1 ? "var(--muted-foreground)" : "var(--foreground)",
            opacity: page <= 1 ? 0.4 : 1,
            cursor: page <= 1 ? "default" : "pointer",
            fontSize: 12,
          }}
        >
          <ChevronLeft size={13} />
        </button>
        {pages.map((p) => (
          <button
            key={p}
            type="button"
            aria-label={`Page ${p}`}
            aria-current={p === page ? "page" : undefined}
            onClick={() => onPage(p)}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 28,
              padding: "4px 6px",
              borderRadius: "var(--radius-button)",
              border: "var(--bd-card)",
              background: p === page ? "var(--foreground)" : "var(--bg-2)",
              color: p === page ? "var(--bg-1, var(--background))" : "var(--foreground)",
              fontWeight: p === page ? 600 : 400,
              cursor: "pointer",
              fontSize: 12,
            }}
          >
            {p}
          </button>
        ))}
        <button
          type="button"
          aria-label="Next page"
          disabled={page >= totalPages}
          onClick={() => onPage(Math.min(totalPages, page + 1))}
          style={{
            display: "inline-flex",
            alignItems: "center",
            padding: "4px 8px",
            borderRadius: "var(--radius-button)",
            border: "var(--bd-card)",
            background: "var(--bg-2)",
            color: page >= totalPages ? "var(--muted-foreground)" : "var(--foreground)",
            opacity: page >= totalPages ? 0.4 : 1,
            cursor: page >= totalPages ? "default" : "pointer",
            fontSize: 12,
          }}
        >
          <ChevronRight size={13} />
        </button>
      </div>
    </div>
  );
}

export default function ConnectionsBrowsePage() {
  const router = useRouter();
  const searchParams = useSearchParams();

  // Collection view state (search + active category tag), seeded from the URL so
  // it shares the same q/tags grammar as every other Collection surface.
  const [state, setState] = useState<CollectionState>(() =>
    parseCollectionState(new URLSearchParams(searchParams.toString()), "list")
  );

  const [catalog, setCatalog] = useState<IntegrationCatalogResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [debouncedSearch, setDebouncedSearch] = useState(state.q.trim());
  const [page, setPage] = useState(1);
  const [connecting, setConnecting] = useState<string | null>(null);
  const [connectedSlugs, setConnectedSlugs] = useState<Set<string>>(new Set());

  // The single active category value (TagBar is multi-select, but category is a
  // server filter so we honor only the first active value; "" = All).
  const category = useMemo(
    () => (state.tags[CATEGORY_FAMILY]?.[0] ?? ""),
    [state.tags]
  );

  // Persist view state to the URL (replace; no RSC refetch per keystroke).
  const commitState = useCallback(
    (next: CollectionState) => {
      setState(next);
      const qs = serializeCollectionState(next, "list").toString();
      const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname;
      window.history.replaceState(null, "", url);
    },
    []
  );

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

  // Debounce the shared search box → server query.
  useEffect(() => {
    const timeout = window.setTimeout(() => {
      setDebouncedSearch(state.q.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(timeout);
  }, [state.q]);

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
          POPULAR_APP_SLUGS.has(item.slug.toLowerCase()) &&
          !HIDDEN_CHANNEL_SLUGS.has(item.slug.toLowerCase())
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
        // Filter hidden channels from all catalog results regardless of category.
        const visible = nextCatalog.items.filter(
          (item) => !HIDDEN_CHANNEL_SLUGS.has(item.slug.toLowerCase())
        );
        setCatalog({
          ...nextCatalog,
          items: visible,
          total_items: nextCatalog.total_items - (nextCatalog.items.length - visible.length),
        });
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

  function handleConnect(slug: string) {
    setConnecting(slug);
    router.push(
      `/connections/redirect?app=${encodeURIComponent(slug)}&return_to=${encodeURIComponent("/connections/browse")}`
    );
  }

  const items = catalog?.items ?? [];

  const totalItems = catalog?.total_items ?? 0;
  const totalPages = catalog?.total_pages ?? 1;
  const currentPage = catalog?.page ?? page;
  const rangeFrom = totalItems === 0 ? 0 : (currentPage - 1) * (catalog?.limit ?? PAGE_SIZE) + 1;
  const rangeTo = Math.min(currentPage * (catalog?.limit ?? PAGE_SIZE), totalItems);

  const trimmedSearch = state.q.trim();

  const config: CollectionConfig<IntegrationCatalogItem> = {
    title: "Browse apps",
    subtitle: "Connect the apps your workers need to take action.",
    items,
    loading,
    error: loadError,
    idOf: (i) => i.slug,
    // Real item text for the client filter. Since search is server-driven, the
    // client filter is a harmless consistent subset of the server result.
    searchOf: (i) => `${i.name} ${i.slug} ${i.description ?? ""}`,
    searchPlaceholder: "Search Gmail, Notion, GitHub…",
    // The category is a SERVER filter; report the active category on every loaded
    // item so the client tag filter never hides a server result.
    tagsOf: () => (category ? { [CATEGORY_FAMILY]: [category] } : {}),
    tags: { [CATEGORY_FAMILY]: CATEGORY_OPTIONS },
    view: { default: "list", grid: true },
    // 3 visual columns: App (primary) · Actions count · Connect/Status. The
    // status + menu slots are disabled; the trailing column carries the inline
    // Connect affordance (or the Connected pill). Widths cover all 3 columns.
    columns: {
      template: "1.7fr 96px 140px",
      headers: ["App", "Actions", ""],
      headerTransparent: true,
      statusColumn: false,
      menuColumn: false,
    },
    row: (i) => {
      const isConnected = connectedSlugs.has(i.slug.toLowerCase());
      const isConnecting = connecting === i.slug;
      return {
        leading: <CatalogLogo item={i} />,
        primary: i.name,
        secondary: outcomeText(i),
        cols: [
          i.tools_count > 0 ? (
            <span key="actions" className="c-cell m">
              {i.tools_count} action{i.tools_count !== 1 ? "s" : ""}
            </span>
          ) : (
            <span key="actions" />
          ),
          <span key="connect-wrap" style={{ display: "inline-flex", alignItems: "center", gap: 8, justifyContent: "flex-end", width: "100%" }}>
            {isConnected ? (
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11.5, fontWeight: 500, color: "var(--positive)", whiteSpace: "nowrap" }}>
                <CheckCircle2 size={12} />
                Connected
              </span>
            ) : (
              <button
                type="button"
                className="c-addbtn"
                style={{ padding: "5px 11px", fontSize: 12, whiteSpace: "nowrap" }}
                disabled={isConnecting}
                // stopPropagation so Connect never also opens the detail (Tools) pane.
                onClick={(e) => {
                  e.stopPropagation();
                  handleConnect(i.slug);
                }}
              >
                {isConnecting ? <Loader2 className="animate-spin" size={12} /> : <ExternalLink size={12} />}
                {isConnecting ? "Opening…" : "Connect"}
              </button>
            )}
          </span>,
        ],
      };
    },
    card: (i) => {
      const isConnected = connectedSlugs.has(i.slug.toLowerCase());
      return {
        leading: <CatalogLogo item={i} />,
        name: i.name,
        description: outcomeText(i),
        status: isConnected ? { tone: "ok", label: "Connected" } : null,
        meta: i.tools_count > 0 ? `${i.tools_count} action${i.tools_count !== 1 ? "s" : ""}` : undefined,
      };
    },
    detail: (i) => {
      const isConnected = connectedSlugs.has(i.slug.toLowerCase());
      const isConnecting = connecting === i.slug;
      const actions = (
        <button
          type="button"
          className="c-addbtn"
          style={{ padding: "6px 12px", fontSize: 12.5 }}
          disabled={isConnecting}
          onClick={() => handleConnect(i.slug)}
        >
          {isConnecting ? (
            <Loader2 className="animate-spin" size={13} />
          ) : isConnected ? (
            <Plus size={13} />
          ) : (
            <ExternalLink size={13} />
          )}
          {isConnecting ? "Opening…" : isConnected ? "Add account" : "Connect"}
        </button>
      );
      return {
        header: {
          leading: <CatalogLogo item={i} />,
          title: i.name,
          actions,
          sub: (
            <>
              {isConnected ? (
                <span className="c-vpill" style={{ display: "inline-flex", alignItems: "center", gap: 4, color: "var(--positive)" }}>
                  <CheckCircle2 size={11} />
                  Connected
                </span>
              ) : null}
              <span className="c-dh-sub" style={{ margin: 0 }}>
                {i.tools_count} action{i.tools_count !== 1 ? "s" : ""} available
              </span>
            </>
          ),
        },
        tabs: [
          {
            key: "Actions",
            label: "Actions",
            count: i.tools_count || undefined,
            render: () => <CatalogToolsPanel item={i} />,
          },
        ],
      };
    },
    states: {
      empty: {
        title: "No integrations found",
        help: "Clear filters or try a broader search.",
        icon: Search,
        action:
          trimmedSearch.length > 0 ? (
            <div style={{ marginTop: 4, display: "inline-flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
              <p style={{ margin: 0, fontSize: 12, color: "var(--muted-foreground)" }}>
                Does {trimmedSearch} expose an API key? Add it as a secret and any worker can use it.
              </p>
              <Link
                href={`/connections/secrets?prefill=${encodeURIComponent(trimmedSearch.toUpperCase().replace(/[^A-Z0-9_]+/g, "_") + "_API_KEY")}`}
                className="c-addbtn"
                style={{ padding: "6px 12px", fontSize: 12.5 }}
              >
                Add {trimmedSearch} as a secret
              </Link>
            </div>
          ) : undefined,
      },
      errorRetry: () => void loadCatalog(),
    },
    // Server pager — the catalog is server-paginated (1,046 apps), so the global
    // CollectionView client pager can't drive it. Render the global-styled
    // numbered pager here, wired to server pages. (Loaded page ≤ 30 ≤ the
    // CollectionView LIST_PAGE_SIZE window, so the internal pager never fires.)
    footer: (
      <CatalogPager
        page={currentPage}
        totalPages={totalPages}
        rangeFrom={rangeFrom}
        rangeTo={rangeTo}
        total={totalItems}
        onPage={(p) => setPage(p)}
      />
    ),
  };

  return (
    <CollectionView
      config={config}
      state={state}
      onChange={(next) => {
        // A category tag change resets to page 1 (new server filter set).
        const nextCategory = next.tags[CATEGORY_FAMILY]?.[0] ?? "";
        if (nextCategory !== category) setPage(1);
        commitState(next);
      }}
    />
  );
}
