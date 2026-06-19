/**
 * Approval decision dispatch (SPEC §5 Approvals).
 *
 * An approval is one of three kinds, encoded in `decision_input_json.kind`, and
 * each routes to a different endpoint. This was duplicated inline in the
 * approvals list + review pages; centralised here so the Collection migration
 * reuses the EXACT proven dispatch instead of reinventing it.
 */
import { api } from "@/lib/api";
import type { ApprovalAnnotations, ApprovalRow } from "@/lib/types";

export type ApprovalKind = "destructive_delete" | "agent_tool" | "run";

/**
 * Whether a reviewer comment left at APPROVE time can be persisted for this
 * approval kind. The `run` and `destructive_delete` endpoints accept an
 * `annotations` payload; the `agent_tool` approve endpoint
 * (`/approvals/{id}/approve`) only accepts `edited_output`, so a comment cannot
 * ride along on approve. (Reject always folds the comment into `reason`.)
 */
export function approveCommentSupported(
  approval: Pick<ApprovalRow, "decision_input_json">,
): boolean {
  return approvalKind(approval) !== "agent_tool";
}

/**
 * Build the `annotations` payload the backend persists with a decision from a
 * free-text reviewer comment. The note rides on the same `text` channel the
 * full-page review surface uses (`{ quote: "", comment }`), so a comment left
 * on the list/detail surface is stored identically.
 */
export function commentToAnnotations(comment?: string): ApprovalAnnotations | null {
  const trimmed = comment?.trim();
  if (!trimmed) return null;
  return { text: [{ quote: "", comment: trimmed }], images: [] };
}

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

/**
 * Approve, routing by kind (mirrors app/approvals/page.tsx:576-582).
 * `comment` is persisted as an annotation where the kind's endpoint supports it
 * (run, destructive_delete). For `agent_tool` the comment is dropped on approve
 * (see `approveCommentSupported`); callers should warn the reviewer.
 */
export async function approveApproval(approval: ApprovalRow, comment?: string): Promise<void> {
  const annotations = commentToAnnotations(comment);
  switch (approvalKind(approval)) {
    case "destructive_delete":
      await api.approvals.approveAction(approval.id, annotations);
      return;
    case "agent_tool":
      await api.approvals.approveAgentTool(approval.id);
      return;
    default:
      await api.runs.approve(approval.run_id, undefined, annotations);
  }
}

/**
 * Reject, routing by kind (mirrors app/approvals/page.tsx:584-586).
 * `comment` is sent as the rejection `reason` AND, where supported, as an
 * annotation. For `agent_tool` only the `reason` channel exists.
 */
export async function rejectApproval(approval: ApprovalRow, comment?: string): Promise<void> {
  const reason = comment?.trim() || undefined;
  const annotations = commentToAnnotations(comment);
  switch (approvalKind(approval)) {
    case "destructive_delete":
      await api.approvals.rejectAction(approval.id, reason, annotations);
      return;
    case "agent_tool":
      await api.approvals.rejectAgentTool(approval.id, reason);
      return;
    default:
      await api.runs.reject(approval.run_id, reason, annotations);
  }
}
