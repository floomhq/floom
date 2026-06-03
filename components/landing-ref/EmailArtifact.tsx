import { Edit3, Send } from "lucide-react";
import { ToolLogo, ToolLogoChip } from "./logos";
import { StatusPill } from "./StatusPill";

/**
 * EmailArtifact — a real-looking email draft the worker produced. Used in the
 * "Actual work comes back" section and the template detail page.
 */
export function EmailArtifact({
  title,
  byline,
  statusLabel = "Draft",
  sources,
  subject,
  body,
  signoff,
  footerNote,
  showActions = true,
}: {
  title: string;
  byline?: string;
  statusLabel?: string;
  sources?: string[];
  subject: string;
  body: string;
  signoff?: string;
  footerNote?: string;
  showActions?: boolean;
}) {
  return (
    <div className="overflow-hidden rounded-[18px] border border-border bg-card shadow-sm">
      <div className="flex items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2">
          <ToolLogo name="Gmail" />
          <div>
            <div className="text-[13.5px] font-semibold text-foreground">{title}</div>
            {byline && <div className="text-[11px] text-muted-foreground">{byline}</div>}
          </div>
        </div>
        <StatusPill tone="pending">{statusLabel}</StatusPill>
      </div>

      {sources && sources.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-secondary/40 px-4 py-2 text-[11px]">
          <span className="text-muted-foreground">Sources</span>
          {sources.map((s) =>
            s === "Company Brain" ? (
              <span
                key={s}
                className="inline-flex h-7 items-center rounded-[9px] border border-border bg-card px-2 font-medium text-foreground/85"
              >
                Company Brain
              </span>
            ) : (
              <ToolLogoChip key={s} tool={s} size="sm" />
            ),
          )}
        </div>
      )}

      <div className="space-y-3 px-5 py-4 text-[13.5px] leading-relaxed text-foreground">
        <div>
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            Subject
          </span>
          <div className="mt-0.5 font-semibold">{subject}</div>
        </div>
        {body.split("\n\n").map((para, i) => (
          <p key={i} className="whitespace-pre-line">
            {para}
          </p>
        ))}
        {signoff && <p className="whitespace-pre-line text-muted-foreground">{signoff}</p>}
      </div>

      {footerNote && (
        <div className="border-t border-border bg-secondary/40 px-4 py-2 text-[11.5px] text-muted-foreground">
          {footerNote}
        </div>
      )}

      {showActions && (
        <div className="flex items-center justify-end gap-1.5 border-t border-border px-4 py-2.5">
          <button className="inline-flex h-11 items-center gap-1 rounded-[12px] border border-border bg-card px-3.5 text-[12.5px] font-medium text-foreground transition hover:bg-accent">
            <Edit3 className="h-3.5 w-3.5" /> Edit draft
          </button>
          <button className="inline-flex h-11 items-center gap-1 rounded-[12px] bg-primary px-3.5 text-[12.5px] font-semibold text-primary-foreground shadow-sm transition hover:bg-primary/90">
            <Send className="h-3.5 w-3.5" /> Send email
          </button>
        </div>
      )}
    </div>
  );
}
