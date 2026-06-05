"use client";

/**
 * V3 alternate — "Photo Wall"
 * Uniform circular avatar tiles in a clean grid behind the hero text.
 * No rectangles, no mixed shapes — just disks. Reads like a team photo wall.
 */

import { motion, useReducedMotion, type Transition } from "motion/react";
import { useEffect, useState } from "react";
import { HeroPromptComposer } from "../landing-ref/HeroPromptComposer";

const EASE_OUT: Transition["ease"] = [0.22, 1, 0.36, 1];

type Worker = { monogram: string; name: string; role: string; tone?: string };

// Two rows of avatars, offset so the hero text reads through the negative space
const ROW_TOP: Worker[] = [
  { monogram: "M", name: "Maya", role: "Sales" },
  { monogram: "A", name: "Atlas", role: "Ops" },
  { monogram: "O", name: "Otto", role: "Research" },
  { monogram: "I", name: "Iris", role: "Support" },
  { monogram: "N", name: "Nova", role: "Reports" },
  { monogram: "F", name: "Felix", role: "Recruiting" },
  { monogram: "S", name: "Sage", role: "Finance" },
];

const ROW_BOT: Worker[] = [
  { monogram: "K", name: "Kai", role: "Marketing" },
  { monogram: "R", name: "Rio", role: "Outreach" },
  { monogram: "T", name: "Tess", role: "Brief" },
  { monogram: "L", name: "Luca", role: "Drafts" },
  { monogram: "P", name: "Piper", role: "Triage" },
  { monogram: "V", name: "Vita", role: "Updates" },
  { monogram: "G", name: "Gus", role: "Notes" },
];

function Avatar({
  w,
  index,
  reduce,
  size = 64,
  faded,
}: {
  w: Worker;
  index: number;
  reduce: boolean;
  size?: number;
  faded?: boolean;
}) {
  return (
    <motion.div
      initial={reduce ? false : { opacity: 0, scale: 0.7, y: 8 }}
      animate={
        reduce
          ? undefined
          : {
              opacity: faded ? 0.42 : 1,
              scale: 1,
              y: [0, -3, 0],
            }
      }
      transition={{
        opacity: { duration: 0.6, delay: 0.3 + index * 0.04, ease: EASE_OUT },
        scale: { duration: 0.6, delay: 0.3 + index * 0.04, ease: EASE_OUT },
        y: reduce
          ? { duration: 0 }
          : { duration: 5 + (index % 4) * 0.6, repeat: Infinity, ease: "easeInOut", delay: index * 0.2 },
      }}
      className="flex flex-col items-center"
      style={{ opacity: reduce ? (faded ? 0.42 : 1) : undefined }}
    >
      <span
        aria-hidden
        className="inline-flex items-center justify-center rounded-full font-semibold text-white"
        style={{
          width: size,
          height: size,
          fontSize: Math.round(size * 0.4),
          background:
            "linear-gradient(140deg, var(--emerald-dark) 0%, color-mix(in srgb, var(--emerald-dark) 70%, #000) 100%)",
          boxShadow:
            "inset 0 1px 0 rgba(255,255,255,0.18), 0 8px 18px -10px rgba(10,82,48,0.45)",
        }}
      >
        {w.monogram}
      </span>
      <div className="mt-1.5 text-center">
        <div className="text-[10.5px] font-semibold leading-tight text-foreground/85">{w.name}</div>
        <div className="text-[9px] uppercase tracking-[0.14em] text-muted-foreground">{w.role}</div>
      </div>
    </motion.div>
  );
}

export function HeroV3Wall() {
  const reduce = useReducedMotion() ?? false;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <section className="relative isolate overflow-hidden px-6 pt-14 pb-20 sm:pt-20" style={{ minHeight: "min(820px, 92vh)" }}>
      {/* Atmospheric blooms */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-[6%] h-[420px] w-[520px] rounded-full blur-3xl"
        style={{ background: "radial-gradient(ellipse at 40% 40%, color-mix(in srgb, var(--emerald-dark) 14%, transparent) 0%, transparent 80%)", zIndex: 0 }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 bottom-[4%] h-[460px] w-[540px] rounded-full blur-3xl"
        style={{ background: "radial-gradient(ellipse at 60% 60%, color-mix(in srgb, var(--emerald-dark) 12%, transparent) 0%, transparent 82%)", zIndex: 0 }}
      />

      {/* Top row: 7 avatars, faded as they go behind the hero text */}
      <div className="pointer-events-none absolute inset-x-0 top-[14%] hidden justify-center sm:flex" style={{ zIndex: 1 }}>
        <div className="flex items-end gap-8 lg:gap-12">
          {mounted &&
            ROW_TOP.map((w, i) => (
              <Avatar
                key={w.name}
                w={w}
                index={i}
                reduce={reduce}
                size={i === 0 || i === ROW_TOP.length - 1 ? 56 : i === 3 ? 76 : 64}
                faded={i >= 2 && i <= 4}
              />
            ))}
        </div>
      </div>

      {/* Bottom row: 7 avatars, large at ends, faded in the middle */}
      <div className="pointer-events-none absolute inset-x-0 bottom-[8%] hidden justify-center sm:flex" style={{ zIndex: 1 }}>
        <div className="flex items-start gap-8 lg:gap-12">
          {mounted &&
            ROW_BOT.map((w, i) => (
              <Avatar
                key={w.name}
                w={w}
                index={i + ROW_TOP.length}
                reduce={reduce}
                size={i === 0 || i === ROW_BOT.length - 1 ? 56 : i === 3 ? 70 : 60}
                faded={i >= 2 && i <= 4}
              />
            ))}
        </div>
      </div>

      {/* Hero stack */}
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
    </section>
  );
}
