"use client";

import { useState } from "react";
import { PauseCircle, CheckCircle2, XCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { approveApproval, rejectApproval } from "@/lib/approvals/decision";
import { notifyApprovalsChanged } from "@/lib/useApprovalsSync";
import type { ApprovalCard as ApprovalCardType } from "@/lib/emily-chat-types";

// #825: approvals appear INLINE in the thread — card + comment + Approve/Reject
// via the EXISTING approvals API (same kind-aware dispatch the /approvals page
// uses). Rule #9: calm, not alarmed — pending is grey "waiting" with a pause
// icon, never amber.
export function ApprovalCard({ card }: { card: ApprovalCardType }) {
  const [approved, setApproved] = useState<boolean | null>(card.approved);
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  const isPending = approved === null;

  const decide = async (decision: boolean) => {
    if (!card.approvalId) {
      toast.error("This approval can't be resolved from chat; open the Approvals page.");
      return;
    }
    setBusy(true);
    try {
      // Resolve the full row so the kind-aware dispatch (run / agent_tool /
      // destructive_delete) routes to the right endpoint — same path as /approvals.
      const pending = await api.approvals.list("pending");
      const row = pending.find((r) => r.id === card.approvalId);
      if (!row) {
        toast.error("This approval is no longer pending.");
        notifyApprovalsChanged();
        return;
      }
      if (decision) {
        // TODO(#769): plain-text comment on APPROVE — backend only stores a
        // reason on reject today. The box stays usable; the comment rides along
        // once #769 lands.
        await approveApproval(row);
      } else {
        await rejectApproval(row, comment.trim() || undefined);
      }
      setApproved(decision);
      notifyApprovalsChanged();
      toast.success(decision ? "Approved" : "Rejected");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Could not record the decision.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "rounded-[var(--radius-card)] overflow-hidden text-sm",
        // Rule #9: pending is quiet grey — color only after a decision.
        isPending
          ? "bg-muted/30"
          : approved
          ? "bg-[color-mix(in_srgb,var(--positive)_8%,transparent)]"
          : "bg-[color-mix(in_srgb,var(--negative)_8%,transparent)]"
      )}
    >
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        {card.brand ? (
          <BrandLogo icon={card.brand} className="size-4 mt-0.5 shrink-0" />
        ) : (
          <PauseCircle className="size-3.5 text-muted-foreground mt-0.5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium truncate">{card.workerName}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{card.action}</p>
        </div>
        {isPending ? (
          <Badge variant="secondary" className="text-[10px] font-normal text-muted-foreground">
            waiting
          </Badge>
        ) : approved ? (
          <CheckCircle2 className="size-4 shrink-0 text-[var(--positive)]" />
        ) : (
          <XCircle className="size-4 shrink-0 text-[var(--negative)]" />
        )}
      </div>

      {isPending ? (
        <div className="space-y-2 px-3.5 pb-3">
          <input
            className="w-full rounded-[var(--radius-input)] bg-background/80 px-2 py-1 text-xs outline-none focus:bg-background transition-colors"
            placeholder="Add a comment (sent with reject; approve comments land with #769)"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            disabled={busy}
          />
          <div className="flex gap-2">
            <Button
              size="sm"
              className="h-7 text-xs font-normal"
              style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
              disabled={busy}
              onClick={() => void decide(true)}
            >
              {busy ? "…" : "Approve"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs font-normal"
              disabled={busy}
              onClick={() => void decide(false)}
            >
              Reject
            </Button>
          </div>
        </div>
      ) : (
        <div className="px-3.5 pb-3">
          <Badge
            variant="secondary"
            className={cn(
              "text-[10px] font-normal",
              approved
                ? "bg-[color-mix(in_srgb,var(--positive)_12%,transparent)] text-[color-mix(in_srgb,var(--positive)_78%,var(--ink))]"
                : "bg-[color-mix(in_srgb,var(--negative)_12%,transparent)] text-[color-mix(in_srgb,var(--negative)_78%,var(--ink))]"
            )}
          >
            {approved ? "Approved" : "Rejected"}
          </Badge>
        </div>
      )}
    </div>
  );
}
