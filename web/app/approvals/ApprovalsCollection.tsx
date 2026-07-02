"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CheckSquare2 } from "lucide-react";
import type { ApprovalRow } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey, TagOption } from "@/lib/collection/types";
import {
  Collection,
  DetailGroup,
  DetailRow,
  DetailNote,
  DetailActions,
} from "@/components/collection";
import { approvalActionLine } from "@/components/share/ApprovalActionItems";
import {
  ProposedOutput,
  approvalCostLine,
  approvalExpiry,
  approvalRequestedRelative,
} from "@/components/share/ApprovalReviewBody";
import {
  parseDecisionInput,
  approveApproval,
  rejectApproval,
  approveCommentSupported,
} from "@/lib/approvals/decision";
import { notifyApprovalsChanged, useApprovalsListSync } from "@/lib/useApprovalsSync";
import { useApprovals, useWorkers } from "@/lib/query/hooks";
import { useWorkspaceHref } from "@/lib/useWorkspaceHref";

function itemCount(a: ApprovalRow): number {
  const di = parseDecisionInput(a.decision_input_json);
  for (const v of Object.values(di)) {
    if (Array.isArray(v)) return v.length;
  }
  return a.artifacts?.length ?? 0;
}

const CURATED_CONTENT_TAGS = ["email", "crm", "github", "report", "analytics", "slack"] as const;
const CURATED_CONTENT_TAG_SET = new Set<string>(CURATED_CONTENT_TAGS);

function approvalContentTags(a: ApprovalRow, workerTags: Record<string, string[]>): string[] {
  const tags = workerTags[a.worker_id] ?? [];
  return tags.filter((t) => CURATED_CONTENT_TAG_SET.has(t));
}

function approvalWorkerTagOptions(items: ApprovalRow[]): TagOption[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    seen.set(item.worker_id, item.worker_name ?? item.worker_id);
  }
  return Array.from(seen.entries()).map(([value, label]) => ({
    value: `worker:${value}`,
    label,
    count: items.filter((i) => i.worker_id === value).length,
  }));
}

function approvalContentTagOptions(
  items: ApprovalRow[],
  workerTags: Record<string, string[]>,
): TagOption[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of new Set(approvalContentTags(item, workerTags))) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return CURATED_CONTENT_TAGS.filter((tag) => counts.has(tag)).map((tag) => ({
    value: tag,
    label: tag,
    count: counts.get(tag) ?? 0,
  }));
}

