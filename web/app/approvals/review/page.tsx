"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle, ChevronLeft, ChevronRight, Download, ExternalLink, FileText, ImageIcon, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ApprovalRow, Artifact } from "@/lib/types";

function parseDecisionInput(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
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
  const artifactHref = file.artifact
    ? isSignedLink && token
      ? api.approvals.publicArtifactUrl(approval.id, file.artifact.id, token)
      : api.runs.artifactUrl(approval.run_id, file.artifact.id)
    : null;
  const href = file.href || artifactHref;
  const isImage = Boolean(href && file.mimeType?.startsWith("image/"));
  const meta = [file.mimeType || (file.artifact ? "artifact" : "file"), file.artifact ? formatBytes(file.artifact.size_bytes) : null]
    .filter(Boolean)
    .join(" · ");

  return (
    <div>
      <h2 className="text-sm font-medium text-[var(--ink)]">File preview</h2>
      <div className="mt-2 rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-2)]">
        <div className="flex min-w-0 items-center justify-between gap-3 border-b border-[var(--border-soft)] px-4 py-3">
          <span className="flex min-w-0 items-center gap-2">
            {isImage ? <ImageIcon className="h-4 w-4 shrink-0 text-[var(--ink-soft)]" /> : <FileText className="h-4 w-4 shrink-0 text-[var(--ink-soft)]" />}
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
        {isImage ? (
          <div className="max-h-[46vh] overflow-auto p-3">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={href ?? undefined} alt={file.title} className="max-h-[42vh] max-w-full rounded-[var(--radius-button)] object-contain" />
          </div>
        ) : file.text ? (
          <pre className="max-h-[46vh] overflow-auto whitespace-pre-wrap p-4 text-sm leading-6 text-[var(--ink)]">{file.text}</pre>
        ) : (
          <div className="p-4 text-sm text-[var(--ink-soft)]">
            {href
              ? "This approval includes a file artifact. Download it to inspect the contents."
              : "This approval includes a file artifact. Open the run to inspect the file contents."}
          </div>
        )}
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
  const [reason, setReason] = useState("");
  const [showReason, setShowReason] = useState(false);

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

  const removeCurrent = useCallback(() => {
    setRows((current) => {
      const next = current.filter((row) => row.id !== approval?.id);
      setIndex((currentIndex) => Math.min(currentIndex, Math.max(0, next.length - 1)));
      return next;
    });
  }, [approval?.id]);

  const approve = useCallback(async () => {
    if (!approval) return;
    setBusy("approve");
    try {
      if (isSignedLink && token) {
        await api.approvals.publicApprove(approval.id, token);
      } else if (isDestructiveDelete) {
        await api.approvals.approveAction(approval.id);
      } else {
        await api.runs.approve(approval.run_id);
      }
      toast.success("Approved");
      removeCurrent();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  }, [approval, isDestructiveDelete, isSignedLink, removeCurrent, token]);

  const reject = useCallback(async () => {
    if (!approval) return;
    setBusy("reject");
    try {
      if (isSignedLink && token) {
        await api.approvals.publicReject(approval.id, token, reason || undefined);
      } else if (isDestructiveDelete) {
        await api.approvals.rejectAction(approval.id, reason || undefined);
      } else {
        await api.runs.reject(approval.run_id, reason || undefined);
      }
      toast.success("Rejected");
      setReason("");
      setShowReason(false);
      removeCurrent();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Reject failed");
    } finally {
      setBusy(null);
    }
  }, [approval, isDestructiveDelete, isSignedLink, reason, removeCurrent, token]);

  return (
    <div className="mx-auto flex min-h-screen w-full max-w-3xl flex-col px-4 py-6 sm:px-6 sm:py-10">
      <div className="mb-6 flex items-center justify-between gap-4">
        {isSignedLink ? (
          <span className="text-sm text-[var(--ink-soft)]">Approval review</span>
        ) : (
          <Link
            href="/approvals"
            className="inline-flex items-center gap-1.5 text-sm text-[var(--ink-soft)] hover:text-[var(--ink)]"
          >
            <ChevronLeft className="h-4 w-4" />
            All approvals
          </Link>
        )}
        {rows.length > 0 && (
          <span className="text-sm text-[var(--ink-soft)]">
            {index + 1} of {rows.length}
          </span>
        )}
      </div>

      {loading ? (
        <div className="rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--paper)] p-6">
          <div className="h-6 w-48 animate-pulse rounded bg-[var(--bg-2)]" />
          <div className="mt-5 h-44 animate-pulse rounded bg-[var(--bg-2)]" />
        </div>
      ) : !approval ? (
        <div className="rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--paper)] px-6 py-12 text-center">
          <CheckCircle className="mx-auto h-9 w-9 text-[var(--ink-faint)]" />
          <h1 className="mt-4 text-xl font-semibold text-[var(--ink)]">
            No pending approvals
          </h1>
          <p className="mt-2 text-sm text-[var(--ink-soft)]">
            Everything currently waiting for a decision has been handled.
          </p>
        </div>
      ) : (
        <section className="rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--paper)] shadow-[var(--shadow-card)]">
          <div className="border-b border-[var(--border-soft)] px-5 py-4 sm:px-6">
            <div className="flex flex-wrap items-center gap-2 text-xs text-[var(--ink-soft)]">
              <span>{formatRelative(approval.created_at)}</span>
              {isDestructiveDelete && (
                <span className="rounded-[var(--radius-pill)] border border-red-200 bg-red-50 px-2 py-0.5 font-medium text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
                  Delete request
                </span>
              )}
            </div>
            <h1 className="mt-2 text-2xl font-semibold tracking-tight text-[var(--ink)]">
              {approval.label || "Review approval"}
            </h1>
            <div className="mt-2 flex flex-wrap gap-3 text-sm text-[var(--ink-soft)]">
              <Link className="inline-flex items-center gap-1 hover:text-[var(--ink)]" href={`/workers/${approval.worker_id}`}>
                {approval.worker_name ?? approval.worker_id}
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
              <Link className="inline-flex items-center gap-1 hover:text-[var(--ink)]" href={`/runs/${approval.run_id}`}>
                Run {approval.run_id}
                <ExternalLink className="h-3.5 w-3.5" />
              </Link>
            </div>
          </div>

          <div className="space-y-5 px-5 py-5 sm:px-6">
            {approval.preview ? (
              <div>
                <h2 className="text-sm font-medium text-[var(--ink)]">Preview</h2>
                <div className="mt-2 max-h-[46vh] overflow-auto rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-2)] p-4 text-sm leading-6 text-[var(--ink)] whitespace-pre-wrap">
                  {approval.preview}
                </div>
              </div>
            ) : (
              <div className="rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-2)] p-4 text-sm text-[var(--ink-soft)]">
                This approval does not include a rendered preview.
              </div>
            )}

            {previewFile && (
              <ApprovalFilePreview
                file={previewFile}
                approval={approval}
                isSignedLink={isSignedLink}
                token={token}
              />
            )}

            {Object.keys(decisionInput).length > 0 && (
              <details className="rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-transparent">
                <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-[var(--ink)]">
                  Request metadata
                </summary>
                <pre className="overflow-auto border-t border-[var(--border-soft)] p-4 text-xs text-[var(--ink-soft)]">
                  {JSON.stringify(decisionInput, null, 2)}
                </pre>
              </details>
            )}

            {showReason && (
              <label className="block">
                <span className="text-sm font-medium text-[var(--ink)]">Reason for rejection</span>
                <textarea
                  value={reason}
                  onChange={(event) => setReason(event.target.value)}
                  className="mt-2 min-h-24 w-full rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--ink)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)]"
                  placeholder="Tell the worker what to change."
                />
              </label>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-2 border-t border-[var(--border-soft)] px-5 py-4 sm:px-6">
            <button
              type="button"
              onClick={approve}
              disabled={!!busy}
              className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-button)] bg-[var(--primary)] px-4 text-sm font-medium text-[var(--primary-text)] shadow-[var(--shadow-btn)] disabled:opacity-40"
            >
              <CheckCircle className="h-4 w-4" />
              {busy === "approve" ? "Approving" : "Approve"}
            </button>
            {showReason ? (
              <button
                type="button"
                onClick={reject}
                disabled={!!busy}
                className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-button)] bg-destructive px-4 text-sm font-medium text-white disabled:opacity-40"
              >
                <XCircle className="h-4 w-4" />
                {busy === "reject" ? "Rejecting" : "Reject"}
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowReason(true)}
                disabled={!!busy}
                className="inline-flex h-10 items-center gap-2 rounded-[var(--radius-button)] border border-[var(--border-soft)] px-4 text-sm font-medium text-destructive disabled:opacity-40"
              >
                <XCircle className="h-4 w-4" />
                Reject
              </button>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                type="button"
                onClick={() => setIndex((current) => Math.max(0, current - 1))}
                disabled={index === 0 || !!busy}
                aria-label="Previous approval"
                className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-button)] border border-[var(--border-soft)] disabled:opacity-40"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setIndex((current) => Math.min(rows.length - 1, current + 1))}
                disabled={index >= rows.length - 1 || !!busy}
                aria-label="Next approval"
                className="inline-flex h-10 w-10 items-center justify-center rounded-[var(--radius-button)] border border-[var(--border-soft)] disabled:opacity-40"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </div>
        </section>
      )}
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
