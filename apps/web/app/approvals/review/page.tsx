"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle, ChevronLeft, ChevronRight, Download, FileText, Film, ImageIcon, RotateCcw, Table, XCircle } from "lucide-react";
import Papa from "papaparse";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { WorkerosMark } from "@/components/share/ShareCardShell";
import { GenericOutput } from "@/components/generic-output";
import { ApprovalActionItems, approvalActionLine } from "@/components/share/ApprovalActionItems";
import type { ApprovalRow, Artifact } from "@/lib/types";
import { AnnotationsViewer } from "./annotations";

const API_BASE = process.env.NEXT_PUBLIC_API_PROXY_BASE || "/api/proxy";

/** Persisted screenshot refs are /uploads/<sha> relative to the API proxy. */
function resolveUploadUrl(ref: string): string {
  if (/^https?:\/\//.test(ref)) return ref;
  return `${API_BASE}${ref.startsWith("/") ? "" : "/"}${ref}`;
}

const TABLE_PREVIEW_ROWS = 100;
const TABLE_PREVIEW_COLS = 12;
const TEXT_PREVIEW_LIMIT = 512 * 1024;

function parseDecisionInput(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// Infer a GenericOutput type from the proposed-output preview string.
function inferPreviewType(preview: string): string {
  const t = preview.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) return "json";
  if (/^#{1,3}\s|\n[-*]\s|\|.+\|/.test(t)) return "markdown";
  return "text";
}

function formatRelative(iso: string): string {
  const minutes = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatBytes(bytes?: number): string | null {
  if (bytes == null) return null;
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unitIndex]}`;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function safePreviewHref(value: unknown): string | null {
  const href = stringValue(value);
  if (!href) return null;
  try {
    const parsed = new URL(href, "http://localhost");
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return href;
  } catch {
    return null;
  }
  return null;
}

type ApprovalFileKind = "text" | "html" | "table" | "spreadsheet" | "image" | "pdf" | "video" | "binary";

function approvalFileKind(file: PreviewFile): ApprovalFileKind {
  const mime = (file.mimeType || "").toLowerCase();
  const name = `${file.title || ""} ${file.detail || ""}`.toLowerCase();
  if (mime.startsWith("image/") || /\.(png|jpe?g|gif|webp|svg)$/.test(name)) return "image";
  if (mime === "application/pdf" || /\.pdf$/.test(name)) return "pdf";
  if (mime.startsWith("video/") || /\.(mp4|webm|mov|m4v|ogv)$/.test(name)) return "video";
  if (
    mime.includes("spreadsheet") ||
    mime.includes("excel") ||
    /\.(xlsx|xlsm)$/.test(name)
  ) {
    return "spreadsheet";
  }
  if (mime === "text/csv" || mime === "text/tab-separated-values" || /\.(csv|tsv)$/.test(name)) return "table";
  if (mime === "text/html" || /\.html?$/.test(name)) return "html";
  if (
    mime.startsWith("text/") ||
    /\.(md|mdx|txt|log|json|ya?ml|toml|xml|sql|py|js|jsx|ts|tsx|css|scss|sh)$/.test(name)
  ) {
    return "text";
  }
  return "binary";
}

function fileKindIcon(kind: ApprovalFileKind) {
  if (kind === "image") return <ImageIcon className="h-4 w-4 shrink-0 text-[var(--ink-soft)]" />;
  if (kind === "video") return <Film className="h-4 w-4 shrink-0 text-[var(--ink-soft)]" />;
  if (kind === "table" || kind === "spreadsheet") return <Table className="h-4 w-4 shrink-0 text-[var(--ink-soft)]" />;
  return <FileText className="h-4 w-4 shrink-0 text-[var(--ink-soft)]" />;
}

function parseXlsxSheet(sheetXml: string, sharedXml: string): string[][] {
  const parser = new DOMParser();
  const sharedDoc = sharedXml ? parser.parseFromString(sharedXml, "application/xml") : null;
  const sharedStrings = sharedDoc
    ? Array.from(sharedDoc.querySelectorAll("si")).map((node) =>
        Array.from(node.querySelectorAll("t")).map((part) => part.textContent ?? "").join("")
      )
    : [];
  const sheetDoc = parser.parseFromString(sheetXml, "application/xml");
  const rows: string[][] = [];

  for (const row of Array.from(sheetDoc.querySelectorAll("sheetData row")).slice(0, TABLE_PREVIEW_ROWS)) {
    const cells: string[] = [];
    for (const cell of Array.from(row.querySelectorAll("c")).slice(0, TABLE_PREVIEW_COLS)) {
      const ref = cell.getAttribute("r") ?? "";
      const colIndex = Math.min(columnIndexFromCellRef(ref), TABLE_PREVIEW_COLS - 1);
      const type = cell.getAttribute("t");
      const valueNode = cell.querySelector("v");
      let value = valueNode?.textContent ?? "";
      if (type === "s") {
        value = sharedStrings[Number(value)] ?? value;
      } else if (type === "inlineStr") {
        value = Array.from(cell.querySelectorAll("is t")).map((part) => part.textContent ?? "").join("");
      }
      cells[colIndex] = value;
    }
    rows.push(cells);
  }

  return rows;
}

function columnIndexFromCellRef(ref: string): number {
  const letters = (ref.match(/[A-Z]+/i)?.[0] ?? "A").toUpperCase();
  let index = 0;
  for (const char of letters) {
    index = index * 26 + char.charCodeAt(0) - 64;
  }
  return Math.max(index - 1, 0);
}

type PreviewFile = {
  title: string;
  detail?: string;
  mimeType?: string;
  text?: string;
  href?: string;
  artifact?: Artifact;
};

function previewFileFromRecord(record: Record<string, unknown>): PreviewFile | null {
  const title =
    stringValue(record.name) ||
    stringValue(record.filename) ||
    stringValue(record.label) ||
    stringValue(record.path) ||
    "Attached file";
  const mimeType = stringValue(record.type) || stringValue(record.mime_type) || stringValue(record.content_type) || undefined;
  const text = stringValue(record.preview) || stringValue(record.text) || stringValue(record.content) || undefined;
  const href = safePreviewHref(record.url) || safePreviewHref(record.href) || safePreviewHref(record.download_url) || undefined;
  const detail = stringValue(record.path) || stringValue(record.relative_path) || undefined;
  return { title, detail, mimeType, text, href };
}

function artifactPreview(artifact: Artifact): PreviewFile {
  return {
    title: artifact.name || artifact.path || "Artifact",
    detail: artifact.relative_path || artifact.path,
    mimeType: artifact.type,
    artifact,
  };
}

function approvalPreviewFile(
  approval: ApprovalRow,
  decisionInput: Record<string, unknown>,
): PreviewFile | null {
  for (const key of ["preview_file", "previewFile", "file", "artifact"]) {
    const direct = objectValue(decisionInput[key]);
    if (direct) return previewFileFromRecord(direct);
  }
  for (const key of ["artifacts", "files"]) {
    const values = Array.isArray(decisionInput[key]) ? decisionInput[key] : [];
    const first = values.map(objectValue).find(Boolean);
    if (first) return previewFileFromRecord(first);
  }
  const url =
    safePreviewHref(decisionInput.preview_url) ||
    safePreviewHref(decisionInput.file_url) ||
    safePreviewHref(decisionInput.artifact_url);
  if (url) {
    return {
      title: stringValue(decisionInput.preview_name) || stringValue(decisionInput.filename) || "Preview file",
      href: url,
      mimeType: stringValue(decisionInput.preview_type) || stringValue(decisionInput.type) || undefined,
    };
  }
  const firstArtifact = approval.artifacts?.[0];
  return firstArtifact ? artifactPreview(firstArtifact) : null;
}

function PreviewUnavailable({
  title,
  detail,
  href,
  onRetry,
}: {
  title: string;
  detail: string;
  href: string;
  onRetry: () => void;
}) {
  return (
    <div className="flex min-h-[220px] items-center justify-center p-5">
      <div className="max-w-lg rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--paper)] p-5 text-sm">
        <p className="font-medium text-[var(--ink)]">{title}</p>
        <p className="mt-2 leading-6 text-[var(--ink-soft)]">{detail}</p>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={onRetry}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-soft)] px-3 text-sm hover:bg-[var(--bg-2)]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Retry
          </button>
          <a
            href={href}
            download
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-soft)] px-3 text-sm hover:bg-[var(--bg-2)]"
          >
            <Download className="h-3.5 w-3.5" />
            Download
          </a>
        </div>
      </div>
    </div>
  );
}

function LoadingPreview() {
  return (
    <div className="space-y-2 p-4">
      {[1, 2, 3, 4].map((index) => (
        <div key={index} className="h-4 animate-pulse rounded-[var(--radius-button)] bg-[var(--border-soft)]" />
      ))}
    </div>
  );
}

function TablePreview({ rows }: { rows: string[][] }) {
  const visibleRows = rows.slice(0, TABLE_PREVIEW_ROWS);
  const colCount = Math.min(
    TABLE_PREVIEW_COLS,
    Math.max(...visibleRows.map((row) => row.length), 1)
  );
  if (visibleRows.length === 0) {
    return <p className="p-4 text-sm text-[var(--ink-soft)]">No rows found.</p>;
  }

  return (
    <div className="max-h-[48vh] overflow-auto">
      <table className="min-w-full border-collapse text-left text-xs">
        <tbody>
          {visibleRows.map((row, rowIndex) => (
            <tr key={rowIndex} className={rowIndex === 0 ? "bg-[var(--bg-2)] font-medium" : "odd:bg-[var(--bg-2)]/45"}>
              {Array.from({ length: colCount }).map((_, colIndex) => (
                <td key={colIndex} className="max-w-[260px] border border-[var(--border-soft)] px-2.5 py-1.5 align-top">
                  <span className="block truncate" title={row[colIndex] ?? ""}>
                    {row[colIndex] ?? ""}
                  </span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(rows.length > TABLE_PREVIEW_ROWS || rows.some((row) => row.length > TABLE_PREVIEW_COLS)) && (
        <p className="border-t border-[var(--border-soft)] px-3 py-2 text-xs text-[var(--ink-soft)]">
          Showing first {Math.min(rows.length, TABLE_PREVIEW_ROWS)} rows and {colCount} columns.
        </p>
      )}
    </div>
  );
}

function ArtifactObjectUrlPreview({
  href,
  file,
  kind,
}: {
  href: string;
  file: PreviewFile;
  kind: ApprovalFileKind;
}) {
  const [src, setSrc] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    let objectUrl = "";
    setSrc("");
    setError(null);
    fetch(href)
      .then((response) => {
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        return response.blob();
      })
      .then((blob) => {
        const nextUrl = URL.createObjectURL(blob);
        if (cancelled) {
          URL.revokeObjectURL(nextUrl);
          return;
        }
        objectUrl = nextUrl;
        setSrc(nextUrl);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Download failed");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [href, reloadKey]);

  if (error) {
    return (
      <PreviewUnavailable
        title={`${kind === "video" ? "Video" : "Image"} preview unavailable`}
        detail={`The artifact could not be fetched inline: ${error}. It remains available for download.`}
        href={href}
        onRetry={() => setReloadKey((value) => value + 1)}
      />
    );
  }
  if (!src) return <LoadingPreview />;

  if (kind === "video") {
    return (
      <div className="flex min-h-[360px] items-center justify-center bg-[var(--bg-2)] p-4">
        <video src={src} controls className="max-h-[52vh] max-w-full rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-black">
          <a href={href}>Download video</a>
        </video>
      </div>
    );
  }

  return (
    <div className="flex max-h-[52vh] items-center justify-center overflow-auto bg-[var(--bg-2)] p-4">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt={file.title} className="max-h-[48vh] max-w-full rounded-[var(--radius-button)] object-contain" />
    </div>
  );
}

function TextArtifactPreview({
  href,
  file,
  kind,
}: {
  href: string;
  file: PreviewFile;
  kind: ApprovalFileKind;
}) {
  const [text, setText] = useState(file.text || "");
  const [loading, setLoading] = useState(Boolean(!file.text));
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (file.text) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(href)
      .then((response) => {
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        const length = Number(response.headers.get("content-length") || 0);
        if (length > TEXT_PREVIEW_LIMIT) throw new Error("File is too large to preview inline");
        return response.text();
      })
      .then((value) => {
        if (!cancelled) setText(value);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : "Download failed");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [file.text, href, reloadKey]);

  if (loading) return <LoadingPreview />;
  if (error) {
    return (
      <PreviewUnavailable
        title="Text preview unavailable"
        detail={`The artifact could not be fetched inline: ${error}. It remains available for download.`}
        href={href}
        onRetry={() => setReloadKey((value) => value + 1)}
      />
    );
  }

  if (kind === "html") {
    return (
      <div className="max-h-[52vh] overflow-auto bg-white">
        <iframe
          title={file.title}
          srcDoc={text}
          sandbox=""
          referrerPolicy="no-referrer"
          className="h-[52vh] min-h-[420px] w-full border-0 bg-white"
        />
      </div>
    );
  }

  if (kind === "table") {
    const delimiter = file.title.toLowerCase().endsWith(".tsv") || (file.detail || "").toLowerCase().endsWith(".tsv") ? "\t" : undefined;
    const rows = Papa.parse<string[]>(text, { delimiter, skipEmptyLines: true }).data;
    return <TablePreview rows={rows} />;
  }

  return (
    <pre className="max-h-[52vh] overflow-auto whitespace-pre-wrap p-4 text-sm leading-6 text-[var(--ink)]">
      {text}
    </pre>
  );
}

function PdfArtifactPreview({ href, file }: { href: string; file: PreviewFile }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageCount, setPageCount] = useState<number | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setPageCount(null);

    async function renderFirstPage() {
      try {
        const [pdfjs, response] = await Promise.all([
          import("pdfjs-dist/legacy/build/pdf.mjs"),
          fetch(href),
        ]);
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        pdfjs.GlobalWorkerOptions.workerSrc = new URL(
          "pdfjs-dist/legacy/build/pdf.worker.mjs",
          import.meta.url,
        ).toString();
        const pdf = await pdfjs.getDocument({ data: new Uint8Array(await response.arrayBuffer()) }).promise;
        const cleanupPdf = async () => {
          const destroy = (pdf as unknown as { destroy?: () => Promise<void> | void }).destroy;
          if (destroy) await destroy.call(pdf);
        };
        if (cancelled) {
          await cleanupPdf();
          return;
        }

        setPageCount(pdf.numPages);
        const page = await pdf.getPage(1);
        if (cancelled) {
          await cleanupPdf();
          return;
        }

        const viewport = page.getViewport({ scale: 1.25 });
        const canvas = canvasRef.current;
        const context = canvas?.getContext("2d");
        if (!canvas || !context) throw new Error("Canvas is unavailable.");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        canvas.style.width = `${Math.ceil(viewport.width)}px`;
        canvas.style.height = `${Math.ceil(viewport.height)}px`;
        await page.render({ canvas, canvasContext: context, viewport }).promise;
        await cleanupPdf();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not render PDF preview");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void renderFirstPage();
    return () => {
      cancelled = true;
    };
  }, [href, reloadKey]);

  if (error) {
    return (
      <PreviewUnavailable
        title="PDF preview unavailable"
        detail={`The PDF could not be fetched or rendered inline: ${error}. It remains available for download.`}
        href={href}
        onRetry={() => setReloadKey((value) => value + 1)}
      />
    );
  }

  return (
    <div className="flex max-h-[56vh] min-h-[420px] flex-col bg-[var(--bg-2)]">
      <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-soft)] bg-[var(--paper)] px-4 py-2 text-xs text-[var(--ink-soft)]">
        <span>{pageCount ? `Page 1 of ${pageCount}` : `Rendering ${file.title}`}</span>
        <a href={href} download className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-soft)] px-2.5 hover:bg-[var(--bg-2)]">
          <Download className="h-3.5 w-3.5" />
          Download
        </a>
      </div>
      <div className="flex-1 overflow-auto p-4">
        {loading && <LoadingPreview />}
        <canvas
          ref={canvasRef}
          className={`mx-auto max-w-full rounded-[var(--radius-button)] bg-white shadow-[var(--shadow-card)] ${loading ? "invisible" : ""}`}
        />
      </div>
    </div>
  );
}

function SpreadsheetArtifactPreview({ href }: { href: string }) {
  const [rows, setRows] = useState<string[][]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const [{ default: JSZip }, response] = await Promise.all([
          import("jszip"),
          fetch(href),
        ]);
        if (!response.ok) throw new Error(`Download failed (${response.status})`);
        const zip = await JSZip.loadAsync(await response.arrayBuffer());
        const sheetName = Object.keys(zip.files)
          .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
          .sort()[0];
        if (!sheetName) throw new Error("Workbook has no visible worksheet XML.");

        const [sheetXml, sharedXml] = await Promise.all([
          zip.file(sheetName)?.async("text"),
          zip.file("xl/sharedStrings.xml")?.async("text"),
        ]);
        if (!sheetXml) throw new Error("Worksheet data is empty.");
        const nextRows = parseXlsxSheet(sheetXml, sharedXml ?? "");
        if (!cancelled) setRows(nextRows);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Could not preview spreadsheet");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [href, reloadKey]);

  if (loading) return <LoadingPreview />;
  if (error) {
    return (
      <PreviewUnavailable
        title="Spreadsheet preview unavailable"
        detail={`The workbook could not be fetched or parsed: ${error}. It remains available for download.`}
        href={href}
        onRetry={() => setReloadKey((value) => value + 1)}
      />
    );
  }
  return <TablePreview rows={rows} />;
}

function ApprovalArtifactPreviewBody({
  file,
  href,
  kind,
}: {
  file: PreviewFile;
  href: string | null;
  kind: ApprovalFileKind;
}) {
  if (file.text && (kind === "text" || kind === "html" || kind === "table")) {
    return <TextArtifactPreview href={href || "#"} file={file} kind={kind} />;
  }
  if (!href) {
    return (
      <div className="p-4 text-sm text-[var(--ink-soft)]">
        This approval includes a file artifact, but no download URL is available on this review link.
      </div>
    );
  }
  if (kind === "image" || kind === "video") return <ArtifactObjectUrlPreview href={href} file={file} kind={kind} />;
  if (kind === "pdf") return <PdfArtifactPreview href={href} file={file} />;
  if (kind === "spreadsheet") return <SpreadsheetArtifactPreview href={href} />;
  if (kind === "html" || kind === "table" || kind === "text") return <TextArtifactPreview href={href} file={file} kind={kind} />;
  return (
    <div className="p-4 text-sm text-[var(--ink-soft)]">
      This artifact type is not previewable inline yet. Use Download to inspect it.
    </div>
  );
}

function ApprovalFilePreview({
  file,
  approval,
  isSignedLink,
  token,
}: {
  file: PreviewFile;
  approval: ApprovalRow;
  isSignedLink: boolean;
  token: string | null;
}) {
  const artifactId = typeof file.artifact?.id === "string" && file.artifact.id.trim()
    ? file.artifact.id
    : null;
  const artifactHref = file.artifact && artifactId
    ? isSignedLink && token
      ? api.approvals.publicArtifactUrl(approval.id, artifactId, token)
      : api.runs.artifactUrl(approval.run_id, artifactId)
    : null;
  const href = file.href || artifactHref;
  const kind = approvalFileKind(file);
  const meta = [file.mimeType || (file.artifact ? "artifact" : "file"), file.artifact ? formatBytes(file.artifact.size_bytes) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div>
      <h2 className="text-sm font-medium text-[var(--ink)]">File preview</h2>
      <div className="mt-2 overflow-hidden rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-2)]">
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-[var(--border-soft)] px-4 py-3">
          <span className="flex min-w-0 items-center gap-2">
            {fileKindIcon(kind)}
            <span className="min-w-0">
              <span className="block truncate text-sm font-medium text-[var(--ink)]">{file.title}</span>
              <span className="block truncate text-xs text-[var(--ink-soft)]">{[file.detail, meta].filter(Boolean).join(" · ")}</span>
            </span>
          </span>
          {href && (
            <a
              href={href}
              download
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-soft)] px-2.5 text-xs font-medium text-[var(--ink)] hover:bg-[var(--paper)]"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          )}
        </div>
        <ApprovalArtifactPreviewBody file={file} href={href} kind={kind} />
      </div>
    </div>
  );
}

function ReviewContent() {
  const searchParams = useSearchParams();
  const targetId = searchParams.get("id");
  const token = searchParams.get("token");
  const isSignedLink = Boolean(targetId && token);
  const [rows, setRows] = useState<ApprovalRow[]>([]);
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [chatComment, setChatComment] = useState("");
  const [chatFiles, setChatFiles] = useState<{ url: string; name: string }[]>([]);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Noindex public approval pages so share links don't appear in search results.
  useEffect(() => {
    if (!isSignedLink) return;
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex,nofollow";
    document.head.appendChild(meta);
    return () => { document.head.removeChild(meta); };
  }, [isSignedLink]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (targetId && token) {
        const approval = await api.approvals.publicGet(targetId, token);
        setRows([approval]);
        setIndex(0);
        return;
      }
      const pending = await api.approvals.list("pending");
      const nextRows = targetId
        ? pending.filter((row) => row.id === targetId || row.run_id === targetId)
        : pending;
      setRows(nextRows);
      setIndex(0);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not load approvals");
    } finally {
      setLoading(false);
    }
  }, [targetId, token]);

  useEffect(() => {
    void load();
  }, [load]);

  const approval = rows[index] ?? null;
  const decisionInput = useMemo(
    () => parseDecisionInput(approval?.decision_input_json),
    [approval?.decision_input_json]
  );
  const previewFile = useMemo(
    () => (approval ? approvalPreviewFile(approval, decisionInput) : null),
    [approval, decisionInput]
  );
  const isDestructiveDelete = decisionInput.kind === "destructive_delete";

  useEffect(() => {
    setChatComment("");
    setChatFiles([]);
  }, [approval?.id]);

  const uploadFile = useCallback(
    async (file: File) => {
      if (!approval) return;
      setUploading(true);
      try {
        const result =
          isSignedLink && token
            ? await api.approvals.uploadScreenshotPublic(approval.id, token, file, file.name)
            : await api.approvals.uploadScreenshot(approval.id, file, file.name);
        setChatFiles((prev) => [...prev, { url: result.url, name: file.name }]);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Upload failed");
      } finally {
        setUploading(false);
      }
    },
    [approval, isSignedLink, token]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      Array.from(e.dataTransfer.files).forEach((file) => void uploadFile(file));
    },
    [uploadFile]
  );

  const removeCurrent = useCallback(() => {
    setRows((current) => {
      const next = current.filter((row) => row.id !== approval?.id);
      setIndex((currentIndex) => Math.min(currentIndex, Math.max(0, next.length - 1)));
      return next;
    });
  }, [approval?.id]);

  const annotationsPayload = useMemo(() => {
    const text = chatComment.trim()
      ? [{ quote: "", comment: chatComment.trim() }]
      : [];
    const images = chatFiles.map((f) => ({ url: f.url, caption: f.name, pins: [] as { x: number; y: number; comment: string }[] }));
    return text.length > 0 || images.length > 0 ? { text, images } : null;
  }, [chatComment, chatFiles]);

  const approve = useCallback(async () => {
    if (!approval) return;
    setBusy("approve");
    try {
      if (isSignedLink && token) {
        await api.approvals.publicApprove(approval.id, token, undefined, annotationsPayload);
      } else if (isDestructiveDelete) {
        await api.approvals.approveAction(approval.id, annotationsPayload);
      } else {
        await api.runs.approve(approval.run_id, undefined, annotationsPayload);
      }
      toast.success("Approved");
      removeCurrent();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  }, [annotationsPayload, approval, isDestructiveDelete, isSignedLink, removeCurrent, token]);

  const reject = useCallback(async () => {
    if (!approval) return;
    setBusy("reject");
    try {
      const reason = chatComment.trim() || undefined;
      if (isSignedLink && token) {
        await api.approvals.publicReject(approval.id, token, reason, annotationsPayload);
      } else if (isDestructiveDelete) {
        await api.approvals.rejectAction(approval.id, reason, annotationsPayload);
      } else {
        await api.runs.reject(approval.run_id, reason, annotationsPayload);
      }
      toast.success("Rejected");
      removeCurrent();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Reject failed");
    } finally {
      setBusy(null);
    }
  }, [annotationsPayload, chatComment, approval, isDestructiveDelete, isSignedLink, removeCurrent, token]);

  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-[var(--bg)] px-4 py-6">
      {/* Internal owner: back-link + queue counter above the card */}
      {!isSignedLink && (
        <div className="mb-2 flex w-full max-w-[560px] items-center justify-between">
          <Link
            href="/approvals"
            className="inline-flex items-center gap-1 text-xs text-[var(--ink-soft)] hover:text-[var(--ink)]"
          >
            <ChevronLeft className="h-3.5 w-3.5" />
            All approvals
          </Link>
          {rows.length > 1 && (
            <div className="flex items-center gap-2 text-xs text-[var(--ink-soft)]">
              <button
                type="button"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                disabled={index === 0 || !!busy}
                aria-label="Previous approval"
                className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-button)] border border-[var(--border-soft)] disabled:opacity-40 hover:bg-[var(--bg-2)]"
              >
                <ChevronLeft className="h-3.5 w-3.5" />
              </button>
              <span>{index + 1} of {rows.length}</span>
              <button
                type="button"
                onClick={() => setIndex((i) => Math.min(rows.length - 1, i + 1))}
                disabled={index >= rows.length - 1 || !!busy}
                aria-label="Next approval"
                className="inline-flex h-6 w-6 items-center justify-center rounded-[var(--radius-button)] border border-[var(--border-soft)] disabled:opacity-40 hover:bg-[var(--bg-2)]"
              >
                <ChevronRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      )}

      {/* Wave 3: ONE fixed-height 480px card */}
      <div
        className="flex w-full max-w-[560px] flex-col rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--paper)] shadow-[var(--shadow-card)]"
        style={{ height: "480px" }}
      >
        {/* Card header: brand + "Approval request" + shared-link marker */}
        <div className="flex shrink-0 items-center justify-between border-b border-[var(--border-soft)] px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <WorkerosMark size={18} />
            <span className="text-sm font-medium text-[var(--ink)]">Approval request</span>
          </div>
          {isSignedLink && (
            <span className="rounded-[var(--radius-pill)] bg-[var(--bg-2)] px-2 py-0.5 text-xs text-[var(--ink-soft)]">
              Shared link
            </span>
          )}
        </div>

        {/* Scrollable content area */}
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="space-y-3">
              <div className="h-5 w-3/4 animate-pulse rounded bg-[var(--bg-2)]" />
              <div className="h-20 animate-pulse rounded bg-[var(--bg-2)]" />
            </div>
          ) : !approval ? (
            <div className="flex h-full flex-col items-center justify-center py-8 text-center">
              <CheckCircle className="h-8 w-8 text-[var(--ink-faint)]" />
              <p className="mt-3 text-sm font-medium text-[var(--ink)]">No pending approvals</p>
              <p className="mt-1 text-xs text-[var(--ink-soft)]">
                Everything currently waiting for a decision has been handled.
              </p>
            </div>
          ) : (
            <>
              {/* Plain-language action line */}
              <div className="rounded-[var(--radius-button)] border border-[color-mix(in_srgb,var(--pending)_24%,var(--border-soft))] bg-[color-mix(in_srgb,var(--pending)_8%,var(--bg-2))] px-4 py-3">
                <p className="text-[14px] font-semibold leading-snug text-[var(--ink)]">
                  {approvalActionLine(approval.label, decisionInput)}
                </p>
                <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
                  {formatRelative(approval.created_at)}
                  {isDestructiveDelete && (
                    <span className="ml-2 font-medium text-red-600 dark:text-red-400">Delete request</span>
                  )}
                </p>
              </div>

              {/* Action items */}
              {!isDestructiveDelete && <ApprovalActionItems decisionInput={decisionInput} />}

              {/* Proposed output via GenericOutput */}
              {approval.preview && (
                <div className="max-h-[120px] overflow-y-auto rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-2)] p-4">
                  <GenericOutput type={inferPreviewType(approval.preview)} value={approval.preview} />
                </div>
              )}

              {/* File preview */}
              {previewFile && (
                <ApprovalFilePreview
                  file={previewFile}
                  approval={approval}
                  isSignedLink={isSignedLink}
                  token={token}
                />
              )}

              {/* Read-only persisted annotations from prior reviewers */}
              {approval.annotations &&
                (approval.annotations.text?.length > 0 || approval.annotations.images?.length > 0) && (
                  <AnnotationsViewer
                    annotations={approval.annotations}
                    resolveImageUrl={resolveUploadUrl}
                  />
                )}
            </>
          )}
        </div>

        {/* Pinned footer: chatbox feedback row + Reject / Approve */}
        <div className="shrink-0 border-t border-[var(--border-soft)]">
          {/* Chatbox — resizable, auto-grows, drag-and-drop for images and files */}
          <div
            className={`mx-3 mt-3 flex items-start gap-2 rounded-[var(--radius-button)] border px-3 py-2 transition-colors ${
              dragOver
                ? "border-[var(--primary)] bg-[color-mix(in_srgb,var(--primary)_6%,var(--bg-2))]"
                : "border-[var(--border-soft)] bg-[var(--bg-2)]"
            }`}
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
          >
            <textarea
              value={chatComment}
              onChange={(e) => {
                setChatComment(e.target.value);
                e.target.style.height = "auto";
                e.target.style.height = `${e.target.scrollHeight}px`;
              }}
              placeholder="Add a comment or drop an image…"
              rows={1}
              className="flex-1 resize-none bg-transparent text-sm text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none"
              style={{ minHeight: "28px", maxHeight: "96px", overflowY: "auto" }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading || !approval}
              aria-label="Attach image or file"
              className="mt-0.5 shrink-0 text-[var(--ink-soft)] hover:text-[var(--ink)] disabled:opacity-40"
            >
              <ImageIcon className="h-4 w-4" />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) void uploadFile(file);
                e.target.value = "";
              }}
            />
          </div>

          {/* Attached file chips */}
          {chatFiles.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-3 pt-1.5">
              {chatFiles.map((f, i) => (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] border border-[var(--border-soft)] bg-[var(--bg-2)] px-2 py-0.5 text-xs text-[var(--ink-soft)]"
                >
                  <ImageIcon className="h-3 w-3" />
                  {f.name}
                  <button
                    type="button"
                    onClick={() => setChatFiles((prev) => prev.filter((_, j) => j !== i))}
                    className="ml-0.5 leading-none hover:text-[var(--ink)]"
                    aria-label={`Remove ${f.name}`}
                  >
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* Reject / Approve */}
          <div className="flex items-center gap-2 px-3 py-3">
            <button
              type="button"
              onClick={approve}
              disabled={!!busy || !approval}
              className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--primary)] px-4 text-sm font-medium text-[var(--primary-text)] shadow-[var(--shadow-btn)] disabled:opacity-40"
            >
              <CheckCircle className="h-4 w-4" />
              {busy === "approve" ? "Approving…" : "Approve"}
            </button>
            <button
              type="button"
              onClick={reject}
              disabled={!!busy || !approval}
              className="inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-soft)] px-4 text-sm font-medium text-destructive disabled:opacity-40"
            >
              <XCircle className="h-4 w-4" />
              {busy === "reject" ? "Rejecting…" : "Reject"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function ApprovalReviewPage() {
  return (
    <Suspense fallback={null}>
      <ReviewContent />
    </Suspense>
  );
}
