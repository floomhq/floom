"use client";

// S47: Approvals page — pending approval cards with Approve / Edit-then-approve / Reject.
// feat/approvals-user-flow: worker name links to /workers/<id>, run id links to /runs/<id>,
//   deep-link via ?id=<approval_id> scrolls + briefly highlights the target card.
// B5 (Phase 5.2): organisation at scale — group by worker (collapsible), sort
//   (newest / oldest / worker), paginate (matches /runs pattern), per-card age,
//   oldest visually distinct, light per-group bulk approve/reject.
// ChatGPT-simplicity bar: no nested cards, single blue accent, sentence case, no emoji.

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Check, CheckCircle, ChevronDown, Clock, ExternalLink, Link2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ApprovalRow } from "@/lib/types";
import { cn } from "@/lib/utils";
import { notifyApprovalsChanged, useApprovalsListSync } from "@/lib/useApprovalsSync";

const PAGE_SIZE = 20;
// A pending approval older than this reads as "most-waiting" → subtle emphasis.
const STALE_MS = 6 * 60 * 60 * 1000; // 6h

type SortMode = "newest" | "oldest" | "worker";

function ageMs(iso: string): number {
  return Date.now() - new Date(iso).getTime();
}

// "pending 12m" / "pending 3h" / "pending 2d" — sets up the future soft-deadline.
function formatPending(iso: string): string {
  const mins = Math.floor(ageMs(iso) / 60000);
  if (mins < 1) return "pending just now";
  if (mins < 60) return `pending ${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `pending ${hrs}h`;
  return `pending ${Math.floor(hrs / 24)}d`;
}

function parseDecisionInput(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function ApprovalCard({
  approval,
  highlighted,
  stale,
  selectable,
  selected,
  onToggleSelect,
  onDecision,
}: {
  approval: ApprovalRow;
  highlighted: boolean;
  stale: boolean;
  selectable: boolean;
  selected: boolean;
  onToggleSelect: () => void;
  onDecision: () => void;
}) {
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [editing, setEditing] = useState(false);
  const [editedText, setEditedText] = useState(approval.preview ?? "");
  const [rejectReason, setRejectReason] = useState("");
  const [showReject, setShowReject] = useState(false);
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  // Standalone signed review link the owner can share or open full-page outside
  // the dashboard. Minted server-side and returned on the approval row.
  const shareLink = approval.public_link ?? null;

  const handleCopyLink = useCallback(async () => {
    if (!shareLink) return;
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
      toast.success("Link copied");
    } catch {
      toast.error("Could not copy link");
    }
  }, [shareLink]);

  const decisionInput = parseDecisionInput(approval.decision_input_json);
  const isDestructiveDelete = decisionInput.kind === "destructive_delete";

  // Scroll into view and briefly highlight when this card is the deep-link target.
  useEffect(() => {
    if (!highlighted) return;
    const el = cardRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }, [highlighted]);

  const handleApprove = useCallback(async () => {
    setBusy("approve");
    try {
      if (isDestructiveDelete) {
        const res = await api.approvals.approveAction(approval.id);
        toast.success(res.detail || "Delete approved and executed");
        notifyApprovalsChanged();
        onDecision();
      } else {
        let editedOutput: Record<string, unknown> | undefined;
        if (editing && editedText !== (approval.preview ?? "")) {
          editedOutput = { text: editedText };
        }
        const res = await api.runs.approve(approval.run_id, editedOutput);
        toast.success("Approved — follow-up run started");
        notifyApprovalsChanged();
        if (res.run_id) {
          setTimeout(() => {
            window.location.href = `/runs/${res.run_id}`;
          }, 800);
        }
        onDecision();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Approve failed");
    } finally {
      setBusy(null);
    }
  }, [approval.id, approval.run_id, editing, editedText, approval.preview, isDestructiveDelete, onDecision]);

  const handleReject = useCallback(async () => {
    setBusy("reject");
    try {
      if (isDestructiveDelete) {
        await api.approvals.rejectAction(approval.id, rejectReason || undefined);
        toast.success("Delete request rejected");
      } else {
        await api.runs.reject(approval.run_id, rejectReason || undefined);
        toast.success("Rejected");
      }
      notifyApprovalsChanged();
      onDecision();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Reject failed");
    } finally {
      setBusy(null);
    }
  }, [approval.id, approval.run_id, rejectReason, isDestructiveDelete, onDecision]);

  return (
    <div
      ref={cardRef}
      className={cn(
        "rounded-[var(--radius-card)] border bg-[var(--paper)] p-5 transition-[box-shadow] duration-500",
        highlighted
          ? "border-blue-500/60 ring-2 ring-blue-500/20"
          : "border-[var(--border-soft)]"
      )}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          {selectable && (
            <input
              type="checkbox"
              checked={selected}
              onChange={onToggleSelect}
              disabled={!!busy}
              aria-label="Select approval"
              className="mt-1 h-4 w-4 shrink-0 cursor-pointer accent-[var(--primary)]"
            />
          )}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {/* Worker name links to /workers/<worker_id> */}
              <Link
                href={`/workers/${approval.worker_id}`}
                className="text-sm font-medium text-[var(--ink)] hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
              >
                {approval.worker_name ?? approval.worker_id}
              </Link>
              {isDestructiveDelete && (
                <span className="inline-flex items-center gap-1 rounded-[var(--radius-pill)] bg-red-50 dark:bg-red-950/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-700 dark:text-red-400 border border-red-200 dark:border-red-800">
                  Delete request
                </span>
              )}
              <span
                className={cn(
                  "text-xs",
                  stale ? "font-medium text-amber-700 dark:text-amber-400" : "text-[var(--ink-mute)]"
                )}
              >
                {formatPending(approval.created_at)}
              </span>
            </div>
            {approval.label && (
              <p className="mt-0.5 text-xs text-[var(--ink-soft)]">{approval.label}</p>
            )}
            {/* Run link — "Run run_xxx" → /runs/<run_id> */}
            <Link
              href={`/runs/${approval.run_id}`}
              className="mt-0.5 block text-[11px] text-[var(--ink-faint)] hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
            >
              Run {approval.run_id}
            </Link>
          </div>
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
              className="w-full min-h-[120px] rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-1 focus:ring-[var(--primary)] resize-y"
              value={editedText}
              onChange={(e) => setEditedText(e.target.value)}
            />
          ) : (
            <div className="rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-2)] px-3 py-2 text-sm text-[var(--ink)] whitespace-pre-wrap">
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
            className="w-full rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-2)] px-3 py-1.5 text-sm text-[var(--ink)] placeholder:text-[var(--ink-faint)] focus:outline-none focus:ring-1 focus:ring-destructive"
          />
        </div>
      )}

      {/* Action row */}
      <div className="mt-4 flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={handleApprove}
          disabled={!!busy}
          className={cn(
            "inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] px-3 text-sm font-medium transition-opacity disabled:opacity-40",
            isDestructiveDelete
              ? "bg-red-600 text-white hover:bg-red-700"
              : "bg-[var(--primary)] text-[var(--primary-text)] hover:opacity-90"
          )}
        >
          <CheckCircle className="h-3.5 w-3.5" />
          {isDestructiveDelete ? "Approve & delete" : editing ? "Approve edited" : "Approve"}
        </button>

        {approval.preview && !editing && !isDestructiveDelete && (
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

        {/* Per-approval share — copies THIS approval's own unlisted link (its own
            id + signed token). Send it to one person to have them review just
            this item; no login required on their end. Distinct from the header's
            "Open as full page", which steps through the whole pending queue. */}
        {shareLink && (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={handleCopyLink}
              title="Copy this approval's unlisted link — send it to one person to review just this item (no login needed)"
              className="inline-flex h-8 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-transparent px-2.5 text-xs font-medium text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-[var(--ink)] transition-colors"
            >
              {copied ? <Check className="h-3.5 w-3.5 text-green-600 dark:text-green-400" /> : <Link2 className="h-3.5 w-3.5" />}
              {copied ? "Copied" : "Copy share link"}
            </button>
            <a
              href={shareLink}
              target="_blank"
              rel="noopener noreferrer"
              title="Open just this approval as a standalone full page"
              className="inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-transparent text-[var(--ink-soft)] hover:bg-[var(--bg-2)] hover:text-[var(--ink)] transition-colors"
              aria-label="Open this approval as a standalone page"
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </div>
        )}
      </div>
    </div>
  );
}

type WorkerGroup = {
  workerId: string;
  workerName: string;
  rows: ApprovalRow[];
};

// Loading skeleton that mirrors the real loaded layout (sort/count bar → worker
// group header → cards with worker name, label, run link, preview block, action
// row). Same radius/spacing/border tokens as ApprovalCard so data arrival causes
// no layout shift. Shared by the inline loading state and the Suspense fallback.
function ApprovalCardSkeleton() {
  return (
    <div className="rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--paper)] p-5">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1 space-y-2">
          {/* worker name + pending age */}
          <div className="flex items-center gap-2">
            <div className="h-4 w-32 animate-pulse rounded bg-[var(--bg-2)]" />
            <div className="h-3 w-16 animate-pulse rounded bg-[var(--bg-2)]" />
          </div>
          {/* label */}
          <div className="h-3 w-48 animate-pulse rounded bg-[var(--bg-2)]" />
          {/* run link */}
          <div className="h-2.5 w-28 animate-pulse rounded bg-[var(--bg-2)]" />
        </div>
        {/* Pending pill */}
        <div className="h-5 w-20 shrink-0 animate-pulse rounded-[var(--radius-pill)] bg-[var(--bg-2)]" />
      </div>
      {/* preview block */}
      <div className="mt-4 h-16 animate-pulse rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-2)]" />
      {/* action row */}
      <div className="mt-4 flex items-center gap-2">
        <div className="h-8 w-24 animate-pulse rounded-[var(--radius-button)] bg-[var(--bg-2)]" />
        <div className="h-8 w-28 animate-pulse rounded-[var(--radius-button)] bg-[var(--bg-2)]" />
        <div className="h-8 w-20 animate-pulse rounded-[var(--radius-button)] bg-[var(--bg-2)]" />
        <div className="ml-auto h-8 w-24 animate-pulse rounded-[var(--radius-button)] bg-[var(--bg-2)]" />
      </div>
    </div>
  );
}

function ApprovalsListSkeleton() {
  return (
    <div className="max-w-2xl">
      {/* Sort + count bar */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="h-3 w-20 animate-pulse rounded bg-[var(--bg-2)]" />
        <div className="flex items-center gap-3">
          <div className="h-3 w-12 animate-pulse rounded bg-[var(--bg-2)]" />
          <div className="h-3 w-16 animate-pulse rounded bg-[var(--bg-2)]" />
          <div className="h-3 w-14 animate-pulse rounded bg-[var(--bg-2)]" />
        </div>
      </div>
      <div className="space-y-5">
        <section className="space-y-3">
          {/* Worker group header */}
          <div className="flex items-center gap-1.5">
            <div className="h-4 w-4 animate-pulse rounded bg-[var(--bg-2)]" />
            <div className="h-4 w-28 animate-pulse rounded bg-[var(--bg-2)]" />
            <div className="h-4 w-6 animate-pulse rounded bg-[var(--bg-2)]" />
          </div>
          <div className="space-y-3">
            <ApprovalCardSkeleton />
            <ApprovalCardSkeleton />
          </div>
        </section>
      </div>
    </div>
  );
}

function ApprovalsPageSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-2">
          <div className="h-7 w-28 animate-pulse rounded bg-[var(--bg-2)]" />
          <div className="h-4 w-64 animate-pulse rounded bg-[var(--bg-2)]" />
        </div>
        <div className="h-4 w-28 shrink-0 animate-pulse rounded bg-[var(--bg-2)]" />
      </div>
      <ApprovalsListSkeleton />
    </div>
  );
}

function ApprovalsContent() {
  const searchParams = useSearchParams();
  // Deep-link: ?id=<approval_id> scrolls + highlights that card.
  const targetId = searchParams.get("id") ?? null;

  const [approvals, setApprovals] = useState<ApprovalRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [sort, setSort] = useState<SortMode>("newest");
  const [page, setPage] = useState(0);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const rows = await api.approvals.list("pending");
      setApprovals(rows);
      // Drop any selections that no longer exist.
      setSelected((prev) => {
        const ids = new Set(rows.map((r) => r.id));
        const next = new Set([...prev].filter((id) => ids.has(id)));
        return next;
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not load approvals";
      setLoadError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Revalidate on focus + on the shared change signal so the list never drifts
  // from the nav badge (G5 P2).
  useApprovalsListSync(load);

  const sortedAll = useMemo(() => {
    const rows = [...approvals];
    if (sort === "oldest") {
      rows.sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
    } else {
      // newest + worker both default to newest-first within their grouping
      rows.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
    }
    return rows;
  }, [approvals, sort]);

  const totalPages = Math.max(1, Math.ceil(sortedAll.length / PAGE_SIZE));
  const safePage = Math.min(page, totalPages - 1);
  const pageRows = useMemo(
    () => sortedAll.slice(safePage * PAGE_SIZE, safePage * PAGE_SIZE + PAGE_SIZE),
    [sortedAll, safePage]
  );

  // Oldest pending across the whole set — visually emphasised even when stale.
  const oldestId = useMemo(() => {
    if (approvals.length === 0) return null;
    return [...approvals].sort(
      (a, b) => +new Date(a.created_at) - +new Date(b.created_at)
    )[0].id;
  }, [approvals]);

  // Deep-link: if ?id= targets a row on a later page, jump to that page once.
  const jumpedRef = useRef(false);
  useEffect(() => {
    if (jumpedRef.current || !targetId || sortedAll.length === 0) return;
    const idx = sortedAll.findIndex(
      (r) => r.id === targetId || r.run_id === targetId
    );
    if (idx >= 0) {
      jumpedRef.current = true;
      setPage(Math.floor(idx / PAGE_SIZE));
    }
  }, [targetId, sortedAll]);

  // Group the current page's rows by worker. Rows keep the active sort order
  // (pageRows is pre-sorted). Group order: by-worker → alphabetical; otherwise
  // groups follow the order their first (sort-leading) row appears.
  const groups = useMemo<WorkerGroup[]>(() => {
    const map = new Map<string, WorkerGroup>();
    for (const row of pageRows) {
      const key = row.worker_id;
      const existing = map.get(key);
      if (existing) existing.rows.push(row);
      else
        map.set(key, {
          workerId: key,
          workerName: row.worker_name ?? row.worker_id,
          rows: [row],
        });
    }
    const result = Array.from(map.values());
    if (sort === "worker") {
      result.sort((a, b) => a.workerName.localeCompare(b.workerName));
    }
    return result;
  }, [pageRows, sort]);

  const toggleCollapse = useCallback((workerId: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(workerId)) next.delete(workerId);
      else next.add(workerId);
      return next;
    });
  }, []);

  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectGroup = useCallback((group: WorkerGroup) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const allSelected = group.rows.every((r) => next.has(r.id));
      if (allSelected) group.rows.forEach((r) => next.delete(r.id));
      else group.rows.forEach((r) => next.add(r.id));
      return next;
    });
  }, []);

  // Bulk action: call the existing per-run approve/reject endpoints in sequence.
  const runBulk = useCallback(
    async (group: WorkerGroup, action: "approve" | "reject") => {
      const ids = group.rows.filter((r) => selected.has(r.id));
      if (ids.length === 0) return;
      setBulkBusy(true);
      let ok = 0;
      let failed = 0;
      for (const row of ids) {
        try {
          const di = parseDecisionInput(row.decision_input_json);
          const isDelete = di.kind === "destructive_delete";
          if (action === "approve") {
            if (isDelete) await api.approvals.approveAction(row.id);
            else await api.runs.approve(row.run_id);
          } else {
            if (isDelete) await api.approvals.rejectAction(row.id);
            else await api.runs.reject(row.run_id);
          }
          ok += 1;
        } catch {
          failed += 1;
        }
      }
      setBulkBusy(false);
      if (ok > 0) {
        toast.success(
          `${action === "approve" ? "Approved" : "Rejected"} ${ok}${
            failed ? `, ${failed} failed` : ""
          }`
        );
      } else if (failed > 0) {
        toast.error(`${failed} ${action === "approve" ? "approvals" : "rejections"} failed`);
      }
      if (ok > 0) notifyApprovalsChanged();
      await load();
    },
    [selected, load]
  );

  return (
    // P2-12 (audit 2026-05-29): page was max-w-2xl while Runs/Connections fill
    // the layout container, so the empty-state card looked half-width. Match
    // their full-width rhythm; the approval list keeps a comfortable reading
    // column internally below.
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-[var(--ink)]">Approvals</h1>
          <p className="mt-1 text-sm text-[var(--ink-soft)]">
            Workers waiting for your decision before executing.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 sm:shrink-0">
          {/* Standalone full-page review of all pending approvals — the
              /approvals/review route renders chrome-free (no dashboard sidebar)
              and steps through every pending item. Opens in a new tab so it can
              be used full-screen or handed off. */}
          {approvals.length > 0 && (
            <a
              href="/approvals/review"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 text-sm text-[var(--ink-soft)] underline-offset-2 hover:text-[var(--ink)] hover:underline transition-colors"
              title="Open ALL pending approvals as a standalone full page (steps through the whole queue). To send one approval to one person, use its per-card share link."
            >
              <ExternalLink className="h-3.5 w-3.5" />
              Review all as full page
            </a>
          )}
          {/* P1-9: link back to the dashboard for chat-only operators who land
              here from a notification. "Go to platform" was both low-contrast and
              ambiguous in the single-tenant OS (implied the separate Cloud
              product). Clearer copy + readable contrast. */}
          <Link
            href="/overview"
            className="text-sm text-[var(--ink-soft)] underline-offset-2 hover:text-[var(--ink)] hover:underline transition-colors"
          >
            Back to dashboard
          </Link>
        </div>
      </div>

      {loading ? (
        <ApprovalsListSkeleton />
      ) : loadError ? (
        <div className="rounded-[var(--radius-card)] border border-red-200 bg-red-50/80 p-5 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-300">
          <div className="font-medium">Could not load approvals.</div>
          <div className="mt-1">{loadError}</div>
          <button
            type="button"
            onClick={() => void load()}
            className="mt-3 inline-flex h-8 items-center rounded-[var(--radius-button)] border border-red-200 px-3 text-xs font-medium hover:bg-red-100 dark:border-red-800 dark:hover:bg-red-900/40"
          >
            Retry
          </button>
        </div>
      ) : approvals.length === 0 ? (
        <div className="w-full rounded-[var(--radius-card)] border border-[var(--border-soft)] bg-[var(--paper)] px-6 py-10 text-center">
          <CheckCircle className="mx-auto h-8 w-8 text-[var(--ink-faint)]" />
          <p className="mt-3 text-sm text-[var(--ink-soft)]">No pending approvals</p>
          <Link
            href="/overview"
            className="mt-4 inline-block text-sm text-[var(--ink-soft)] underline-offset-2 hover:text-[var(--ink)] hover:underline transition-colors"
          >
            Back to dashboard
          </Link>
        </div>
      ) : (
        // Approval cards keep a comfortable reading column; the page header and
        // empty-state span full width to match Runs/Connections (P2-12).
        <div className="max-w-2xl">
          {/* Sort + count bar */}
          <div className="mb-4 flex items-center justify-between gap-3">
            <span className="text-xs text-[var(--ink-mute)]">
              {approvals.length} pending
            </span>
            <div className="flex items-center gap-3">
              {(["newest", "oldest", "worker"] as SortMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => {
                    setSort(mode);
                    setPage(0);
                  }}
                  className={cn(
                    "text-xs transition-colors",
                    sort === mode
                      ? "font-medium text-[var(--ink)]"
                      : "text-[var(--ink-mute)] hover:text-[var(--ink-soft)]"
                  )}
                >
                  {mode === "newest"
                    ? "Newest"
                    : mode === "oldest"
                    ? "Most waiting"
                    : "By worker"}
                </button>
              ))}
            </div>
          </div>

          <div className="space-y-5">
            {groups.map((group) => {
              const isCollapsed = collapsed.has(group.workerId);
              const groupSelected = group.rows.filter((r) => selected.has(r.id));
              const allSelected =
                group.rows.length > 0 && group.rows.every((r) => selected.has(r.id));
              return (
                <section key={group.workerId} className="space-y-3">
                  {/* Group header — worker name + count, collapsible */}
                  <div className="flex items-center justify-between gap-3">
                    <button
                      type="button"
                      onClick={() => toggleCollapse(group.workerId)}
                      className="flex min-w-0 items-center gap-1.5 text-sm font-medium text-[var(--ink)] transition-colors hover:text-blue-600 dark:hover:text-blue-400"
                    >
                      <ChevronDown
                        className={cn(
                          "h-4 w-4 shrink-0 text-[var(--ink-mute)] transition-transform",
                          isCollapsed && "-rotate-90"
                        )}
                      />
                      <span className="truncate">{group.workerName}</span>
                      <span className="shrink-0 text-[var(--ink-mute)]">
                        ({group.rows.length})
                      </span>
                    </button>
                    {/* Light bulk affordance — only shows when ≥2 in group */}
                    {group.rows.length >= 2 && (
                      <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-xs text-[var(--ink-mute)]">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={() => toggleSelectGroup(group)}
                          disabled={bulkBusy}
                          className="h-3.5 w-3.5 cursor-pointer accent-[var(--primary)]"
                        />
                        Select all
                      </label>
                    )}
                  </div>

                  {/* Per-group bulk action bar — only when something is selected */}
                  {groupSelected.length > 0 && (
                    <div className="flex items-center gap-2 rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-[var(--bg-2)] px-3 py-2">
                      <span className="text-xs text-[var(--ink-soft)]">
                        {groupSelected.length} selected
                      </span>
                      <div className="ml-auto flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => runBulk(group, "approve")}
                          disabled={bulkBusy}
                          className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-button)] bg-[var(--primary)] px-2.5 text-xs font-medium text-[var(--primary-text)] hover:opacity-90 disabled:opacity-40 transition-opacity"
                        >
                          <CheckCircle className="h-3 w-3" />
                          Approve
                        </button>
                        <button
                          type="button"
                          onClick={() => runBulk(group, "reject")}
                          disabled={bulkBusy}
                          className="inline-flex h-7 items-center gap-1.5 rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-transparent px-2.5 text-xs font-medium text-destructive hover:bg-destructive/5 disabled:opacity-40 transition-colors"
                        >
                          <XCircle className="h-3 w-3" />
                          Reject
                        </button>
                      </div>
                    </div>
                  )}

                  {!isCollapsed && (
                    <div className="space-y-3">
                      {group.rows.map((a) => (
                        <ApprovalCard
                          key={a.id}
                          approval={a}
                          highlighted={targetId === a.id || targetId === a.run_id}
                          stale={a.id === oldestId || ageMs(a.created_at) >= STALE_MS}
                          selectable={group.rows.length >= 2}
                          selected={selected.has(a.id)}
                          onToggleSelect={() => toggleSelect(a.id)}
                          onDecision={load}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>

          {/* Pagination — matches /runs prev/next pattern */}
          {totalPages > 1 && (
            <div className="mt-6 flex items-center justify-between gap-3">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(0, p - 1))}
                disabled={safePage <= 0}
                className="inline-flex h-8 items-center rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-transparent px-3 text-xs text-[var(--ink)] hover:bg-[var(--bg-2)] disabled:opacity-40 transition-colors"
              >
                ← Previous
              </button>
              <span className="text-xs text-[var(--ink-mute)]">
                Page {safePage + 1} of {totalPages}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages - 1, p + 1))}
                disabled={safePage >= totalPages - 1}
                className="inline-flex h-8 items-center rounded-[var(--radius-button)] border border-[var(--border-soft)] bg-transparent px-3 text-xs text-[var(--ink)] hover:bg-[var(--bg-2)] disabled:opacity-40 transition-colors"
              >
                Next →
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function ApprovalsPage() {
  return (
    <Suspense fallback={<ApprovalsPageSkeleton />}>
      <ApprovalsContent />
    </Suspense>
  );
}
