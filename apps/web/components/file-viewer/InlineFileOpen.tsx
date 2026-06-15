"use client";

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react";
import { ArrowLeft, Download, Folder as FolderIcon, Pencil, Plus, Save, Upload, X } from "lucide-react";
import { isImageFile } from "@/lib/runs/trace";
import { SqliteTableView } from "@/components/file-viewer/SqliteTableView";
import { CodeBlock } from "@/components/file-viewer/code-block";
import { MarkdownRenderer } from "@/components/contexts/markdown-renderer";
import type { SqliteView } from "@/lib/types";

function isDbFile(name: string): boolean {
  return /\.(db|sqlite|sqlite3)$/i.test(name);
}

function isMarkdownFile(name: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(name);
}

/**
 * Whether a text file has a "rendered" representation distinct from its raw
 * source. Markdown renders to formatted prose; code files render with syntax
 * highlighting. Plain `.txt` has no richer view, so the Preview/Raw toggle is
 * still shown (#1289 — every file gets the toggle) but both modes look alike.
 */
function previewKind(name: string): "markdown" | "code" | "plain" {
  if (isMarkdownFile(name)) return "markdown";
  if (/\.(txt|log|text)$/i.test(name)) return "plain";
  return "code";
}

const ROW_DRAG_MIME = "application/x-workeros-brain-row";
const FOLDER_PLACEHOLDER_FILE = ".workeros-folder";

export type InlineDragItem =
  | { kind: "file"; path: string; name: string; dir: string }
  | { kind: "folder"; path: string; name: string; dir: string };

function isFolderPlaceholder(path: string): boolean {
  const parts = path.split("/");
  return parts[parts.length - 1] === FOLDER_PLACEHOLDER_FILE;
}

function safeFolderSegment(raw: string): string {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean)[0]
    ?.replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63) ?? "";
}

// APP-UI-V4-SPEC rule #5 / §4: ONE inline file-open pattern, shared by Brain and
// Run outputs. Files open INLINE (breadcrumb `<root> / file`, Back, Download) —
// never a popup. Images render as images.
export interface InlineFile {
  id: string;
  name: string;
  /** Download / image source URL. */
  url: string;
  sizeBytes?: number;
  /** Known-binary (e.g. .db) — never text-loaded; shows the download fallback. */
  binary?: boolean;
  /** #780: file tags (Brain) rendered as quiet chips in the row. */
  tags?: string[];
}

