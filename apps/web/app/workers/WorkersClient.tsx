"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Box, ChevronDown, ChevronRight, Folder, Globe, Lock, Plus, Search, Star, Archive, LayoutGrid, Clock, Users,
  FileText, Mail, BarChart2,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouter, useSearchParams } from "next/navigation";
import type { WorkerSummary } from "@/lib/types";
import { formatRelativeTime } from "@/components/connections/connection-data";
import { WorkerIconPills } from "@/components/WorkerIconPills";
import { ShareWorkerButton } from "@/components/ShareWorkerButton";
import { PromptText } from "@/components/PromptText";
import { sortWorkersByRecentActivity } from "@/lib/worker-list-order";

const LS_KEY_FAVORITES = "workeros:favorites";

// Worker Author is the engine behind /workers/new (manifest system_worker:true),
// not an employee, so it must never appear in the Workers list. The API already
// excludes system_worker:true from the default /workers view; this is a
// defensive display filter so a system/internal worker can never leak into the
// list (e.g. from a DB-sourced row that bypassed the API filter).
//
// Primary signal is the `system` flag on the payload (added 2026-06-02). The
// hardcoded id is a stopgap fallback for any worker whose payload predates the
// flag. Worker Author stays fully FUNCTIONAL — this hides it from the list only.
// (Codex: if a payload ever lacks `system`, that worker.yml is missing
// system_worker:true upstream; the id fallback covers worker-author specifically.)
const SYSTEM_WORKER_ID_FALLBACK = new Set(["worker-author"]);

function isSystemWorker(w: WorkerSummary): boolean {
  return w.system === true || SYSTEM_WORKER_ID_FALLBACK.has(w.id);
}

type WorkersTab = "all" | "starred" | "recent" | "archived";
const TAB_KEYS: WorkersTab[] = ["all", "starred", "recent", "archived"];
function isValidTab(value: string | null): value is WorkersTab {
  return value !== null && TAB_KEYS.includes(value as WorkersTab);
}

function getFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY_FAVORITES);
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}

function saveFavorites(favs: Set<string>) {
  try {
    localStorage.setItem(LS_KEY_FAVORITES, JSON.stringify(Array.from(favs)));
  } catch {}
}

