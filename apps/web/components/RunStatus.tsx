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

const BADGE_STYLE: Record<string, string> = {
  success: "bg-emerald-50 text-emerald-700 border-emerald-200",
  error: "bg-red-50 text-red-700 border-red-200",
  running: "bg-blue-50 text-blue-700 border-blue-200",
  unknown: "bg-muted text-muted-foreground border-border",
};

export function RunStatusBadge({ status }: { status: string }) {
  const kind = classify(status);
  return (
    <Badge variant="outline" className={BADGE_STYLE[kind]}>
      {status.replace("_", " ")}
    </Badge>
  );
}
