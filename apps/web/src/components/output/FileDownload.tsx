// File artifact card with Download button and optional inline preview.
// Accepts either a remote URL, a base64 string (converted to a blob
// URL in the browser), or raw bytes. The optional `previewHtml` field
// is rendered via dangerouslySetInnerHTML — callers (or the cascade
// auto-picker) are responsible for trusting that source.
import { useMemo } from 'react';

export interface FileDownloadProps {
  /** Remote URL. Takes precedence over `bytes` when both are set. */
  url?: string;
  /** Base64-encoded file contents (no data: prefix). */
  bytes?: string;
  filename: string;
  mime?: string;
  /**
   * Optional HTML string to render above the download card for a
   * quick visual of what's inside the file (e.g. the slide deck HTML
   * while the downloadable artifact is a PDF).
   */
  previewHtml?: string;
}

function bytesToBlobUrl(bytes: string, mime: string): string {
  // atob throws on invalid input; guard so we never break the render.
  let binary: string;
  try {
    binary = atob(bytes);
  } catch {
    return '';
  }
  const buf = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buf[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([buf], { type: mime });
  return URL.createObjectURL(blob);
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileDownload({
  url,
  bytes,
  filename,
  mime = 'application/octet-stream',
  previewHtml,
}: FileDownloadProps) {
  // Compute download href once per bytes/url change. When bytes is set we
  // produce a blob: URL; React does not auto-revoke these but file-download
  // is a terminal UX so leaking one URL per run is acceptable (and the tab
  // reclaims it on navigation).
  const href = useMemo(() => {
    if (url) return url;
    if (bytes) return bytesToBlobUrl(bytes, mime);
    return '';
  }, [url, bytes, mime]);

  const sizeHint = bytes ? formatBytes(Math.floor((bytes.length * 3) / 4)) : null;

  return (
    // data-renderer lets audits confirm the cascade mapped file outputs
    // (e.g. openslides PDF, openblog .md) to FileDownload. Added
    // 2026-04-18 (bug #9).
    <div
      data-renderer="FileDownload"
      className="app-expanded-card"
      style={{ padding: 0, overflow: 'hidden' }}
    >
      {previewHtml && (
        <div
          style={{
            padding: 16,
            borderBottom: '1px solid var(--line)',
            maxHeight: 360,
            overflow: 'auto',
          }}
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: previewHtml }}
        />
      )}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px',
        }}
      >
        <div
          aria-hidden="true"
          style={{
            width: 36,
            height: 44,
            border: '1px solid var(--line)',
            borderRadius: 6,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10,
            fontWeight: 600,
            color: 'var(--muted)',
            flexShrink: 0,
          }}
        >
          {filename.split('.').pop()?.toUpperCase().slice(0, 4) || 'FILE'}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontSize: 14,
              fontWeight: 500,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {filename}
          </div>
          {sizeHint && (
            <div style={{ fontSize: 12, color: 'var(--muted)' }}>{sizeHint}</div>
          )}
        </div>
        {href ? (
          <a
            href={href}
            download={filename}
            className="output-copy-btn"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center' }}
          >
            Download
          </a>
        ) : (
          <span className="output-copy-btn" style={{ opacity: 0.5, cursor: 'not-allowed' }}>
            Unavailable
          </span>
        )}
      </div>
    </div>
  );
}
