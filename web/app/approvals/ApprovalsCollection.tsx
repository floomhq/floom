"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CheckSquare2 } from "lucide-react";
import { api } from "@/lib/api";
import { reportError } from "@/lib/notify";
import type { ApprovalRow, WorkerSummary } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey, TagOption } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { approvalActionLine } from "@/components/share/ApprovalActionItems";
import { ApprovalReviewBody } from "@/components/share/ApprovalReviewBody";
import {
  parseDecisionInput,
  approveApproval,
  rejectApproval,
  approveCommentSupported,
} from "@/lib/approvals/decision";
import { notifyApprovalsChanged, useApprovalsListSync } from "@/lib/useApprovalsSync";

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

export default function ApprovalsCollection() {
  const [items, setItems] = useState<ApprovalRow[]>([]);
  const [workers, setWorkers] = useState<WorkerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
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
    try {
      const rows = await api.approvals.list("pending");
      setItems(rows);
      setError(null);
    } catch {
      setError("Could not load approvals.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Content tags are inherited from the parent worker (SPEC §11).
    api.workers
      .list()
      .then(setWorkers)
      .catch((err) => reportError("Could not load workers for approval filters.", err));
    // Safety timeout: if the API proxy is unreachable and the request hangs,
    // stop showing the skeleton after 10 s so users see an error + retry.
    const timeout = setTimeout(() => {
      setLoading((prev) => {
        if (prev) {
          setError("Could not load approvals. Check your connection and try again.");
        }
        return false;
      });
    }, 10_000);
    return () => clearTimeout(timeout);
  }, [refresh]);

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
    error,
    idOf: (a) => a.id,
    searchOf: (a) => `${a.worker_name ?? ""} ${a.label ?? ""}`,
    tagsOf: (a) => {
      const curated = approvalContentTags(a, workerTags);
      return (curated.length > 0 ? { content: curated } : {}) as Partial<Record<TagFamilyKey, string[]>>;
    },
    tags: {
      content: approvalContentTagOptions(items, workerTags),
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
          sub: (
            <span className="c-dh-sub" style={{ margin: 0 }}>
              <span className="c-dh-desc">{actionLine}</span>
            </span>
          ),
        },
        // Single review surface (no tab row): the in-app inbox detail IS the
        // canonical input-left / proposed-output-right review. One link with
        // several approvals (Emily/Slack/WhatsApp) is the dotted pager on
        // /approvals/review; here the pager reads "1 of 1".
        tabs: [
          {
            key: "Review",
            label: "Review",
            render: () => (
              <ApprovalReviewBody
                approval={a}
                actionLine={actionLine}
                index={0}
                total={1}
                onPrev={() => {}}
                onNext={() => {}}
                comment={comments[a.id] ?? ""}
                onComment={(value) => setComment(a.id, value)}
                approveKeepsComment={approveCommentSupported(a)}
                busy={busy === a.id}
                onApprove={() => void decide(a, true)}
                onReject={() => void decide(a, false)}
                runLink={
                  <Link href={`/runs/${a.run_id}`} style={{ color: "var(--accent)" }}>
                    #{a.run_id}
                  </Link>
                }
                workerLink={
                  <Link href={`/workers?sel=${encodeURIComponent(a.worker_id)}`} style={{ color: "var(--accent)" }}>
                    {a.worker_name ?? a.worker_id}
                  </Link>
                }
                footnote={
                  <>
                    Same view in-app and via a shared link. Your decision is recorded against this request.
                    {a.public_link && (
                      <>
                        {" "}
                        <Link href={a.public_link} style={{ color: "var(--accent)" }}>
                          Open shareable link →
                        </Link>
                      </>
                    )}
                  </>
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
        setLoading(true);
        void refresh();
      },
    },
  };

  return <Collection config={config} />;
}
