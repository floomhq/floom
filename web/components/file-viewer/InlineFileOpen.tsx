"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Download, Folder as FolderIcon } from "lucide-react";
import { isImageFile } from "@/lib/runs/trace";
import { SqliteTableView } from "@/components/file-viewer/SqliteTableView";
import type { SqliteView } from "@/lib/types";

function isDbFile(name: string): boolean {
  return /\.(db|sqlite|sqlite3)$/i.test(name);
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
  loadSqlite,
}: {
  files: InlineFile[];
  rootLabel: string;
  emptyLabel?: string;
  /** Text-content loader (Brain: readTextFile). Omitted → download-only fallback. */
  loadText?: (file: InlineFile) => Promise<string>;
  /** #770: when provided, each row offers an inline rename (never a native prompt). */
  onRename?: (file: InlineFile, newName: string) => Promise<void>;
  /** #777: load a .db file's tables/rows for the inline SQLite viewer. */
  loadSqlite?: (file: InlineFile, table?: string) => Promise<SqliteView>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [dir, setDir] = useState(""); // #783: current folder prefix ("" = root)
  const open = files.find((f) => f.id === openId) ?? null;

  const baseName = (path: string) => (path.includes("/") ? path.slice(path.lastIndexOf("/") + 1) : path);
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

  const canLoadText = !!loadText && !!open && !open.binary && !isImageFile(open.name);
  useEffect(() => {
    setText(null);
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

  if (files.length === 0) {
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
          <a
            href={open.url}
            download={open.name}
            className="c-vpill"
            style={{ marginLeft: "auto", padding: "4px 9px", textDecoration: "none" }}
          >
            <Download size={13} /> Download
          </a>
        </div>
        {isImageFile(open.name) ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={open.url}
            alt={open.name}
            style={{ maxWidth: "100%", borderRadius: "var(--r-card, 16px)", display: "block" }}
          />
        ) : canLoadText ? (
          loading ? (
            <div style={{ color: "var(--muted-foreground)", padding: 14 }}>Loading…</div>
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
        ) : isDbFile(open.name) && loadSqlite ? (
          // #777: inline SQLite table viewer (Brain supplies the loader).
          <SqliteTableView load={(table) => loadSqlite(open, table)} />
        ) : (
          <div style={{ color: "var(--muted-foreground)", padding: 14 }}>
            {isDbFile(open.name)
              ? "SQLite database — use Download to open this file."
              : "Preview isn't available inline yet — use Download to open this file."}
            {/* TODO(#815): richer artifact preview. */}
          </div>
        )}
      </div>
    );
  }

  // #783: fold nested paths into navigable folders at the current `dir` level.
  const levelFiles = files.filter((f) => f.name.startsWith(dir) && !f.name.slice(dir.length).includes("/"));
  const folderSet = new Set<string>();
  for (const f of files) {
    if (!f.name.startsWith(dir)) continue;
    const rest = f.name.slice(dir.length);
    const slash = rest.indexOf("/");
    if (slash > 0) folderSet.add(rest.slice(0, slash));
  }
  const folders = Array.from(folderSet).sort();
  const crumbs = dir ? dir.replace(/\/$/, "").split("/") : [];

  return (
    <div>
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
      <div className="c-ltable">
      {folders.map((name) => (
        <button
          key={`dir:${name}`}
          type="button"
          className="c-lrow"
          style={{ gridTemplateColumns: "1fr auto" }}
          onClick={() => setDir(`${dir}${name}/`)}
        >
          <div className="c-lprimary">
            <div className="c-lp-tx">
              <div className="nm" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <FolderIcon size={13} /> {name}
              </div>
            </div>
          </div>
          <span className="c-cell m">
            {files.filter((f) => f.name.startsWith(`${dir}${name}/`)).length} files
          </span>
        </button>
      ))}
      {levelFiles.map((f) => {
        const renaming = renamingId === f.id;
        const display = f.name.slice(dir.length);
        return (
          <div
            key={f.id}
            className="c-lrow"
            style={{ gridTemplateColumns: "1fr auto", alignItems: "center", display: "grid" }}
          >
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
                          borderRadius: "var(--r-pill, 9999px)",
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
    </div>
  );
}
