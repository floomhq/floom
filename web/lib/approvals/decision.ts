/**
 * Approval decision dispatch (SPEC §5 Approvals).
 *
 * An approval is one of three kinds, encoded in `decision_input_json.kind`, and
 * each routes to a different endpoint. This was duplicated inline in the
 * approvals list + review pages; centralised here so the Collection migration
 * reuses the EXACT proven dispatch instead of reinventing it.
 */
import { api } from "@/lib/api";
import type { ApprovalRow } from "@/lib/types";

export type ApprovalKind = "destructive_delete" | "agent_tool" | "run";

export function parseDecisionInput(raw?: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function approvalKind(approval: Pick<ApprovalRow, "decision_input_json">): ApprovalKind {
  const di = parseDecisionInput(approval.decision_input_json);
  if (di.kind === "destructive_delete") return "destructive_delete";
  if (di.kind === "agent_tool") return "agent_tool";
  return "run";
}

/** Approve, routing by kind (mirrors app/approvals/page.tsx:576-582). */
export async function approveApproval(approval: ApprovalRow): Promise<void> {
  switch (approvalKind(approval)) {
    case "destructive_delete":
      await api.approvals.approveAction(approval.id);
      return;
    case "agent_tool":
      await api.approvals.approveAgentTool(approval.id);
      return;
    default:
      await api.runs.approve(approval.run_id);
  }
}

/** Reject, routing by kind (mirrors app/approvals/page.tsx:584-586). */
export async function rejectApproval(approval: ApprovalRow, reason?: string): Promise<void> {
  switch (approvalKind(approval)) {
    case "destructive_delete":
      await api.approvals.rejectAction(approval.id, reason || undefined);
      return;
    case "agent_tool":
      await api.approvals.rejectAgentTool(approval.id, reason || undefined);
      return;
    default:
      await api.runs.reject(approval.run_id, reason || undefined);
  }
}
