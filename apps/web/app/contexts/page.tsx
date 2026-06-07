"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  File as FileIcon,
  FileCode,
  FileText,
  Image as ImageIcon,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ContextDetail, ContextFileItem, ContextSummary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function displayTypeIcon(displayType: string) {
  if (displayType === "Markdown") return <FileText className="size-4 shrink-0 text-muted-foreground" />;
  if (["YAML", "Python", "JavaScript", "TypeScript", "JSON", "Shell", "SQL"].includes(displayType))
    return <FileCode className="size-4 shrink-0 text-muted-foreground" />;
  if (displayType === "Image") return <ImageIcon className="size-4 shrink-0 text-muted-foreground" />;
  return <FileIcon className="size-4 shrink-0 text-muted-foreground" />;
}

function packNameFromFiles(files: FileList | File[], existing: ContextSummary[]): string {
  const first = Array.from(files)[0];
  const baseName = (first?.name || "My brain")
    .replace(/\.[^.]+$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "my-brain";
  const existingNames = new Set(existing.map((item) => item.name));
  let candidate = baseName;
  let suffix = 2;
  while (existingNames.has(candidate)) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

export default function ContextsPage() {
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [contexts, setContexts] = useState<ContextSummary[]>([]);
  const [selectedName, setSelectedName] = useState<string>("");
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [newContextName, setNewContextName] = useState("");
  const [showNewContext, setShowNewContext] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const loadContexts = useCallback(async (nextSelected?: string) => {
    const items = await api.contexts.list();
    setContexts(items);
    const selected = nextSelected !== undefined ? nextSelected : (selectedName || items[0]?.name || "");
    setSelectedName(selected);
    if (selected) {
      const loaded = await api.contexts.get(selected);
      setDetail(loaded);
    } else {
      setDetail(null);
    }
  }, [selectedName]);

  useEffect(() => {
    loadContexts()
      .catch((error: unknown) => toast.error(error instanceof Error ? error.message : "Failed to load knowledge packs"))
      .finally(() => setLoading(false));
  }, [loadContexts]);

  const filteredContexts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contexts;
    return contexts.filter((c) => c.name.toLowerCase().includes(q));
  }, [contexts, search]);

  async function selectContext(name: string) {
    setSelectedName(name);
    try {
      setDetail(await api.contexts.get(name));
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to load knowledge pack");
    }
  }

  async function createContext() {
    const name = newContextName.trim();
    if (!name) return;
    try {
      await api.contexts.create(name);
      setNewContextName("");
      setShowNewContext(false);
      await loadContexts(name);
      toast.success("Knowledge pack created");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to create knowledge pack");
    }
  }

  async function deleteContext(context: ContextSummary) {
    if (!confirm(`Delete knowledge pack "${context.name}"? This cannot be undone.`)) return;
    try {
      await api.contexts.delete(context.name, true);
      const remaining = contexts.filter((item) => item.name !== context.name);
      setContexts(remaining);
      await loadContexts(remaining[0]?.name || "");
      toast.success("Knowledge pack deleted");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to delete knowledge pack");
    }
  }

  async function deleteFile(file: ContextFileItem) {
    if (!selectedName || !confirm(`Delete "${file.path}"?`)) return;
    try {
      const next = await api.contexts.deleteFile(selectedName, file.path);
      setDetail(next);
      await loadContexts(selectedName);
      toast.success("File deleted");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to delete file");
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    if (files.length === 0) return;
    const shouldCreateFolder = !selectedName || !detail || detail.system || detail.read_only;
    const targetName = shouldCreateFolder ? packNameFromFiles(files, contexts) : selectedName;
    try {
      await api.contexts.upload(targetName, files, { createIfMissing: shouldCreateFolder });
      await loadContexts(targetName);
      toast.success(shouldCreateFolder ? "Folder created" : "File added");
    } catch (error: unknown) {
      toast.error(error instanceof Error ? error.message : "Failed to add file");
    }
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="space-y-1">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-72" />
        </div>
        <div className="flex gap-4" style={{ minHeight: 520 }}>
          <Skeleton className="w-[25%] min-w-[240px] max-w-[320px] rounded-[var(--radius-button)]" />
          <Skeleton className="flex-1 rounded-[var(--radius-button)]" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5" style={{ height: "calc(100vh - 120px)" }}>
      {/* Page header */}
      <div className="flex items-start justify-between gap-4 shrink-0">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Contexts</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Reusable knowledge packs your workers can read before they act.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowNewContext(true)}>
          <Plus className="size-4" />
          New
        </Button>
      </div>

      {/* New context inline form */}
      {showNewContext && (
        <div className="shrink-0 flex items-center gap-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2">
          <Input
            autoFocus
            value={newContextName}
            onChange={(e) => setNewContextName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void createContext();
              if (e.key === "Escape") { setShowNewContext(false); setNewContextName(""); }
            }}
            placeholder="knowledge-base"
            className="h-8 w-56"
          />
          <Button size="sm" onClick={createContext} disabled={!newContextName.trim()}>Create</Button>
          <Button size="sm" variant="ghost" onClick={() => { setShowNewContext(false); setNewContextName(""); }}>
            <X className="size-4" />
          </Button>
        </div>
      )}

      {/* 25/75 split */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: pack list (25%) */}
        <section className="flex flex-col rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden min-w-[240px] max-w-[320px] w-[25%]">
          <div className="border-b border-[var(--border-default)] p-3 shrink-0">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-2">Knowledge packs</p>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search packs..."
                className="h-7 pl-8 text-sm"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-[var(--border-default)]">
            {filteredContexts.length === 0 && (
              <div className="p-4 text-center">
                {contexts.length === 0 ? (
                  <div className="space-y-2">
                    <p className="text-sm text-muted-foreground">No knowledge packs yet.</p>
                    <p className="text-xs text-muted-foreground">Add your first one.</p>
                  </div>
                ) : (
                  <p className="text-sm text-muted-foreground">No matches.</p>
                )}
              </div>
            )}
            {filteredContexts.map((ctx) => (
              <div
                key={ctx.name}
                role="button"
                tabIndex={0}
                onClick={() => void selectContext(ctx.name)}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") void selectContext(ctx.name); }}
                className={`group relative flex w-full items-start gap-2.5 px-3 py-3 text-left transition-colors cursor-pointer ${
                  ctx.name === selectedName
                    ? "bg-[var(--active-nav-bg)] border-l-2 border-l-[var(--border-default)]"
                    : "hover:bg-muted/40"
                }`}
              >
                <span className="mt-0.5 text-muted-foreground">{ctx.name === selectedName ? "●" : "○"}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium">{ctx.name}</span>
                  {ctx.description && (
                    <span className="block truncate text-xs text-muted-foreground mt-0.5">{ctx.description}</span>
                  )}
                  <span className="block text-xs text-muted-foreground mt-0.5">
                    {ctx.file_count} {ctx.file_count === 1 ? "file" : "files"} · {ctx.worker_count} {ctx.worker_count === 1 ? "worker" : "workers"}
                  </span>
                </span>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); void deleteContext(ctx); }}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); void deleteContext(ctx); } }}
                  className="opacity-0 group-hover:opacity-100 transition-opacity mt-0.5"
                  title={`Delete ${ctx.name}`}
                >
                  <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                </button>
              </div>
            ))}
          </div>
        </section>

        {/* Right: pack detail (75%) */}
        <section
          className="flex-1 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden flex flex-col"
          onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => { e.preventDefault(); setDragActive(false); void uploadFiles(e.dataTransfer.files); }}
        >
          {!selectedName ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="text-center space-y-2">
                <p className="text-sm text-muted-foreground">Select a knowledge pack to manage it.</p>
              </div>
            </div>
          ) : !detail ? (
            <div className="flex-1 flex items-center justify-center">
              <Skeleton className="h-10 w-48" />
            </div>
          ) : (
            <PackDetail
              detail={detail}
              dragActive={dragActive}
              onOpenFile={(file) => router.push(`/contexts/${encodeURIComponent(detail.name)}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`)}
              onDeleteFile={deleteFile}
              onAddFile={() => fileInputRef.current?.click()}
            />
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void uploadFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </section>
      </div>
    </div>
  );
}

