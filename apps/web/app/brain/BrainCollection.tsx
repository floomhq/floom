"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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

/** Auto-name a new folder without prompting (the operator 2026-06-22: "just
 *  choose one, I can change it later"). Picks the first free `new-folder`,
 *  `new-folder-2`, … so creation never blocks on a name dialog. An optional
 *  seed (e.g. a dropped file's base name) is preferred when it is free. */
function autoFolderName(existing: string[], seed?: string): string {
  const taken = new Set(existing);
  const base = (seed && slugifyContextName(seed)) || "new-folder";
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = slugifyContextName(`${base}-${i}`) || `new-folder-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return slugifyContextName(`new-folder-${Date.now()}`);
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

// #1112 / the operator 2026-06-22: dropping files on the Library creates a
// folder and uploads into it WITHOUT a blocking name prompt. The folder is
// auto-named (seeded from the first dropped file, falling back to `new-folder`),
// and can be renamed later. No modal — the create+upload runs immediately.
async function createFolderFromDrop(files: File[], existing: string[]): Promise<string> {
  const seed = files[0]?.name.replace(/\.[^/.]+$/, "");
  const slug = autoFolderName(existing, seed);
  // #1241/#1243: writeable=true so the created folder accepts uploads.
  await api.contexts.create(slug, true);
  await api.contexts.upload(slug, files, undefined);
  toast.success(
    files.length === 1
      ? `Created "${slug}" and added 1 file`
      : `Created "${slug}" and added ${files.length} files`,
  );
  return slug;
}

// Empty-state action: the standard centered empty state shows ONE action
// (matching Run history etc.). Drop-anywhere is the primary affordance (the help
// text says so + the whole page is a drop target); "Browse files" is the single
// clickable fallback. Folder-creation stays in the toolbar.
function EmptyStateActions({ onBrowse }: { onBrowse: () => void }) {
  return (
    <button
      type="button"
      className="c-addbtn"
      onClick={onBrowse}
      style={{ display: "inline-flex", marginTop: 8 }}
    >
      <Upload size={14} /> Browse files
    </button>
  );
}

export default function BrainCollection({ initialFolders }: { initialFolders: ContextSummary[] }) {
  const foldersQuery = useContexts(initialFolders.length > 0 ? initialFolders : undefined);
  const folders = foldersQuery.data ?? initialFolders;
  // Show a loading skeleton until the first fetch completes so we never flash
  // "No folders yet" before the real data arrives (14a: empty-initial-state bug).
  // Cached revisits bypass this because the query already has data.
  const loading = foldersQuery.isLoading && !foldersQuery.data;
  const [listDragOver, setListDragOver] = useState(false);
  // Guards the auto-create folder paths against double-fires.
  const [creating, setCreating] = useState(false);
  // #1813: folder being renamed (drives the rename modal).
  const [renameTarget, setRenameTarget] = useState<ContextSummary | null>(null);
  // Browse-files trigger for the empty state (same flow as a drop).
  const browseInputRef = useRef<HTMLInputElement>(null);

  const existingNames = useMemo(() => folders.map((f) => f.name), [folders]);

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

  // #1112 / the operator 2026-06-22: dropping files auto-creates an auto-named
  // folder and uploads into it — no blocking name prompt.
  const handleDroppedFiles = async (dropped: File[]) => {
    if (dropped.length === 0 || creating) return;
    setCreating(true);
    try {
      await createFolderFromDrop(dropped, existingNames);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create folder.");
    } finally {
      setCreating(false);
    }
  };

  // Toolbar "New folder": auto-name and create immediately (the operator
  // 2026-06-22: "just choose one, I can change it later"). No name dialog.
  const createEmptyFolder = async () => {
    if (creating) return;
    setCreating(true);
    const slug = autoFolderName(existingNames);
    try {
      await api.contexts.create(slug, true); // writeable so it accepts uploads
      toast.success(`Created "${slug}"`);
      await refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Could not create the folder.");
    } finally {
      setCreating(false);
    }
  };

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
    view: { default: "list", grid: true },
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
    // dropping files is the primary affordance, so folder-creation is a quiet
    // secondary text button in the toolbar. It auto-names + creates immediately
    // (no name dialog — the operator 2026-06-22); rename later.
    toolbarActions: (
      <button type="button" className="c-vpill" disabled={creating} onClick={() => void createEmptyFolder()}>
        New folder
      </button>
    ),
    states: {
      // Standard centered empty state (the operator 2026-06-22): clean icon +
      // title + subtext + ONE action, matching Run history and every other
      // surface. NO dashed drop-zone box — the whole page is the drop target
      // (outer onDrop → auto-named folder), with a single drag-over overlay, so
      // a heavy bounded box at rest is redundant chrome. Upload icon, not Inbox.
      // Copy uses colons not em-dashes (lint:emdash).
      empty: {
        icon: Upload,
        title: "Your Library is empty",
        help: "Drag any docs onto this page and a folder is created for them automatically. Your workers read these before they act.",
        action: <EmptyStateActions onBrowse={openBrowse} />,
      },
    },
  };

  return (
    // #1112: Outer drop zone — dropping files anywhere on the Library page
    // auto-creates a folder for them (no name prompt) instead of erroring.
    <div
      data-testid="library-dropzone"
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
        void handleDroppedFiles(Array.from(e.dataTransfer.files));
      }}
    >
      {/* FIX 2 (the operator 2026-06-22): ONE clean drag-over overlay — a subtle
          page highlight with a single "Drop to add to your Library" message.
          No competing affordances (no second box, no Browse button) during a
          drag. */}
      {listDragOver && (
        <div
          data-testid="library-drag-overlay"
          style={{
            position: "absolute",
            inset: 0,
            zIndex: 20,
            pointerEvents: "none",
            borderRadius: "var(--radius-card)",
            outline: "2px solid var(--primary)",
            outlineOffset: -2,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "color-mix(in srgb, var(--primary) 8%, var(--bg-card))",
            transition: "background .12s ease",
          }}
        >
          <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
            <Upload size={22} style={{ color: "var(--primary)" }} />
            <span style={{ fontSize: 14, fontWeight: 500, color: "var(--ink)" }}>
              Drop to add to your Library
            </span>
          </div>
        </div>
      )}
      <Collection config={config} />
      {/* Hidden picker: "Browse files" in the empty state opens the OS file
          dialog, then routes the chosen files through the same auto-create
          flow as a drop. */}
      <input
        ref={browseInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          const chosen = Array.from(e.target.files ?? []);
          void handleDroppedFiles(chosen);
          // Reset so picking the same file again still fires onChange.
          e.target.value = "";
        }}
      />
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
