"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Box, ChevronRight, Folder, Plus, Search, Star, Archive,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouter, useSearchParams } from "next/navigation";
import type { WorkerSummary } from "@/lib/types";
import { formatRelativeTime } from "@/components/connections/connection-data";
import { WorkerIconPills } from "@/components/WorkerIconPills";

const LS_KEY_FAVORITES = "workeros:favorites";

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
  const [workers, setWorkers] = useState<WorkerSummary[]>(initialWorkers);
  const [archivedWorkers, setArchivedWorkers] = useState<WorkerSummary[]>([]);
  // Only show a loading state if initialWorkers is empty AND we're re-fetching
  const [loading, setLoading] = useState(false);
  const [loadingArchived, setLoadingArchived] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(() => getFavorites());

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
      setWorkers(initialWorkers);
    }
  }, [initialWorkers]);

  // S44: if RSC delivered empty (API unavailable), fall back to client fetch.
  useEffect(() => {
    if (initialWorkers.length === 0) {
      setLoading(true);
      api.workers
        .list()
        .then((w) => {
          setWorkers(w);
          setLoading(false);
        })
        .catch(() => setLoading(false));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Load archived workers when Archived tab is first selected.
  useEffect(() => {
    if (tab === "archived" && archivedWorkers.length === 0 && !loadingArchived) {
      setLoadingArchived(true);
      api.workers
        .list({ include_archived: true })
        .then((all) => {
          setArchivedWorkers(all.filter((w) => w.archived));
          setLoadingArchived(false);
        })
        .catch(() => setLoadingArchived(false));
    }
  }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

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
    let pool = workers;
    if (tab === "starred") {
      pool = pool.filter((w) => favorites.has(w.id));
    } else if (tab === "recent") {
      pool = pool
        .filter((w) => w.recent_stats?.last_run_at)
        .sort((a, b) => {
          const ta = new Date(a.recent_stats!.last_run_at!).getTime();
          const tb = new Date(b.recent_stats!.last_run_at!).getTime();
          return tb - ta;
        })
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

      {!loading && workers.length === 0 ? (
        <EmptyWorkersState />
      ) : (
        <div className="space-y-5">
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
            <Tabs value={tab} onValueChange={handleTabChange}>
              <TabsList>
                <TabsTrigger value="all">All</TabsTrigger>
                <TabsTrigger value="starred">
                  <Star className="size-3.5" />
                  Starred
                </TabsTrigger>
                <TabsTrigger value="recent">Recent</TabsTrigger>
                <TabsTrigger value="archived">
                  <Archive className="size-3.5" />
                  Archived
                </TabsTrigger>
              </TabsList>
            </Tabs>
          </div>

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

          {/* Flat grid (not grouped by folder). Tag matching folded into the
              search box above; the standing tag-chip wall was removed for
              digestibility (Federico 2026-05-29). */}
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {(loading || (isArchivedTab && loadingArchived))
              ? Array.from({ length: 8 }).map((_, i) => (
                  <WorkerCardSkeleton key={i} />
                ))
              : displayedWorkers.map((w) => (
                  <WorkerCard
                    key={w.id}
                    worker={w}
                    isFavorite={favorites.has(w.id)}
                    onFavoriteToggle={toggleFavorite}
                  />
                ))}
          </div>

          {!loading && !loadingArchived && displayedWorkers.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {tab === "starred"
                ? "Nothing starred yet. Click the star on any worker card to pin it here."
                : tab === "recent"
                ? "No workers run yet."
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
    { id: "research_brief", title: "Research brief", description: "Markdown brief from a topic, audience, and depth.", icon: "📄" },
    { id: "gmail_intake_brief", title: "Gmail triage", description: "Unread Gmail summary with next actions.", icon: "✉️" },
    { id: "csv_enricher", title: "CSV enricher", description: "Spreadsheet enrichment with structured output.", icon: "📊" },
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
                <div className="text-2xl mb-2" aria-hidden>
                  {t.icon}
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
                  &quot;{ex}&quot;
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
// WorkerCard
// ---------------------------------------------------------------------------

// Fixed card height — every card is the same height so the grid reads as a
// clean, scannable matrix. Hover is a subtle lift only (shadow), never a
// size jump (Federico 2026-05-29).
const CARD_HEIGHT = "h-[188px]";

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
      className={`group ${CARD_HEIGHT} hover:shadow-sm transition-shadow overflow-hidden`}
      title={hoverDescription || undefined}
    >
      <Link href={`/workers/${worker.id}`} className="block h-full">
        <CardContent className="h-full flex flex-col p-4 gap-2">
          {/* 1. Composed Langdock-style pill strip at the TOP — the start-node
              (trigger) + connection brand logos. No letter-avatar: the pills +
              title carry identity. Never visually empty (start node always
              renders). */}
          <div className="flex items-start justify-between gap-2">
            {worker.archived ? (
              <span
                className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground"
                title="Archived"
              >
                <Archive className="size-3.5" />
                Archived
              </span>
            ) : (
              <WorkerIconPills
                worker={worker}
                connections={worker.connections}
                triggerType={worker.trigger_type}
                size="sm"
              />
            )}
            {!worker.archived && (
              <div className="flex items-center gap-1.5 shrink-0">
                {/* FIX 2 (Federico 2026-05-29): the "Example" tag moved OFF the
                    title row to a subtle top-right corner chip, aligned with
                    the star. Quiet (--bg-2, muted, text-[10px]) so the title
                    row reads clean — just the title. */}
                {worker.is_example && (
                  <span className="inline-flex items-center rounded-[var(--radius-button)] border border-[var(--line-soft)] bg-[var(--bg-2)] px-1.5 py-0.5 text-[10px] font-normal leading-none text-[var(--ink-mute)]">
                    Example
                  </span>
                )}
                <button
                  type="button"
                  title={isFavorite ? "Remove from favourites" : "Add to favourites"}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onFavoriteToggle(worker.id);
                  }}
                  className={`size-7 -mt-0.5 -mr-1 flex items-center justify-center rounded transition-colors shrink-0 ${
                    isFavorite
                      ? "text-[var(--accent)] hover:opacity-80"
                      : "text-muted-foreground/40 hover:text-[var(--accent)]"
                  }`}
                >
                  <Star className={`size-3.5 ${isFavorite ? "fill-current" : ""}`} />
                </button>
              </div>
            )}
          </div>

          {/* 2. Title + description form ONE bounded body block (flex-1,
              min-h-0) that absorbs the space between the top pill row and the
              pinned footer. FIX 3 (Federico 2026-05-29): the description used
              to bleed into the footer when the title ran 2 lines and/or a
              status pill appeared. Reserving the title at a fixed 2-line
              height and clamping the description inside a min-h-0 flex body
              means the footer is laid out (never overlapped) and every card
              holds the same height. */}
          <div className="flex-1 min-h-0 flex flex-col gap-1.5">
            <h3
              className={`font-medium text-[15px] leading-snug line-clamp-2 min-h-[2.7em] ${
                worker.archived ? "text-muted-foreground" : ""
              }`}
            >
              {worker.name}
            </h3>

            {!worker.archived && worker.status !== "healthy" && worker.status !== "ready" && worker.status && (
              <CardStatusPill status={worker.status} />
            )}

            {/* Description — clamped to 2 lines. `line-clamp-2` already sets
                display:-webkit-box + overflow:hidden; do NOT add a separate
                `overflow-hidden` utility — it conflicts with the webkit-box
                display and collapses the paragraph to 0 height (caught live
                2026-05-29). The min-h-0 flex parent bounds it instead. */}
            <p className="text-sm text-muted-foreground line-clamp-2">
              {description}
            </p>
          </div>

          {/* 3. Quiet footer — one line: relative last-run + a small success
              bar (filled % of last-7d success). Pinned below the body block. */}
          <CardFooterLine stats={stats} />
        </CardContent>
      </Link>
    </Card>
  );
}

function CardFooterLine({ stats }: { stats?: import("@/lib/types").RecentStats | null }) {
  if (!stats || (!stats.last_run_at && stats.runs_7d === 0)) {
    // Keep the footer slot present so card content lands at the same baseline.
    return <div className="mt-auto h-4" aria-hidden />;
  }
  const pct =
    stats.success_rate_7d != null ? Math.round(stats.success_rate_7d * 100) : null;
  return (
    <div className="mt-auto flex items-center gap-2 text-xs text-[var(--ink-soft)]">
      <span className="truncate">
        {stats.last_run_at ? formatRelativeTime(stats.last_run_at) : "no recent runs"}
      </span>
      {pct != null && (
        <span className="ml-auto flex items-center gap-1.5 shrink-0" title={`${pct}% success (7d)`}>
          <span className="relative h-1 w-12 overflow-hidden rounded-full bg-[var(--line-soft)]">
            <span
              className="absolute inset-y-0 left-0 rounded-full bg-[var(--success)]"
              style={{ width: `${pct}%` }}
            />
          </span>
          <span className="tabular-nums text-[var(--ink-mute)]">{pct}%</span>
        </span>
      )}
    </div>
  );
}

function CardStatusPill({ status }: { status: string }) {
  // P2: "ready" (never-run) is treated exactly like "healthy" — no pill.
  if (status === "healthy" || status === "ready" || !status) return null;
  const conf: Record<string, { label: string; classes: string }> = {
    needs_attention: {
      label: "Needs attention",
      classes: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
    },
    missing_secret: {
      label: "Missing secret",
      classes: "bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/40 dark:text-amber-300 dark:border-amber-900",
    },
    error: {
      label: "Error",
      classes: "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900",
    },
  };
  const { label, classes } = conf[status] ?? { label: status, classes: "bg-muted text-muted-foreground border-border" };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${classes}`}
    >
      <span className="size-1.5 rounded-full bg-current opacity-70" aria-hidden="true" />
      {label}
    </span>
  );
}

function firstLine(value?: string): string {
  return (value || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}

function WorkerCardSkeleton() {
  return (
    <Card className={`${CARD_HEIGHT} overflow-hidden`}>
      <CardContent className="h-full flex flex-col p-4 gap-2">
        {/* Pill strip + star row */}
        <div className="flex items-start justify-between gap-2">
          <Skeleton className="h-7 w-20 rounded-[var(--radius-squircle)]" />
          <Skeleton className="size-5 rounded shrink-0" />
        </div>
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-2/3" />
        <Skeleton className="mt-auto h-3 w-24" />
      </CardContent>
    </Card>
  );
}
