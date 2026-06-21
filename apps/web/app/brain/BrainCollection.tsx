"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Folder, Lock, Upload, Users } from "lucide-react";
import { api } from "@/lib/api";
import { useContexts } from "@/lib/query/hooks";
import { reportError } from "@/lib/notify";
import { formatRelative } from "@/lib/formatters";
import type { ContextSummary, ContextDetail } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { LoadingState } from "@/components/collection/CollectionStates";
import { InlineFileOpen, type InlineDragItem } from "@/components/file-viewer/InlineFileOpen";
import { visibilityLabel } from "@/lib/permissions";
import { formatBytes, writeKey } from "@/lib/brain/format";

const detailCache = new Map<string, ContextDetail>();
const FOLDER_PLACEHOLDER_FILE = ".workeros-folder";

function useContextDetail(name: string): [ContextDetail | undefined, () => Promise<void>] {
  const [d, setD] = useState<ContextDetail | undefined>(detailCache.get(name));
  const load = (force = false): Promise<void> => {
    if (!force && detailCache.has(name)) {
      setD(detailCache.get(name));
      return Promise.resolve();
    }
    return api.contexts
      .get(name)
      .then((cd) => {
        detailCache.set(name, cd);
        setD(cd);
      })
      .catch((err) => reportError("Could not load folder contents.", err));
  };
  useEffect(() => {
    let alive = true;
    if (detailCache.has(name)) {
      setD(detailCache.get(name));
    } else {
      api.contexts.get(name).then((cd) => {
        detailCache.set(name, cd);
        if (alive) setD(cd);
      }).catch((err) => reportError("Could not load folder contents.", err));
    }
    return () => {
      alive = false;
    };
  }, [name]);
  // #770: reload re-fetches and refreshes the cache (used after move/rename).
  return [d, () => load(true)];
}

// Rule #5: Brain shares the EXACT inline file-open pattern with Run outputs —
// breadcrumb `{folder} / file`, Back, Download; images render as images; text
// loads inline via readTextFile; .db gets the honest #777 fallback.
function FilesTab({ folder }: { folder: ContextSummary }) {
  const [d, reload] = useContextDetail(folder.name);
  if (!d) return <LoadingState rows={4} />;
  const contextFiles = (d.files ?? []).filter((f) => !f.deleted);
  const files = (d.files ?? [])
    .filter((f) => !f.deleted)
    .map((f) => ({
      id: f.path,
      name: f.path,
      url: api.contexts.fileUrl(folder.name, f.path),
      sizeBytes: f.size,
      binary: f.is_binary,
      tags: f.tags, // #780: show file tags as chips
    }));
  // Drag-and-drop upload is only offered when the operator may write to the
  // folder (read-only/system packs stay read-only).
  const canWrite = !folder.read_only && folder.writeable !== false;
  const moveItem = async (item: InlineDragItem, targetDir: string) => {
    if (!canWrite) return;
    try {
      if (item.kind === "file") {
        await api.contexts.moveFile(folder.name, item.path, `${targetDir}${item.name}`);
      } else {
        const sourcePrefix = item.path;
        const targetPrefix = `${targetDir}${item.name}/`;
        const children = contextFiles
          .filter((file) => file.path.startsWith(sourcePrefix))
          .sort((a, b) => a.path.localeCompare(b.path));
        for (const child of children) {
          const rest = child.path.slice(sourcePrefix.length);
          await api.contexts.moveFile(folder.name, child.path, `${targetPrefix}${rest}`);
        }
      }
      toast.success(item.kind === "file" ? `Moved ${item.name}` : `Moved ${item.name}/`);
      await reload();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not move row.");
    }
  };

  return (
    <InlineFileOpen
      files={files}
      rootLabel={folder.name}
      emptyLabel="This folder is empty."
      loadText={(f) => api.contexts.readTextFile(folder.name, f.id)}
      // #777: inline SQLite viewer for .db files.
      loadSqlite={(f, table) => api.contexts.sqlite(folder.name, f.id, table)}
      // .npz array viewer: fetch raw bytes, parsed header-only client-side.
      loadBlob={async (f) => (await api.contexts.fetchFileBlob(folder.name, f.id)).arrayBuffer()}
      // #770: rename a file (move within the same directory), then refresh.
      onRename={async (file, newName) => {
        const dir = file.id.includes("/") ? file.id.slice(0, file.id.lastIndexOf("/") + 1) : "";
        await api.contexts.moveFile(folder.name, file.id, `${dir}${newName}`);
        await reload();
      }}
      onMoveItem={canWrite ? moveItem : undefined}
      onCreateSubfolder={
        canWrite
          ? async (dirPrefix, folderName) => {
              try {
                await api.contexts.saveTextFile(
                  folder.name,
                  `${dirPrefix}${folderName}/${FOLDER_PLACEHOLDER_FILE}`,
                  "",
                );
                toast.success(`Created ${folderName}/`);
                await reload();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Could not create subfolder.");
              }
            }
          : undefined
      }
      onSaveText={
        canWrite
          ? async (file, content) => {
              try {
                await api.contexts.saveTextFile(folder.name, file.id, content, file.tags);
                toast.success(`Saved ${file.name}`);
                await reload();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Could not save file.");
                throw e;
              }
            }
          : undefined
      }
      // Drag-and-drop / Browse upload into the brain folder (#issue-6a).
      onUpload={
        canWrite
          ? async (dropped, dirPrefix) => {
              try {
                await api.contexts.upload(folder.name, dropped, dirPrefix || undefined);
                toast.success(
                  dropped.length === 1 ? "Added 1 file" : `Added ${dropped.length} files`,
                );
                await reload();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Could not upload files.");
              }
            }
          : undefined
      }
    />
  );
}

