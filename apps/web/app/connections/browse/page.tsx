/* eslint-disable @next/next/no-img-element */
"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import {
  CheckCircle2,
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
import type { CatalogToolItem, IntegrationCatalogItem } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { ConnectionsTabs } from "@/components/connections/ConnectionsTabs";

// ---------------------------------------------------------------------------
// Category mapping — maps Composio category slugs to friendly UI labels.
// Used to build the "content" tag family in the collection config.
// ---------------------------------------------------------------------------

const CATEGORY_LABEL_MAP: Record<string, string> = {
  productivity: "Productivity",
  notes: "Productivity",
  documents: "Productivity",
  "project-management": "Productivity",
  "task-management": "Productivity",
  calendar: "Productivity",
  email: "Email",
  communication: "Email",
  crm: "CRM",
  "contact-management": "CRM",
  "social-media-accounts": "Social",
  "social-media-marketing": "Social",
  marketing: "Marketing",
  "marketing-automation": "Marketing",
  databases: "Data",
  spreadsheets: "Data",
  analytics: "Data",
  "team-chat": "Collaboration",
  "team-collaboration": "Collaboration",
  "video-conferencing": "Collaboration",
};

function friendlyCategory(slug: string): string | null {
  return CATEGORY_LABEL_MAP[slug.toLowerCase()] ?? null;
}

// Curated popular slugs.
const POPULAR_APP_SLUGS = new Set([
  "gmail", "slack", "notion", "github", "googlecalendar",
  "hubspot", "linear", "googlesheets", "salesforce", "discord",
  "linkedin", "stripe", "googledrive", "airtable", "jira", "dropbox",
]);

// Outcome-oriented copy.
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

