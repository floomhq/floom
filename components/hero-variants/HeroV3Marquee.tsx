"use client";

/**
 * V3 alternate — "Marquee"
 * Hero text centered top, two infinite-scrolling rows of worker badges
 * below. Movement gives a "team in motion" feel; identical card shape
 * (rounded pill) reads cleaner than the mixed-shape collage.
 */

import { motion, useReducedMotion, type Transition } from "motion/react";
import { useEffect, useState } from "react";
import { HeroPromptComposer } from "../landing-ref/HeroPromptComposer";
import { ToolLogo, hasLogo } from "../landing-ref/logos";

const EASE_OUT: Transition["ease"] = [0.22, 1, 0.36, 1];

type Worker = {
  monogram: string;
  name: string;
  role: string;
  tools: string[];
  status: "Live" | "Running" | "Approved" | "Waiting";
};

const ROW_A: Worker[] = [
  { monogram: "M", name: "Maya", role: "Sales · Follow-ups", tools: ["hubspot", "gmail"], status: "Live" },
  { monogram: "A", name: "Atlas", role: "Ops · Reports", tools: ["sheets", "slack"], status: "Running" },
  { monogram: "O", name: "Otto", role: "Research · Briefs", tools: ["web", "notion"], status: "Approved" },
  { monogram: "I", name: "Iris", role: "Support · Triage", tools: ["intercom", "slack"], status: "Waiting" },
  { monogram: "N", name: "Nova", role: "Reports · Weekly", tools: ["sheets", "gmail"], status: "Live" },
  { monogram: "F", name: "Felix", role: "Recruiting · Outreach", tools: ["linear", "gmail"], status: "Running" },
  { monogram: "S", name: "Sage", role: "Finance · Drafts", tools: ["sheets"], status: "Live" },
  { monogram: "K", name: "Kai", role: "Marketing · Posts", tools: ["notion", "slack"], status: "Approved" },
];

const ROW_B: Worker[] = [
  { monogram: "R", name: "Rio", role: "Outreach · Cold email", tools: ["gmail", "hubspot"], status: "Running" },
  { monogram: "T", name: "Tess", role: "Brief · Pre-meeting", tools: ["notion", "calendar"], status: "Live" },
  { monogram: "L", name: "Luca", role: "Drafts · Replies", tools: ["gmail", "slack"], status: "Waiting" },
  { monogram: "P", name: "Piper", role: "Triage · Inbox", tools: ["gmail", "slack"], status: "Live" },
  { monogram: "V", name: "Vita", role: "Updates · Friday", tools: ["sheets", "slack"], status: "Approved" },
  { monogram: "G", name: "Gus", role: "Notes · Calls", tools: ["calendar", "notion"], status: "Live" },
  { monogram: "Z", name: "Zara", role: "QBR · Quarterly", tools: ["sheets", "gmail"], status: "Running" },
  { monogram: "B", name: "Bram", role: "Demo · Prep", tools: ["calendar", "hubspot"], status: "Live" },
];

function statusDotColor(s: Worker["status"]) {
  if (s === "Running") return "#E0B349";
  return "var(--emerald-dark)";
}

function WorkerChip({ w }: { w: Worker }) {
  return (
    <div
      className="inline-flex shrink-0 items-center gap-3 rounded-full py-2 pl-2 pr-4"
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border-default)",
        boxShadow: "0 14px 28px -16px rgba(20,20,20,0.18), inset 0 1px 0 rgba(255,255,255,0.6)",
      }}
    >
      <span
        aria-hidden
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-[14px] font-semibold text-white"
        style={{
          background: "linear-gradient(140deg, var(--emerald-dark) 0%, color-mix(in srgb, var(--emerald-dark) 70%, #000) 100%)",
          boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18)",
        }}
      >
        {w.monogram}
      </span>
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-semibold leading-tight text-foreground">{w.name}</div>
        <div className="truncate text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{w.role}</div>
      </div>
      <span aria-hidden className="ml-1 h-6 w-px shrink-0" style={{ background: "var(--border-soft)" }} />
      <span className="inline-flex shrink-0 items-center -space-x-1">
        {w.tools.filter(hasLogo).slice(0, 2).map((t) => (
          <span
            key={t}
            className="grid h-5 w-5 place-items-center rounded-full border bg-white [&_svg]:h-2.5 [&_svg]:w-2.5"
            style={{ borderColor: "var(--border-default)" }}
            aria-label={t}
          >
            <ToolLogo name={t} />
          </span>
        ))}
      </span>
      <span
        aria-hidden
        className="ml-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: statusDotColor(w.status) }}
      />
    </div>
  );
}

