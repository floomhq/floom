"use client";

import { Brain, Check } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
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
  const reduce = useReducedMotion();
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

      {/* Company Brain — focal card with literal brain illustration behind */}
      <div className="relative shrink-0 lg:w-[260px]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 z-0 size-[300px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#3a6ea5]/[0.10] blur-3xl lg:size-[380px]"
        />
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 z-0 -translate-x-1/2 -translate-y-1/2"
          animate={reduce ? undefined : { scale: [1, 1.04, 1], opacity: [0.85, 1, 0.85] }}
          transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
        >
          <Brain
            strokeWidth={1.2}
            className="size-[380px] text-[#3a6ea5]/25 lg:size-[460px]"
          />
        </motion.div>
        <div className="relative z-10 rounded-[18px] border border-border bg-card p-5 shadow-md">
          <div className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[14px] font-semibold text-foreground">
              <Brain className="h-4 w-4 text-[#3a6ea5]" strokeWidth={2} />
              Company Brain
            </div>
            <StatusPill tone="success">Live</StatusPill>
          </div>
          <ul className="space-y-2">
            {KNOWS.map((k) => (
              <li
                key={k}
                className="flex items-center gap-2 rounded-[9px] border border-border bg-secondary/50 px-2.5 py-1.5 text-[12.5px]"
              >
                <Check className="h-3.5 w-3.5 shrink-0 text-[#3a6ea5]" strokeWidth={2.5} />
                <span className="text-foreground">{k}</span>
              </li>
            ))}
          </ul>
        </div>
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
