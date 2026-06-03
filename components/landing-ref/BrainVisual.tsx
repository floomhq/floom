import { Check } from "lucide-react";
import { StatusPill } from "./StatusPill";

const SOURCES = [
  "Docs",
  "SOPs",
  "ICP",
  "Style guides",
  "Past reports",
  "Past outreach",
  "Approval rules",
  "Pricing",
  "CRM rules",
];

const KNOWS = [
  "Knows what good looks like",
  "Knows your tone",
  "Knows what needs approval",
  "Knows where to pull data",
];

const WORKERS = [
  "Client Follow-up Worker",
  "Monday Report Worker",
  "Lead Research Worker",
  "Founder Update Worker",
];

/** Subtle warm connector — horizontal on desktop, vertical on mobile. */
function Connector() {
  return (
    <span
      aria-hidden="true"
      className="mx-auto my-1 h-6 w-px shrink-0 bg-gradient-to-b from-transparent via-border to-transparent lg:my-0 lg:h-px lg:w-10 lg:bg-gradient-to-r"
    />
  );
}

export function BrainVisual() {
  return (
    <div className="flex flex-col items-stretch gap-1 lg:flex-row lg:items-center lg:gap-1">
      {/* Sources */}
      <div className="flex-1 rounded-[18px] border border-border/60 bg-secondary/40 p-4">
        <div className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Contexts
        </div>
        <div className="flex flex-wrap gap-1.5">
          {SOURCES.map((s) => (
            <span
              key={s}
              className="inline-flex h-7 items-center rounded-[9px] border border-border bg-card px-2 text-[12px] text-foreground/85"
            >
              {s}
            </span>
          ))}
        </div>
      </div>

      <Connector />

      {/* Company Brain — focal card */}
      <div className="shrink-0 rounded-[18px] border border-border bg-card p-5 shadow-md lg:w-[260px]">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[14px] font-semibold text-foreground">Company Brain</div>
          <StatusPill tone="success">Live</StatusPill>
        </div>
        <ul className="space-y-2">
          {KNOWS.map((k) => (
            <li
              key={k}
              className="flex items-center gap-2 rounded-[9px] border border-border bg-secondary/50 px-2.5 py-1.5 text-[12.5px]"
            >
              <Check className="h-3.5 w-3.5 shrink-0 text-foreground" strokeWidth={2.5} />
              <span className="text-foreground">{k}</span>
            </li>
          ))}
        </ul>
      </div>

      <Connector />

      {/* Used by workers */}
      <div className="flex-1 rounded-[18px] border border-border/60 bg-secondary/40 p-4">
        <div className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Used by workers
        </div>
        <div className="space-y-1.5">
          {WORKERS.map((w) => (
            <div
              key={w}
              className="flex items-center gap-2 rounded-[10px] border border-border bg-card px-3 py-2 text-[12.5px]"
            >
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-primary text-[10px] font-bold text-primary-foreground">
                F
              </span>
              <span className="truncate font-medium text-foreground">{w}</span>
            </div>
          ))}
          <div className="px-3 pt-1 text-[11.5px] text-muted-foreground">+ every other worker</div>
        </div>
      </div>
    </div>
  );
}
