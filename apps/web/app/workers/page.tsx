"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Box, ChevronDown, ChevronUp, Eye, Folder, Pencil, Play, Plus, Tags, X } from "lucide-react";
import type { WorkerSummary } from "@/lib/types";
import { formatRelativeTime } from "@/components/connections/connection-data";

const TAG_COLLAPSED_MAX = 8;
const SESSION_KEY_TAGS_EXPANDED = "workeros:tags-expanded";

export default function WorkersPage() {
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [tagsExpanded, setTagsExpanded] = useState<boolean>(() => {
    try {
      return sessionStorage.getItem(SESSION_KEY_TAGS_EXPANDED) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    api.workers.list().then((w) => {
      setWorkers(w);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  // Flatten folders into leaf-path chips (e.g. "Recruiting/NovaSearch")
  const flatFolders = useMemo(() => flattenFolders(workers), [workers]);
  const hasFolders = flatFolders.length > 0;

  const allTags = useMemo(
    () => Array.from(new Set(workers.flatMap((worker) => worker.tags || []))).sort(),
    [workers],
  );
  const filteredWorkers = workers.filter((worker) => {
    const matchesTag = !tagFilter || (worker.tags || []).includes(tagFilter);
    const matchesFolder = !folderFilter || worker.folder === folderFilter || worker.folder?.startsWith(`${folderFilter}/`);
    return matchesTag && matchesFolder;
  });
  const hasFilter = Boolean(tagFilter || folderFilter);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Workers</h1>
          <p className="text-[#666] text-sm mt-1">All available workers. Select one to run it.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => api.workers.reload().then(() => window.location.reload())}>
            Reload workers
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
        <div className="space-y-4">
          {/* Top filter bar */}
          <div className="rounded-md border border-[#eaeaea] bg-white px-4 py-3 space-y-3">
            {/* Folders row (hidden when no folders defined) */}
            {(hasFolders || loading) && (
              <div className="flex items-start gap-2">
                <div className="flex items-center gap-1.5 text-xs font-medium text-[#555] pt-1 shrink-0">
                  <Folder className="w-3.5 h-3.5" />
                  <span>Folders</span>
                </div>
                {loading ? (
                  <Skeleton className="h-6 w-48" />
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => setFolderFilter(null)}
                      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs border transition-colors ${
                        !folderFilter
                          ? "bg-[#1a1a1a] text-white border-[#1a1a1a]"
                          : "bg-white text-[#555] border-[#d4d4d8] hover:bg-[#f4f4f5]"
                      }`}
                    >
                      All
                    </button>
                    {flatFolders.map(({ path, label, count }) => (
                      <button
                        key={path}
                        type="button"
                        onClick={() => setFolderFilter((cur) => cur === path ? null : path)}
                        className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs border transition-colors ${
                          folderFilter === path
                            ? "bg-[#1a1a1a] text-white border-[#1a1a1a]"
                            : "bg-white text-[#555] border-[#d4d4d8] hover:bg-[#f4f4f5]"
                        }`}
                      >
                        {label}
                        <span className="ml-1 opacity-60">{count}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Tags row */}
            <div className="flex items-start gap-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-[#555] pt-1 shrink-0">
                <Tags className="w-3.5 h-3.5" />
                <span>Tags</span>
              </div>
              {loading ? (
                <Skeleton className="h-6 w-64" />
              ) : allTags.length === 0 ? (
                <p className="text-xs text-[#999] pt-1">No tags.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {(tagsExpanded ? allTags : allTags.slice(0, TAG_COLLAPSED_MAX)).map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setTagFilter((cur) => cur === tag ? null : tag)}
                    >
                      <Badge
                        variant="outline"
                        className={`cursor-pointer text-xs font-normal ${
                          tagFilter === tag
                            ? "bg-[#1a1a1a] text-white border-[#1a1a1a]"
                            : "bg-white hover:bg-[#f4f4f5]"
                        }`}
                      >
                        {tag}
                      </Badge>
                    </button>
                  ))}
                  {allTags.length > TAG_COLLAPSED_MAX && (
                    <button
                      type="button"
                      onClick={() => {
                        const next = !tagsExpanded;
                        setTagsExpanded(next);
                        try { sessionStorage.setItem(SESSION_KEY_TAGS_EXPANDED, String(next)); } catch {}
                      }}
                      className="inline-flex items-center gap-0.5 text-xs text-[#666] hover:text-[#333] transition-colors"
                    >
                      {tagsExpanded ? (
                        <><ChevronUp className="w-3 h-3" />Show fewer</>
                      ) : (
                        <><ChevronDown className="w-3 h-3" />Show all ({allTags.length})</>
                      )}
                    </button>
                  )}
                </div>
              )}

              {/* Clear filters button inline with tags row when filter is active */}
              {hasFilter && (
                <button
                  type="button"
                  onClick={() => { setTagFilter(null); setFolderFilter(null); }}
                  className="ml-auto shrink-0 flex items-center gap-1 text-xs text-[#888] hover:text-[#333] transition-colors pt-1"
                >
                  <X className="w-3 h-3" />
                  Clear filters
                </button>
              )}
            </div>
          </div>

          {/* Filter summary */}
          {hasFilter && (
            <div className="text-xs text-[#666]">
              Showing {filteredWorkers.length} of {workers.length}
              {folderFilter ? ` in ${folderFilter}` : ""}
              {tagFilter ? ` tagged "${tagFilter}"` : ""}
            </div>
          )}

          {/* Worker cards: full-width grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {loading
              ? Array.from({ length: 8 }).map((_, i) => (
                  <Skeleton key={i} className="h-44 w-full" />
                ))
              : filteredWorkers.map((w) => (
                  <WorkerCard key={w.id} worker={w} onTagClick={setTagFilter} />
                ))}
          </div>

          {!loading && filteredWorkers.length === 0 && (
            <p className="text-sm text-[#999]">No workers match the active filters.</p>
          )}
        </div>
      )}
    </div>
  );
}

interface FlatFolder {
  path: string;
  label: string;
  count: number;
}

/**
 * Flatten the folder tree into a list of leaf-path chips.
 * Parent folders that have children are shown as "Parent/Child" labels.
 * Workers with no folder are ignored (they appear under "All").
 */
function flattenFolders(workers: WorkerSummary[]): FlatFolder[] {
  const countByPath = new Map<string, number>();

  for (const worker of workers) {
    if (!worker.folder) continue;
    // Count this worker under its exact path and all ancestor paths
    const parts = worker.folder.split("/").filter(Boolean);
    let path = "";
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      countByPath.set(path, (countByPath.get(path) ?? 0) + 1);
    }
  }

  if (countByPath.size === 0) return [];

  // Build the tree to find which nodes are leaves vs. parents
  const allPaths = Array.from(countByPath.keys()).sort();

  // A path is "shown" if it has no children OR if it has children but also
  // has workers directly in it (not only via children). For simplicity, we
  // always show every unique path used by at least one worker (the full set of
  // distinct folder values), then sort. This makes "Recruiting/NovaSearch" a
  // separate chip from "Recruiting".
  const distinctFolders = Array.from(
    new Set(workers.map((w) => w.folder).filter(Boolean) as string[])
  ).sort();

  return distinctFolders.map((path) => ({
    path,
    label: path, // show full path e.g. "Recruiting/NovaSearch"
    count: countByPath.get(path) ?? 0,
  }));
}

function EmptyWorkersState() {
  const templates = [
    {
      id: "research_brief",
      title: "Research brief",
      description: "Markdown brief from topic, audience, and depth.",
    },
    {
      id: "gmail_intake_brief",
      title: "Gmail intake brief",
      description: "Unread Gmail triage summary with next actions.",
    },
    {
      id: "csv_enricher",
      title: "CSV enricher",
      description: "Spreadsheet enrichment with structured output.",
    },
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

function WorkerCard({ worker, onTagClick }: { worker: WorkerSummary; onTagClick: (tag: string) => void }) {
  const statusColor: Record<string, string> = {
    healthy: "text-emerald-600 border-emerald-200 bg-emerald-50",
    needs_attention: "text-amber-600 border-amber-200 bg-amber-50",
    missing_secret: "text-amber-600 border-amber-200 bg-amber-50",
    error: "text-red-600 border-red-200 bg-red-50",
  };
  const hoverDescription = firstLine(worker.long_description);
  const stats = worker.recent_stats;
  const hasStats = stats && stats.runs_7d > 0;

  return (
    <Card
      className="border-[#eaeaea] shadow-none bg-white hover:border-[#d4d4d8] transition-colors"
      title={hoverDescription || undefined}
    >
      <CardContent className="p-5 space-y-3">
        {/* Header row: name + status badge + View/Edit actions */}
        <div className="flex items-start justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Box className="w-4 h-4 text-[#999] shrink-0" />
            <h3 className="font-medium text-[15px] truncate">{worker.name}</h3>
          </div>
          <div className="flex items-center gap-1 shrink-0">
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

        <p className="text-sm text-[#666] line-clamp-2">{worker.description || "No description."}</p>

        {worker.folder && (
          <p className="text-xs text-[#999]">{worker.folder}</p>
        )}

        {(worker.tags || []).length > 0 && (
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

        {/* Trigger chips: show all configured triggers, no runner label */}
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

        {/* Usage telemetry: only shown if worker has been run in last 7 days */}
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
            <Button
              variant="secondary"
              size="sm"
              className="w-full"
            >
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