/** Derive a backend-safe slug from any human-typed name.
 * Backend accepts: ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$
 * "Walk Test Folder" → "walk-test-folder"
 */
function slugifyContextName(raw: string): string {
  return (raw || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")   // spaces/specials → hyphens
    .toLowerCase()
    .replace(/^-+|-+$/g, "")             // trim leading/trailing hyphens
    .slice(0, 63) || "";
}

function NewFolderForm({ onCreated }: { onCreated: () => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = slugifyContextName(name);
  const showSlugHint = name.trim() !== "" && name.trim() !== slug;

  const submit = async () => {
    if (!slug) return;
    setBusy(true);
    setError(null);
    try {
      // #1241/#1243: user-created folders must default to writeable=true so the
      // drop-zone and upload affordances are available immediately after creation.
      await api.contexts.create(slug, true);
      toast.success(`Created "${slug}"`);
      await onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create the folder.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
      <label style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>Folder name</label>
      <input
        className="c-srch"
        style={{ maxWidth: "none" }}
        autoFocus
        value={name}
        onChange={(e) => { setName(e.target.value); setError(null); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        placeholder="e.g. company-facts or Walk Test Folder"
      />
      {showSlugHint && (
        <div style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>
          Saved as: <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink)" }}>{slug}</span>
        </div>
      )}
      {error && (
        <div style={{ fontSize: 12, color: "var(--red, #c0392b)", padding: "6px 10px", background: "var(--bg-2)", borderRadius: 8 }}>
          {error}
        </div>
      )}
      <button type="button" className="c-addbtn" disabled={busy || !slug} onClick={() => void submit()}>
        {busy ? "Creating…" : "Create folder"}
      </button>
    </div>
  );
}

// Secondary create-folder path (drop is primary). Reuses NewFolderForm in a
// centered modal, matching DropCreateFolderOverlay's surface treatment.
function NewFolderModal({
  onCreated,
  onCancel,
}: {
  onCreated: () => void | Promise<void>;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,.35)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          background: "var(--bg-card)",
          border: "var(--bd-card)",
          borderRadius: "var(--radius-card)",
          padding: 24,
          minWidth: 340,
          maxWidth: 440,
          boxShadow: "var(--shadow-pop)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Folder size={16} style={{ color: "var(--ink-soft)" }} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>New folder</span>
        </div>
        <NewFolderForm onCreated={onCreated} />
      </div>
    </div>
  );
}

// #1813: rename an auto-named folder. Mirrors NewFolderForm: free-typed name,
// slugified to the backend-safe form, with a "Saved as" hint when they differ.
function RenameFolderForm({
  folder,
  onRenamed,
}: {
  folder: ContextSummary;
  onRenamed: (newName: string) => void | Promise<void>;
}) {
  const [name, setName] = useState(folder.name);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const slug = slugifyContextName(name);
  const showSlugHint = name.trim() !== "" && name.trim() !== slug;
  const unchanged = slug === folder.name;

  const submit = async () => {
    if (!slug || unchanged) return;
    setBusy(true);
    setError(null);
    try {
      await api.contexts.rename(folder.name, slug);
      toast.success(`Renamed to "${slug}"`);
      await onRenamed(slug);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename the folder.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 420 }}>
      <label style={{ fontSize: 12.5, color: "var(--ink-soft)" }}>Folder name</label>
      <input
        className="c-srch"
        style={{ maxWidth: "none" }}
        autoFocus
        value={name}
        onChange={(e) => { setName(e.target.value); setError(null); }}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        placeholder="e.g. company-facts or Walk Test Folder"
      />
      {showSlugHint && (
        <div style={{ fontSize: 11.5, color: "var(--ink-soft)" }}>
          Saved as: <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink)" }}>{slug}</span>
        </div>
      )}
      {error && (
        <div style={{ fontSize: 12, color: "var(--red, #c0392b)", padding: "6px 10px", background: "var(--bg-2)", borderRadius: 8 }}>
          {error}
        </div>
      )}
      <button type="button" className="c-addbtn" disabled={busy || !slug || unchanged} onClick={() => void submit()}>
        {busy ? "Renaming…" : "Rename folder"}
      </button>
    </div>
  );
}

function RenameFolderModal({
  folder,
  onRenamed,
  onCancel,
}: {
  folder: ContextSummary;
  onRenamed: (newName: string) => void | Promise<void>;
  onCancel: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,.35)",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        style={{
          background: "var(--bg-card)",
          border: "var(--bd-card)",
          borderRadius: "var(--radius-card)",
          padding: 24,
          minWidth: 340,
          maxWidth: 440,
          boxShadow: "var(--shadow-pop)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Folder size={16} style={{ color: "var(--ink-soft)" }} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>Rename folder</span>
        </div>
        <RenameFolderForm folder={folder} onRenamed={onRenamed} />
      </div>
    </div>
  );
}