function MarqueeRow({ workers, reverse = false, speedSec = 50 }: { workers: Worker[]; reverse?: boolean; speedSec?: number }) {
  // Duplicate the list so the loop is seamless
  const doubled = [...workers, ...workers];
  return (
    <div className="relative w-full overflow-hidden">
      {/* Edge fade */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 z-10 w-32"
        style={{ background: "linear-gradient(to right, var(--bg) 0%, transparent 100%)" }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 z-10 w-32"
        style={{ background: "linear-gradient(to left, var(--bg) 0%, transparent 100%)" }}
      />
      <motion.div
        className="flex gap-3 py-2"
        animate={{ x: reverse ? ["-50%", "0%"] : ["0%", "-50%"] }}
        transition={{ duration: speedSec, repeat: Infinity, ease: "linear" }}
        style={{ width: "max-content" }}
      >
        {doubled.map((w, i) => (
          <WorkerChip key={`${w.name}-${i}`} w={w} />
        ))}
      </motion.div>
    </div>
  );
}

export function HeroV3Marquee() {
  const reduce = useReducedMotion() ?? false;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <section className="relative isolate overflow-hidden px-6 pt-14 pb-10 sm:pt-20" style={{ minHeight: "min(820px, 92vh)" }}>
      {/* Soft emerald glow */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-[6%] h-[420px] w-[520px] rounded-full blur-3xl"
        style={{ background: "radial-gradient(ellipse at 40% 40%, color-mix(in srgb, var(--emerald-dark) 14%, transparent) 0%, transparent 80%)", zIndex: 0 }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 top-[40%] h-[420px] w-[480px] rounded-full blur-3xl"
        style={{ background: "radial-gradient(ellipse at 60% 60%, color-mix(in srgb, var(--emerald-dark) 12%, transparent) 0%, transparent 82%)", zIndex: 0 }}
      />

      <div className="relative mx-auto max-w-3xl text-center" style={{ zIndex: 30 }}>
        <motion.a
          href="https://f.inc/"
          target="_blank"
          rel="noopener noreferrer"
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE_OUT }}
          className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--emerald-dark)]/25 bg-[var(--emerald-dark)]/[0.05] px-3 py-1 text-[11.5px] text-muted-foreground backdrop-blur-sm transition-all duration-200 hover:-translate-y-px hover:border-[var(--emerald-dark)]/45 hover:bg-[var(--emerald-dark)]/[0.09] hover:text-foreground"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--emerald-dark)]" aria-hidden />
          <span>Backed by</span>
          <span className="font-semibold text-foreground">Founders Inc</span>
        </motion.a>

        <motion.h1
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.08, ease: EASE_OUT }}
          className="text-balance text-[34px] font-semibold leading-[1.06] tracking-[-0.025em] text-foreground sm:text-[64px] sm:leading-[1.03]"
        >
          Hire AI{" "}
          <em
            className="font-serif italic"
            style={{
              fontFamily: 'var(--font-serif), "Iowan Old Style", "Apple Garamond", Baskerville, Times, serif',
              fontWeight: 500,
              color: "var(--emerald-dark)",
              letterSpacing: "-0.01em",
            }}
          >
            workers
          </em>
          <br className="hidden sm:inline" /> for your company.
        </motion.h1>

        <motion.p
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.18, ease: EASE_OUT }}
          className="text-balance mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-muted-foreground"
        >
          Describe the job. Workeros hires the worker and runs it for your team, with your approval before anything ships.
        </motion.p>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.28, ease: EASE_OUT }}
        >
          <HeroPromptComposer />
        </motion.div>
      </div>

      {/* Two infinite-scroll marquees of worker chips, opposite directions */}
      <div className="relative mt-14 hidden sm:block" style={{ zIndex: 20 }}>
        {mounted && (
          <>
            <MarqueeRow workers={ROW_A} speedSec={reduce ? 0 : 60} />
            <div className="h-3" />
            <MarqueeRow workers={ROW_B} reverse speedSec={reduce ? 0 : 80} />
          </>
        )}
      </div>
    </section>
  );
}
