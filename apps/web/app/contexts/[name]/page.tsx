"use client";

import { Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Download,
  File as FileIcon,
  FileCode,
  FilePlus,
  FileText,
  Folder,
  Image as ImageIcon,
  Link as LinkIcon,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ContextDetail, ContextFileItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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

type FolderEntry = { kind: "folder"; name: string; path: string; fileCount: number; size: number };
type FileEntry = { kind: "file"; name: string; file: ContextFileItem };
type Entry = FolderEntry | FileEntry;

/** Normalize a folder path: trim slashes, collapse blanks. "" = root. */
function normalizeFolder(raw: string | null | undefined): string {
  if (!raw) return "";
  return raw
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join("/");
}

/**
 * Build the immediate children (folders + files) of `currentFolder` from a flat
 * file list. Folders are derived from path prefixes; a folder exists if any file
 * lives anywhere beneath it.
 */
function buildEntries(files: ContextFileItem[], currentFolder: string): Entry[] {
  const prefix = currentFolder ? `${currentFolder}/` : "";
  const folders = new Map<string, { fileCount: number; size: number }>();
  const directFiles: FileEntry[] = [];

  for (const file of files) {
    if (currentFolder && !file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      directFiles.push({ kind: "file", name: rest, file });
    } else {
      const folderName = rest.slice(0, slash);
      const agg = folders.get(folderName) ?? { fileCount: 0, size: 0 };
      agg.fileCount += 1;
      agg.size += file.size;
      folders.set(folderName, agg);
    }
  }

  const folderEntries: FolderEntry[] = [...folders.entries()]
    .map(([name, agg]) => ({
      kind: "folder" as const,
      name,
      path: currentFolder ? `${currentFolder}/${name}` : name,
      fileCount: agg.fileCount,
      size: agg.size,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  directFiles.sort((a, b) => a.name.localeCompare(b.name));

  return [...folderEntries, ...directFiles];
}

export default function PackDetailPage() {
  return (
    <Suspense fallback={<Skeleton className="h-7 w-64" />}>
      <PackDetailContent />
    </Suspense>
  );
}

function PackDetailContent() {
  const { name } = useParams<{ name: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [dragActive, setDragActive] = useState(false);
  const [newFileOpen, setNewFileOpen] = useState(false);
  const [newFilePath, setNewFilePath] = useState("");
  const [creating, setCreating] = useState(false);

  const packName = decodeURIComponent(name);
  const currentFolder = normalizeFolder(searchParams.get("path"));

  useEffect(() => {
    api.contexts.get(packName)
      .then(setDetail)
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Failed to load pack"))
      .finally(() => setLoading(false));
  }, [packName]);

  const entries = useMemo(
    () => (detail ? buildEntries(detail.files, currentFolder) : []),
    [detail, currentFolder]
  );

  function navigateFolder(folderPath: string) {
    const target = normalizeFolder(folderPath);
    const qs = target ? `?path=${encodeURIComponent(target)}` : "";
    router.push(`/contexts/${encodeURIComponent(packName)}${qs}`);
  }

  async function deleteFile(file: ContextFileItem) {
    if (!confirm(`Delete "${file.path}"?`)) return;
    try {
      const next = await api.contexts.deleteFile(packName, file.path);
      setDetail(next);
      toast.success("File deleted");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to delete file");
    }
  }

  async function uploadFiles(files: FileList | File[]) {
    if (files.length === 0) return;
    try {
      // Upload into the current folder so dropped/picked files land where the
      // operator is looking, not at the pack root.
      await api.contexts.upload(packName, files, currentFolder || undefined);
      const refreshed = await api.contexts.get(packName);
      setDetail(refreshed);
      toast.success("File added");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to add file");
    }
  }

  function openNewFile() {
    // Prefill with the current folder so a new file lands here by default.
    setNewFilePath(currentFolder ? `${currentFolder}/` : "");
    setNewFileOpen(true);
  }

  async function createFile() {
    const rel = normalizeFolder(newFilePath);
    if (!rel) {
      toast.error("Enter a file name or path");
      return;
    }
    if (newFilePath.trim().endsWith("/")) {
      toast.error("Path must end in a file name, e.g. SOP/onboarding.md");
      return;
    }
    if (detail?.files.some((f) => f.path === rel)) {
      toast.error("A file already exists at that path");
      return;
    }
    setCreating(true);
    try {
      await api.contexts.saveTextFile(packName, rel, "");
      const refreshed = await api.contexts.get(packName);
      setDetail(refreshed);
      setNewFileOpen(false);
      toast.success("File created");
      // Drill into the folder the new file landed in.
      const slash = rel.lastIndexOf("/");
      if (slash !== -1) navigateFolder(rel.slice(0, slash));
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to create file");
    } finally {
      setCreating(false);
    }
  }

  function openFile(file: ContextFileItem) {
    router.push(`/contexts/${encodeURIComponent(packName)}/files/${file.path.split("/").map(encodeURIComponent).join("/")}`);
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-7 w-64" />
        <div className="flex gap-4" style={{ minHeight: 400 }}>
          <Skeleton className="flex-1 rounded-xl" />
        </div>
      </div>
    );
  }

  if (!detail) {
    return (
      <div className="space-y-4">
        <Link href="/contexts" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-4" /> Back to contexts
        </Link>
        <p className="text-sm text-muted-foreground">Knowledge pack not found.</p>
      </div>
    );
  }

  const folderSegments = currentFolder ? currentFolder.split("/") : [];

  return (
    <div className="flex flex-col gap-5" style={{ height: "calc(100vh - 120px)" }}>
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-sm shrink-0">
        <Link href="/contexts" className="text-muted-foreground hover:text-foreground transition-colors">
          Contexts
        </Link>
        <span className="text-muted-foreground">/</span>
        <span className="font-medium">{detail.name}</span>
      </div>

      {/* Header */}
      <div className="shrink-0">
        <h1 className="text-xl font-semibold tracking-tight">{detail.name}</h1>
        {detail.description ? (
          <p className="text-sm text-muted-foreground mt-0.5">{detail.description}</p>
        ) : (
          <p className="text-xs text-muted-foreground mt-0.5 italic">No description. Add a README.md.</p>
        )}
        <div className="flex gap-3 mt-3">
          {[
            { label: "Files", value: detail.file_count ?? 0 },
            { label: "Workers", value: detail.worker_count ?? 0 },
            { label: "Size", value: formatBytes(detail.total_size_bytes ?? 0) },
          ].map(({ label, value }) => (
            <div key={label} className="flex items-center gap-1.5 rounded-md border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-1.5">
              <span className="text-xs text-muted-foreground">{label}</span>
              <span className="text-xs font-medium">{value}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-5">
        {/* Used by */}
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">Used by</p>
          {(detail.used_by ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No workers reference this pack yet. Workers attach contexts in their{" "}
              <code className="text-xs font-mono bg-muted px-1 py-0.5 rounded">worker.yml</code>.
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {(detail.used_by ?? []).map((ref) => (
                <Link
                  key={ref.worker_id}
                  href={`/workers/${encodeURIComponent(ref.worker_id)}`}
                  className="inline-flex items-center rounded-md border border-[var(--border-default)] bg-[var(--bg-app)] px-2.5 py-1 text-sm hover:bg-muted transition-colors"
                >
                  {ref.worker_name}
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* Files */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragActive(true); }}
          onDragLeave={() => setDragActive(false)}
          onDrop={(e) => { e.preventDefault(); setDragActive(false); void uploadFiles(e.dataTransfer.files); }}
        >
          <div className="flex items-center justify-between mb-2 gap-3 flex-wrap">
            {/* Folder breadcrumb */}
            <div className="flex items-center gap-1 text-xs min-w-0">
              <button
                type="button"
                onClick={() => navigateFolder("")}
                className={`transition-colors ${currentFolder ? "text-muted-foreground hover:text-foreground" : "font-medium text-foreground"}`}
              >
                Files
              </button>
              {folderSegments.map((seg, i) => {
                const segPath = folderSegments.slice(0, i + 1).join("/");
                const isLast = i === folderSegments.length - 1;
                return (
                  <span key={segPath} className="flex items-center gap-1 min-w-0">
                    <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
                    <button
                      type="button"
                      onClick={() => navigateFolder(segPath)}
                      className={`truncate font-mono transition-colors ${isLast ? "font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                    >
                      {seg}
                    </button>
                  </span>
                );
              })}
            </div>
            <div className="flex items-center gap-1.5">
              <Button size="sm" variant="outline" onClick={openNewFile} className="h-7 text-xs gap-1">
                <FilePlus className="size-3.5" />
                New file
              </Button>
              <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} className="h-7 text-xs gap-1">
                <Download className="size-3.5 rotate-180" />
                Upload
              </Button>
            </div>
          </div>

          {entries.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border-default)] p-6 text-center">
              <p className="text-sm text-muted-foreground">
                {currentFolder ? "This folder is empty." : "This pack is empty. Add a file to get started."}
              </p>
              {currentFolder && (
                <button
                  type="button"
                  onClick={() => navigateFolder("")}
                  className="mt-2 text-xs text-[var(--accent)] hover:underline"
                >
                  Back to root
                </button>
              )}
            </div>
          ) : (
            <div className="space-y-1">
              {entries.map((entry) =>
                entry.kind === "folder" ? (
                  <div
                    key={`dir:${entry.path}`}
                    className="group flex items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-2.5 hover:bg-muted/40 transition-colors cursor-pointer"
                    onClick={() => navigateFolder(entry.path)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") navigateFolder(entry.path); }}
                  >
                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-mono truncate">{entry.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {entry.fileCount} {entry.fileCount === 1 ? "file" : "files"} · {formatBytes(entry.size)}
                      </p>
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </div>
                ) : (
                  <div
                    key={`file:${entry.file.path}`}
                    className="group flex items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-2.5 hover:bg-muted/40 transition-colors cursor-pointer"
                    onClick={() => openFile(entry.file)}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openFile(entry.file); }}
                  >
                    {displayTypeIcon(entry.file.display_type ?? "File")}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-mono truncate">{entry.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 truncate">
                        {entry.file.description || <span className="italic">(no description)</span>}
                      </p>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        {formatBytes(entry.file.size)} · {entry.file.display_type}
                      </p>
                    </div>
                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); openFile(entry.file); }}>
                        Open
                      </Button>
                      <CopyFileLinkButton packName={packName} filePath={entry.file.path} />
                      <a
                        href={api.contexts.fileUrl(packName, entry.file.path)}
                        title="Download"
                        onClick={(e) => e.stopPropagation()}
                        className="p-1 rounded hover:bg-muted inline-flex"
                      >
                        <Download className="size-3.5 text-muted-foreground" />
                      </a>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); void deleteFile(entry.file); }}
                        className="p-1 rounded hover:bg-muted"
                        title="Delete file"
                      >
                        <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                      </button>
                    </div>
                  </div>
                )
              )}
            </div>
          )}

          {dragActive && (
            <div className="mt-2 rounded-lg border-2 border-dashed border-[var(--border-default)] p-4 text-center text-sm text-muted-foreground">
              Drop files here to add them{currentFolder ? ` to ${currentFolder}` : ""}
            </div>
          )}
        </div>
      </div>

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

      <Dialog open={newFileOpen} onOpenChange={setNewFileOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New file</DialogTitle>
            <DialogDescription>
              Use slashes to create folders, e.g. <span className="font-mono">SOP/onboarding.md</span>.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="new-file-path">File path</Label>
            <Input
              id="new-file-path"
              value={newFilePath}
              autoFocus
              spellCheck={false}
              placeholder="SOP/onboarding.md"
              className="font-mono text-sm"
              onChange={(e) => setNewFilePath(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !creating) void createFile(); }}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewFileOpen(false)} disabled={creating}>
              Cancel
            </Button>
            <Button onClick={() => void createFile()} disabled={creating}>
              {creating ? "Creating…" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function CopyFileLinkButton({ packName, filePath }: { packName: string; filePath: string }) {
  const [copied, setCopied] = useState(false);

  function copyLink(e: React.MouseEvent) {
    e.stopPropagation();
    const pathEncoded = filePath.split("/").map(encodeURIComponent).join("/");
    const url = `${window.location.origin}/contexts/${encodeURIComponent(packName)}/files/${pathEncoded}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }

  return (
    <button
      type="button"
      onClick={copyLink}
      className="p-1 rounded hover:bg-muted inline-flex"
      title="Copy link to this file"
    >
      {copied ? <Check className="size-3.5 text-green-600" /> : <LinkIcon className="size-3.5 text-muted-foreground" />}
    </button>
  );
}
