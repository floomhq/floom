"use client";

// v6 standalone share card (brain file / brain pack / worker). ONE fixed-height
// card. Brain content is NAVIGABLE like the in-app brain: a shared pack lists
// its files + folders with real previews and lets you click between them via
// breadcrumbs (root -> folder -> file); a shared file renders its actual content
// inline through the GENERIC renderer. A sticky bottom "Add to workspace" CTA
// stays pinned. The old `npx ... add <token>` install artifact is dropped.
import { useMemo, useState } from "react";
import Link from "next/link";
import { ChevronRight, Download, FileText, Folder, Package, X } from "lucide-react";
import { GenericOutput } from "@/components/generic-output";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { WorkerShareCard } from "@/components/share/WorkerShareCard";
import { SHARE_CARD_BODY_HEIGHT, FloomMark } from "@/components/share/ShareCardShell";
import type { PublicShareFile, StandaloneShare } from "@/lib/types";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Map a file's mime/display type + extension to a GenericOutput type.
function fileOutputType(file: PublicShareFile): string {
  const hint = `${file.display_type || ""} ${file.mime_type || ""} ${file.path}`.toLowerCase();
  if (/\.(json)$|application\/json/.test(hint)) return "json";
  if (/\.(csv|tsv)$|text\/csv/.test(hint)) return "csv";
  if (/\.(md|mdx|markdown)$|markdown/.test(hint)) return "markdown";
  if (/\.(png|jpe?g|gif|webp|svg)$|^image|\bimage\b/.test(hint)) return "file";
  return "text";
}

type Node =
  | { kind: "folder"; name: string; fileCount: number }
  | { kind: "file"; file: PublicShareFile };

