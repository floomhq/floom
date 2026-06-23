"use client";

/**
 * V3OutputPreview — a REAL, LEGIBLE miniature artifact of what the worker
 * produces. This is the jewel of the card: the eye should land here and read
 * actual output (a real subject line, real names + scores, real numbers), not
 * skeleton noise. Sized to be readable at grid density. `size="lg"` is used on
 * detail pages where it gets more room.
 */

import type { Sample } from "@/components/landing-ref/data";

const PRI_COLOR: Record<string, string> = {
  high: "#E5533D",
  med: "#C98A1A",
  low: "#6B7280",
};

function Email({ s, lg }: { s: Extract<Sample, { kind: "email" }>; lg?: boolean }) {
  return (
    <div className={lg ? "space-y-2" : "space-y-1.5"}>
      <div className="flex items-center justify-between gap-2">
        <span className={`truncate font-semibold text-foreground/90 ${lg ? "text-[14px]" : "text-[12px]"}`}>{s.subject}</span>
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium"
          style={{ background: "var(--v3-sel)", color: "var(--v3-accent)" }}
        >
          Draft
        </span>
      </div>
      <div className={`text-muted-foreground ${lg ? "text-[12px]" : "text-[10.5px]"}`}>To {s.to}</div>
      <div className="space-y-1">
        {s.lines.map((l) => (
          <div key={l} className={`truncate leading-snug text-foreground/70 ${lg ? "text-[12.5px]" : "text-[11.5px]"}`}>
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

function Digest({ s, lg }: { s: Extract<Sample, { kind: "digest" }>; lg?: boolean }) {
  return (
    <div className={lg ? "space-y-2" : "space-y-1.5"}>
      <div className={`truncate font-semibold text-foreground/90 ${lg ? "text-[14px]" : "text-[12px]"}`}>{s.title}</div>
      <div className="space-y-1.5">
        {s.items.map((it) => (
          <div key={it} className="flex items-start gap-2">
            <span className="mt-[6px] h-1 w-1 shrink-0 rounded-full bg-foreground/35" />
            <span className={`truncate leading-snug text-foreground/70 ${lg ? "text-[12.5px]" : "text-[11.5px]"}`}>{it}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function List({ s, lg }: { s: Extract<Sample, { kind: "list" }>; lg?: boolean }) {
  return (
    <div className={lg ? "space-y-1.5" : "space-y-1.5"}>
      {s.rows.map((r) => (
        <div key={r.name} className="flex items-center justify-between gap-3">
          <span className={`truncate font-medium text-foreground/85 ${lg ? "text-[12.5px]" : "text-[11.5px]"}`}>{r.name}</span>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 font-semibold tabular-nums ${lg ? "text-[11px]" : "text-[10px]"}`}
            style={{ background: "var(--v3-sel)", color: "var(--v3-accent)" }}
          >
            {r.score}
          </span>
        </div>
      ))}
    </div>
  );
}

function Kpi({ s, lg }: { s: Extract<Sample, { kind: "kpi" }>; lg?: boolean }) {
  return (
    <div className="grid grid-cols-3 gap-2">
      {s.cells.map((c) => (
        <div key={c.label} className="rounded-[8px] bg-secondary/70 px-2.5 py-2.5">
          <div className="text-[9px] uppercase tracking-[0.06em] text-muted-foreground/80">{c.label}</div>
          <div className={`mt-1 font-semibold leading-none tabular-nums text-foreground/90 ${lg ? "text-[17px]" : "text-[14px]"}`}>{c.value}</div>
          {c.delta ? (
            <div className="mt-1.5 font-mono text-[9.5px]" style={{ color: "var(--v3-accent)" }}>{c.delta}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Issues({ s, lg }: { s: Extract<Sample, { kind: "issues" }>; lg?: boolean }) {
  return (
    <div className="space-y-1.5">
      {s.rows.map((r) => (
        <div key={r.title} className="flex items-center gap-2">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: PRI_COLOR[r.pri] }} />
          <span className={`truncate leading-snug text-foreground/75 ${lg ? "text-[12.5px]" : "text-[11.5px]"}`}>{r.title}</span>
        </div>
      ))}
    </div>
  );
}

function Artifact({ sample, lg }: { sample: Sample; lg: boolean }) {
  return (
    <>
      {sample.kind === "email" && <Email s={sample} lg={lg} />}
      {sample.kind === "digest" && <Digest s={sample} lg={lg} />}
      {sample.kind === "list" && <List s={sample} lg={lg} />}
      {sample.kind === "kpi" && <Kpi s={sample} lg={lg} />}
      {sample.kind === "issues" && <Issues s={sample} lg={lg} />}
    </>
  );
}

export function V3OutputPreview({
  sample,
  size = "sm",
  bare = false,
  className = "",
}: {
  sample: Sample;
  size?: "sm" | "lg";
  bare?: boolean;
  className?: string;
}) {
  const lg = size === "lg";
  if (bare) {
    return (
      <div className={className}>
        <Artifact sample={sample} lg={lg} />
      </div>
    );
  }
  return (
    <div className={`rounded-[14px] bg-secondary/55 p-3 ${className}`}>
      <div className={`rounded-[11px] bg-card px-3.5 py-3 ${lg ? "min-h-[150px]" : "min-h-[118px]"}`}>
        <Artifact sample={sample} lg={lg} />
      </div>
    </div>
  );
}
