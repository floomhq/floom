"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { api } from "@/lib/api";
import type { ApprovalRow, WorkerSummary } from "@/lib/types";
import type { CollectionConfig, TagFamilyKey } from "@/lib/collection/types";
import { Collection } from "@/components/collection";
import { contentTagOptions } from "@/lib/workers/derive";
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

  // Curated status groups only — no raw per-worker tags (avoids one-off noise).
  const CURATED_CONTENT_TAGS = ["email", "crm", "github", "report", "analytics", "slack"];

  const config: CollectionConfig<ApprovalRow> = {
    title: "Approvals",
    subtitle: "Workers waiting for your decision before executing.",
    items,
    loading,
    error,
    idOf: (a) => a.id,
    searchOf: (a) => `${a.worker_name ?? ""} ${a.label ?? ""}`,
    tagsOf: (a) => {
      const allTags = workerTags[a.worker_id] ?? [];
      const curated = allTags.filter((t) => CURATED_CONTENT_TAGS.includes(t));
      return (curated.length > 0 ? { content: curated } : {}) as Partial<Record<TagFamilyKey, string[]>>;
    },
    tags: {
      content: contentTagOptions(workers).filter((t) => CURATED_CONTENT_TAGS.includes(t.value)),
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
                  <Link href={`/workers/${a.worker_id}`} style={{ color: "var(--accent)" }}>
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
      empty: { title: "No pending approvals", help: "Workers will appear here when they need a decision." },
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
  border: "1px solid var(--line)",
  borderRadius: 12,
  background: "var(--bg-2)",
  padding: 14,
  color: "var(--ink-soft)",
  whiteSpace: "pre-wrap",
};
