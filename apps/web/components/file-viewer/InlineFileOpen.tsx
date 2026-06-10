"use client";

import { useState } from "react";
import { ArrowLeft, Download } from "lucide-react";
import { isImageFile } from "@/lib/runs/trace";

// APP-UI-V4-SPEC rule #5 / §4: ONE inline file-open pattern, shared by Brain and
// Run outputs. Files open INLINE (breadcrumb `<root> / file`, Back, Download) —
// never a popup. Images render as images.
export interface InlineFile {
  id: string;
  name: string;
  /** Download / image source URL. */
  url: string;
  sizeBytes?: number;
}

function sizeLabel(bytes?: number): string {
  if (!bytes) return "";
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

export function InlineFileOpen({
  files,
  rootLabel,
  emptyLabel = "No files.",
}: {
  files: InlineFile[];
  rootLabel: string;
  emptyLabel?: string;
}) {
  const [openId, setOpenId] = useState<string | null>(null);
  const open = files.find((f) => f.id === openId) ?? null;

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
        ) : (
          <div style={{ color: "var(--muted-foreground)", padding: 14 }}>
            {/* TODO(#815/#777): inline text/markdown/SQLite preview; download for now. */}
            Preview isn&apos;t available inline yet — use Download to open this file.
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
            </div>
          </div>
          <span className="c-cell m">{sizeLabel(f.sizeBytes)}</span>
        </button>
      ))}
    </div>
  );
}
