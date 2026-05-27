"use client";

export const dynamic = "force-dynamic";

import { Suspense, useEffect, useMemo, useState, useCallback } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Box, ChevronRight, Folder, Plus, Search, Star,
} from "lucide-react";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useRouter, useSearchParams } from "next/navigation";
import type { WorkerSummary } from "@/lib/types";
import { formatRelativeTime } from "@/components/connections/connection-data";
import { Sparkline } from "@/components/Sparkline";

const LS_KEY_FAVORITES = "workeros:favorites";

type WorkersTab = "all" | "starred" | "recent";
const TAB_KEYS: WorkersTab[] = ["all", "starred", "recent"];
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

export default function WorkersPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">Loading workers...</div>}>
      <WorkersContent />
    </Suspense>
  );
}

function WorkersContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [favorites, setFavorites] = useState<Set<string>>(() => getFavorites());

  // S28: tabs (All/Starred/Recent) live in URL hash. Folder + tag stay as
  // query params (those are filters, not tab selection).
  const initialTab =
    (typeof window !== "undefined" && window.location.hash.replace(/^#/, "")) ||
    searchParams.get("tab");
  const [tab, setTab] = useState<WorkersTab>(isValidTab(initialTab) ? initialTab : "all");
  const folderFilter = searchParams.get("folder");
  // S26: tag filter (clicking a tag on a card filters the list to workers
  // with that tag; URL-synced so refresh + sharing work).
  const tagFilter = searchParams.get("tag");
  const [search, setSearch] = useState("");

  const setTagFilter = useCallback((tag: string | null) => {
    const params = new URLSearchParams(searchParams.toString());
    if (tag) params.set("tag", tag);
    else params.delete("tag");
    router.replace(`/workers${params.size ? `?${params.toString()}` : ""}`, { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    api.workers
      .list()
      .then((w) => {
        setWorkers(w);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

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
    // S28: hash slug instead of query param. Preserve folder/tag query
    // filters in place.
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

  // Worker selection per tab
  const displayedWorkers = useMemo(() => {
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
    if (tagFilter) {
      pool = pool.filter((w) => (w.tags || []).includes(tagFilter));
    }
    if (searchLower) {
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
  }, [workers, tab, folderFilter, tagFilter, favorites, searchLower]);

  // Folders only render on "all" tab
  const showFolders = tab === "all" && subFolders.length > 0 && !searchLower && !tagFilter;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            All available workers. Run, edit, or create.
          </p>
        </div>
        <Link href="/workers/new">
          <Button size="sm">
            <Plus className="w-3.5 h-3.5 mr-1.5" />
            New worker
          </Button>
        </Link>
      </div>

      {!loading && workers.length === 0 ? (
        <EmptyWorkersState />
      ) : (
        <div className="space-y-5">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative max-w-sm flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
              <Input
                placeholder="Search workers..."
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
              </TabsList>
            </Tabs>
          </div>

          {tab === "all" && (
            <div className="flex items-center gap-1 text-sm text-muted-foreground">
              <button
                type="button"
                onClick={() => setFolder(null)}
                className="hover:text-foreground transition-colors"
              >
                Workers
              </button>
              <ChevronRight className="size-3.5" />
              {breadcrumbs.length === 0 ? (
                <span>All</span>
              ) : (
                breadcrumbs.map((bc, i) => (
                  <span key={bc.path} className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setFolder(bc.path)}
                      className="hover:text-foreground transition-colors"
                    >
                      {bc.label}
                    </button>
                    {i < breadcrumbs.length - 1 ? (
                      <ChevronRight className="size-3.5" />
                    ) : null}
                  </span>
                ))
              )}
            </div>
          )}

          {showFolders && (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {subFolders.map(({ path, label, count }) => (
                <button
                  key={path}
                  type="button"
                  onClick={() => setFolder(path)}
                  className="flex items-center gap-3 rounded-md border bg-card px-4 py-3 hover:bg-accent transition-colors text-left"
                >
                  <Folder className="size-5 text-muted-foreground" />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{label}</p>
                    <p className="text-xs text-muted-foreground">
                      {count} worker{count === 1 ? "" : "s"}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}

          {tagFilter && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">Filtered by tag:</span>
              <button
                type="button"
                onClick={() => setTagFilter(null)}
                className="inline-flex items-center gap-1 rounded-full border border-[var(--accent)] bg-[var(--accent-soft)] px-2.5 py-1 text-xs font-medium text-[var(--accent)] hover:opacity-90 transition-opacity"
              >
                {tagFilter}
                <span aria-hidden="true">×</span>
                <span className="sr-only">Clear tag filter</span>
              </button>
            </div>
          )}

          {/* S23: auto-rows-fr stretches every card in a row to equal height. */}
          <div className="grid auto-rows-fr grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <WorkerCardSkeleton key={i} />
                ))
              : displayedWorkers.map((w) => (
                  <WorkerCard
                    key={w.id}
                    worker={w}
                    isFavorite={favorites.has(w.id)}
                    onTagClick={setTagFilter}
                    onFavoriteToggle={toggleFavorite}
                  />
                ))}
          </div>

          {!loading && displayedWorkers.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {tab === "starred"
                ? "Nothing starred yet. Click the star on any worker card to pin it here."
                : tab === "recent"
                ? "No workers run yet."
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
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
            Or start from a template
          </p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {templates.map((t) => (
              <Link
                key={t.id}
                href={`/workers/new?template=${t.id}`}
                className="group block rounded-lg border bg-card hover:bg-accent transition-colors p-4"
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
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
            Example prompts
          </p>
          <ul className="space-y-1.5">
            {examples.map((ex, i) => (
              <li key={i}>
                <Link
                  href={`/workers/new?prompt=${encodeURIComponent(ex)}`}
                  className="block rounded-md px-3 py-2 text-sm hover:bg-accent transition-colors text-muted-foreground hover:text-foreground"
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

function WorkerCard({
  worker,
  isFavorite,
  onTagClick,
  onFavoriteToggle,
  compact,
}: {
  worker: WorkerSummary;
  isFavorite: boolean;
  onTagClick?: (tag: string) => void;
  onFavoriteToggle: (id: string) => void;
  compact?: boolean;
}) {
  const hoverDescription = firstLine(worker.long_description);
  const stats = worker.recent_stats;
  const hasStats = stats && stats.runs_7d > 0;
  const hasSparkline = Array.isArray(worker.timeseries) && worker.timeseries.length > 0 && hasStats;

  // S26: cards trimmed. Default view shows title + status pill + description
  // + tags + the bare "Last run Xh ago" timestamp. Sparkline, trigger pill,
  // and extended stats (runs/7d, success rate) collapse on hover via the
  // `group` + `group-hover:` pattern. Tags become click-to-filter buttons
  // (Federico request, supersedes the S22b "static pills" decision).
  return (
    <Card
      className="group h-full hover:border-border hover:shadow-sm transition-all overflow-hidden"
      title={hoverDescription || undefined}
    >
      <Link href={`/workers/${worker.id}`} className="block h-full">
      <CardContent className={`h-full p-5 ${compact ? "space-y-2" : "space-y-2.5"}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            <h3 className="font-medium text-[15px] leading-snug line-clamp-2">{worker.name}</h3>
          </div>
          <button
            type="button"
            title={isFavorite ? "Remove from favourites" : "Add to favourites"}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onFavoriteToggle(worker.id);
            }}
            className={`size-7 flex items-center justify-center rounded transition-colors shrink-0 ${
              isFavorite
                ? "text-[var(--accent)] hover:opacity-80"
                : "text-muted-foreground/40 hover:text-[var(--accent)]"
            }`}
          >
            <Star className={`size-3.5 ${isFavorite ? "fill-current" : ""}`} />
          </button>
        </div>

        <CardStatusPill status={worker.status} />

        {!compact && (
          <p className="text-sm text-muted-foreground line-clamp-2">{worker.description || "No description."}</p>
        )}

        {!compact && (worker.tags || []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {(worker.tags || []).map((tag) => (
              <button
                key={tag}
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onTagClick?.(tag);
                }}
                className="inline-flex items-center rounded-full border border-border bg-card px-2 py-0.5 text-xs font-normal text-muted-foreground hover:border-[var(--accent)] hover:bg-[var(--accent-soft)] hover:text-[var(--accent)] transition-colors"
              >
                {tag}
              </button>
            ))}
          </div>
        )}

        {/* Bare timestamp shown by default; replaced by extended stats on hover. */}
        {stats?.last_run_at && (
          <p className="text-xs text-muted-foreground group-hover:hidden">
            Last run {formatRelativeTime(stats.last_run_at)}
          </p>
        )}

        {/* Hover-only block: sparkline + trigger + extended stats line.
            Uses max-h transition so the card grows smoothly on hover instead
            of jumping. Replaces the bare timestamp above. */}
        <div className="hidden group-hover:flex flex-col gap-2 pt-1">
          {(worker.triggers || []).length > 0 ? (
            <div className="flex flex-wrap gap-1">
              {(worker.triggers || []).map((label) => (
                <span
                  key={label}
                  className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-muted text-muted-foreground"
                >
                  {label}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{worker.trigger_type}</p>
          )}

          {hasSparkline && (
            <div>
              <Sparkline data={worker.timeseries!} width={120} height={28} />
            </div>
          )}

          {hasStats && (
            <p className="text-xs text-muted-foreground">
              {stats.last_run_at ? `Last run ${formatRelativeTime(stats.last_run_at)}` : ""}
              {stats.last_run_at && stats.runs_7d > 0 ? " · " : ""}
              {stats.runs_7d > 0 ? `${stats.runs_7d} run${stats.runs_7d === 1 ? "" : "s"} in 7d` : ""}
              {stats.success_rate_7d != null ? ` · ${Math.round(stats.success_rate_7d * 100)}% success` : ""}
            </p>
          )}
        </div>
      </CardContent>
      </Link>
    </Card>
  );
}

function CardStatusPill({ status }: { status: string }) {
  const conf: Record<string, { label: string; classes: string }> = {
    healthy: {
      label: "Healthy",
      classes: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900",
    },
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

// S23: skeleton shaped to match the real WorkerCard (title, status pill,
// 2-line description, tag row, trigger row, sparkline strip, stats row).
// Previous Skeleton was a flat h-44 rectangle that flipped to a tall
// content card on load — looked broken.
function WorkerCardSkeleton() {
  return (
    <Card className="h-full overflow-hidden">
      <CardContent className="p-5 space-y-3">
        <div className="flex items-start justify-between gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="size-5 rounded-full" />
        </div>
        <Skeleton className="h-5 w-24 rounded-full" />
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <div className="flex gap-1.5">
          <Skeleton className="h-5 w-14 rounded" />
          <Skeleton className="h-5 w-16 rounded" />
          <Skeleton className="h-5 w-12 rounded" />
        </div>
        <Skeleton className="h-5 w-20 rounded" />
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-3 w-5/6" />
      </CardContent>
    </Card>
  );
}