// Module-level tools cache shared across modal instances.
const _toolsCache: Map<string, CatalogToolItem[]> = new Map();
// ---------------------------------------------------------------------------
// ToolsModal
// ---------------------------------------------------------------------------

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
    if (cached) { setTools(cached); return; }
    setLoadingTools(true);
    api.integrations
      .catalogTools(item.slug)
      .then((data) => { _toolsCache.set(item.slug, data); setTools(data); })
      .catch(() => setTools([]))
      .finally(() => setLoadingTools(false));
  }, [open, item.slug]);

  useEffect(() => { if (!open) setToolSearch(""); }, [open]);

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
        <DialogHeader className="flex-row items-center gap-3 [border-bottom:var(--bd-div)] px-4 py-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-ui)] bg-[var(--bg-2)]">
            <img              src={item.logo_url}
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

        <div className="[border-bottom:var(--bd-div)] px-4 py-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <input
              type="text"
              value={toolSearch}
              onChange={(e) => setToolSearch(e.target.value)}
              placeholder="Filter actions..."
              className="h-8 w-full rounded-[var(--radius-ui)] bg-[var(--bg-2)] pl-8 pr-3 text-xs text-ink placeholder:text-muted-foreground focus:outline-none"
            />            {toolSearch ? (
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

        <DialogFooter className="[border-top:var(--bd-div)] px-4 py-3" showCloseButton={false}>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={connecting}
            onClick={() => { onClose(); onConnect(item.slug); }}
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

// ---------------------------------------------------------------------------
// Row logo
// ---------------------------------------------------------------------------

function CatalogLogo({ item }: { item: IntegrationCatalogItem }) {
  return (
    <span className="c-logo">
      <img
        src={item.logo_url}
        alt={`${item.name} logo`}
        className="h-5 w-5 object-contain"
        loading="lazy"
        decoding="async"
      />
    </span>  );
}

// ---------------------------------------------------------------------------
// Detail panel body — actions count + "What can it do?" expandable tools list
// ---------------------------------------------------------------------------

function CatalogDetail({
  item,
  onConnect,
  connecting,
}: {
  item: IntegrationCatalogItem;
  onConnect: (slug: string) => void;
  connecting: boolean;
}) {
  const [modalOpen, setModalOpen] = useState(false);

  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm text-muted-foreground">{outcomeText(item)}</p>

      {item.tools_count > 0 ? (
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="self-start text-xs text-muted-foreground transition-colors hover:text-[var(--accent)]"
        >
          {item.tools_count} actions available →
        </button>
      ) : null}
      {modalOpen ? (
        <ToolsModal
          item={item}
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          onConnect={onConnect}
          connecting={connecting}
        />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ConnectionsBrowsePage() {
  const router = useRouter();
  const [items, setItems] = useState<IntegrationCatalogItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [connectedSlugs, setConnectedSlugs] = useState<Set<string>>(new Set());
  const [connecting, setConnecting] = useState<string | null>(null);

  // Load the catalog (large batch, client-side search via Collection).
  useEffect(() => {
    let alive = true;
    Promise.allSettled([
      api.integrations.catalog({ page: 1, limit: 200, search: "", category: "" }),
      api.connections.list(),
    ]).then(([catalogRes, connRes]) => {
      if (!alive) return;
      if (catalogRes.status === "fulfilled") {
        setItems(catalogRes.value.items);
      } else {
        toast.error("Could not load integrations.");
      }
      if (connRes.status === "fulfilled") {
        const active = new Set(
          connRes.value
            .filter((c) => c.status === "active")
            .map((c) => (c.app_name ?? "").toLowerCase())
        );
        setConnectedSlugs(active);
      }
      setLoading(false);
    });
    return () => { alive = false; };
  }, []);

  // Unique friendly category labels for the tag bar.
  const categoryOptions = useMemo(() => {
    const seen = new Set<string>();
    for (const item of items) {
      for (const cat of item.categories ?? []) {
        const label = friendlyCategory(cat);
        if (label) seen.add(label);
      }
    }
    return Array.from(seen).sort().map((label) => ({ value: label, label }));
  }, [items]);

  function handleConnect(slug: string) {
    setConnecting(slug);
    router.push(
      `/connections/redirect?app=${encodeURIComponent(slug)}&return_to=${encodeURIComponent("/connections/browse")}`
    );
  }

  const config: CollectionConfig<IntegrationCatalogItem> = {
    title: "Browse integrations",
    subtitle: "Connect the apps your workers need to take action.",
    items,
    loading,
    idOf: (i) => i.slug,
    searchPlaceholder: "Search Gmail, Slack, Notion…",
    searchOf: (i) => `${i.name} ${i.description ?? ""} ${(i.categories ?? []).join(" ")}`,
    tagsOf: (i) => {
      const categoryLabels = Array.from(
        new Set(
          (i.categories ?? [])
            .map(friendlyCategory)
            .filter((l): l is string => l !== null)
        )
      );
      return {
        smart: POPULAR_APP_SLUGS.has(i.slug.toLowerCase()) ? ["popular"] : [],
        content: categoryLabels,
      } as Partial<Record<TagFamilyKey, string[]>>;
    },
    tags: {
      smart: [{ value: "popular", label: "Popular" }],
      ...(categoryOptions.length > 0 ? { content: categoryOptions } : {}),
    },
    counts: [
      { value: items.length, label: "integrations" },
      { value: connectedSlugs.size, label: "connected" },
    ],
    view: { default: "list" },
    columns: {
      template: "1.8fr 1fr 120px 40px",
      headers: ["Integration", "Category", "Status", ""],
    },
    row: (i) => {
      const isConnected = connectedSlugs.has(i.slug.toLowerCase());
      const categoryLabel =
        (i.categories ?? []).map(friendlyCategory).find((l): l is string => l !== null) ?? "";
      return {
        leading: <CatalogLogo item={i} />,
        primary: i.name,
        secondary: outcomeText(i),
        cols: [
          <span key="cat" className="text-xs text-muted-foreground">{categoryLabel}</span>,
          isConnected ? (
            <span key="s" className="flex items-center gap-1 text-xs font-medium text-green-600">
              <CheckCircle2 className="h-3.5 w-3.5" /> Connected
            </span>
          ) : null,
        ],
        menu: [
          {
            label: isConnected ? "Add account" : "Connect",
            onSelect: () => handleConnect(i.slug),
          },
        ],
      };
    },
    card: (i) => {
      const isConnected = connectedSlugs.has(i.slug.toLowerCase());
      return {
        leading: <CatalogLogo item={i} />,
        name: i.name,
        description: outcomeText(i),
        status: isConnected
          ? { tone: "ok" as const, label: "Connected" }
          : null,
      };
    },
    detail: (i) => {
      const isConnected = connectedSlugs.has(i.slug.toLowerCase());
      const isConnecting = connecting === i.slug;
      const actions = isConnected ? (
        <>
          <span className="flex items-center gap-1 text-xs font-medium text-green-600">
            <CheckCircle2 className="h-3.5 w-3.5" /> Connected
          </span>          <button
            type="button"
            className="c-addbtn"
            style={{ padding: "6px 11px", fontSize: 12.5 }}
            disabled={isConnecting}
            onClick={() => handleConnect(i.slug)}
          >
            {isConnecting ? <Loader2 className="h-3 w-3 animate-spin inline-block mr-1" /> : <Plus className="h-3 w-3 inline-block mr-1" />}
            Add account
          </button>
        </>      ) : (
        <button
          type="button"
          className="c-addbtn"
          style={{ padding: "6px 11px", fontSize: 12.5 }}
          disabled={isConnecting}
          onClick={() => handleConnect(i.slug)}
        >
          {isConnecting ? "Opening…" : "Connect"}
        </button>
      );
      return {
        header: {
          leading: <CatalogLogo item={i} />,
          title: i.name,
          actions,
          sub: (
            <>
              {(i.categories ?? [])
                .map(friendlyCategory)
                .filter((l): l is string => l !== null)
                .filter((l, idx, arr) => arr.indexOf(l) === idx)
                .map((label) => (
                  <span key={label} className="c-vpill">{label}</span>
                ))}
              {isConnected && (
                <span className="c-vpill" style={{ color: "var(--green, #16a34a)" }}>
                  Connected
                </span>
              )}
            </>
          ),
        },
        tabs: [
          {
            key: "Overview",
            label: "Overview",
            render: () => (
              <CatalogDetail
                item={i}
                onConnect={handleConnect}
                connecting={isConnecting}
              />
            ),
          },
        ],
      };
    },
    states: {
      empty: {
        title: "No integrations found",
        help: "Clear filters or try a broader search.",
      },
    },
  };

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <ConnectionsTabs />
      <Collection config={config} />
    </div>
  );
}
