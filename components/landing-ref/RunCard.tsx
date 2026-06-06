"use client";

import { motion, useReducedMotion, type Variants } from "motion/react";
import { ToolLogoChip } from "./logos";
import { StatusPill } from "./StatusPill";

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.06, delayChildren: 0.12 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } },
};

function BrainChips({ items }: { items: string[] }) {
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((b) => (
        <span
          key={b}
          className="inline-flex h-7 items-center rounded-[9px] border border-border bg-secondary/60 px-2 text-[11px] text-muted-foreground"
        >
          {b}
        </span>
      ))}
    </span>
  );
}

function Field({
  label,
  children,
  reduce,
}: {
  label: string;
  children: React.ReactNode;
  reduce: boolean;
}) {
  if (reduce) {
    return (
      <div className="flex items-start gap-3 py-2">
        <div className="w-24 shrink-0 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </div>
        <div className="min-w-0 flex-1 text-[12.5px] text-foreground/90">{children}</div>
      </div>
    );
  }
  return (
    <motion.div variants={item} className="flex items-start gap-3 py-2">
      <div className="w-24 shrink-0 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
        {label}
      </div>
      <div className="min-w-0 flex-1 text-[12.5px] text-foreground/90">{children}</div>
    </motion.div>
  );
}

export type RunCardProps = {
  id: string;
  worker: string;
  statusLabel: string;
  trigger: string;
  tools: string[];
  brain: string[];
  output: string;
  approval: string;
  /** Embedded artifact (e.g. email preview) shown between fields and footer. */
  children?: React.ReactNode;
  /** Approval / action footer node. */
  footer?: React.ReactNode;
  /** "panel" = single column; "inspector" = two-column metadata on desktop. */
  layout?: "panel" | "inspector";
  /** Which field rows to render in panel layout (default: all). */
  fields?: Array<"trigger" | "tools" | "brain" | "output" | "approval">;
};

export function RunCard({
  id,
  worker,
  statusLabel,
  trigger,
  tools,
  brain,
  output,
  approval,
  children,
  footer,
  layout = "panel",
  fields = ["trigger", "tools", "brain", "output", "approval"],
}: RunCardProps) {
  const reduce = useReducedMotion() ?? false;
  const ROW: Record<string, React.ReactNode> = {
    trigger: (
      <Field label="Trigger" reduce={reduce}>
        {trigger}
      </Field>
    ),
    tools: (
      <Field label="Tools used" reduce={reduce}>
        <span className="flex flex-wrap gap-1.5">
          {tools.map((t) => (
            <ToolLogoChip key={t} tool={t} size="sm" />
          ))}
        </span>
      </Field>
    ),
    brain: (
      <Field label="Brain used" reduce={reduce}>
        <BrainChips items={brain} />
      </Field>
    ),
    output: (
      <Field label="Output" reduce={reduce}>
        {output}
      </Field>
    ),
    approval: (
      <Field label="Approval" reduce={reduce}>
        {approval}
      </Field>
    ),
  };

  const Container = reduce ? "div" : motion.div;
  const containerProps = reduce
    ? {}
    : {
        initial: "hidden",
        whileInView: "show",
        viewport: { once: true, amount: 0.2, margin: "0px 0px -8% 0px" },
        variants: stagger,
      };

  return (
    <Container
      {...containerProps}
      className="overflow-hidden rounded-[18px] border border-border bg-card shadow-sm"
    >
      <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-7 w-7 shrink-0 place-items-center rounded-[9px] bg-primary text-[11px] font-bold text-primary-foreground">
            F
          </span>
          <div>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
              <span className="text-[13.5px] font-semibold text-foreground">{worker}</span>
              <span className="font-mono text-[10.5px] text-muted-foreground">{id}</span>
            </div>
          </div>
        </div>
        <StatusPill>{statusLabel}</StatusPill>
      </div>

      {layout === "inspector" ? (
        <div className="grid gap-x-8 px-4 py-1 sm:grid-cols-2 sm:divide-x sm:divide-border/60">
          <div className="divide-y divide-border/60 sm:pr-2">
            <Field label="Trigger" reduce={reduce}>
              {trigger}
            </Field>
            <Field label="Tools used" reduce={reduce}>
              <span className="flex flex-wrap gap-1.5">
                {tools.map((t) => (
                  <ToolLogoChip key={t} tool={t} size="sm" />
                ))}
              </span>
            </Field>
            <Field label="Brain used" reduce={reduce}>
              <BrainChips items={brain} />
            </Field>
          </div>
          <div className="divide-y divide-border/60 sm:pl-6">
            <Field label="Output" reduce={reduce}>
              {output}
            </Field>
            <Field label="Approval" reduce={reduce}>
              {approval}
            </Field>
            <Field label="Worker" reduce={reduce}>
              {worker}
            </Field>
          </div>
        </div>
      ) : (
        <div className="divide-y divide-border/60 px-4 py-1">
          {fields.map((f) => (
            <div key={f}>{ROW[f]}</div>
          ))}
        </div>
      )}

      {children && <div className="border-t border-border px-4 py-3">{children}</div>}
      {footer && <div className="border-t border-border bg-secondary/40 px-4 py-3">{footer}</div>}
    </Container>
  );
}
