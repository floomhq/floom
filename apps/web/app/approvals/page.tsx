"use client";

// S47: Approvals page — pending approval cards with Approve / Edit-then-approve / Reject.
// ChatGPT-simplicity bar: no nested cards, single blue accent, sentence case.

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { CheckCircle, Clock, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ApprovalRow } from "@/lib/types";
import { cn } from "@/lib/utils";

function formatRelative(iso: string) {
  const ms = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function ApprovalCard({
  approval,
  onDecision,
}: {
  approval: ApprovalRow;
  onDecision: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(approval.preview ?? "");
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);

  const handleApprove = useCallback(async () => {
    setBusy("approve");
    try {
      let editedOutput: Record<string, unknown> | undefined;
      if (editing && editedText !== (approval.preview ?? "")) {
        editedOutput = { text: editedText };
      }
      const res = await api.runs.approve(approval.run_id, editedOutput);
      toast.success("Approved — follow-up run started");
      if (res.run_id) {
        // Brief delay then navigate to follow-up run
        setTimeout(() => {
          window.location.href = `/runs/${res.run_id}`;
        }, 800);
      }
      onDecision();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  }, [approval.run_id, editing, editedText, approval.preview, onDecision]);

  const handleReject = useCallback(async () => {
    setBusy("reject");
    try {
      await api.runs.reject(approval.run_id, rejectReason || undefined);
      toast.success("Rejected");
      onDecision();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusy(null);
    }
  }, [approval.run_id, rejectReason, onDecision]);

  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--paper)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium text-[var(--ink)]">
              {approval.worker_name ?? approval.worker_id}
            </span>
            <span className="text-xs text-[var(--ink-mute)]">
              {formatRelative(approval.created_at)}
            </span>
          </div>
          {approval.label && (
            <p className="mt-0.5 text-xs text-[var(--ink-soft)]">{approval.label}</p>
          )}
          <Link
            href={`/runs/${approval.run_id}`}
            className="mt-0.5 text-[11px] text-[var(--ink-faint)] hover:text-[var(--ink-soft)] transition-colors"
          >
            Run {approval.run_id}
          </Link>
        </div>
        <span className="shrink-0 inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-amber-50 dark:bg-amber-950/30 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-400 border border-amber-200 dark:border-amber-800">
          <Clock className="h-3 w-3" />
          Pending
        </span>
      </div>

      {/* Preview / edit area */}
      {approval.preview && (
        <div className="mt-4">
          {editing ? (
            <textarea
              className="w-full min-h-[120px] rounded-[var(--radius-input)] border border-[var(--border-soft)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] resize-y"
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
            />
          ) : (
            <div className="rounded-[var(--radius-input)] border border-[var(--border-soft)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--ink)] whitespace-pre-wrap">
              {approval.preview}
            </div>
          )}
        </div>
      )}

      {/* Reject reason input */}
      {showReject && (
        <div className="mt-3">
          <input
            type="text"
            placeholder="Reason (optional)"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            className="w-full rounded-[var(--radius-input)] border border-[var(--border-soft)] bg-[var(--bg-2)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-1 focus:ring-destructive"
          />
        </div>
      )}

      {/* Action row */}
      <div className="mt-4 flex items-center gap-2 flex-wrap">
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

export default function ApprovalsPage() {
  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const rows = await api.approvals.list("pending");
      setApprovals(rows);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div className="max-w-2xl">
      <div className="mb-6">
        <h1 className="text-lg font-semibold text-[var(--ink)]">Approvals</h1>
        <p className="mt-1 text-sm text-[var(--ink-soft)]">
          Workers waiting for your decision before executing.
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {[0, 1].map((i) => (
            <div
              key={i}
              className="h-28 animate-pulse rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--bg-2)]"
            />
          ))}
        </div>
      ) : approvals.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--paper)] px-6 py-10 text-center">
          <CheckCircle className="mx-auto h-8 w-8 text-[var(--ink-faint)]" />
          <p className="mt-3 text-sm text-[var(--ink-soft)]">No pending approvals</p>
        </div>
      ) : (
        <div className="space-y-3">
          {approvals.map((a) => (
            <ApprovalCard key={a.id} approval={a} onDecision={load} />
          ))}
        </div>
      )}
    </div>
  );
}
