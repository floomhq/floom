"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Folder } from "lucide-react";
import { api } from "@/lib/api";
import { formatRelative } from "@/lib/formatters";
import type { ContextSummary, ContextDetail } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { InlineFileOpen } from "@/components/file-viewer/InlineFileOpen";
import { visibilityLabel } from "@/lib/permissions";
import { formatBytes, writeKey } from "@/lib/brain/format";

const detailCache = new Map<string, ContextDetail>();

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
      .catch(() => {});
  };
  useEffect(() => {
    let alive = true;
    if (detailCache.has(name)) {
      setD(detailCache.get(name));
    } else {
      api.contexts.get(name).then((cd) => {
        detailCache.set(name, cd);
        if (alive) setD(cd);
      }).catch(() => {});
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
  if (!d) return <div style={muted}>Loading…</div>;
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
  return (
    <InlineFileOpen
      files={files}
      rootLabel={folder.name}
      emptyLabel="This folder is empty."
      loadText={(f) => api.contexts.readTextFile(folder.name, f.id)}
      // #770: rename a file (move within the same directory), then refresh.
      onRename={async (file, newName) => {
        const dir = file.id.includes("/") ? file.id.slice(0, file.id.lastIndexOf("/") + 1) : "";
        await api.contexts.moveFile(folder.name, file.id, `${dir}${newName}`);
        await reload();
      }}
    />
  );
}

function NewFolderForm({ onCreated }: { onCreated: () => void | Promise<void> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    const n = name.trim();
    if (!n) return;
    setBusy(true);
    try {
      await api.contexts.create(n);
      toast.success(`Created ${n}`);
      await onCreated();
    } catch {
      toast.error("Could not create the folder.");
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
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
        placeholder="e.g. Company facts"
      />
      <button type="button" className="c-addbtn" disabled={busy || !name.trim()} onClick={() => void submit()}>
        {busy ? "Creating…" : "Create folder"}
      </button>
    </div>
  );
}

function UsedByTab({ folder }: { folder: ContextSummary }) {
  const [d] = useContextDetail(folder.name);
  if (!d) return <div style={muted}>Loading…</div>;
  const used = d.used_by ?? [];
  return (
    <div className="c-ltable">
      {used.map((ref) => (
        <Link
          key={ref.worker_id}
          href={`/workers/${encodeURIComponent(ref.worker_id)}`}
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

export default function BrainCollection({ initialFolders }: { initialFolders: ContextSummary[] }) {
  const [folders, setFolders] = useState<ContextSummary[]>(initialFolders);

  const refresh = () => api.contexts.list().then(setFolders).catch(() => {});
  useEffect(() => {
    void refresh();
  }, []);

  const remove = async (c: ContextSummary) => {
    try {
      await api.contexts.delete(c.name, true);
      toast.success(`Deleted ${c.name}`);
      await refresh();
    } catch {
      toast.error(`Could not delete ${c.name}`);
    }
  };

  const config: CollectionConfig<ContextSummary> = {
    title: "Brain",
    subtitle: "Reusable folders of files your workers can read before they act.",
    items: folders,
    idOf: (c) => c.name,
    searchOf: (c) => `${c.name} ${c.description ?? ""}`,
    tagsOf: (c) =>
      ({
        visibility: [c.visibility === "workspace" ? "shared" : "private"],
        status: [writeKey(c)],
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
    },
    counts: [
      { value: folders.length, label: "folders" },
      { value: folders.reduce((n, c) => n + (c.file_count ?? 0), 0), label: "files" },
    ],
    view: { default: "list", grid: true },
    columns: {
      template: "1.8fr 1fr 1fr 120px 40px",
      headers: ["Folder", "Files", "Updated", "Access", ""],
    },
    row: (c) => ({
      leading: (
        <span className="c-logo">
          <Folder size={16} />
        </span>
      ),
      primary: c.name,
      secondary: c.description ?? undefined,
      cols: [`${c.file_count ?? 0} files`, formatRelative(c.updated_at ?? "")],
      status: c.read_only ? { tone: "idle", label: "Read only" } : { tone: "ok", label: "Writeable" },
      menu: c.read_only ? undefined : [{ label: "Delete", onSelect: () => void remove(c), danger: true }],
    }),
    card: (c) => ({
      leading: (
        <span className="c-logo" style={{ width: 38, height: 38 }}>
          <Folder size={20} />
        </span>
      ),
      name: c.name,
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
            <span className="c-dh-sub" style={{ margin: 0 }}>
              {c.description ?? `${c.file_count ?? 0} files · ${formatBytes(c.total_size_bytes)}`}
            </span>
          </>
        ),
        actions: (
          <Link
            href={`/contexts?pack=${encodeURIComponent(c.name)}`}
            className="c-vpill"
            style={{ padding: "6px 11px" }}
          >
            Open full page →
          </Link>
        ),
      },
      tabs: [
        { key: "Files", label: "Files", count: c.file_count, render: () => <FilesTab folder={c} /> },
        { key: "Used by", label: "Used by", count: c.worker_count, render: () => <UsedByTab folder={c} /> },
      ],
    }),
    add: {
      label: "New folder",
      panel: {
        title: "New folder",
        render: (close) => <NewFolderForm onCreated={async () => { await refresh(); close(); }} />,
      },
    },
    states: {
      empty: { title: "No folders yet", help: "Create a folder of files your workers can read." },
    },
  };

  return <Collection config={config} />;
}

const muted: React.CSSProperties = { color: "var(--muted-foreground)" };