// Build the immediate children (folders + files) at a given path prefix from the
// flat file list, mirroring the in-app brain's nested folder view.
function childrenAt(files: PublicShareFile[], prefix: string): Node[] {
  const folders = new Map<string, number>();
  const directFiles: PublicShareFile[] = [];
  for (const file of files) {
    if (prefix && !file.path.startsWith(prefix)) continue;
    const rest = prefix ? file.path.slice(prefix.length) : file.path;
    const slash = rest.indexOf("/");
    if (slash === -1) {
      directFiles.push(file);
    } else {
      const folderName = rest.slice(0, slash);
      folders.set(folderName, (folders.get(folderName) ?? 0) + 1);
    }
  }
  const nodes: Node[] = [];
  for (const [name, fileCount] of [...folders.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    nodes.push({ kind: "folder", name, fileCount });
  }
  for (const file of directFiles.sort((a, b) => a.path.localeCompare(b.path))) {
    nodes.push({ kind: "file", file });
  }
  return nodes;
}

function baseName(path: string): string {
  return path.split("/").pop() || path;
}

export function StandaloneShareCard({
  share,
  token,
  authed = false,
}: {
  share: StandaloneShare;
  token: string;
  authed?: boolean;
}) {
  const isSingleFile = share.entity_type === "brain_file";
  const files = useMemo(() => share.files || [], [share.files]);

  // FL4: signed-in visitors land back on their dashboard; logged-out prospects
  // keep the login-bound "Add to workspace" prompt.
  const ctaHref = authed ? "/" : "/login";
  const ctaLabel = authed ? "Dashboard" : "Add to workspace";

  // Navigation state: "" = root; a string ending in "/" = folder prefix; a path
  // (no trailing slash) that matches a file = file view.
  const [folderPrefix, setFolderPrefix] = useState("");
  const [openFilePath, setOpenFilePath] = useState<string | null>(
    isSingleFile ? share.file?.path ?? files[0]?.path ?? null : null,
  );

  const openFile = useMemo(() => {
    if (!openFilePath) return null;
    return files.find((f) => f.path === openFilePath) || share.file || null;
  }, [openFilePath, files, share.file]);

  const nodes = useMemo(() => childrenAt(files, folderPrefix), [files, folderPrefix]);

  const downloadHref = `/s/${encodeURIComponent(token)}/download`;

  // Worker shares reuse the v6 worker flip-card (DRY).
  if (share.entity_type === "worker" && share.worker) {
    return (
      <div className="mx-auto w-full px-3 py-10" style={{ maxWidth: 680 }}>
        <div className="rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] shadow-[var(--shadow-pop)]">
          <WorkerShareCard worker={share.worker} authed={authed} token={token} />
        </div>
      </div>
    );
  }

  // Breadcrumb segments for the current location.
  const crumbs: { label: string; onClick?: () => void }[] = [
    { label: "Brain" },
    {
      label: share.title,
      onClick: openFilePath || folderPrefix ? () => { setFolderPrefix(""); setOpenFilePath(null); } : undefined,
    },
  ];
  if (folderPrefix && !openFilePath) {
    const parts = folderPrefix.replace(/\/$/, "").split("/");
    let acc = "";
    parts.forEach((part, i) => {
      acc += part + "/";
      const prefixSoFar = acc;
      crumbs.push({
        label: `${part}/`,
        onClick: i < parts.length - 1 ? () => { setFolderPrefix(prefixSoFar); setOpenFilePath(null); } : undefined,
      });
    });
  }
  if (openFilePath) {
    // folder context before the file
    const dir = openFilePath.includes("/") ? openFilePath.slice(0, openFilePath.lastIndexOf("/") + 1) : "";
    if (dir) {
      crumbs.push({ label: dir, onClick: () => { setFolderPrefix(dir); setOpenFilePath(null); } });
    }
    crumbs.push({ label: baseName(openFilePath) });
  }

  const showClose = Boolean(folderPrefix || openFilePath) && !isSingleFile;

  return (
    <div className="mx-auto w-full px-3 py-10" style={{ maxWidth: 760 }}>
      <div className="rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)] shadow-[var(--shadow-pop)]">
        {/* Nav */}
        <div className="flex items-center justify-between rounded-t-[var(--radius-card)] [border-bottom:var(--bd-div)] bg-[var(--bg-card)] px-5 py-3">
          <FloomMark />
          <Link href={ctaHref} className="text-sm text-[var(--ink-soft)] no-underline hover:text-[var(--ink)]">
            {ctaLabel}
          </Link>
        </div>

        <div className="px-7 pb-1 pt-4">
          {/* Breadcrumb */}
          <div className="mb-3 flex items-center justify-between gap-3">
            <nav className="flex flex-wrap items-center gap-1.5 text-[13px] text-[var(--ink-soft)]" aria-label="Breadcrumb">
              {crumbs.map((c, i) => (
                <span key={i} className="inline-flex items-center gap-1.5">
                  {i > 0 && <span className="text-[var(--ink-faint)]">/</span>}
                  {c.onClick ? (
                    <button type="button" onClick={c.onClick} className="hover:text-[var(--ink)]">
                      {c.label}
                    </button>
                  ) : (
                    <span className={i === crumbs.length - 1 ? "font-medium text-[var(--ink)]" : ""}>{c.label}</span>
                  )}
                </span>
              ))}
            </nav>
            {showClose && (
              <button
                type="button"
                onClick={() => { setFolderPrefix(""); setOpenFilePath(null); }}
                className="inline-flex h-7 items-center gap-1 rounded-[var(--radius-button)] px-2.5 text-xs text-[var(--ink-soft)] hover:bg-[var(--bg-2)]"
              >
                <X className="size-3" />
                Close
              </button>
            )}
          </div>

          {/* ONE card, fixed height — content swaps in place */}
          <div
            className="flex flex-col overflow-hidden rounded-[var(--radius-card)] [border:var(--bd-card)] bg-[var(--bg-card)]"
            style={{ height: SHARE_CARD_BODY_HEIGHT }}
          >
            {openFile ? (
              <FileView
                file={openFile}
                packTitle={share.title}
                downloadHref={downloadHref}
                ctaHref={ctaHref}
                ctaLabel={ctaLabel}
              />
            ) : (
              <PackView
                share={share}
                nodes={nodes}
                folderPrefix={folderPrefix}
                onOpenFolder={(name) => setFolderPrefix(folderPrefix + name + "/")}
                onOpenFile={(path) => setOpenFilePath(path)}
                ctaHref={ctaHref}
                ctaLabel={ctaLabel}
              />
            )}
          </div>
        </div>

        <div className="px-7 pb-5 pt-3">
          <p className="text-xs text-[var(--ink-faint)]">
            Shared via <span className="font-medium text-[var(--ink-soft)]">Floom</span>. Review the visible content before adding it to your workspace.
          </p>
        </div>
      </div>
    </div>
  );
}

function PackView({
  share,
  nodes,
  folderPrefix,
  onOpenFolder,
  onOpenFile,
  ctaHref,
  ctaLabel,
}: {
  share: StandaloneShare;
  nodes: Node[];
  folderPrefix: string;
  onOpenFolder: (name: string) => void;
  onOpenFile: (path: string) => void;
  ctaHref: string;
  ctaLabel: string;
}) {
  const atRoot = folderPrefix === "";
  const fileCount = nodes.filter((n) => n.kind === "file").length;
  const folderCount = nodes.filter((n) => n.kind === "folder").length;

  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {atRoot && (
          <div className="[border-bottom:var(--bd-div)] px-5 py-4">
            <div className="mb-1 flex items-center gap-2">
              <Package className="size-4 text-[var(--ink-soft)]" />
              <h1 className="text-lg font-semibold tracking-tight">{share.title}</h1>
            </div>
            {share.description && (
              <p className="mb-3 text-sm leading-relaxed text-[var(--ink-soft)]">{share.description}</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Metric label="Files" value={share.pack?.file_count ?? share.files.length} />
              {folderCount > 0 && <Metric label="Folders" value={folderCount} />}
              {share.pack?.total_size_bytes != null && (
                <Metric label="Size" value={formatBytes(share.pack.total_size_bytes)} />
              )}
            </div>
          </div>
        )}

        <div className="px-5 py-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-[var(--ink-soft)]">
            {atRoot ? "Files" : `${folderPrefix.replace(/\/$/, "")} — ${fileCount} file${fileCount === 1 ? "" : "s"}`}
          </p>
          <div className="flex flex-col gap-1">
            {nodes.length === 0 && <p className="text-sm text-[var(--ink-soft)]">This folder is empty.</p>}
            {nodes.map((node) =>
              node.kind === "folder" ? (
                <button
                  key={`folder-${node.name}`}
                  type="button"
                  onClick={() => onOpenFolder(node.name)}
                  className="flex items-center gap-3 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-app)] px-3 py-2.5 text-left hover:bg-[rgba(107,104,97,0.07)]"
                >
                  <Folder className="size-3.5 shrink-0 text-[var(--ink-soft)]" />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs font-medium">{node.name}/</p>
                    <p className="mt-0.5 text-[11px] text-[var(--ink-soft)]">
                      {node.fileCount} file{node.fileCount === 1 ? "" : "s"}
                    </p>
                  </div>
                  <ChevronRight className="size-3 shrink-0 text-[var(--ink-faint)]" />
                </button>
              ) : (
                <button
                  key={`file-${node.file.path}`}
                  type="button"
                  onClick={() => onOpenFile(node.file.path)}
                  className="flex items-center gap-3 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-app)] px-3 py-2.5 text-left hover:bg-[rgba(107,104,97,0.07)]"
                >
                  <FileText className="size-3.5 shrink-0 text-[var(--ink-soft)]" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-mono text-xs font-medium">{baseName(node.file.path)}</p>
                    <p className="mt-0.5 text-[11px] text-[var(--ink-soft)]">
                      {formatBytes(node.file.size)}
                      {node.file.display_type ? ` · ${node.file.display_type}` : ""}
                    </p>
                  </div>
                  <span className="shrink-0 rounded-[var(--radius-button)] [border:var(--bd-card)] px-2.5 py-1 text-[11px] text-[var(--ink-soft)]">
                    Open
                  </span>
                </button>
              ),
            )}
          </div>
        </div>
      </div>

      {/* Sticky CTA */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 [border-top:var(--bd-div)] bg-[var(--bg-2)] px-5 py-3">
        <p className="text-xs text-[var(--ink-soft)]">Add this folder so your workers can use it.</p>
        <Link
          href={ctaHref}
          className="inline-flex h-9 items-center rounded-[var(--radius-button)] bg-[var(--primary)] px-4 text-[13px] font-medium text-[var(--primary-text)] no-underline hover:opacity-90"
        >
          {ctaLabel}
        </Link>
      </div>
    </>
  );
}

function FileView({
  file,
  packTitle,
  downloadHref,
  ctaHref,
  ctaLabel,
}: {
  file: PublicShareFile;
  packTitle: string;
  downloadHref: string;
  ctaHref: string;
  ctaLabel: string;
}) {
  const type = fileOutputType(file);
  const content = file.content_text ?? "";
  return (
    <>
      {/* File header */}
      <div className="flex shrink-0 items-center gap-3 [border-bottom:var(--bd-div)] bg-[var(--bg-card)] px-5 py-3.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-app)]">
          <FileText className="size-4 text-[var(--ink-soft)]" />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate font-mono text-[13px] font-medium">{baseName(file.path)}</p>
          <p className="mt-0.5 text-[11px] text-[var(--ink-soft)]">
            {[file.display_type, formatBytes(file.size)].filter(Boolean).join(" · ")}
          </p>
        </div>
        {file.download_url && (
          <a
            href={file.download_url}
            download
            className="inline-flex size-7 items-center justify-center rounded-[var(--radius-button)] [border:var(--bd-card)] text-[var(--ink-soft)] no-underline hover:bg-[var(--bg-2)]"
            title="Download"
          >
            <Download className="size-3.5" />
          </a>
        )}
      </div>

      {/* File content via GENERIC renderer */}
      <div className="min-h-0 flex-1 overflow-y-auto bg-[var(--bg-card)] px-5 py-4">
        {file.is_binary && type === "file" ? (
          <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <BrandLogo icon={file.display_type || "file"} className="size-8 text-[var(--ink-faint)]" />
            <p className="text-sm text-[var(--ink-soft)]">Binary file — download to view.</p>
          </div>
        ) : content ? (
          <GenericOutput type={type} value={content} />
        ) : (
          <p className="text-sm text-[var(--ink-soft)]">Preview is unavailable for this file.</p>
        )}
      </div>

      {/* Sticky CTA */}
      <div className="flex shrink-0 flex-wrap items-center gap-3 [border-top:var(--bd-div)] bg-[var(--bg-2)] px-5 py-3">
        <Link
          href={ctaHref}
          className="inline-flex h-9 items-center rounded-[var(--radius-button)] bg-[var(--primary)] px-4 text-[13px] font-medium text-[var(--primary-text)] no-underline hover:opacity-90"
        >
          {ctaLabel}
        </Link>
        <a
          href={downloadHref}
          className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-button)] [border:var(--bd-card)] px-3.5 text-[13px] font-medium no-underline hover:bg-[var(--bg-2)]"
        >
          <Download className="size-3.5" />
          Download
        </a>
        <p className="ml-auto text-[11px] text-[var(--ink-faint)]">
          From <span className="font-medium text-[var(--ink-soft)]">{packTitle}</span>
        </p>
      </div>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string | number }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-[var(--bg-app)] px-3 py-1.5 text-xs">
      <span className="text-[var(--ink-soft)]">{label}</span>
      <span className="font-medium">{value}</span>
    </span>
  );
}
