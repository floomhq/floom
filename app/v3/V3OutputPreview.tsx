"use client";

/**
 * V3OutputPreview — a small, deterministic "artifact cue" for a worker card.
 * Identity comes from the work the worker produces, not from avatars. Rendered
 * as calm skeleton shapes in the cool palette: no real text, no color noise.
 * One shape per PreviewKind.
 */

import type { PreviewKind } from "@/components/landing-ref/data";

function Bar({ w = "100%", strong = false }: { w?: string; strong?: boolean }) {
  return (
    <span
      className={`block h-2 rounded-full ${strong ? "bg-foreground/15" : "bg-muted-foreground/15"}`}
      style={{ width: w }}
    />
  );
}

function Email() {
  return (
    <div className="space-y-1.5">
      <Bar w="60%" strong />
      <Bar w="100%" />
      <Bar w="82%" />
    </div>
  );
}

function Digest() {
  return (
    <div className="space-y-2">
      <Bar w="46%" strong />
      <Bar w="100%" />
      <Bar w="88%" />
    </div>
  );
}

function List() {
  return (
    <div className="space-y-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center justify-between gap-3">
          <Bar w={["58%", "70%", "50%"][i]} strong />
          <span
            className="h-2 w-7 shrink-0 rounded-full"
            style={{ background: "var(--v3-sel)" }}
          />
        </div>
      ))}
    </div>
  );
}

function Kpi() {
  return (
    <div className="grid grid-cols-3 gap-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="rounded-[8px] bg-card px-2 py-2">
          <span className="block h-1.5 w-7 rounded-full bg-muted-foreground/20" />
          <span className="mt-2 block h-3 w-10 rounded-full bg-foreground/20" />
        </div>
      ))}
    </div>
  );
}

function Issues() {
  return (
    <div className="space-y-1.5">
      {[0, 1, 2].map((i) => (
        <div key={i} className="flex items-center gap-2">
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: "var(--v3-accent)" }}
          />
          <Bar w={["72%", "90%", "64%"][i]} />
        </div>
      ))}
    </div>
  );
}

const SHAPES: Record<PreviewKind, React.ReactNode> = {
  email: <Email />,
  digest: <Digest />,
  list: <List />,
  kpi: <Kpi />,
  issues: <Issues />,
};

export function V3OutputPreview({
  kind,
  className = "",
}: {
  kind: PreviewKind;
  className?: string;
}) {
  return (
    <div className={`rounded-[12px] bg-secondary/65 p-3 ${className}`}>
      <div className="rounded-[10px] bg-card/80 px-3 py-2.5">{SHAPES[kind]}</div>
    </div>
  );
}
