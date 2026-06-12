import { CheckCircle2, Clock, Loader2, XCircle, Pause } from "lucide-react";
import { Badge } from "@/components/ui/badge";

const SUCCESS_STATES = new Set(["completed", "success", "succeeded"]);
const ERROR_STATES = new Set(["failed", "error", "cancelled"]);
const RUNNING_STATES = new Set(["running", "pending"]);
const QUEUED_STATES = new Set(["queued"]);
const APPROVAL_STATES = new Set(["pending_approval"]);

function classify(status: string): "success" | "error" | "running" | "queued" | "approval" | "unknown" {
  const s = (status || "").toLowerCase();
  if (SUCCESS_STATES.has(s)) return "success";
  if (ERROR_STATES.has(s)) return "error";
  if (RUNNING_STATES.has(s)) return "running";
  if (QUEUED_STATES.has(s)) return "queued";
  if (APPROVAL_STATES.has(s)) return "approval";
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
  if (kind === "success") return <CheckCircle2 className={`${cls} text-success`} />;
  if (kind === "error") return <XCircle className={`${cls} text-error`} />;
  if (kind === "running")
    return <Loader2 className={`${cls} text-pending animate-spin`} />;
  if (kind === "queued")
    return <Clock className={`${cls} text-muted-foreground`} />;
  if (kind === "approval")
    return <Pause className={`${cls} text-muted-foreground`} />;
  return <Clock className={`${cls} text-muted-foreground`} />;
}

const BADGE_STYLE: Record<string, string> = {
  success: "bg-success/10 text-success font-medium",
  error: "bg-error/10 text-error font-semibold",
  running: "bg-pending/10 text-pending font-medium",
  queued: "bg-muted text-muted-foreground font-medium",
  approval: "bg-muted text-muted-foreground font-medium",
  unknown: "bg-muted text-muted-foreground font-medium",
};

// S29l (ChatGPT-audit P-2): pills are decoration when status is the
// default-success state. Show only when the user must act (error, running,
// unknown). The glyph in the row/header already covers "completed".
export function RunStatusBadge({
  status,
  showSuccess = false,
}: {
  status: string;
  // P2-4: opt-in success pill. Default stays quiet (S29l) everywhere; the
  // History tab passes showSuccess so completed runs get a pill for parity
  // with failed ones.
  showSuccess?: boolean;
}) {
  const kind = classify(status);
  if (kind === "success" && !showSuccess) return null;
  // v6: Title-case statuses everywhere on the run page.
  const humanized = status.replace(/_/g, " ").trim().toLowerCase();
  const label =
    kind === "approval"
      ? "Awaiting approval"
      : kind === "success"
      ? "Completed"
      : humanized.charAt(0).toUpperCase() + humanized.slice(1);
  return (
    <Badge variant="outline" className={BADGE_STYLE[kind]}>
      {label}
    </Badge>
  );
}
