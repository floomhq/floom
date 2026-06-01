"use client";

import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { CheckCircle, ChevronLeft, ChevronRight, ExternalLink, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ApprovalRow } from "@/lib/types";

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
