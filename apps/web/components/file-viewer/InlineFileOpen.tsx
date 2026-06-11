"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, Download } from "lucide-react";
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
  loadSqlite,
}: {
  files: InlineFile[];
  rootLabel: string;
  emptyLabel?: string;
  /** Text-content loader (Brain: readTextFile). Omitted → download-only fallback. */
  loadText?: (file: InlineFile) => Promise<string>;
  /** #777: load a .db file's tables/rows for the inline SQLite viewer. */
  loadSqlite?: (file: InlineFile, table?: string) => Promise<SqliteView>;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [text, setText] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const open = files.find((f) => f.id === openId) ?? null;

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
                border: "1px solid var(--line)",
                borderRadius: 12,
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

  return (
    <div className="c-ltable">
      {files.map((f) => (
        <button
          key={f.id}
          type="button"
          className="c-lrow"
          style={{ gridTemplateColumns: "1fr auto" }}
          onClick={() => setOpenId(f.id)}
        >
          <div className="c-lprimary">
            <div className="c-lp-tx">
              <div className="nm" style={{ fontFamily: "var(--font-mono)" }}>
                {f.name}
              </div>
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
          <span className="c-cell m">{sizeLabel(f.sizeBytes)}</span>
        </button>
      ))}
    </div>
  );
}