export default function WorkersClient({ initialWorkers }: { initialWorkers: WorkerSummary[] }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  // S44: start with server-fetched data — no loading flash for the initial render.
  // Strip system/engine workers (e.g. Worker Author) at every ingestion point so
  // they never reach the list, folder counts, or empty-state logic.
  const [workers, setWorkers] = useState<WorkerSummary[]>(() =>
    initialWorkers.filter((w) => !isSystemWorker(w))
  );
  const [archivedWorkers, setArchivedWorkers] = useState<WorkerSummary[]>([]);
  // Only show a loading state if initialWorkers is empty AND we're re-fetching
  const [loading, setLoading] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => getFavorites());

  // Shared/Private section collapse state (both open by default)
  const [sharedCollapsed, setSharedCollapsed] = useState(false);
  const [privateCollapsed, setPrivateCollapsed] = useState(false);

  // S28: tabs (All/Starred/Recent) live in URL hash.
  const initialTab =
    (typeof window !== "undefined" && window.location.hash.replace(/^#/, "")) ||
    searchParams.get("tab");
  const [tab, setTab] = useState<WorkersTab>(isValidTab(initialTab) ? initialTab : "all");
  const folderFilter = searchParams.get("folder");
  const [search, setSearch] = useState("");

  // S44: update workers when initialWorkers changes (e.g. after RSC revalidation).
  useEffect(() => {
    if (initialWorkers.length > 0) {
      setWorkers(initialWorkers.filter((w) => !isSystemWorker(w)));
    }
  }, [initialWorkers]);

  // On mount, reconcile the list with a fresh client fetch.
  // - When RSC delivered data, the App Router client cache can hand back a stale
  //   payload after navigating back from a mutation (e.g. delete), so the All
  //   list briefly shows a ghost of the deleted worker. A mount refetch drops it
  //   without weakening the deliberate 30s RSC cache used for the no-flash render.
  // - When RSC delivered empty (API unavailable), this is the only fetch, so show
  //   a loading state.
  useEffect(() => {
    const cameWithoutData = initialWorkers.length === 0;
    if (cameWithoutData) setLoading(true);
    let cancelled = false;
    api.workers
      .list()
      .then((w) => {
        if (!cancelled) setWorkers(w.filter((x) => !isSystemWorker(x)));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled && cameWithoutData) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Refetch archived workers every time the Archived tab is entered.
  // Previously this was guarded by `archivedWorkers.length === 0`, which only
  // ever fetched once per mount — so a worker archived from its detail page
  // (then routed back here) never showed up while any archived workers were
  // already cached, leaving the tab stuck on a stale "No archived workers".
  // The archived list is small, so an unconditional refetch on tab-enter is the
  // smallest correct fix; the cancelled flag drops a stale in-flight response.
  useEffect(() => {
    if (tab !== "archived") return;
    let cancelled = false;
    setLoadingArchived(true);
    api.workers
      .list({ include_archived: true })
      .then((all) => {
        if (!cancelled)
          setArchivedWorkers(all.filter((w) => w.archived && !isSystemWorker(w)));
      })
      .catch(() => {})
      .finally(() => {
        if (!cancelled) setLoadingArchived(false);
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      saveFavorites(next);
      return next;
    });
  }, []);

  function handleTabChange(value: string) {
    if (!isValidTab(value)) return;
    setTab(value);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("tab");
    const qs = params.size ? `?${params.toString()}` : "";
    const hash = value === "all" ? "" : `#${value}`;
    router.replace(`/workers${qs}${hash}`, { scroll: false });
  }

  function setFolder(path: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (path) params.set("folder", path);
    else params.delete("folder");
    router.replace(`/workers${params.size ? `?${params.toString()}` : ""}`, {
      scroll: false,
    });
  }

  // Folder hierarchy at the current path
  const subFolders = useMemo(() => {
    const all = flattenFolders(workers);
    if (!folderFilter) {
      const tops = new Set<string>();
      const result: { path: string; label: string; count: number }[] = [];
      for (const f of all) {
        const top = f.path.split("/")[0];
        if (tops.has(top)) continue;
        tops.add(top);
        const count = workers.filter((w) =>
          (w.folder || "").split("/")[0] === top
        ).length;
        result.push({ path: top, label: top, count });
      }
      return result;
    }
    const depth = folderFilter.split("/").length;
    const children = new Map<string, number>();
    for (const w of workers) {
      const parts = (w.folder || "").split("/").filter(Boolean);
      if (parts.length <= depth) continue;
      if (parts.slice(0, depth).join("/") !== folderFilter) continue;
      const child = parts.slice(0, depth + 1).join("/");
      children.set(child, (children.get(child) ?? 0) + 1);
    }
    return Array.from(children.entries()).map(([path, count]) => ({
      path,
      label: path.split("/").slice(-1)[0],
      count,
    }));
  }, [workers, folderFilter]);

  const breadcrumbs = useMemo(() => {
    const parts = (folderFilter || "").split("/").filter(Boolean);
    return parts.map((label, i) => ({
      label,
      path: parts.slice(0, i + 1).join("/"),
    }));
  }, [folderFilter]);

  const searchLower = search.trim().toLowerCase();

  const displayedWorkers = useMemo(() => {
    if (tab === "archived") {
      let pool = archivedWorkers;
      if (searchLower) {
        pool = pool.filter((w) => {
          const blob = [w.name, w.description || "", ...(w.tags || []), w.archive_reason || ""]
            .join(" ")
            .toLowerCase();
          return blob.includes(searchLower);
        });
      }
      return pool;
    }
    let pool = tab === "all" ? sortWorkersByRecentActivity(workers) : workers;
    if (tab === "starred") {
      pool = sortWorkersByRecentActivity(pool.filter((w) => favorites.has(w.id)));
    } else if (tab === "recent") {
      pool = sortWorkersByRecentActivity(pool)
        .filter((w) => w.recent_stats?.last_run_at || w.created_at || w.updated_at)
        .slice(0, 10);
    } else if (folderFilter) {
      pool = pool.filter(
        (w) =>
          w.folder === folderFilter ||
          (w.folder || "").startsWith(`${folderFilter}/`)
      );
    }
    if (searchLower) {
      // Tag matching is folded into the search box (Federico 2026-05-29): the
      // blob includes the worker's tags, so typing a tag name filters by tag —
      // no standing tag-chip wall needed.
      pool = pool.filter((w) => {
        const blob = [
          w.name,
          w.description || "",
          ...(w.tags || []),
          w.folder || "",
        ]
          .join(" ")
          .toLowerCase();
        return blob.includes(searchLower);
      });
    }
    return pool;
  }, [workers, archivedWorkers, tab, folderFilter, favorites, searchLower]);

  // Show Shared / Private sections when:
  //   - on the All or Starred tab (Recent and Archived don't need grouping)
  //   - no active search or folder drill-in (sections add noise when filtered)
  //   - at least one shared worker exists (a lone "Private" heading is pointless)
  const splitSections =
    (tab === "all" || tab === "starred") &&
    !searchLower &&
    !folderFilter &&
    displayedWorkers.some((w) => w.visibility === "workspace");

  const sharedWorkers = splitSections
    ? displayedWorkers.filter((w) => w.visibility === "workspace")
    : [];
  const privateWorkers = splitSections
    ? displayedWorkers.filter((w) => w.visibility !== "workspace")
    : [];

  // R5: one combined breadcrumb + folder-chip row. Render whenever we're on
  // the All tab (no search/tag) and there is either a drill-in path or
  // folders to show — so selecting a folder swaps content within the same
  // row instead of opening a new one.
  const showFolderNav =
    tab === "all" &&
    !searchLower &&
    (breadcrumbs.length > 0 || subFolders.length > 0);
  const isArchivedTab = tab === "archived";

  // ESC key ladder (Federico 2026-05-29). Scoped to the page; bails entirely
  // when a modal dialog (e.g. the Cmd-K palette) is open so its own ESC-to-close
  // is never hijacked. Order:
  //   1. dialog open  → no-op here (the dialog handles ESC).
  //   2. search has text or is focused → clear + blur the search.
  //   3. a non-default filter (folder, or tab != all) → reset to All / no folder.
  //   4. nothing active → no-op (must NOT navigate away).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;

      // 1. A modal dialog is open (Cmd-K palette, etc.) — let it own ESC.
      if (document.querySelector('[role="dialog"]')) return;

      const active = document.activeElement;
      const searchEl = document.querySelector<HTMLInputElement>(
        "input[data-workers-search]"
      );
      const searchHasText = search.trim().length > 0;
      const searchFocused = active === searchEl && searchEl !== null;

      // 2. Search has text or is focused → clear + blur.
      if (searchHasText || searchFocused) {
        event.preventDefault();
        setSearch("");
        searchEl?.blur();
        return;
      }

      // Never hijack ESC inside another editable field/textarea.
      if (
        active instanceof HTMLElement &&
        (active.tagName === "INPUT" ||
          active.tagName === "TEXTAREA" ||
          active.isContentEditable)
      ) {
        return;
      }

      // 3. A non-default filter is active → reset to All / no folder.
      if (folderFilter || tab !== "all") {
        event.preventDefault();
        setFolder(null);
        if (tab !== "all") handleTabChange("all");
        return;
      }

      // 4. Nothing active → no-op (do NOT navigate away / go back).
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, folderFilter, tab]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Your AI workers.
          </p>
        </div>
      </div>

      {/* Tab bar + search — always visible so the user can switch tabs even
          when the active workers list is empty (e.g. all workers archived). */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-sm flex-1">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <Input
            data-workers-search
            placeholder="Search workers or tags..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        {/* V9 (Federico 2026-06-02): icon-only filter tabs. */}
        <Tabs value={tab} onValueChange={handleTabChange}>
          <TabsList>
            <TabsTrigger value="all" aria-label="All workers" title="All">
              <LayoutGrid />
            </TabsTrigger>
            <TabsTrigger value="starred" aria-label="Starred workers" title="Starred">
              <Star />
            </TabsTrigger>
            <TabsTrigger value="recent" aria-label="Recent workers" title="Recent">
              <Clock />
            </TabsTrigger>
            <TabsTrigger value="archived" aria-label="Archived workers" title="Archived">
              <Archive />
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {!loading && workers.length === 0 && tab !== "archived" ? (
        <EmptyWorkersState />
      ) : (
        <div className="space-y-5">
          {/* R5: breadcrumb + folder chips share ONE wrapping row so
              selecting a folder never opens a second row / pushes content
              down. The block renders whenever there are folders to show or
              a drill-in path is active, on the All tab without search/tag. */}
          {showFolderNav && (
            <div className="flex items-center gap-1.5 flex-wrap min-h-7">
              {breadcrumbs.length > 0 ? (
                <span className="flex items-center gap-1 text-sm text-muted-foreground mr-1">
                  <button
                    type="button"
                    onClick={() => setFolder(null)}
                    className="hover:text-foreground transition-colors"
                  >
                    Workers
                  </button>
                  {breadcrumbs.map((bc) => (
                    <span key={bc.path} className="flex items-center gap-1">
                      <ChevronRight className="size-3.5" />
                      <button
                        type="button"
                        onClick={() => setFolder(bc.path)}
                        className="hover:text-foreground transition-colors"
                      >
                        {bc.label}
                      </button>
                    </span>
                  ))}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground mr-1">Folders:</span>
              )}
              {subFolders.map(({ path, label, count }) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => setFolder(path)}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card px-2.5 py-0.5 text-xs font-normal text-muted-foreground hover:text-foreground hover:border-muted-foreground/40 transition-colors"
                >
                  <Folder className="size-3" />
                  {label}
                  <span className="text-muted-foreground/60">{count}</span>
                </button>
              ))}
            </div>
          )}

          {/* Grid — flat or split into Shared / Private sections. */}
          {(loading || (isArchivedTab && loadingArchived)) ? (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {Array.from({ length: 8 }).map((_, i) => (
                <WorkerCardSkeleton key={i} />
              ))}
            </div>
          ) : splitSections ? (
            <div className="space-y-6">
              <WorkerSection
                label="Shared"
                icon={Globe}
                workers={sharedWorkers}
                collapsed={sharedCollapsed}
                onToggle={() => setSharedCollapsed((c) => !c)}
                favorites={favorites}
                onFavoriteToggle={toggleFavorite}
              />
              {privateWorkers.length > 0 && (
                <WorkerSection
                  label="Private"
                  icon={Lock}
                  workers={privateWorkers}
                  collapsed={privateCollapsed}
                  onToggle={() => setPrivateCollapsed((c) => !c)}
                  favorites={favorites}
                  onFavoriteToggle={toggleFavorite}
                />
              )}
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {displayedWorkers.map((w) => (
                <WorkerCard
                  key={w.id}
                  worker={w}
                  isFavorite={favorites.has(w.id)}
                  onFavoriteToggle={toggleFavorite}
                />
              ))}
            </div>
          )}

          {!loading && !loadingArchived && displayedWorkers.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {tab === "starred"
                ? "Nothing starred yet. Click the star on any worker card to pin it here."
                : tab === "recent"
                ? "No recent workers yet."
                : tab === "archived"
                ? "No archived workers."
                : searchLower
                ? `No workers match "${search}".`
                : "No workers in this folder."}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: flatten folder tree
// ---------------------------------------------------------------------------

interface FlatFolder {
  path: string;
  label: string;
  count: number;
}

function flattenFolders(workers: WorkerSummary[]): FlatFolder[] {
  const countByPath = new Map<string, number>();

  for (const worker of workers) {
    if (!worker.folder) continue;
    const parts = worker.folder.split("/").filter(Boolean);
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      countByPath.set(path, (countByPath.get(path) ?? 0) + 1);
    }
  }

  if (countByPath.size === 0) return [];

  const distinctFolders = Array.from(
    new Set(workers.map((w) => w.folder).filter(Boolean) as string[])
  ).sort();

  return distinctFolders.map((path) => ({
    path,
    label: path,
    count: countByPath.get(path) ?? 0,
  }));
}

// ---------------------------------------------------------------------------
// EmptyWorkersState
// ---------------------------------------------------------------------------

function EmptyWorkersState() {
  const templates = [
    { id: "research_brief", title: "Research brief", description: "Markdown brief from a topic, audience, and depth.", Icon: FileText },
    { id: "gmail_intake_brief", title: "Gmail triage", description: "Unread Gmail summary with next actions.", Icon: Mail },
    { id: "csv_enricher", title: "CSV enricher", description: "Spreadsheet enrichment with structured output.", Icon: BarChart2 },
  ];

  const examples = [
    "Summarise my Granola meetings, post action items to HubSpot, daily",
    "Every morning at 9am, send me a digest of my GitHub PRs",
    "When a new HubSpot deal lands, post a summary to Slack #sales",
  ];

  return (
    <Card className="overflow-hidden">
      <CardContent className="p-8 sm:p-12 space-y-8">
        <div className="max-w-xl">
          <div className="inline-flex items-center justify-center size-12 rounded-xl bg-[var(--accent-soft)] mb-4">
            <Box className="size-6 text-[var(--accent)]" />
          </div>
          <h2 className="text-2xl font-semibold tracking-tight">
            No workers yet. Spin one up.
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            A worker is a small AI agent (or plain script) that runs on a schedule,
            a webhook, or on demand. Describe what you want, or start from one of
            the examples below.
          </p>
        </div>

        <div className="space-y-3">
          <Link href="/workers/new">
            <Button size="default" className="gap-2">
              <Plus className="size-4" />
              Describe a new worker
            </Button>
          </Link>
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3">
            Or start from a template
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {templates.map((t) => (
              <Link
                key={t.id}
                href={`/workers/new?template=${t.id}`}
                className="group block rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] hover:bg-[var(--active-nav-bg)] transition-colors p-4"
              >
                <div className="mb-2" aria-hidden>
                  <t.Icon className="size-6 text-[var(--ink-soft)]" />
                </div>
                <p className="text-sm font-medium">{t.title}</p>
                <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                  {t.description}
                </p>
              </Link>
            ))}
          </div>
        </div>

        <div>
          <p className="text-xs font-medium text-muted-foreground mb-3">
            Example prompts
          </p>
          <ul className="space-y-1.5">
            {examples.map((ex, i) => (
              <li key={i}>
                <Link
                  href={`/workers/new?prompt=${encodeURIComponent(ex)}`}
                  className="block rounded-[var(--radius-button)] px-3 py-2 text-sm hover:bg-muted transition-colors text-muted-foreground hover:text-foreground"
                >
                  &quot;<PromptText>{ex}</PromptText>&quot;
                </Link>
              </li>
            ))}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// WorkerSection — collapsible Shared / Private group header + grid
// ---------------------------------------------------------------------------

function WorkerSection({
  label,
  icon: Icon,
  workers,
  collapsed,
  onToggle,
  favorites,
  onFavoriteToggle,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  workers: WorkerSummary[];
  collapsed: boolean;
  onToggle: () => void;
  favorites: Set<string>;
  onFavoriteToggle: (id: string) => void;
}) {
  return (
    <div className="space-y-3">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors select-none"
      >
        <Icon className="size-3.5" />
        <span>{label}</span>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] font-normal tabular-nums leading-none">
          {workers.length}
        </span>
        <ChevronDown
          className={`size-3.5 transition-transform duration-150 ${collapsed ? "-rotate-90" : ""}`}
        />
      </button>
      {!collapsed && (
        workers.length > 0 ? (
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {workers.map((w) => (
              <WorkerCard
                key={w.id}
                worker={w}
                isFavorite={favorites.has(w.id)}
                onFavoriteToggle={onFavoriteToggle}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            No {label.toLowerCase()} workers.
          </p>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// WorkerCard
// ---------------------------------------------------------------------------

// Fixed card height — every card is the same height so the grid reads as a
// clean, scannable matrix. Hover is a subtle lift only (shadow), never a
// size jump (Federico 2026-05-29).
const CARD_HEIGHT = "h-[188px]";

// U4 (Federico 2026-05-31): Langdock-style card. A distinct tinted HEADER BAND
// (--bg-2) at the top holds the composed icon strip + the favourite star; the
// white card body (--bg-card) below holds title / description / footer. The
// band reads as a separate surface from the body, like a Langdock workflow
// card. Typography is dialled to a compact Langdock scale: title 14px,
// description 12.5px (text-[13px] leading-snug), footer/meta 11px.
function WorkerCard({
  worker,
  isFavorite,
  onFavoriteToggle,
}: {
  worker: WorkerSummary;
  isFavorite: boolean;
  onFavoriteToggle: (id: string) => void;
}) {
  const hoverDescription = firstLine(worker.long_description);
  const stats = worker.recent_stats;
  const description =
    worker.archived && worker.archive_reason
      ? worker.archive_reason
      : worker.description || "No description.";

  return (
    <Card
      className={`group ${CARD_HEIGHT} gap-0 py-0 hover:shadow-sm transition-shadow overflow-hidden`}
      title={hoverDescription || undefined}
    >
      <Link href={`/workers/${worker.id}`} className="flex h-full flex-col">
        {/* HEADER BAND — distinct tinted top surface (Langdock). Holds the
            composed icon strip (U3: all the worker's tool/connection/category
            glyphs, capped at 5 then +N) and the favourite star. Top corners
            follow the card radius; a hairline separates it from the body. */}
        <div className="flex items-center justify-between gap-2 rounded-t-[var(--radius-card)] border-b border-[var(--border-default)] bg-[color-mix(in_srgb,var(--foreground)_7%,var(--bg-card))] px-3.5 py-2.5">
          {worker.archived ? (
            <span
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] border border-border bg-card/60 px-2 py-1 text-[11px] text-muted-foreground"
              title="Archived"
            >
              <Archive className="size-3" />
              Archived
            </span>
          ) : (
            // U3: render the full available icon set (primary category/brand
            // glyph + trigger glyph + ALL connection logos), capped at 5 cells
            // then a +N overflow chip — the same composed strip the detail
            // header shows.
            <WorkerIconPills
              worker={worker}
              inputs={worker.inputs ?? []}
              connections={worker.connections}
              triggerType={worker.trigger_type}
              size="sm"
              max={8}
            />
          )}
          {!worker.archived && (
            <div className="flex items-center gap-0.5 shrink-0">
              {/* Visibility indicator — only shown when SHARED (private is the
                  quiet default, so showing it on every card would be noise). */}
              {worker.visibility === "workspace" && (
                <span className="mr-1 inline-flex items-center gap-1 text-[10px] font-normal leading-none text-[var(--ink-mute)]">
                  <Users className="size-3" />
                  Shared
                </span>
              )}
              {/* Share — hover-only, mirrors the favourite star treatment. */}
              <span className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
                <ShareWorkerButton workerId={worker.id} workerName={worker.name} variant="icon" />
              </span>
              {/* Favourite star (Federico 2026-05-30): hover-only to cut cognitive
                  load — except an already-favourited worker keeps its filled star
                  at rest. focus-visible keeps it reachable for keyboard users. */}
              <button
                type="button"
                title={isFavorite ? "Remove from favourites" : "Add to favourites"}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onFavoriteToggle(worker.id);
                }}
                className={`-my-1.5 -mr-1.5 flex size-9 shrink-0 items-center justify-center rounded transition-[color,opacity] focus-visible:opacity-100 sm:my-0 sm:-mr-1 sm:size-6 ${
                  isFavorite
                    ? "text-[var(--accent)] hover:opacity-80"
                    : "text-muted-foreground/40 opacity-0 group-hover:opacity-100 hover:text-[var(--accent)]"
                }`}
              >
                <Star className={`size-3.5 ${isFavorite ? "fill-current" : ""}`} />
              </button>
            </div>
          )}
        </div>

        {/* BODY — white card surface with title / description / footer. */}
        <div className="flex flex-1 flex-col gap-1.5 p-4">
          {/* Title — compact Langdock scale (14px), capped at 2 lines. No rigid
              min-height: reserving 2 lines for every title starved the
              description on cards that also show a status pill. */}
          <h3
            className={`text-sm font-medium leading-snug overflow-hidden shrink-0 ${
              worker.archived ? "text-muted-foreground" : ""
            }`}
            style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}
          >
            {worker.name}
          </h3>

          {/* U1 — Description: a CLEAN 2-line clamp ending in an ellipsis. The
              Tailwind line-clamp-2 utility computed display:flow-root here
              (clamp ignored → text sliced mid-line), and as a flex child it was
              shrunk below 2 lines. Force the -webkit-box clamp via inline style
              + shrink-0 so it renders exactly 2 lines + ellipsis and flexbox
              can't squeeze it (the cutoff bug Federico flagged 2026-05-30).
              Smaller Langdock body size (13px). */}
          <p
            className="text-[13px] leading-snug text-muted-foreground overflow-hidden shrink-0"
            style={{ display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: 2 }}
          >
            {description}
          </p>

          {/* Spacer pushes the footer to the bottom on a fixed-height card. */}
          <div className="flex-1" />

          {/* Quiet footer — relative last-run time + a single small status dot. */}
          <CardFooterLine stats={stats} status={worker.archived ? undefined : worker.status} />
        </div>
      </Link>
    </Card>
  );
}

// Footer status: a single small dot + label. Attention states (error /
// needs-attention / missing-secret) surface here instead of as a title-row pill.
// Healthy/ready workers show no dot — just the last-run time, kept quiet.
function footerStatus(status?: string): { cls: string; label: string } | null {
  switch (status) {
    case "error":
      return { cls: "bg-red-500", label: "Error" };
    case "needs_attention":
      return { cls: "bg-amber-500", label: "Needs attention" };
    case "missing_secret":
      return { cls: "bg-amber-500", label: "Missing secret" };
    default:
      return null;
  }
}

function CardFooterLine({
  stats,
  status,
}: {
  stats?: import("@/lib/types").RecentStats | null;
  status?: string;
}) {
  const attention = footerStatus(status);
  const lastRun = stats?.last_run_at ? formatRelativeTime(stats.last_run_at) : null;

  if (!attention && !lastRun) {
    // Keep the footer slot present so card content lands at the same baseline.
    return <div className="mt-auto h-4" aria-hidden />;
  }
  return (
    // U4: meta row at the compact Langdock scale (11px).
    <div className="mt-auto flex items-center gap-2 text-[11px] text-[var(--ink-soft)]">
      {lastRun && <span className="truncate">{lastRun}</span>}
      {attention && (
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          <span className={`size-1.5 rounded-full ${attention.cls}`} aria-hidden="true" />
          <span className="text-[var(--ink-mute)]">{attention.label}</span>
        </span>
      )}
    </div>
  );
}


function firstLine(value?: string): string {
  return (value || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function WorkerCardSkeleton() {
  return (
    <Card className={`${CARD_HEIGHT} gap-0 py-0 overflow-hidden`}>
      {/* Header band: icon strip + star */}
        <div className="flex items-center justify-between gap-2 rounded-t-[var(--radius-card)] border-b border-[var(--border-default)] bg-[color-mix(in_srgb,var(--foreground)_7%,var(--bg-card))] px-3.5 py-2">
        <Skeleton className="h-7 w-20 rounded-[var(--radius-squircle)]" />
        <Skeleton className="size-5 rounded shrink-0" />
      </div>
      {/* Body */}
      <div className="flex flex-1 flex-col gap-1.5 p-4">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="mt-auto h-3 w-24" />
      </div>
    </Card>
  );
}
