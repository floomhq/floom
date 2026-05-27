import { CheckCircle2, Clock, Loader2, XCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const SUCCESS_STATES = new Set(["completed", "success", "succeeded"]);
const ERROR_STATES = new Set(["failed", "error", "cancelled"]);
const RUNNING_STATES = new Set(["running", "queued", "pending"]);

function classify(status: string): "success" | "error" | "running" | "unknown" {
  const s = (status || "").toLowerCase();
  if (SUCCESS_STATES.has(s)) return "success";
  if (ERROR_STATES.has(s)) return "error";
  if (RUNNING_STATES.has(s)) return "running";
  return "unknown";
}

export function RunStatusGlyph({
  status,
  className,
}: {
  status: string;
  className?: string;
}) {
  const kind = classify(status);
  const cls = className ?? "size-4";
  if (kind === "success") return <CheckCircle2 className={`${cls} text-emerald-600`} />;
  if (kind === "error") return <XCircle className={`${cls} text-red-600`} />;
  if (kind === "running")
    return <Loader2 className={`${cls} text-blue-600 animate-spin`} />;
  return <Clock className={`${cls} text-muted-foreground`} />;
}

// S22e: bumped failed/error contrast (roast P1: faint pink + faint red made
// failed runs invisible against healthy rows in a 60%-success list). Added
// dark-mode variants across all states (was light-only).
const BADGE_STYLE: Record<string, string> = {
  success: "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900 font-medium",
  error: "bg-red-100 text-red-800 border-red-300 dark:bg-red-950/50 dark:text-red-200 dark:border-red-800 font-semibold",
  running: "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900 font-medium",
  unknown: "bg-muted text-muted-foreground border-border font-medium",
};

export function RunStatusBadge({ status }: { status: string }) {
  const kind = classify(status);
  return (
    <Badge variant="outline" className={BADGE_STYLE[kind]}>
      {status.replace("_", " ")}
    </Badge>
  );
}
