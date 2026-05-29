"use client";

import { useEffect, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Check,
  Download,
  File as FileIcon,
  FileCode,
  FileText,
  Image as ImageIcon,
  Link as LinkIcon,
  Plus,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ContextDetail, ContextFileItem } from "@/lib/types";
import { Button } from "@/components/ui/button";
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

export default function PackDetailPage() {
  const { name } = useParams<{ name: string }>();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [detail, setDetail] = useState<ContextDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [dragActive, setDragActive] = useState(false);

  const packName = decodeURIComponent(name);

  useEffect(() => {
    api.contexts.get(packName)
      .then(setDetail)
      .catch((err: unknown) => toast.error(err instanceof Error ? err.message : "Failed to load pack"))
      .finally(() => setLoading(false));
  }, [packName]);

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
      await api.contexts.upload(packName, files);
      const refreshed = await api.contexts.get(packName);
      setDetail(refreshed);
      toast.success("File added");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to add file");
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
          <div className="flex items-center justify-between mb-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Files</p>
            <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()} className="h-7 text-xs gap-1">
              <Plus className="size-3.5" />
              Add file
            </Button>
          </div>

          {detail.files.length === 0 ? (
            <div className="rounded-lg border border-dashed border-[var(--border-default)] p-6 text-center">
              <p className="text-sm text-muted-foreground">This pack is empty. Add a file to get started.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {detail.files.map((file) => (
                <div
                  key={file.path}
                  className="group flex items-center gap-3 rounded-lg border border-[var(--border-default)] bg-[var(--bg-app)] px-3 py-2.5 hover:bg-muted/40 transition-colors cursor-pointer"
                  onClick={() => openFile(file)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") openFile(file); }}
                >
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
                    <Button size="sm" variant="outline" className="h-7 text-xs" onClick={(e) => { e.stopPropagation(); openFile(file); }}>
                      Open
                    </Button>
                    <CopyFileLinkButton packName={packName} filePath={file.path} />
                    <a
                      href={api.contexts.fileUrl(packName, file.path)}
                      title="Download"
                      onClick={(e) => e.stopPropagation()}
                      className="p-1 rounded hover:bg-muted inline-flex"
                    >
                      <Download className="size-3.5 text-muted-foreground" />
                    </a>
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); void deleteFile(file); }}
                      className="p-1 rounded hover:bg-muted"
                      title="Delete file"
                    >
                      <Trash2 className="size-3.5 text-muted-foreground hover:text-destructive" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {dragActive && (
            <div className="mt-2 rounded-lg border-2 border-dashed border-[var(--border-default)] p-4 text-center text-sm text-muted-foreground">
              Drop files here to add them
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