function UsedByTab({ folder }: { folder: ContextSummary }) {
  const [d] = useContextDetail(folder.name);
  if (!d) return <LoadingState rows={3} />;
  const used = d.used_by ?? [];
  return (
    <div className="c-ltable">
      {used.map((ref) => (
        <Link
          key={ref.worker_id}
          href={`/workers?sel=${encodeURIComponent(ref.worker_id)}`}
          className="c-lrow"
          style={{ gridTemplateColumns: "1fr", textDecoration: "none" }}
        >
          <div className="c-lprimary">
            <div className="c-lp-tx">
              <div className="nm">{ref.worker_name}</div>
            </div>
          </div>
        </Link>
      ))}
      {used.length === 0 && <div style={{ ...muted, padding: 14 }}>No workers use this folder yet.</div>}
    </div>
  );
}

// #1112: When files are dropped on the brain list, prompt for a folder name,
// create the folder, then upload the dropped files into it.
function DropCreateFolderOverlay({
  files,
  onDone,
  onCancel,
}: {
  files: File[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const firstFile = files[0];
  const defaultName = firstFile
    ? slugifyContextName(firstFile.name.replace(/\.[^/.]+$/, ""))
    : "new-folder";
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.select();
  }, []);

  const slug = slugifyContextName(name);
  const showSlugHint = name.trim() !== "" && name.trim() !== slug;

  const submit = useCallback(async () => {
    if (!slug || busy) return;
    setBusy(true);
    setError(null);
    try {
      // #1241/#1243: writeable=true so the created folder accepts uploads.
      await api.contexts.create(slug, true);
      await api.contexts.upload(slug, files, undefined);
      toast.success(
        files.length === 1
          ? `Created "${slug}" and added 1 file`
          : `Created "${slug}" and added ${files.length} files`,
      );
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create folder.");
      setBusy(false);
    }
  }, [slug, busy, files, onDone]);

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0,0,0,.35)",
      }}
    >
      <div
        style={{
          background: "var(--bg-card)",
          border: "var(--bd-card)",
          borderRadius: "var(--radius-card)",
          padding: 24,
          minWidth: 340,
          maxWidth: 440,
          boxShadow: "var(--shadow-pop)",
          display: "flex",
          flexDirection: "column",
          gap: 14,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <Upload size={16} style={{ color: "var(--ink-soft)" }} />
          <span style={{ fontWeight: 600, fontSize: 14 }}>
            Create folder &amp; upload {files.length === 1 ? "1 file" : `${files.length} files`}
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <label style={{ fontSize: 12, color: "var(--ink-soft)" }}>Folder name</label>
          <input
            ref={inputRef}
            className="c-srch"
            style={{ maxWidth: "none" }}
            value={name}
            onChange={(e) => { setName(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
              if (e.key === "Escape") onCancel();
            }}
            disabled={busy}
          />
          {showSlugHint && (
            <div style={{ fontSize: 11, color: "var(--ink-soft)" }}>
              Saved as:{" "}
              <span style={{ fontFamily: "var(--font-mono)", color: "var(--ink)" }}>{slug}</span>
            </div>
          )}
        </div>
        {error && (
          <div style={{ fontSize: 12, color: "var(--red, #c0392b)", background: "var(--bg-2)", borderRadius: 8, padding: "6px 10px" }}>
            {error}
          </div>
        )}
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button type="button" className="c-vpill" style={{ padding: "6px 14px" }} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className="c-addbtn" disabled={busy || !slug} onClick={() => void submit()}>
            {busy ? "Creating…" : "Create folder"}
          </button>
        </div>
      </div>
    </div>
  );
}

// Empty-state actions: drop is the headline (in EmptyState.help); here we offer
// the two clickable paths under it. "Browse files" mirrors a drop (primary,
// filled button); "New folder" is the secondary, quieter path. (#1709: canonical name)
function EmptyStateActions({
  onBrowse,
  onNewFolder,
}: {
  onBrowse: () => void;
  onNewFolder: () => void;
}) {
  return (
    <div style={{ display: "flex", gap: 10, alignItems: "center", marginTop: 4 }}>
      <button type="button" className="c-addbtn" onClick={onBrowse}>
        <Upload size={14} /> Browse files
      </button>
      <button
        type="button"
        onClick={onNewFolder}
        style={{
          background: "none",
          border: "none",
          padding: "6px 4px",
          fontSize: 13,
          color: "var(--ink-soft)",
          cursor: "pointer",
        }}
      >
        New folder
      </button>
    </div>
  );
}

export default function BrainCollection({ initialFolders }: { initialFolders: ContextSummary[] }) {
  const foldersQuery = useContexts(initialFolders.length > 0 ? initialFolders : undefined);
  const folders = foldersQuery.data ?? initialFolders;
  // Show a loading skeleton until the first fetch completes so we never flash
  // "No folders yet" before the real data arrives (14a: empty-initial-state bug).
  // Cached revisits bypass this because the query already has data.
  const loading = foldersQuery.isLoading && !foldersQuery.data;
  // #1112: dropped files pending folder creation
  const [pendingDropFiles, setPendingDropFiles] = useState<File[] | null>(null);
  const [listDragOver, setListDragOver] = useState(false);
  // Secondary path: create an empty folder (drop is the primary affordance).
  const [newFolderOpen, setNewFolderOpen] = useState(false);
  // #1813: folder being renamed (drives the rename modal).
  const [renameTarget, setRenameTarget] = useState<ContextSummary | null>(null);
  // Browse-files trigger for the empty state (same flow as a drop).
  const browseInputRef = useRef<HTMLInputElement>(null);

  const refresh = async () => {
    try {
      await foldersQuery.refetch();
    } catch {
      // leave existing state intact on error
    }
  };

  const remove = async (c: ContextSummary) => {
    try {
      await api.contexts.delete(c.name, true);
      toast.success(`Deleted ${c.name}`);
      await refresh();
    } catch {
      toast.error(`Could not delete ${c.name}`);
    }
  };

  const openNewFolder = () => setNewFolderOpen(true);
  const openBrowse = () => browseInputRef.current?.click();

  const folderTitle = (c: ContextSummary) => (
    <span className="inline-flex min-w-0 items-baseline gap-1.5">
      <span className="truncate">{c.name}</span>
      {c.visibility === "workspace" ? (
        <Users className="size-3 text-[var(--muted-foreground)] translate-y-px" aria-label="Shared" />
      ) : (
        <Lock className="size-3 text-[var(--muted-foreground)] translate-y-px" aria-label="Private" />
      )}
    </span>
  );

  const categoryTags = useMemo(
    () =>
      Array.from(
        new Set(
          folders
            .map((folder) => folder.category?.trim())
            .filter((category): category is string => Boolean(category)),
        ),
      )
        .sort((a, b) => a.localeCompare(b))
        .map((category) => ({ value: category, label: category })),
    [folders],
  );

  const config: CollectionConfig<ContextSummary> = {
    title: "Library",
    subtitle: "Reusable folders of files your workers can read before they act.",
    items: folders,
    loading,
    // No banner and no prominent toolbar addButton: dropping files is the
    // primary affordance (outer wrapper handles file drops; the empty state
    // leads with a drop CTA). Folder-creation is the quiet secondary path in
    // config.toolbarActions and under the empty-state CTA.
    idOf: (c) => c.name,
    searchOf: (c) => `${c.name} ${c.description ?? ""} ${c.category ?? ""}`,
    tagsOf: (c) =>
      ({
        visibility: [c.visibility === "workspace" ? "shared" : "private"],
        status: [writeKey(c)],
        content: c.category ? [c.category] : [],
      }) as Partial<Record<TagFamilyKey, string[]>>,
    tags: {
      status: [
        { value: "writeable", label: "writeable" },
        { value: "read-only", label: "read only" },
      ],
      visibility: [
        { value: "private", label: "Private" },
        { value: "shared", label: "Shared" },
      ],
      ...(categoryTags.length > 0 ? { content: categoryTags } : {}),
    },
    counts: [
      { value: folders.length, label: "folders" },
      { value: folders.reduce((n, c) => n + (c.file_count ?? 0), 0), label: "files" },
    ],
    view: { default: "grid", grid: true },
    columns: {
      template: "1.8fr 1fr 1fr 40px",
      headers: ["Folder", "Files", "Updated", ""],
      statusColumn: false,
    },
    row: (c) => ({
      leading: (
        <span className="c-logo">
          <Folder size={16} />
        </span>
      ),
      primary: folderTitle(c),
      secondary: c.description ?? undefined,
      cols: [`${c.file_count ?? 0} files`, formatRelative(c.updated_at ?? "")],
      menu: c.read_only
        ? undefined
        : [
            { label: "Rename", onSelect: () => setRenameTarget(c) },
            { label: "Delete", onSelect: () => void remove(c), danger: true },
          ],
    }),
    card: (c) => ({
      leading: (
        <span className="c-logo" style={{ width: 38, height: 38 }}>
          <Folder size={20} />
        </span>
      ),
      // #1257: wrap in a span with title so the full name is accessible on hover
      // even when it is ellipsis-truncated by c-gnm.
      name: <span title={c.name}>{c.name}</span>,
      description: `${c.file_count ?? 0} files · ${formatRelative(c.updated_at ?? "")}`,
      status: c.read_only ? { tone: "idle", label: "Read only" } : null,
    }),
    detail: (c) => ({
      header: {
        leading: (
          <span className="c-logo" style={{ width: 42, height: 42 }}>
            <Folder size={22} />
          </span>
        ),
        title: c.name,
        sub: (
          <>
            <span className="c-vpill">{visibilityLabel(c.visibility)}</span>
            {c.read_only && <span className="c-vpill">Read only</span>}
            <span className="c-vpill">{c.file_count ?? 0} files</span>
            <span className="c-vpill">{formatBytes(c.total_size_bytes)}</span>
          </>
        ),
      },
      tabs: [
        { key: "Files", label: "Files", count: c.file_count, render: () => <FilesTab folder={c} /> },
        { key: "Used by", label: "Used by", count: c.worker_count, render: () => <UsedByTab folder={c} /> },
      ],
    }),
    // No prominent toolbar "+ New folder" addButton (the operator 2026-06-15):
    // dropping files is the primary affordance, so folder-creation is demoted to
    // a quiet secondary text button in the toolbar (config.toolbarActions) and
    // a secondary action under the empty-state drop CTA.
    toolbarActions: (
      <button type="button" className="c-vpill" onClick={openNewFolder}>
        New folder
      </button>
    ),
    states: {
      // Default state LEADS with drop, not "+ New folder" (the operator
      // 2026-06-15). The whole wrapper is already a drop zone (outer onDrop →
      // DropCreateFolderOverlay), so the empty state is a big, obvious "drop
      // files here" affordance. Creating a folder is the secondary path, a
      // plain text button under the drop CTA. Upload icon, not Inbox.
      // Copy uses colons not em-dashes (lint:emdash).
      empty: {
        icon: Upload,
        title: "Drop files here to get started",
        help: "Drag any docs, PDFs, or notes onto this page and a folder is created for them automatically. Your workers read these before they act.",
        action: <EmptyStateActions onBrowse={openBrowse} onNewFolder={openNewFolder} />,
        // B6: the empty state is itself a clearly-bounded dashed drop-zone box,
        // so the drop target is visible at rest (not only on drag-over).
        dropzone: true,
      },
    },
  };

  return (
    // #1112: Outer drop zone — dropping files on the brain list triggers folder
    // creation instead of an upload error.
    <div
      style={{ position: "relative", flex: 1, minHeight: 0 }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          if (!listDragOver) setListDragOver(true);
        }
      }}
      onDragLeave={(e) => {
        // Only clear when the pointer leaves the outer wrapper itself.
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setListDragOver(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setListDragOver(false);
        const dropped = Array.from(e.dataTransfer.files);
        if (dropped.length > 0) setPendingDropFiles(dropped);
      }}
    >
      {listDragOver && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 10,
            pointerEvents: "none",
            borderRadius: "var(--radius-card)",
            outline: "2px dashed var(--ink-soft)",
            outlineOffset: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "var(--bg-card)/80",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <Upload size={22} style={{ color: "var(--ink-soft)" }} />
            <span style={{ fontSize: 13, color: "var(--ink-soft)" }}>Drop to create a new folder</span>
          </div>
        </div>
      )}
      <Collection config={config} />
      {/* Hidden picker: "Browse files" in the empty state opens the OS file
          dialog, then routes the chosen files through the same create-folder
          flow as a drop. */}
      <input
        ref={browseInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? []);
          if (chosen.length > 0) setPendingDropFiles(chosen);
          // Reset so picking the same file again still fires onChange.
          e.target.value = "";
        }}
      />
      {pendingDropFiles && (
        <DropCreateFolderOverlay
          files={pendingDropFiles}
          onDone={async () => {
            setPendingDropFiles(null);
            await refresh();
          }}
          onCancel={() => setPendingDropFiles(null)}
        />
      )}
      {newFolderOpen && (
        <NewFolderModal
          onCreated={async () => {
            setNewFolderOpen(false);
            await refresh();
          }}
          onCancel={() => setNewFolderOpen(false)}
        />
      )}
      {renameTarget && (
        <RenameFolderModal
          folder={renameTarget}
          onRenamed={async (newName) => {
            // Drop the ContextDetail cached under the old name (and any stale
            // entry parked under the new name from a prior folder) so reusing
            // either name in this session refetches instead of rendering the
            // wrong folder's files. #1813.
            detailCache.delete(renameTarget.name);
            detailCache.delete(newName);
            setRenameTarget(null);
            await refresh();
          }}
          onCancel={() => setRenameTarget(null)}
        />
      )}
    </div>
  );
}

const muted: React.CSSProperties = { color: "var(--muted-foreground)" };
