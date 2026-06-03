import { Check, Edit3, ExternalLink, Mail, Send } from "lucide-react";

/**
 * ApprovalCard — a Slack/Floom-style approval of a concrete action (never an
 * abstract "output"). Used inside the hero run card and the detail page.
 */
export function ApprovalCard({
  question,
  action,
  primaryLabel = "Send email",
  variant = "panel",
}: {
  question: string;
  action?: string;
  primaryLabel?: string;
  variant?: "panel" | "row";
}) {
  return (
    <div
      className={
        variant === "panel"
          ? "rounded-[12px] border border-border bg-card p-3"
          : "flex flex-wrap items-center justify-between gap-2"
      }
    >
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[9px] bg-secondary text-foreground">
          <Mail className="h-3.5 w-3.5" />
        </span>
        <div>
          <div className="text-[12.5px] font-semibold text-foreground">{question}</div>
          {action && <div className="text-[11.5px] text-muted-foreground">{action}</div>}
        </div>
      </div>
      <div className="mt-2 flex w-full flex-wrap gap-1.5 sm:mt-0 sm:w-auto">
        <button className="inline-flex h-11 items-center gap-1 rounded-[12px] border border-border bg-card px-3 text-[11.5px] font-medium text-foreground transition hover:bg-accent">
          <ExternalLink className="h-3 w-3" /> Open run
        </button>
        <button className="inline-flex h-11 items-center gap-1 rounded-[12px] border border-border bg-card px-3 text-[11.5px] font-medium text-foreground transition hover:bg-accent">
          <Edit3 className="h-3 w-3" /> Edit draft
        </button>
        <button className="inline-flex h-11 items-center gap-1 rounded-[12px] bg-primary px-3.5 text-[11.5px] font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90">
          {primaryLabel === "Send email" ? <Send className="h-3 w-3" /> : <Check className="h-3 w-3" />}
          {primaryLabel}
        </button>
      </div>
    </div>
  );
}
