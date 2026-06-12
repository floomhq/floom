"use client";

// Inspired by Vercel AI Elements. MIT License.

import { CheckCircle2, Circle, Loader2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";

export function Task({
  title,
  status,
  detail,
  className,
}: {
  title: string;
  status: "pending" | "running" | "completed" | "failed";
  detail?: string;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-2 rounded-[var(--radius-button)] [border:var(--bd-card)] bg-card p-2", className)}>
      {status === "completed" ? (
        <CheckCircle2 className="mt-0.5 size-4 text-success" />
      ) : status === "failed" ? (
        <XCircle className="mt-0.5 size-4 text-error" />
      ) : status === "running" ? (
        <Loader2 className="mt-0.5 size-4 animate-spin text-pending" />
      ) : (
        <Circle className="mt-0.5 size-4 text-muted-foreground" />
      )}
      <div className="min-w-0">
        <p className="truncate text-sm font-medium">{title}</p>
        {detail && <p className="truncate text-xs text-muted-foreground">{detail}</p>}
      </div>
    </div>
  );
}