// In-app Review tab body, framed through the detail register (DetailGroup /
// DetailRow / DetailNote / DetailActions) so it matches the Connections and
// Workers detail surfaces. Stays custom: "approval-review" — it is interactive
// (comment + approve/reject) and loads the proposed output via shared helpers.
// The standalone hero review (ApprovalReviewBody) is kept for the shared-link /
// standalone-card surfaces; here the same content is register-framed.
function ApprovalReviewTabBody({
  approval,
  actionLine,
  comment,
  onComment,
  approveKeepsComment,
  busy,
  onApprove,
  onReject,
  runLink,
  workerLink,
}: {
  approval: ApprovalRow;
  actionLine: string;
  comment: string;
  onComment: (value: string) => void;
  approveKeepsComment: boolean;
  busy: boolean;
  onApprove: () => void;
  onReject: () => void;
  runLink: React.ReactNode;
  workerLink: React.ReactNode;
}) {
  const cost = approvalCostLine(approval);
  const expiry = approvalExpiry(approval.expires_at);
  return (
    <div>
      <DetailGroup label="Proposed action">
        <p style={{ margin: "0 0 12px", fontSize: 14, fontWeight: 500, color: "var(--ink)" }}>
          {actionLine}
        </p>
        <ProposedOutput approval={approval} />
      </DetailGroup>

      <DetailGroup label="Your response">
        <textarea
          className="c-appr-comment"
          value={comment}
          onChange={(e) => onComment(e.target.value)}
          placeholder="Add a comment with your decision, or leave a note…"
          rows={3}
          disabled={busy}
          style={{ width: "100%" }}
        />
        {comment.trim() && !approveKeepsComment && (
          <DetailNote>
            This worker approves via a tool callback that cannot store a comment. Your note is sent only if you reject.
          </DetailNote>
        )}
        <DetailActions separated>
          <button
            type="button"
            className="c-addbtn"
            style={{ padding: "8px 18px", fontSize: 13 }}
            onClick={onApprove}
            disabled={busy}
          >
            {busy ? "Working" : "Approve"}
          </button>
          <button
            type="button"
            className="c-vpill"
            style={{ padding: "8px 18px", color: "var(--warning)", borderColor: "var(--warning)" }}
            onClick={onReject}
            disabled={busy}
          >
            Reject
          </button>
        </DetailActions>
      </DetailGroup>

      <DetailGroup label="Context">
        <DetailRow label="Worker" value={workerLink} />
        <DetailRow label="Run" value={runLink} />
        <DetailRow label="Why" value={approval.label?.trim() ? approval.label : actionLine} />
        <DetailRow label="Requested" value={approvalRequestedRelative(approval.created_at)} />
        {cost && <DetailRow label="Cost so far" value={cost} />}
        {expiry && (
          <DetailRow label="Expires" value={expiry === "expired" ? "Expired" : `in ${expiry}`} />
        )}
      </DetailGroup>

      <DetailGroup>
        <DetailNote>
          Same request in-app and via a shared link. Your decision is recorded against this request.
          {approval.public_link && (
            <>
              {" "}
              <Link href={approval.public_link} style={{ color: "var(--accent)" }}>
                Open shareable link →
              </Link>
            </>
          )}
        </DetailNote>
      </DetailGroup>
    </div>
  );
}

