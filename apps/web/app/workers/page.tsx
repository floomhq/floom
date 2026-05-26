"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { api } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Box, ChevronRight, Folder, Play, Plus, Tags } from "lucide-react";
import type { WorkerSummary } from "@/lib/types";

export default function WorkersPage() {
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [folderFilter, setFolderFilter] = useState<string | null>(null);
  const [expandedFolders, setExpandedFolders] = useState<Set<string>>(new Set());

  useEffect(() => {
    api.workers.list().then((w) => {
      setWorkers(w);
      setLoading(false);
    }).catch(() => setLoading(false));
  }, []);

  const folders = useMemo(() => buildFolderTree(workers), [workers]);
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

  function toggleFolder(path: string) {
    setExpandedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  return (
    <div className="space-y-6">
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
        <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)] gap-5 items-start">
          <aside className="rounded-md border border-[#eaeaea] bg-white p-3 space-y-4">
            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-[#555] mb-2">
                <Folder className="w-3.5 h-3.5" />
                Folders
              </div>
              {loading ? (
                <Skeleton className="h-24 w-full" />
              ) : folders.length === 0 ? (
                <p className="text-xs text-[#999]">No folders.</p>
              ) : (
                <div className="space-y-1">
                  <button
                    type="button"
                    onClick={() => setFolderFilter(null)}
                    className={`w-full text-left text-xs rounded px-2 py-1.5 ${!folderFilter ? "bg-[#f4f4f5] text-[#222]" : "text-[#666] hover:bg-[#f7f7f6]"}`}
                  >
                    All folders
                  </button>
                  {folders.map((folder) => (
                    <FolderNode
                      key={folder.path}
                      node={folder}
                      activePath={folderFilter}
                      expandedFolders={expandedFolders}
                      onToggle={toggleFolder}
                      onSelect={setFolderFilter}
                    />
                  ))}
                </div>
              )}
            </div>

            <div>
              <div className="flex items-center gap-2 text-xs font-medium text-[#555] mb-2">
                <Tags className="w-3.5 h-3.5" />
                Tags
              </div>
              {allTags.length === 0 ? (
                <p className="text-xs text-[#999]">No tags.</p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {allTags.map((tag) => (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => setTagFilter((current) => current === tag ? null : tag)}
                    >
                      <Badge
                        variant="outline"
                        className={`cursor-pointer text-xs font-normal ${tagFilter === tag ? "bg-[#1a1a1a] text-white border-[#1a1a1a]" : "bg-white hover:bg-[#f4f4f5]"}`}
                      >
                        {tag}
                      </Badge>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {hasFilter && (
              <Button
                variant="outline"
                size="sm"
                className="w-full h-8 text-xs"
                onClick={() => {
                  setTagFilter(null);
                  setFolderFilter(null);
                }}
              >
                Clear filters
              </Button>
            )}
          </aside>

          <div className="space-y-3">
            {hasFilter && (
              <div className="text-xs text-[#666]">
                Showing {filteredWorkers.length} of {workers.length}
                {folderFilter ? ` in ${folderFilter}` : ""}
                {tagFilter ? ` tagged ${tagFilter}` : ""}
              </div>
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {loading
                ? Array.from({ length: 4 }).map((_, i) => (
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
        </div>
      )}
    </div>
  );
}

interface FolderNodeModel {
  name: string;
  path: string;
  count: number;
  children: FolderNodeModel[];
}

function buildFolderTree(workers: WorkerSummary[]): FolderNodeModel[] {
  const roots: FolderNodeModel[] = [];
  const byPath = new Map<string, FolderNodeModel>();

  for (const worker of workers) {
    if (!worker.folder) continue;
    const parts = worker.folder.split("/").filter(Boolean);
    let path = "";
    let siblings = roots;
    for (const part of parts) {
      path = path ? `${path}/${part}` : part;
      let node = byPath.get(path);
      if (!node) {
        node = { name: part, path, count: 0, children: [] };
        byPath.set(path, node);
        siblings.push(node);
        siblings.sort((a, b) => a.name.localeCompare(b.name));
      }
      node.count += 1;
      siblings = node.children;
    }
  }

  return roots;
}

function FolderNode({
  node,
  activePath,
  expandedFolders,
  onToggle,
  onSelect,
}: {
  node: FolderNodeModel;
  activePath: string | null;
  expandedFolders: Set<string>;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
}) {
  const expanded = expandedFolders.has(node.path);
  const hasChildren = node.children.length > 0;

  return (
    <div>
      <div className={`flex items-center rounded ${activePath === node.path ? "bg-[#f4f4f5]" : "hover:bg-[#f7f7f6]"}`}>
        <button
          type="button"
          className="h-7 w-7 shrink-0 flex items-center justify-center text-[#777]"
          onClick={() => hasChildren && onToggle(node.path)}
          aria-label={expanded ? `Collapse ${node.path}` : `Expand ${node.path}`}
        >
          {hasChildren && (
            <ChevronRight className={`w-3.5 h-3.5 transition-transform ${expanded ? "rotate-90" : ""}`} />
          )}
        </button>
        <button
          type="button"
          onClick={() => onSelect(node.path)}
          className="min-w-0 flex-1 text-left text-xs py-1.5 pr-2 text-[#555]"
          title={node.path}
        >
          <span className="truncate inline-block max-w-[135px] align-bottom">{node.name}</span>
          <span className="ml-1 text-[#999]">{node.count}</span>
        </button>
      </div>
      {expanded && hasChildren && (
        <div className="ml-4 mt-1 space-y-1">
          {node.children.map((child) => (
            <FolderNode
              key={child.path}
              node={child}
              activePath={activePath}
              expandedFolders={expandedFolders}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
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
    paused: "text-gray-500 border-gray-200 bg-gray-50",
    missing_secret: "text-amber-600 border-amber-200 bg-amber-50",
    error: "text-red-600 border-red-200 bg-red-50",
  };
  const hoverDescription = firstLine(worker.long_description);

  return (
    <Card
      className="border-[#eaeaea] shadow-none bg-white hover:border-[#d4d4d8] transition-colors"
      title={hoverDescription || undefined}
    >
      <CardContent className="p-5 space-y-3">
        <div className="flex items-start justify-between">
          <div className="flex items-center gap-2">
            <Box className="w-4 h-4 text-[#999]" />
            <h3 className="font-medium text-[15px]">{worker.name}</h3>
          </div>
          <Badge variant="outline" className={statusColor[worker.status] || statusColor.healthy}>
            {worker.status.replace("_", " ")}
          </Badge>
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
        <div className="flex items-center gap-3 text-xs text-[#999]">
          <span>Trigger: {worker.trigger_type}</span>
          <span>Runner: {worker.runner}</span>
        </div>
        {worker.last_run && (
          <p className="text-xs text-[#999]">
            Last run: {worker.last_run.created_at ? new Date(worker.last_run.created_at).toLocaleString() : "—"} · {worker.last_run.status}
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
              {worker.status === "paused" ? "View (paused)" : "Run worker"}
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
