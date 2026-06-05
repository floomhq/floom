"use client";

import { useState } from "react";
import { Clock, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { cn } from "@/lib/utils";
import type { ApprovalCard as ApprovalCardType } from "@/lib/emily-chat-types";

export function ApprovalCard({ card }: { card: ApprovalCardType }) {
  const [approved, setApproved] = useState<boolean | null>(card.approved);

  const isPending = approved === null;

  return (
    <div
      className={cn(
        "rounded-lg border overflow-hidden text-sm",
        isPending
          ? "border-amber-400/30 bg-amber-50/40 dark:bg-amber-950/20"
          : approved
          ? "border-green-500/20 bg-green-50/30 dark:bg-green-950/20"
          : "border-red-500/20 bg-red-50/30 dark:bg-red-950/20"
      )}
    >
      <div className="flex items-start gap-2.5 px-3.5 py-2.5">
        {card.brand ? (
          <BrandLogo icon={card.brand} className="size-4 mt-0.5 shrink-0" />
        ) : (
          <Clock className="size-3.5 text-amber-600 mt-0.5 shrink-0" />
        )}
        <div className="min-w-0 flex-1">
          <p className="font-medium truncate">{card.workerName}</p>
          <p className="text-xs text-muted-foreground mt-0.5">{card.action}</p>
        </div>
        {!isPending && (
          approved ? (
            <CheckCircle2 className="size-4 shrink-0 text-green-600" />
          ) : (
            <XCircle className="size-4 shrink-0 text-red-500" />
          )
        )}
      </div>

      {isPending ? (
        <div className="flex gap-2 px-3.5 pb-3">
          <Button
            size="sm"
            className="h-7 text-xs font-normal"
            style={{ background: "var(--primary)", color: "var(--primary-foreground)" }}
            onClick={() => setApproved(true)}
          >
            Approve
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs font-normal"
            onClick={() => setApproved(false)}
          >
            Deny
          </Button>
        </div>
      ) : (
        <div className="px-3.5 pb-3">
          <Badge
            variant="secondary"
            className={cn(
              "text-[10px] font-normal",
              approved
                ? "bg-green-500/10 text-green-700 border-green-500/20"
                : "bg-red-500/10 text-red-600 border-red-500/20"
            )}
          >
            {approved ? "Approved" : "Denied"}
          </Badge>
        </div>
      )}
    </div>
  );
}
