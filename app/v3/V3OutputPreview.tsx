"use client";

/**
 * V3OutputPreview — a small, REAL miniature artifact of what the worker
 * produces. Identity comes from the work itself (a real subject line, real
 * names + scores, real numbers), not from skeleton bars. One shape per kind,
 * rendered legibly in the cool palette.
 */

import type { Sample } from "@/components/landing-ref/data";

const PRI_COLOR: Record<string, string> = {
  high: "#E5533D",
  med: "#C98A1A",
  low: "#6B7280",
};

function Email({ s }: { s: Extract<Sample, { kind: "email" }> }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-[11px] font-semibold text-foreground/85">{s.subject}</span>
        <span
          className="shrink-0 rounded-full px-1.5 py-0.5 text-[8.5px] font-medium"
          style={{ background: "var(--v3-sel)", color: "var(--v3-accent)" }}
        >
          Draft
        </span>
      </div>
      <div className="text-[10px] text-muted-foreground">To {s.to}</div>
      <div className="space-y-0.5">
        {s.lines.map((l) => (
          <div key={l} className="truncate text-[10.5px] leading-snug text-foreground/65">
            {l}
          </div>
        ))}
      </div>
    </div>
  );
}

function Digest({ s }: { s: Extract<Sample, { kind: "digest" }> }) {
  return (
    <div className="space-y-1.5">
      <div className="truncate text-[11px] font-semibold text-foreground/85">{s.title}</div>
      <div className="space-y-1">
        {s.items.map((it) => (
          <div key={it} className="flex items-start gap-1.5">
            <span className="mt-[5px] h-1 w-1 shrink-0 rounded-full bg-foreground/30" />
            <span className="truncate text-[10.5px] leading-snug text-foreground/65">{it}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function List({ s }: { s: Extract<Sample, { kind: "list" }> }) {
  return (
    <div className="space-y-1.5">
      {s.rows.map((r) => (
        <div key={r.name} className="flex items-center justify-between gap-3">
          <span className="truncate text-[10.5px] font-medium text-foreground/80">{r.name}</span>
          <span
            className="shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold tabular-nums"
            style={{ background: "var(--v3-sel)", color: "var(--v3-accent)" }}
          >
            {r.score}
          </span>
        </div>
      ))}
    </div>
  );
}

function Kpi({ s }: { s: Extract<Sample, { kind: "kpi" }> }) {
  return (
    <div className="grid grid-cols-3 gap-1.5">
      {s.cells.map((c) => (
        <div key={c.label} className="rounded-[8px] bg-secondary/70 px-2 py-2">
          <div className="text-[8.5px] uppercase tracking-[0.06em] text-muted-foreground/80">{c.label}</div>
          <div className="mt-1 text-[12.5px] font-semibold leading-none tabular-nums text-foreground/90">{c.value}</div>
          {c.delta ? (
            <div className="mt-1 font-mono text-[9px]" style={{ color: "var(--v3-accent)" }}>{c.delta}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function Issues({ s }: { s: Extract<Sample, { kind: "issues" }> }) {
  return (
    <div className="space-y-1.5">
      {s.rows.map((r) => (
        <div key={r.title} className="flex items-center gap-1.5">
          <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: PRI_COLOR[r.pri] }} />
          <span className="truncate text-[10.5px] leading-snug text-foreground/70">{r.title}</span>
        </div>
      ))}
    </div>
  );
}

export function V3OutputPreview({
  sample,
  className = "",
}: {
  sample: Sample;
  className?: string;
}) {
  return (
    <div className={`rounded-[12px] bg-secondary/55 p-2.5 ${className}`}>
      <div className="min-h-[96px] rounded-[10px] bg-card px-3 py-2.5">
        {sample.kind === "email" && <Email s={sample} />}
        {sample.kind === "digest" && <Digest s={sample} />}
        {sample.kind === "list" && <List s={sample} />}
        {sample.kind === "kpi" && <Kpi s={sample} />}
        {sample.kind === "issues" && <Issues s={sample} />}
      </div>
    </div>
  );
}
