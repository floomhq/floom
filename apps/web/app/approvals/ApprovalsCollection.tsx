"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CheckSquare2 } from "lucide-react";
import { api } from "@/lib/api";
import type { ApprovalRow, WorkerSummary } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey, TagOption } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import {
  ApprovalActionItems,
  approvalActionLine,
} from "@/components/share/ApprovalActionItems";
import {
  parseDecisionInput,
  approveApproval,
  rejectApproval,
} from "@/lib/approvals/decision";
import { notifyApprovalsChanged, useApprovalsListSync } from "@/lib/useApprovalsSync";

function itemCount(a: ApprovalRow): number {
  const di = parseDecisionInput(a.decision_input_json);
  for (const v of Object.values(di)) {
    if (Array.isArray(v)) return v.length;
  }
  return a.artifacts?.length ?? 0;
}

const KV_STYLE: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "140px 1fr",
  gap: "9px 16px",
};

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
    api.workers.list().then(setWorkers).catch(() => {});
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
    try {
      if (approve) await approveApproval(a);
      else await rejectApproval(a);
      toast.success(approve ? "Approved" : "Rejected");
      notifyApprovalsChanged();
      await refresh();
    } catch {
      toast.error("Could not record your decision.");
    }
  };

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
      return {
        header: {
          // V4 SPEC rule 3: no avatar in detail header for approvals.
          leading: undefined,
          title: a.worker_name ?? a.worker_id,
          sub: <span className="c-dh-sub" style={{ margin: 0 }}>{approvalActionLine(a.label, di)}</span>,
          actions: (
            <>
              <button
                type="button"
                className="c-vpill"
                style={{ padding: "6px 11px", color: "var(--warning)", borderColor: "var(--warning)" }}
                onClick={() => void decide(a, false)}
              >
                Reject
              </button>
              <button
                type="button"
                className="c-addbtn"
                style={{ padding: "6px 11px", fontSize: 12.5 }}
                onClick={() => void decide(a, true)}
              >
                Approve
              </button>
            </>
          ),
        },
        tabs: [
          {
            key: "Request",
            label: "Request",
            render: () => (
              <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
                <div style={KV_STYLE}>
                  <span style={kvK}>Worker</span>
                  <span>{a.worker_name ?? a.worker_id}</span>
                  <span style={kvK}>Requested</span>
                  <span>{new Date(a.created_at).toLocaleString()}</span>
                  <span style={kvK}>Status</span>
                  <span>{a.status}</span>
                </div>
                {a.preview && (
                  <div>
                    <h4 style={h4}>Proposed output</h4>
                    <div className="c-outbox" style={outbox}>
                      {a.preview}
                    </div>
                  </div>
                )}
              </div>
            ),
          },
          {
            key: "Items",
            label: "Items",
            count: itemCount(a) || undefined,
            render: () => <ApprovalActionItems decisionInput={di} />,
          },
          {
            key: "Run",
            label: "Run",
            render: () => (
              <div style={KV_STYLE}>
                <span style={kvK}>Run</span>
                <span>
                  <Link href={`/runs/${a.run_id}`} style={{ color: "var(--accent)" }}>
                    #{a.run_id}
                  </Link>
                </span>
                <span style={kvK}>Worker</span>
                <span>
                  <Link href={`/workers?sel=${encodeURIComponent(a.worker_id)}`} style={{ color: "var(--accent)" }}>
                    {a.worker_name ?? a.worker_id}
                  </Link>
                </span>
                {a.follow_up_run_id && (
                  <>
                    <span style={kvK}>Follow-up run</span>
                    <span>#{a.follow_up_run_id}</span>
                  </>
                )}
              </div>
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

const kvK: React.CSSProperties = { color: "var(--muted-foreground)", fontSize: 12.5 };
const h4: React.CSSProperties = {
  fontSize: 11,
  letterSpacing: ".05em",
  textTransform: "uppercase",
  color: "var(--muted-foreground)",
  margin: "0 0 9px",
};
const outbox: React.CSSProperties = {
  border: "var(--bd-card)",
  borderRadius: "var(--radius-card)",
  background: "var(--bg-2)",
  padding: 14,
  color: "var(--ink-soft)",
  whiteSpace: "pre-wrap",
};
