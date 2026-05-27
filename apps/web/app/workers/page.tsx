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
  Box, ChevronRight, Eye, Folder, Pencil, Play, Plus, Search, Star,
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

  const initialTab = searchParams.get("tab");
  const [tab, setTab] = useState<WorkersTab>(isValidTab(initialTab) ? initialTab : "all");
  const folderFilter = searchParams.get("folder");
  const [search, setSearch] = useState("");

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
    const params = new URLSearchParams(searchParams.toString());
    if (value === "all") params.delete("tab");
    else params.set("tab", value);
    router.replace(`/workers${params.size ? `?${params.toString()}` : ""}`, {
      scroll: false,
    });
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
  }, [workers, tab, folderFilter, favorites, searchLower]);

  // Folders only render on "all" tab
  const showFolders = tab === "all" && subFolders.length > 0 && !searchLower;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            All available workers. Run, edit, or create.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              api.workers.reload().then(() => window.location.reload())
            }
          >
            Reload
          </Button>
          <Link href="/workers/new">
            <Button size="sm">
              <Plus className="w-3.5 h-3.5 mr-1.5" />
              New worker
            </Button>
          </Link>
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

          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-44 w-full" />
                ))
              : displayedWorkers.map((w) => (
                  <WorkerCard
                    key={w.id}
                    worker={w}
                    isFavorite={favorites.has(w.id)}
                    onTagClick={(t) => setSearch(t)}
                    onFavoriteToggle={toggleFavorite}
                  />
                ))}
          </div>

          {!loading && displayedWorkers.length === 0 && (
            <p className="text-sm text-muted-foreground">
              {tab === "starred"
                ? "Nothing starred yet. Tap the star on any worker card to pin it here."
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
    { id: "research_brief", title: "Research brief", description: "Markdown brief from topic, audience, and depth." },
    { id: "gmail_intake_brief", title: "Gmail intake brief", description: "Unread Gmail triage summary with next actions." },
    { id: "csv_enricher", title: "CSV enricher", description: "Spreadsheet enrichment with structured output." },
  ];

  return (
    <div className="rounded-md border border-[#eaeaea] bg-white p-6 space-y-5">
      <div>
        <h2 className="text-lg font-semibold tracking-tight">Create your first worker from a template</h2>
        <p className="text-sm text-[#666] mt-1">Start with a filled WorkerContract and edit the YAML before saving.</p>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {templates.map((template) => (
          <Link key={template.id} href={`/workers/new?template=${template.id}`}>
            <div className="h-full rounded-md border border-[#eaeaea] p-4 hover:border-[#cfcfd4] transition-colors">
              <p className="text-sm font-medium">{template.title}</p>
              <p className="text-xs text-[#666] mt-1 leading-relaxed">{template.description}</p>
            </div>
          </Link>
        ))}
      </div>
    </div>
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
  onTagClick: (tag: string) => void;
  onFavoriteToggle: (id: string) => void;
  compact?: boolean;
}) {
  const statusColor: Record<string, string> = {
    healthy: "text-emerald-600 border-emerald-200 bg-emerald-50",
    needs_attention: "text-amber-600 border-amber-200 bg-amber-50",
    missing_secret: "text-amber-600 border-amber-200 bg-amber-50",
    error: "text-red-600 border-red-200 bg-red-50",
  };
  const hoverDescription = firstLine(worker.long_description);
  const stats = worker.recent_stats;
  const hasStats = stats && stats.runs_7d > 0;
  const hasSparkline = Array.isArray(worker.timeseries) && worker.timeseries.length > 0 && hasStats;

  return (
    <Card
      className="border-[#eaeaea] shadow-none bg-white hover:border-[#d4d4d8] transition-colors"
      title={hoverDescription || undefined}
    >
      <CardContent className={`p-5 ${compact ? "space-y-2" : "space-y-3"}`}>
        {/* Header row */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Box className="w-4 h-4 text-[#999] shrink-0" />
            <h3 className="font-medium text-[15px] truncate">{worker.name}</h3>
          </div>
          <div className="flex items-center gap-1 shrink-0">
            <button
              type="button"
              title={isFavorite ? "Remove from favourites" : "Add to favourites"}
              onClick={() => onFavoriteToggle(worker.id)}
              className={`h-7 w-7 flex items-center justify-center rounded transition-colors ${
                isFavorite ? "text-amber-400 hover:text-amber-500" : "text-[#ccc] hover:text-amber-400"
              }`}
            >
              <Star className={`w-3.5 h-3.5 ${isFavorite ? "fill-current" : ""}`} />
            </button>
            <Link href={`/workers/${worker.id}`} title="View worker">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-[#888] hover:text-[#333]">
                <Eye className="w-3.5 h-3.5" />
              </Button>
            </Link>
            <Link href={`/workers/${worker.id}/edit`} title="Edit worker">
              <Button variant="ghost" size="sm" className="h-7 w-7 p-0 text-[#888] hover:text-[#333]">
                <Pencil className="w-3.5 h-3.5" />
              </Button>
            </Link>
            <Badge variant="outline" className={statusColor[worker.status] || statusColor.healthy}>
              {worker.status.replace("_", " ")}
            </Badge>
          </div>
        </div>

        {!compact && (
          <p className="text-sm text-[#666] line-clamp-2">{worker.description || "No description."}</p>
        )}

        {worker.folder && (
          <p className="text-xs text-[#999]">{worker.folder}</p>
        )}

        {!compact && (worker.tags || []).length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {(worker.tags || []).map((tag) => (
              <button key={tag} type="button" onClick={() => onTagClick(tag)}>
                <Badge variant="outline" className="cursor-pointer bg-white text-xs font-normal hover:bg-[#f4f4f5]">
                  {tag}
                </Badge>
              </button>
            ))}
          </div>
        )}

        {/* Trigger chips */}
        {(worker.triggers || []).length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {(worker.triggers || []).map((label) => (
              <span
                key={label}
                className="inline-flex items-center px-2 py-0.5 rounded text-[11px] bg-[#f4f4f5] text-[#555]"
              >
                {label}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-[#999]">{worker.trigger_type}</p>
        )}

        {/* Sparkline (only shown when timeseries data available and has runs) */}
        {hasSparkline && (
          <div>
            <Sparkline data={worker.timeseries!} width={120} height={28} />
          </div>
        )}

        {/* Usage stats text */}
        {hasStats && (
          <p className="text-xs text-[#999]">
            {stats.last_run_at ? `Last run ${formatRelativeTime(stats.last_run_at)}` : ""}
            {stats.last_run_at && stats.runs_7d > 0 ? " · " : ""}
            {stats.runs_7d > 0 ? `${stats.runs_7d} run${stats.runs_7d === 1 ? "" : "s"} in 7d` : ""}
            {stats.success_rate_7d != null ? ` · ${Math.round(stats.success_rate_7d * 100)}% success` : ""}
          </p>
        )}

        <div className="pt-1">
          <Link href={`/workers/${worker.id}`}>
            <Button variant="secondary" size="sm" className="w-full">
              <Play className="w-3.5 h-3.5 mr-1.5" />
              Run worker
            </Button>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function firstLine(value?: string): string {
  return (value || "").split("\n").map((line) => line.trim()).find(Boolean) || "";
}