export default function ApprovalsCollection() {
  const workspaceHref = useWorkspaceHref();
  const approvalsQuery = useApprovals("pending");
  const workersQuery = useWorkers();
  const { refetch: refetchApprovals } = approvalsQuery;
  const { refetch: refetchWorkers } = workersQuery;
  const items = approvalsQuery.data ?? [];
  const workers = workersQuery.data ?? [];
  const loading = approvalsQuery.isLoading && !approvalsQuery.data;
  const [error, setError] = useState<string | null>(null);
  const listError =
    error ??
    (approvalsQuery.isError && !approvalsQuery.data ? "Could not load approvals." : null);
  // Per-approval reviewer comment (keyed by approval id), and the in-flight
  // decision so the buttons can disable + show progress.
  const [comments, setComments] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const workerTags = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const w of workers) m[w.id] = w.tags ?? [];
    return m;
  }, [workers]);

  const refresh = useCallback(async () => {
    const result = await refetchApprovals();
    void refetchWorkers();
    if (result.error) {
      setError("Could not load approvals.");
    } else {
      setError(null);
    }
  }, [refetchApprovals, refetchWorkers]);

  // Keep the sidebar badge + other tabs in sync (preserves legacy behavior).
  useApprovalsListSync(refresh);

  const decide = async (a: ApprovalRow, approve: boolean) => {
    const comment = comments[a.id]?.trim() || undefined;
    setBusy(a.id);
    try {
      if (approve) await approveApproval(a, comment);
      else await rejectApproval(a, comment);
      toast.success(approve ? "Approved" : "Rejected");
      setComments((prev) => {
        const next = { ...prev };
        delete next[a.id];
        return next;
      });
      notifyApprovalsChanged();
      await refresh();
    } catch {
      toast.error("Could not record your decision.");
    } finally {
      setBusy(null);
    }
  };

  const setComment = useCallback((id: string, value: string) => {
    setComments((prev) => ({ ...prev, [id]: value }));
  }, []);

  const config: CollectionConfig<ApprovalRow> = {
    title: "Approvals",
    subtitle: "Workers waiting for your decision before executing.",
    items,
    loading,
    error: listError,
    idOf: (a) => a.id,
    searchOf: (a) => `${a.worker_name ?? ""} ${a.label ?? ""}`,
    tagsOf: (a) => {
      const curated = approvalContentTags(a, workerTags);
      const worker = [`worker:${a.worker_id}`];
      return {
        status: ["pending"],
        content: [...worker, ...(curated.length > 0 ? curated : [])],
      } as Partial<Record<TagFamilyKey, string[]>>;
    },
    tags: {
      status: [{ value: "pending", label: "pending", count: items.length }],
      content: [
        ...approvalWorkerTagOptions(items),
        ...approvalContentTagOptions(items, workerTags),
      ],
    },
    counts: [{ value: items.length, label: "pending" }],
    view: { default: "list", grid: true },
    columns: {
      template: "1.8fr 1fr 120px 40px",
      headers: ["Worker", "Wants to", "Waiting", ""],
    },
    row: (a) => ({
      // V4 SPEC rule 3: no avatar for approvals — non-person entity.
      primary: a.worker_name ?? a.worker_id,
      cols: [approvalActionLine(a.label, parseDecisionInput(a.decision_input_json))],
      status: {
        tone: "pending",
        label: itemCount(a) > 0 ? `${itemCount(a)} items` : "Pending",
      },
      menu: [
        { label: "Approve", onSelect: () => void decide(a, true) },
        { label: "Reject", onSelect: () => void decide(a, false), danger: true },
      ],
    }),
    card: (a) => ({
      // V4 SPEC rule 3: no avatar monogram for approvals.
      name: a.worker_name ?? a.worker_id,
      description: approvalActionLine(a.label, parseDecisionInput(a.decision_input_json)),
      status: {
        tone: "pending",
        label: itemCount(a) > 0 ? `${itemCount(a)} items` : "Pending",
      },
    }),
    detail: (a) => {
      const di = parseDecisionInput(a.decision_input_json);
      const actionLine = approvalActionLine(a.label, di);
      return {
        header: {
          // V4 SPEC rule 3: no avatar in detail header for approvals. Lean header
          // (consistent with the worker/run detail): worker name + action-line sub,
          // the decision lives in the body, not crammed above the divider.
          leading: undefined,
          title: a.worker_name ?? a.worker_id,
          // Structured header status pill (engine-rendered), like Connections.
          status: {
            tone: "pending",
            label: itemCount(a) > 0 ? `Pending · ${itemCount(a)} items` : "Pending",
          },
          sub: (
            <span className="c-dh-sub" style={{ margin: 0 }}>
              <span className="c-dh-desc">{actionLine}</span>
            </span>
          ),
        },
        // Single review surface (no tab row). Stays custom: "approval-review"
        // (interactive: comment + approve/reject), but the body is now framed
        // through the detail register (DetailGroup / DetailRow / DetailNote /
        // DetailActions) so it matches the rest of the detail surfaces.
        tabs: [
          {
            key: "Review",
            label: "Review",
            custom: "approval-review",
            render: () => (
              <ApprovalReviewTabBody
                approval={a}
                actionLine={actionLine}
                comment={comments[a.id] ?? ""}
                onComment={(value) => setComment(a.id, value)}
                approveKeepsComment={approveCommentSupported(a)}
                busy={busy === a.id}
                onApprove={() => void decide(a, true)}
                onReject={() => void decide(a, false)}
                runLink={
                  <Link href={workspaceHref(`/runs/${a.run_id}`)} style={{ color: "var(--accent)" }}>
                    #{a.run_id}
                  </Link>
                }
                workerLink={
                  <Link href={workspaceHref(`/workers?sel=${encodeURIComponent(a.worker_id)}`)} style={{ color: "var(--accent)" }}>
                    {a.worker_name ?? a.worker_id}
                  </Link>
                }
              />
            ),
          },
        ],
      };
    },
    states: {
      empty: { title: "No pending approvals", help: "Workers will appear here when they need a decision.", icon: CheckSquare2 },
      errorRetry: () => {
        void refresh();
      },
    },
  };

  return <Collection config={config} />;
}
