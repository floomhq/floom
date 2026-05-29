"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  Check,
  File as FileIcon,
  FileCode,
  FileText,
  Image as ImageIcon,
  Link as LinkIcon,
  Lock,
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

export default function ContextsPageShell() {
  return (
    <Suspense>
      <ContextsPage />
    </Suspense>
  );
}

function ContextsPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [contexts, setContexts] = useState<ContextSummary[]>([]);
  const [selectedName, setSelectedName] = useState<string>(() => searchParams.get("pack") ?? "");
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [newContextName, setNewContextName] = useState("");
  const [showNewContext, setShowNewContext] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  // Keep URL in sync with selected pack so the link is shareable/refreshable.
  useEffect(() => {
    if (selectedName) {
      const next = `?pack=${encodeURIComponent(selectedName)}`;
      if (typeof window !== "undefined" && window.location.search !== next) {
        router.replace(`/contexts${next}`, { scroll: false });
      }
    }
  }, [selectedName, router]);

  const loadContexts = useCallback(async (nextSelected?: string) => {
    const items = await api.contexts.list();
    setContexts(items);
    setSelectedName((current) => {
      // Default to the first operator-owned pack; only fall back to a system
      // pack when there are no operator packs yet. This keeps the create CTA
      // front-and-center for a fresh operator instead of opening a read-only
      // engine pack.
      const firstOperator = items.find((c) => !c.system)?.name;
      const fallback = firstOperator || items[0]?.name || "";
      const selected = nextSelected !== undefined ? nextSelected : (current || fallback);
      if (selected) {
        api.contexts.get(selected).then(setDetail).catch(() => setDetail(null));
      } else {
        setDetail(null);
      }
      return selected;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    // G5 FIX 5 (P2-A): the initial load occasionally hit a transient
    // "Failed to fetch" (network hiccup / cold proxy) and surfaced the raw
    // browser error as a toast, even though /contexts returns 200 [] correctly.
    // Retry once on a transient fetch error before alarming the operator, and
    // never show the raw "Failed to fetch" string.
    const isTransientFetchError = (error: unknown) =>
      error instanceof TypeError ||
      (error instanceof Error && /failed to fetch|load failed|network/i.test(error.message));

    (async () => {
      try {
        await loadContexts();
      } catch (error: unknown) {
        if (isTransientFetchError(error)) {
          try {
            await new Promise((r) => setTimeout(r, 600));
            if (cancelled) return;
            await loadContexts();
          } catch {
            if (!cancelled) toast.error("Couldn't reach the server. Check your connection and retry.");
          }
        } else if (!cancelled) {
          toast.error(error instanceof Error ? error.message : "Failed to load knowledge packs");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [loadContexts]);

  const filteredContexts = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contexts;
    return contexts.filter((c) => c.name.toLowerCase().includes(q));
  }, [contexts, search]);

  const operatorPacks = useMemo(() => filteredContexts.filter((c) => !c.system), [filteredContexts]);
  const systemPacks = useMemo(() => filteredContexts.filter((c) => c.system), [filteredContexts]);
  const hasOperatorPacks = useMemo(() => contexts.some((c) => !c.system), [contexts]);

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
    if (context.read_only) return; // System packs are not deletable.
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
    if (!selectedName || files.length === 0) return;
    if (detail?.read_only) {
      toast.error("System packs are read-only.");
      return;
    }
    try {
      await api.contexts.upload(selectedName, files);
      await loadContexts(selectedName);
      toast.success("File added");
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

          <div className="flex-1 overflow-y-auto">
            {filteredContexts.length === 0 && (
              <div className="p-4 text-center">
                <p className="text-sm text-muted-foreground">No matches.</p>
              </div>
            )}

            {/* Your packs */}
            {operatorPacks.length > 0 ? (
              <div className="divide-y divide-[var(--border-default)]">
                {operatorPacks.map((ctx) => (
                  <PackRow
                    key={ctx.name}
                    ctx={ctx}
                    selected={ctx.name === selectedName}
                    onSelect={() => void selectContext(ctx.name)}
                    onDelete={() => void deleteContext(ctx)}
                  />
                ))}
              </div>
            ) : (
              !search.trim() && (
                <div className="p-4">
                  <button
                    type="button"
                    onClick={() => setShowNewContext(true)}
                    className="w-full rounded-[var(--radius-button)] border border-dashed border-[var(--border-default)] px-3 py-4 text-left hover:bg-muted/40 transition-colors"
                  >
                    <span className="flex items-center gap-2 text-sm font-medium">
                      <Plus className="size-4" />
                      New knowledge pack
                    </span>
                    <span className="mt-1 block text-xs text-muted-foreground">
                      Company facts, ICP, and brand voice your workers read before they act.
                    </span>
                  </button>
                </div>
              )
            )}

            {/* System packs (read-only) */}
            {systemPacks.length > 0 && (
              <div>
                <p className="px-3 pt-4 pb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  System
                </p>
                <div className="divide-y divide-[var(--border-default)]">
                  {systemPacks.map((ctx) => (
                    <PackRow
                      key={ctx.name}
                      ctx={ctx}
                      selected={ctx.name === selectedName}
                      onSelect={() => void selectContext(ctx.name)}
                      onDelete={() => void deleteContext(ctx)}
                    />
                  ))}
                </div>
              </div>
            )}
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
            <div className="flex-1 flex items-center justify-center p-8">
              <div className="max-w-md text-center space-y-4">
                <div className="space-y-1.5">
                  <h2 className="text-base font-semibold">Give your workers knowledge</h2>
                  <p className="text-sm text-muted-foreground">
                    A knowledge pack is a small set of files your workers read before they act:
                    company facts, your ICP, product details, and brand voice. Attach a pack to a
                    worker and it references that context on every run.
                  </p>
                </div>
                <Button onClick={() => setShowNewContext(true)}>
                  <Plus className="size-4" />
                  New knowledge pack
                </Button>
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

function PackRow({
  ctx,
  selected,
  onSelect,
  onDelete,
}: {
  ctx: ContextSummary;
  selected: boolean;
  onSelect: () => void;
  onDelete: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copyLink(e: React.MouseEvent) {
    e.stopPropagation();
    const url = `${window.location.origin}/contexts?pack=${encodeURIComponent(ctx.name)}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") onSelect(); }}
      className={`group relative flex w-full items-start gap-2.5 px-3 py-3 text-left transition-colors cursor-pointer ${
        selected
          ? "bg-[var(--active-nav-bg)] border-l-2 border-l-[var(--border-default)]"
          : "hover:bg-muted/40"
      }`}
    >
      <span className="mt-0.5 text-muted-foreground">{selected ? "●" : "○"}</span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-1.5">
          <span className="truncate text-sm font-medium">{ctx.name}</span>
          {ctx.read_only && (
            <span
              className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border-default)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground shrink-0"
              title="Read-only system pack"
            >
              <Lock className="size-2.5" />
              Read-only
            </span>
          )}
        </span>
        {ctx.description && (
          <span className="block truncate text-xs text-muted-foreground mt-0.5">{ctx.description}</span>
        )}
        <span className="block text-xs text-muted-foreground mt-0.5">
          {ctx.file_count} {ctx.file_count === 1 ? "file" : "files"} · {ctx.worker_count} {ctx.worker_count === 1 ? "worker" : "workers"}
        </span>
      </span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity mt-0.5">
        <button
          type="button"
          onClick={copyLink}
          className="p-1 rounded hover:bg-muted"
          title="Copy link to this pack"
        >
          {copied ? <Check className="size-3.5 text-green-600" /> : <LinkIcon className="size-3.5 text-muted-foreground" />}
        </button>
        {!ctx.read_only && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.stopPropagation(); onDelete(); } }}
            className="p-1 rounded hover:bg-muted"
            title={`Delete ${ctx.name}`}
          >
            <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
          </button>
        )}
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
  const [packLinkCopied, setPackLinkCopied] = useState(false);

  function copyPackLink() {
    const url = `${window.location.origin}/contexts?pack=${encodeURIComponent(detail.name)}`;
    navigator.clipboard.writeText(url).then(() => {
      setPackLinkCopied(true);
      setTimeout(() => setPackLinkCopied(false), 1500);
    });
  }

  const readOnly = Boolean(detail.read_only);

  return (
    <div className={`flex flex-col flex-1 overflow-hidden transition-colors ${dragActive && !readOnly ? "bg-muted/30" : ""}`}>
      {/* Pack header */}
      <div className="border-b border-[var(--border-default)] px-5 py-4 shrink-0">
        <div className="flex items-start justify-between gap-2">
          <h2 className="flex items-center gap-2 text-base font-semibold">
            {detail.name}
            {readOnly && (
              <span
                className="inline-flex items-center gap-0.5 rounded-full border border-[var(--border-default)] px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                title="Read-only system pack"
              >
                <Lock className="size-2.5" />
                Read-only
              </span>
            )}
          </h2>
          <button
            type="button"
            onClick={copyPackLink}
            className="p-1 rounded hover:bg-muted text-muted-foreground transition-colors shrink-0"
            title="Copy link to this pack"
          >
            {packLinkCopied ? <Check className="size-3.5 text-green-600" /> : <LinkIcon className="size-3.5" />}
          </button>
        </div>
        {readOnly && (
          <p className="mt-2 text-xs text-muted-foreground">
            This is a Workeros engine pack. It shapes how workers are generated and is read-only.
          </p>
        )}
        {detail.description ? (
          <p className="text-sm text-muted-foreground mt-0.5">{detail.description}</p>
        ) : (
          <p className="text-xs text-muted-foreground mt-0.5 italic">
            No description. Add a README.md to this pack.
          </p>
        )}

        {/* Stats row. Federico Image #17 (2026-05-29): the used-by worker(s)
            belong in the TOP panel, visible at a glance — Files · Used by
            [worker] · Size. The redundant "Workers" count pill is replaced by
            the actual worker chip(s); the separate lower "Used by" section is
            gone. */}
        <div className="flex flex-wrap items-center gap-3 mt-3">
          <div className="flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Files</span>
            <span className="text-xs font-medium">{detail.file_count}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-1.5 min-w-0">
            <span className="text-xs text-muted-foreground shrink-0">Used by</span>
            {(detail.used_by ?? []).length === 0 ? (
              <span className="text-xs text-muted-foreground italic">none yet</span>
            ) : (
              <span className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 min-w-0">
                {(detail.used_by ?? []).map((ref, i, arr) => (
                  <span key={ref.worker_id} className="inline-flex items-center min-w-0">
                    <Link
                      href={`/workers/${encodeURIComponent(ref.worker_id)}`}
                      className="text-xs font-medium hover:underline truncate"
                    >
                      {ref.worker_name}
                    </Link>
                    {i < arr.length - 1 && <span className="text-xs text-muted-foreground ml-1.5">·</span>}
                  </span>
                ))}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-1.5">
            <span className="text-xs text-muted-foreground">Size</span>
            <span className="text-xs font-medium">{formatBytes(detail.total_size_bytes)}</span>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
        {/* Files */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Files</p>
            {!readOnly && (
              <Button size="sm" variant="outline" onClick={onAddFile} className="h-7 text-xs gap-1">
                <Plus className="size-3.5" />
                Add file
              </Button>
            )}
          </div>

          {detail.files.length === 0 ? (
            <div className="rounded-[var(--radius-button)] border border-dashed border-[var(--border-default)] p-6 text-center">
              {readOnly ? (
                <p className="text-sm text-muted-foreground">This system pack has no files.</p>
              ) : (
                <>
                  <p className="text-sm text-muted-foreground">This pack is empty. Add a file to get started.</p>
                  <Button size="sm" variant="outline" className="mt-3" onClick={onAddFile}>
                    <Plus className="size-4" />
                    Add file
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {detail.files.map((file) => (
                <FileCard
                  key={file.path}
                  file={file}
                  packName={detail.name}
                  readOnly={readOnly}
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
  packName,
  readOnly,
  onOpen,
  onDelete,
}: {
  file: ContextFileItem;
  packName: string;
  readOnly?: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  const [fileLinkCopied, setFileLinkCopied] = useState(false);

  function copyFileLink(e: React.MouseEvent) {
    e.stopPropagation();
    const pathEncoded = file.path.split("/").map(encodeURIComponent).join("/");
    const url = `${window.location.origin}/contexts/${encodeURIComponent(packName)}/files/${pathEncoded}`;
    navigator.clipboard.writeText(url).then(() => {
      setFileLinkCopied(true);
      setTimeout(() => setFileLinkCopied(false), 1500);
    });
  }

  return (
    <div className="group flex items-center gap-3 rounded-[var(--radius-button)] border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-2.5 hover:bg-muted/40 transition-colors">
      {displayTypeIcon(file.display_type ?? "File")}
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
          onClick={copyFileLink}
          className="p-1 rounded hover:bg-muted"
          title="Copy link to this file"
        >
          {fileLinkCopied ? <Check className="size-3.5 text-green-600" /> : <LinkIcon className="size-3.5 text-muted-foreground" />}
        </button>
        {!readOnly && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onDelete(); }}
            className="p-1 rounded hover:bg-muted"
            title="Delete file"
          >
            <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
          </button>
        )}
      </div>
    </div>
  );
}
