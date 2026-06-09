"use client";

import { useCallback, useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { toast } from "sonner";
import { CheckCircle, XCircle } from "lucide-react";
import Link from "next/link";
import { Skeleton } from "@/components/ui/skeleton";
import { RunDetailSplitPane } from "@/components/RunDetailSplitPane";
import { api } from "@/lib/api";
import { notifyApprovalsChanged } from "@/lib/useApprovalsSync";
import { useRunStream } from "@/lib/useRunStream";
import type { ApprovalRow, RunDetail } from "@/lib/types";

// S47: Inline approval decision card shown on PENDING_APPROVAL runs.
function ApprovalDecisionCard({
  approval,
  onDecision,
}: {
  approval: ApprovalRow;
  onDecision: (followUpRunId?: string) => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(approval.preview ?? "");
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);

  const handleApprove = async () => {
    setBusy("approve");
    try {
      let editedOutput: Record<string, unknown> | undefined;
      if (editing && editedText !== (approval.preview ?? "")) {
        editedOutput = { text: editedText };
      }
      const res = await api.runs.approve(approval.run_id, editedOutput);
      toast.success("Approved — follow-up run started");
      notifyApprovalsChanged();
      onDecision(res.run_id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  };

  const handleReject = async () => {
    setBusy("reject");
    try {
      await api.runs.reject(approval.run_id, rejectReason || undefined);
      toast.success("Rejected");
      notifyApprovalsChanged();
      onDecision();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mb-4 rounded-[var(--radius-card)] border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 p-5">
      <p className="text-sm font-medium text-[var(--ink)]">
        {approval.label ?? "Awaiting your approval"}
      </p>
      <p className="mt-0.5 text-xs text-[var(--ink-soft)]">
        Approve to execute, or reject to discard. The side-effect runs only after approval.
      </p>

      {approval.preview && (
        <div className="mt-3">
          {editing ? (
            <textarea
              className="w-full min-h-[100px] rounded-[var(--radius-input)] border border-[var(--border-soft)] bg-[var(--bg-app)] px-3 py-2 text-sm text-[var(--ink)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] resize-y"
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
            />
          ) : (
            <div className="rounded-[var(--radius-input)] border border-[var(--border-soft)] bg-[var(--bg-app)] px-3 py-2 text-sm text-[var(--ink)] whitespace-pre-wrap">
              {approval.preview}
            </div>
          )}
        </div>
      )}

      {showReject && (
        <div className="mt-2">
          <input
            type="text"
            placeholder="Reason (optional)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            className="w-full rounded-[var(--radius-input)] border border-[var(--border-soft)] bg-[var(--bg-app)] px-3 py-1.5 text-sm text-[var(--ink)] focus:outline-none focus:ring-1 focus:ring-destructive"
          />
        </div>
      )}

      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={handleApprove}
          disabled={!!busy}
          className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--primary)] px-3 text-sm font-medium text-[var(--primary-text)] hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          <CheckCircle className="h-3.5 w-3.5" />
          {editing ? "Approve edited" : "Approve"}
        </button>

        {approval.preview && !editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            disabled={!!busy}
            className="inline-flex h-8 items-center rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-transparent px-3 text-sm font-medium text-[var(--ink)] hover:bg-[var(--bg-2)] disabled:opacity-40 transition-colors"
          >
            Edit then approve
          </button>
        )}
        {editing && (
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="inline-flex h-8 items-center rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-transparent px-3 text-sm text-[var(--ink-soft)] hover:bg-[var(--bg-2)] transition-colors"
          >
            Cancel edit
          </button>
        )}
        {!showReject ? (
          <button
            type="button"
            onClick={() => setShowReject(true)}
            disabled={!!busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-transparent px-3 text-sm font-medium text-destructive hover:bg-destructive/5 disabled:opacity-40 transition-colors"
          >
            <XCircle className="h-3.5 w-3.5" />
            Reject
          </button>
        ) : (
          <button
            type="button"
            onClick={handleReject}
            disabled={!!busy}
            className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] bg-destructive px-3 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
          >
            Confirm reject
          </button>
        )}
      </div>
    </div>
  );
}

export default function RunDetailPage() {
  const { id } = useParams();
  const router = useRouter();
  const runId = id as string;
  const [run, setRun] = useState<RunDetail | null>(null);
  const [approval, setApproval] = useState<ApprovalRow | null>(null);
  const [approvalLoadError, setApprovalLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const { parts, fallbackRun, connected, error, finishedPart, streamUnavailable, refresh } = useRunStream(runId);

  const load = useCallback(async () => {
    try {
      const detail = await api.runs.get(runId);
      setRun(detail);
      setApprovalLoadError(null);
      if (detail.status === "pending_approval") {
        // Fetch approval row to show decision card
        try {
          const rows = await api.approvals.list("pending");
          const match = rows.find((r) => r.run_id === runId);
          setApproval(match ?? null);
        } catch (exc) {
          const message = exc instanceof Error ? exc.message : "Could not load approval";
          setApproval(null);
          setApprovalLoadError(message);
        }
      } else {
        setApproval(null);
        setApprovalLoadError(null);
      }
    } catch (exc) {
      toast.error(exc instanceof Error ? exc.message : "Failed to load run");
    } finally {
      setLoading(false);
    }
  }, [runId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (fallbackRun) {
      setRun(fallbackRun);
      setLoading(false);
    }
  }, [fallbackRun]);

  useEffect(() => {
    if (finishedPart) void load();
  }, [finishedPart, load]);

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-[560px] w-full" />
      </div>
    );
  }

  if (!run) {
    return <div className="text-sm text-muted-foreground">Run not found.</div>;
  }

  return (
    <div>
      {run.status === "pending_approval" && approval && (
        <ApprovalDecisionCard
          approval={approval}
          onDecision={(followUpRunId) => {
            if (followUpRunId) {
              router.push(`/runs/${followUpRunId}`);
            } else {
              void load();
            }
          }}
        />
      )}
      {run.status === "pending_approval" && approvalLoadError && (
        <div className="mb-4 rounded-[var(--radius-card)] border border-red-200 bg-red-50/80 px-5 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <div className="font-medium">Could not load the approval card.</div>
          <div className="mt-1">{approvalLoadError}</div>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-2 inline-flex h-8 items-center rounded-[var(--radius-button)] border border-red-200 px-3 text-xs font-medium hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/40"
          >
            Retry
          </button>
        </div>
      )}
      {run.status === "pending_approval" && !approval && !approvalLoadError && (
        <div className="mb-4 rounded-[var(--radius-card)] border border-amber-200 dark:border-amber-800 bg-amber-50/50 dark:bg-amber-950/20 px-5 py-3 text-sm text-amber-700 dark:text-amber-400">
          Awaiting approval. <Link href="/approvals" className="underline underline-offset-2">View approvals</Link>
        </div>
      )}
      <RunDetailSplitPane
        run={run}
        parts={parts}
        streamConnected={connected}
        streamError={error}
        streamUnavailable={streamUnavailable}
        onRefresh={refresh}
        onBack={() => router.push("/runs")}
        onReplay={async () => {
          try {
            const result = await api.runs.replay(run.worker_id, run.id);
            if (!result.run_id) throw new Error("Run ID missing from API response");
            toast.success("Re-running with same inputs");
            router.push(`/runs/${result.run_id}`);
          } catch (exc) {
            toast.error(`Re-run failed: ${exc instanceof Error ? exc.message : "unknown"}`);
          }
        }}
        onCancel={async () => {
          if (!confirm("Cancel this run?")) return;
          try {
            await api.runs.cancel(run.id);
            toast.success("Cancellation requested");
            void load();
          } catch (exc) {
            toast.error(`Cancel failed: ${exc instanceof Error ? exc.message : "unknown"}`);
          }
        }}
      />
    </div>
  );
}