function sizeLabel(bytes?: number): string {
  if (!bytes) return "";
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

export function InlineFileOpen({
  files,
  rootLabel,
  emptyLabel = "No files.",
  loadText,
  onRename,
  onMoveItem,
  onCreateSubfolder,
  onSaveText,
  loadSqlite,
  onUpload,
}: {
  files: InlineFile[];
  rootLabel: string;
  emptyLabel?: string;
  /** Text-content loader (Brain: readTextFile). Omitted → download-only fallback. */
  loadText?: (file: InlineFile) => Promise<string>;
  /** #770: when provided, each row offers an inline rename (never a native prompt). */
  onRename?: (file: InlineFile, newName: string) => Promise<void>;
  /** Move a file or folder row into another folder via the backend move endpoint. */
  onMoveItem?: (item: InlineDragItem, targetDir: string) => Promise<void>;
  /** Create a durable empty subfolder at the current directory prefix. */
  onCreateSubfolder?: (dirPrefix: string, folderName: string) => Promise<void>;
  /** Save the edited text content for the open file. */
  onSaveText?: (file: InlineFile, content: string) => Promise<void>;
  /** #777: load a .db file's tables/rows for the inline SQLite viewer. */
  loadSqlite?: (file: InlineFile, table?: string) => Promise<SqliteView>;
  /**
   * When provided, the list view becomes a drag-and-drop dropzone (and exposes
   * a Browse button). `dirPrefix` is the current navigated subfolder ("" = root)
   * so dropped files land where the operator is looking. Omitted → read-only.
   */
  onUpload?: (files: File[], dirPrefix: string) => Promise<void>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [dir, setDir] = useState(""); // #783: current folder prefix ("" = root)
  const [uploadDragOver, setUploadDragOver] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draggingRow, setDraggingRow] = useState<InlineDragItem | null>(null);
  const [orderedIds, setOrderedIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [subfolderName, setSubfolderName] = useState("");
  const [subfolderBusy, setSubfolderBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState("");
  const [savingEdit, setSavingEdit] = useState(false);
  // #1289: rendered (Preview) vs raw source (Raw) for the open text file.
  const [viewMode, setViewMode] = useState<"preview" | "raw">("preview");
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const open = files.find((f) => f.id === openId) ?? null;
  const brainDnD = Boolean(onMoveItem || onCreateSubfolder);

  useEffect(() => {
    setOrderedIds((current) => {
      const live = new Set(files.map((f) => f.id));
      const kept = current.filter((id) => live.has(id));
      const added = files.map((f) => f.id).filter((id) => !kept.includes(id));
      return [...kept, ...added];
    });
  }, [files]);

  const doUpload = async (dropped: File[]) => {
    if (!onUpload || dropped.length === 0) return;
    setUploading(true);
    try {
      await onUpload(dropped, dir);
    } finally {
      setUploading(false);
    }
  };

  const baseName = (path: string) => (path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path);
  const currentDirLabel = dir ? dir.replace(/\/$/, "") : rootLabel;
  const fileForPath = (path: string) => files.find((f) => f.id === path || f.name === path);

  const submitRename = async (file: InlineFile) => {
    const next = renameValue.trim();
    if (!onRename || !next || next === baseName(file.name)) {
      setRenamingId(null);
      return;
    }
    setRenameBusy(true);
    try {
      await onRename(file, next);
      setRenamingId(null);
    } finally {
      setRenameBusy(false);
    }
  };

  const submitSubfolder = async () => {
    const next = safeFolderSegment(subfolderName);
    if (!onCreateSubfolder || !next || subfolderBusy) return;
    setSubfolderBusy(true);
    try {
      await onCreateSubfolder(dir, next);
      setCreatingFolder(false);
      setSubfolderName("");
    } finally {
      setSubfolderBusy(false);
    }
  };

  const startDrag = (e: DragEvent, item: InlineDragItem) => {
    setDraggingRow(item);
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData(ROW_DRAG_MIME, JSON.stringify(item));
  };

  const dragItemFromEvent = (e: DragEvent): InlineDragItem | null => {
    const raw = e.dataTransfer.getData(ROW_DRAG_MIME);
    if (!raw) return draggingRow;
    try {
      return JSON.parse(raw) as InlineDragItem;
    } catch {
      return draggingRow;
    }
  };

  const isRowDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes(ROW_DRAG_MIME);
  const isFileUploadDrag = (e: DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

  const moveIntoDir = async (e: DragEvent, targetDir: string) => {
    if (!onMoveItem) return;
    const item = dragItemFromEvent(e);
    setDropTarget(null);
    setDraggingRow(null);
    if (!item) return;
    if (item.kind === "file" && item.dir === targetDir) return;
    if (item.kind === "folder") {
      if (item.path === targetDir || targetDir.startsWith(item.path)) return;
      if (`${targetDir}${item.name}/` === item.path) return;
    }
    await onMoveItem(item, targetDir);
  };

  const reorderRows = (dragId: string, targetId: string) => {
    if (dragId === targetId) return;
    setOrderedIds((current) => {
      const next = current.length ? [...current] : files.map((f) => f.id);
      const from = next.indexOf(dragId);
      const to = next.indexOf(targetId);
      if (from === -1 || to === -1) return next;
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };

  const saveEdit = async () => {
    if (!open || !onSaveText || savingEdit) return;
    setSavingEdit(true);
    try {
      await onSaveText(open, editValue);
      setText(editValue);
      setEditing(false);
    } finally {
      setSavingEdit(false);
    }
  };

  const canLoadText = !!loadText && !!open && !open.binary && !isImageFile(open.name);
  const canEditText = !!onSaveText && canLoadText;
  useEffect(() => {
    setText(null);
    setEditing(false);
    setEditValue("");
    setViewMode("preview");
    if (!canLoadText || !open || !loadText) return;
    let alive = true;
    setLoading(true);
    loadText(open)
      .then((t) => alive && setText(t))
      .catch(() => alive && setText("(could not read file)"))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openId]);

  useEffect(() => {
    if (!editing) return;
    setEditValue(text ?? "");
  }, [editing, text]);

  const sortedFiles = useMemo(() => {
    if (!orderedIds.length) return files;
    const rank = new Map(orderedIds.map((id, index) => [id, index]));
    return [...files].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER));
  }, [files, orderedIds]);

  if (files.length === 0 && !onUpload) {
    return <div style={{ color: "var(--muted-foreground)", padding: 14 }}>{emptyLabel}</div>;
  }

  if (open) {
    return (
      <div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            marginBottom: 10,
            fontSize: 12.5,
          }}
        >
          <button type="button" className="c-vpill" style={{ padding: "4px 9px" }} onClick={() => setOpenId(null)}>
            <ArrowLeft size={13} /> Back
          </button>
          <span style={{ color: "var(--muted-foreground)" }}>
            {rootLabel} / <span style={{ color: "var(--ink)" }}>{open.name}</span>
          </span>
          {/* #1289: Preview / Raw segmented toggle — rendered vs raw source.
              Hidden while editing (the editor is always raw text). */}
          {canLoadText && !editing && (
            <div className="c-vtog" role="group" aria-label="View mode" style={{ marginLeft: "auto" }}>
              <button
                type="button"
                className={viewMode === "preview" ? "on" : ""}
                aria-pressed={viewMode === "preview"}
                onClick={() => setViewMode("preview")}
              >
                Preview
              </button>
              <button
                type="button"
                className={viewMode === "raw" ? "on" : ""}
                aria-pressed={viewMode === "raw"}
                onClick={() => setViewMode("raw")}
              >
                Raw
              </button>
            </div>
          )}
          {/* #1289: refined Edit affordance — a clear icon+label pill grouped
              with the other file actions, only shown when editing is possible
              and not already underway (was a lone, awkward right-floated pill). */}
          {canEditText && !editing && (
            <button
              type="button"
              className="c-vpill"
              style={{ padding: "4px 9px", marginLeft: canLoadText ? 0 : "auto" }}
              disabled={loading}
              onClick={() => {
                setEditing(true);
                setEditValue(text ?? "");
              }}
            >
              <Pencil size={13} /> Edit
            </button>
          )}
          {editing && (
            <>
              <button
                type="button"
                className="c-vpill"
                style={{ padding: "4px 9px", marginLeft: "auto" }}
                disabled={savingEdit}
                onClick={() => void saveEdit()}
              >
                <Save size={13} /> {savingEdit ? "Saving..." : "Save"}
              </button>
              <button
                type="button"
                className="c-vpill"
                style={{ padding: "4px 9px" }}
                disabled={savingEdit}
                onClick={() => setEditing(false)}
              >
                <X size={13} /> Cancel
              </button>
            </>
          )}
          <a
            href={open.url}
            download={open.name}
            className="c-vpill"
            style={{ marginLeft: canLoadText || canEditText || editing ? 0 : "auto", padding: "4px 9px", textDecoration: "none" }}
          >
            <Download size={13} /> Download
          </a>
        </div>
        {isImageFile(open.name) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={open.url}
            alt={open.name}
            style={{ maxWidth: "100%", borderRadius: "var(--radius-ui)", display: "block" }}
          />
        ) : canLoadText ? (
          loading ? (
            <div style={{ color: "var(--muted-foreground)", padding: 14 }}>Loading…</div>
          ) : editing ? (
            <textarea
              className="c-file-edit"
              value={editValue}
              disabled={savingEdit}
              onChange={(e) => setEditValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") void saveEdit();
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : viewMode === "preview" ? (
            // #1289 Preview: markdown → rendered prose; code → syntax-highlighted;
            // plain text → readable wrapped block.
            previewKind(open.name) === "markdown" ? (
              <div style={{ maxHeight: 420, overflow: "auto" }}>
                <MarkdownRenderer content={text ?? ""} />
              </div>
            ) : previewKind(open.name) === "code" ? (
              <div style={{ maxHeight: 420, overflow: "auto" }}>
                <CodeBlock text={text ?? ""} filePath={open.name} />
              </div>
            ) : (
              <pre
                style={{
                  border: "var(--bd-card)",
                  borderRadius: "var(--radius-card)",
                  background: "var(--bg-2)",
                  color: "var(--ink-soft)",
                  padding: 13,
                  whiteSpace: "pre-wrap",
                  overflow: "auto",
                  fontSize: 12,
                  fontFamily: "var(--font-mono)",
                  maxHeight: 420,
                }}
              >
                {text ?? ""}
              </pre>
            )
          ) : (
            // #1289 Raw: always the unstyled source, regardless of file type.
            <pre
              style={{
                borderRadius: "var(--radius-ui)",
                background: "var(--bg-2)",
                color: "var(--ink-soft)",
                padding: 13,
                whiteSpace: "pre-wrap",
                overflow: "auto",
                fontSize: 12,
                fontFamily: "var(--font-mono)",
                maxHeight: 420,
              }}
            >
              {text ?? ""}
            </pre>
          )
        ) : isDbFile(open.name) && loadSqlite ? (
          // #777: inline SQLite table viewer (Brain supplies the loader).
          <SqliteTableView load={(table) => loadSqlite(open, table)} />
        ) : (
          <div style={{ color: "var(--muted-foreground)", padding: 14 }}>
            {isDbFile(open.name)
              ? "SQLite database; use Download to open this file."
              : "Preview isn't available inline yet; use Download to open this file."}
            {/* TODO(#815): richer artifact preview. */}
          </div>
        )}
      </div>
    );
  }

  // #783: fold nested paths into navigable folders at the current `dir` level.
  const levelFiles = sortedFiles.filter(
    (f) => !isFolderPlaceholder(f.name) && f.name.startsWith(dir) && !f.name.slice(dir.length).includes("/"),
  );
  const folderSet = new Set<string>();
  for (const f of files) {
    if (!f.name.startsWith(dir)) continue;
    const rest = f.name.slice(dir.length);
    const slash = rest.indexOf("/");
    if (slash > 0) folderSet.add(rest.slice(0, slash));
  }
  const folders = Array.from(folderSet).sort();
  const crumbs = dir ? dir.replace(/\/$/, "").split("/") : [];
  const visibleCount = folders.length + levelFiles.length;

  return (
    <div
      onDragOver={
        onUpload
          ? (e) => {
              e.preventDefault();
              if (!dragOver) setDragOver(true);
            }
          : undefined
      }
      onDragLeave={
        onUpload
          ? (e) => {
              // Only clear when the pointer actually leaves the dropzone (not a child).
              if (e.currentTarget === e.target) setDragOver(false);
            }
          : undefined
      }
      onDrop={
        onUpload
          ? (e) => {
              e.preventDefault();
              setDragOver(false);
              const dropped = Array.from(e.dataTransfer.files);
              void doUpload(dropped);
            }
          : undefined
      }
      style={
        onUpload
          ? {
              position: "relative",
              borderRadius: "var(--radius-ui)",
              // ds-allow-border: drag target affordance while files are over the drop zone.
              outline: dragOver ? "2px dashed var(--ink-soft)" : "2px dashed transparent",
              outlineOffset: 4,
              transition: "outline-color .12s ease",
            }
          : undefined
      }
    >
      {/* Upload affordance — drag files anywhere onto the list, or Browse. */}      {onUpload && (
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const picked = Array.from(e.target.files ?? []);
            void doUpload(picked);
            e.target.value = "";
          }}
        />
      )}
      {/* Breadcrumb for nested folders. */}
      {dir && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8, fontSize: 12.5 }}>
          <button type="button" className="c-vpill" style={{ padding: "3px 8px" }} onClick={() => setDir("")}>
            {rootLabel}
          </button>
          {crumbs.map((c, i) => (
            <span key={i} style={{ color: "var(--muted-foreground)" }}>
              /{" "}
              <button
                type="button"
                style={{ background: "none", border: 0, cursor: "pointer", color: "var(--ink)", padding: 0 }}
                onClick={() => setDir(crumbs.slice(0, i + 1).join("/") + "/")}
              >
                {c}
              </button>
            </span>
          ))}
        </div>
      )}
      {brainDnD && (
        <div className="c-brain-hint">
          <span className="c-row-grip" aria-hidden="true">⠿</span>
          <span>Drag rows to reorder, or drop into another folder</span>
          {onCreateSubfolder && (
            <button
              type="button"
              className="c-vpill"
              style={{ marginLeft: "auto", padding: "4px 9px" }}
              onClick={() => setCreatingFolder((value) => !value)}
            >
              <Plus size={13} /> New subfolder
            </button>
          )}
        </div>
      )}
      {creatingFolder && (
        <div className="c-subfolder-form">
          <span style={{ color: "var(--muted-foreground)", fontSize: 12 }}>Create in {currentDirLabel}</span>
          <input
            className="c-srch"
            autoFocus
            style={{ maxWidth: 220, padding: "6px 10px" }}
            value={subfolderName}
            disabled={subfolderBusy}
            placeholder="reports"
            onChange={(e) => setSubfolderName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submitSubfolder();
              if (e.key === "Escape") setCreatingFolder(false);
            }}
          />
          <button type="button" className="c-vpill" disabled={subfolderBusy || !safeFolderSegment(subfolderName)} onClick={() => void submitSubfolder()}>
            {subfolderBusy ? "Creating..." : "Create"}
          </button>
        </div>
      )}
      {visibleCount === 0 ? (
        <div style={{ color: "var(--muted-foreground)", padding: 14 }}>{emptyLabel}</div>
      ) : null}
      <div className="c-ltable">
      {folders.map((name) => (
        <div
          key={`dir:${name}`}
          role="button"
          tabIndex={0}
          className={`c-lrow c-brain-row ${dropTarget === `${dir}${name}/` ? "drop-target" : ""}`}
          draggable={brainDnD}
          style={{ gridTemplateColumns: "auto 1fr auto" }}
          onDragStart={(e) => startDrag(e, { kind: "folder", path: `${dir}${name}/`, name, dir })}
          onDragEnd={() => {
            setDraggingRow(null);
            setDropTarget(null);
          }}
          onDragOver={(e) => {
            if (!onMoveItem || !isRowDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            setDropTarget(`${dir}${name}/`);
          }}
          onDragLeave={() => setDropTarget(null)}
          onDrop={(e) => {
            if (!onMoveItem || !isRowDrag(e)) return;
            e.preventDefault();
            void moveIntoDir(e, `${dir}${name}/`);
          }}
          onClick={() => setDir(`${dir}${name}/`)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") setDir(`${dir}${name}/`);
          }}
        >
          {brainDnD && <span className="c-row-grip" aria-hidden="true">⠿</span>}
          <div className="c-lprimary">
            <span className="c-logo">
              <FolderIcon size={15} />
            </span>
            <div className="c-lp-tx">
              <div className="nm">{name}/</div>
              <div className="sub">subfolder · {files.filter((f) => !isFolderPlaceholder(f.name) && f.name.startsWith(`${dir}${name}/`)).length} files</div>
            </div>
          </div>
          <span className="c-cell m">›</span>
        </div>
      ))}
      {levelFiles.map((f) => {
        const renaming = renamingId === f.id;
        const display = f.name.slice(dir.length);
        const rowItem: InlineDragItem = { kind: "file", path: f.id, name: display, dir };
        return (
          <div
            key={f.id}
            className="c-lrow c-brain-row"
            tabIndex={brainDnD ? 0 : undefined}
            draggable={brainDnD}
            style={{ gridTemplateColumns: brainDnD ? "auto 1fr auto" : "1fr auto", alignItems: "center", display: "grid" }}
            onDragStart={(e) => startDrag(e, rowItem)}
            onDragEnd={() => {
              setDraggingRow(null);
              setDropTarget(null);
            }}
            onDragOver={(e) => {
              if (!isRowDrag(e)) return;
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }}
            onDrop={(e) => {
              if (!isRowDrag(e)) return;
              e.preventDefault();
              const item = dragItemFromEvent(e);
              setDraggingRow(null);
              if (item?.kind === "file") reorderRows(fileForPath(item.path)?.id ?? item.path, f.id);
            }}
          >
            {brainDnD && <span className="c-row-grip" aria-hidden="true">⠿</span>}
            <div className="c-lprimary">
              <div className="c-lp-tx" style={{ width: "100%" }}>
                {renaming ? (
                  <input
                    className="c-srch"
                    autoFocus
                    style={{ maxWidth: 260, fontFamily: "var(--font-mono)" }}
                    value={renameValue}
                    disabled={renameBusy}
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void submitRename(f);
                      if (e.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={() => void submitRename(f)}
                  />
                ) : (
                  <button
                    type="button"
                    className="nm"
                    style={{ fontFamily: "var(--font-mono)", background: "none", border: 0, padding: 0, cursor: "pointer", textAlign: "left" }}
                    onClick={() => setOpenId(f.id)}
                  >
                    {display}
                  </button>
                )}
                {f.tags && f.tags.length > 0 ? (
                  <div style={{ display: "flex", gap: 4, marginTop: 3, flexWrap: "wrap" }}>
                    {f.tags.map((t) => (
                      <span
                        key={t}
                        style={{
                          fontSize: 10.5,
                          padding: "1px 7px",
                          borderRadius: "var(--radius-ui)",
                          background: "var(--bg-2)",
                          color: "var(--muted-foreground)",
                        }}
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              {onRename && !renaming && (
                <button
                  type="button"
                  className="c-vpill"
                  style={{ padding: "2px 8px", fontSize: 11 }}
                  onClick={() => {
                    setRenameValue(baseName(f.name));
                    setRenamingId(f.id);
                  }}
                >
                  Rename
                </button>
              )}
              <span className="c-cell m">{sizeLabel(f.sizeBytes)}</span>
            </div>
          </div>
        );
      })}
      </div>
      {onUpload && (
        <div
          className={`c-brain-dropzone ${uploadDragOver ? "over" : ""}`}
          onDragOver={(e) => {
            if (!isFileUploadDrag(e)) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = "copy";
            setUploadDragOver(true);
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setUploadDragOver(false);
          }}
          onDrop={(e) => {
            if (!isFileUploadDrag(e)) return;
            e.preventDefault();
            setUploadDragOver(false);
            void doUpload(Array.from(e.dataTransfer.files));
          }}
        >
          <Upload size={16} />
          <span>{uploading ? "Uploading..." : "Drag files here to upload, or"}</span>
          <button type="button" className="c-brain-dropzone-link" disabled={uploading} onClick={() => fileInputRef.current?.click()}>
            browse
          </button>
        </div>
      )}
    </div>
  );
}