function PackDetail({
  detail,
  dragActive,
  onOpenFile,
  onDeleteFile,
  onAddFile,
}: {
  detail: ContextDetail;
  dragActive: boolean;
  onOpenFile: (file: ContextFileItem) => void;
  onDeleteFile: (file: ContextFileItem) => Promise<void>;
  onAddFile: () => void;
}) {
  return (
    <div className={`flex flex-col flex-1 overflow-hidden transition-colors ${dragActive ? "bg-muted/30" : ""}`}>
      {/* Pack header */}
      <div className="border-b border-[var(--border-default)] px-5 py-4 shrink-0">
        <h2 className="text-base font-semibold">{detail.name}</h2>
        {detail.description ? (
          <p className="text-sm text-muted-foreground mt-0.5">{detail.description}</p>
        ) : (
          <p className="text-xs text-muted-foreground mt-0.5 italic">
            No description. Add a README.md to this pack.
          </p>
        )}

        {/* Stats row */}
        <div className="flex gap-3 mt-3">
          <div className="flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Files</span>
            <span className="text-xs font-medium">{detail.file_count}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Workers</span>
            <span className="text-xs font-medium">{detail.worker_count}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Size</span>
            <span className="text-xs font-medium">{formatBytes(detail.total_size_bytes)}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Used by */}
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Used by</p>
          {detail.used_by.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No workers reference this pack yet. Workers attach contexts in their <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">worker.yml</code>.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {detail.used_by.map((ref) => (
                <Link
                  key={ref.worker_id}
                  href={`/workers/${encodeURIComponent(ref.worker_id)}`}
                  className="inline-flex items-center rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-2.5 py-1 text-sm hover:bg-muted transition-colors"
                >
                  {ref.worker_name}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Files */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Files</p>
            <Button size="sm" variant="outline" onClick={onAddFile} className="h-7 text-xs gap-1">
              <Plus className="size-3.5" />
              Add file
            </Button>
          </div>

          {detail.files.length === 0 ? (
            <div className="rounded-[var(--radius-button)] border border-dashed border-[var(--border-default)] p-6 text-center">
              <p className="text-sm text-muted-foreground">This pack is empty. Add a file to get started.</p>
              <Button size="sm" variant="outline" className="mt-3" onClick={onAddFile}>
                <Plus className="size-4" />
                Add file
              </Button>
            </div>
          ) : (
            <div className="space-y-1">
              {detail.files.map((file) => (
                <FileCard
                  key={file.path}
                  file={file}
                  onOpen={() => onOpenFile(file)}
                  onDelete={() => onDeleteFile(file)}
                />
              ))}
            </div>
          )}

          {dragActive && (
            <div className="mt-2 rounded-[var(--radius-button)] border-2 border-dashed border-[var(--border-default)] p-4 text-center text-sm text-muted-foreground">
              Drop files here to add them
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function FileCard({
  file,
  onOpen,
  onDelete,
}: {
  file: ContextFileItem;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex items-center gap-3 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-2.5 hover:bg-muted/40 transition-colors">
      {displayTypeIcon(file.display_type)}
      <div className="min-w-0 flex-1">
        <p className="text-sm font-mono truncate">{file.path}</p>
        <p className="text-xs text-muted-foreground mt-0.5 truncate">
          {file.description || <span className="italic">(no description)</span>}
        </p>
        <p className="text-xs text-muted-foreground mt-0.5">
          {formatBytes(file.size)} · {file.display_type}
        </p>
      </div>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        <Button size="sm" variant="outline" onClick={onOpen} className="h-7 text-xs">
          Open
        </Button>
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          className="p-1 rounded hover:bg-muted"
          title="Delete file"
        >
          <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
        </button>
      </div>
    </div>
  );
}
