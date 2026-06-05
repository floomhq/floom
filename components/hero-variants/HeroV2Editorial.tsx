"use client";

import { motion, useReducedMotion } from "motion/react";
import { Check, Clock } from "lucide-react";
import { HeroPromptComposer } from "../landing-ref/HeroPromptComposer";
import { GmailLogo, HubSpotLogo, SlackLogo } from "../landing-icons";

/**
 * V2 — Editorial split
 * Magazine-spread feel: left column is the editorial hero text, right column
 * is a single big "employee badge" card representing the AI worker as a hire.
 * Warm cream surface, no dark. Bold typography, italic emphasis on key word.
 */
export function HeroV2Editorial() {
  const reduce = useReducedMotion();

  return (
    <section className="relative isolate overflow-hidden px-6 pt-14 pb-24 sm:pt-20">
      {/* Soft emerald wash in the background corner */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -z-10"
        style={{
          right: "-15%",
          top: "-15%",
          width: "70%",
          height: "70%",
          background:
            "radial-gradient(ellipse at center, rgba(10, 82, 48, 0.10), transparent 70%)",
          filter: "blur(80px)",
        }}
      />

      <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1.1fr_1fr]">
        {/* LEFT — editorial text */}
        <div>
          <motion.a
            href="https://f.inc/"
            target="_blank"
            rel="noopener noreferrer"
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={reduce ? undefined : { opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0, ease: [0.22, 1, 0.36, 1] }}
            className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--emerald-dark)]/20 bg-[var(--emerald-dark)]/[0.04] px-3 py-1 text-[11.5px] text-muted-foreground transition hover:-translate-y-px hover:border-[var(--emerald-dark)]/40 hover:text-foreground"
          >
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--emerald-dark)]" aria-hidden="true" />
            <span>Backed by</span>
            <span className="font-semibold text-foreground">Founders Inc</span>
          </motion.a>

          <motion.h1
            initial={reduce ? false : { opacity: 0, y: 14 }}
            animate={reduce ? undefined : { opacity: 1, y: 0 }}
            transition={{ duration: 0.65, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
            className="text-balance text-[40px] font-semibold leading-[1.04] tracking-[-0.025em] text-foreground sm:text-[64px]"
          >
            Hire AI{" "}
            <em
              className="font-serif italic"
              style={{
                fontFamily: 'var(--font-serif), "Iowan Old Style", "Apple Garamond", Baskerville, Times, serif',
                fontWeight: 500,
                color: "#3a6ea5",
                letterSpacing: "-0.01em",
              }}
            >
              workers
            </em>
            <br className="hidden sm:inline" /> for your company.
          </motion.h1>

          <motion.p
            initial={reduce ? false : { opacity: 0, y: 10 }}
            animate={reduce ? undefined : { opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="text-balance mt-6 max-w-xl text-[17px] leading-relaxed text-muted-foreground"
          >
            Describe the job. Workeros hires the worker and runs it for your team, with your approval
            before anything ships.
          </motion.p>

          <motion.div
            initial={reduce ? false : { opacity: 0, y: 12 }}
            animate={reduce ? undefined : { opacity: 1, y: 0 }}
            transition={{ duration: 0.6, delay: 0.28, ease: [0.22, 1, 0.36, 1] }}
            className="mt-8"
          >
            <HeroPromptComposer />
          </motion.div>
        </div>

        {/* RIGHT — employee badge artwork */}
        <motion.div
          initial={reduce ? false : { opacity: 0, y: 18, rotate: -2 }}
          animate={reduce ? undefined : { opacity: 1, y: 0, rotate: -2 }}
          transition={{ duration: 0.8, delay: 0.35, ease: [0.22, 1, 0.36, 1] }}
          className="relative mx-auto w-full max-w-[420px]"
        >
          {/* Stack: bottom card (subtle) */}
          <div
            aria-hidden="true"
            className="absolute inset-x-6 top-6 -z-10 h-full rounded-[24px] border border-border bg-card/60 shadow-md"
            style={{ transform: "rotate(4deg)" }}
          />
          <div
            aria-hidden="true"
            className="absolute inset-x-3 top-3 -z-10 h-full rounded-[24px] border border-border bg-card/80 shadow-md"
            style={{ transform: "rotate(1.5deg)" }}
          />

          {/* Top — focal employee badge */}
          <div className="relative rounded-[24px] border border-border bg-card p-6 shadow-[0_24px_60px_-12px_rgba(20,20,20,0.18)]">
            {/* Header */}
            <div className="mb-5 flex items-center justify-between">
              <span className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-[var(--emerald-dark)]">
                Worker · ID 0042
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-[var(--emerald-dark)]/30 bg-[var(--emerald-dark)]/[0.06] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--emerald-dark)]">
                <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--emerald-dark)]" />
                Live
              </span>
            </div>

            {/* Portrait tile + name */}
            <div className="flex items-center gap-4">
              {/* Stylized portrait (geometric) */}
              <div
                className="relative grid h-20 w-20 shrink-0 place-items-center overflow-hidden rounded-[14px] bg-[var(--emerald-dark)] text-[var(--paper)]"
                aria-hidden="true"
              >
                <svg viewBox="0 0 100 100" className="h-full w-full">
                  <defs>
                    <radialGradient id="bg-portrait" cx="50%" cy="35%" r="80%">
                      <stop offset="0%" stopColor="#1f7d57" />
                      <stop offset="100%" stopColor="#0a3b27" />
                    </radialGradient>
                  </defs>
                  <rect width="100" height="100" fill="url(#bg-portrait)" />
                  {/* Stylized head + shoulders silhouette */}
                  <circle cx="50" cy="38" r="16" fill="#FAFAF7" />
                  <path d="M22 100 C 22 72, 78 72, 78 100 Z" fill="#FAFAF7" />
                </svg>
              </div>
              <div className="min-w-0">
                <div className="truncate text-[20px] font-semibold tracking-[-0.02em] text-foreground">
                  Client Follow-up Worker
                </div>
                <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                  Sales · Drafts follow-ups after calls
                </div>
              </div>
            </div>

            {/* Stats row */}
            <dl className="mt-6 grid grid-cols-3 gap-3 border-y border-border/70 py-4">
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Drafted
                </dt>
                <dd className="mt-1 font-mono text-[18px] font-semibold text-foreground">142</dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Approved
                </dt>
                <dd className="mt-1 font-mono text-[18px] font-semibold text-foreground">128</dd>
              </div>
              <div>
                <dt className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  Saved / wk
                </dt>
                <dd className="mt-1 font-mono text-[18px] font-semibold text-foreground">9h</dd>
              </div>
            </dl>

            {/* Tools row */}
            <div className="mt-4">
              <div className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                Uses
              </div>
              <div className="mt-2 flex items-center gap-2">
                <ToolDot>
                  <GmailLogo />
                </ToolDot>
                <ToolDot>
                  <HubSpotLogo />
                </ToolDot>
                <ToolDot>
                  <SlackLogo />
                </ToolDot>
                <span className="text-[11.5px] text-muted-foreground">+ 3 more</span>
              </div>
            </div>

            {/* Footer */}
            <div className="mt-6 flex items-center justify-between rounded-[12px] border border-border bg-secondary/40 px-3 py-2.5 text-[12.5px]">
              <span className="inline-flex items-center gap-1.5 text-foreground/85">
                <Clock className="h-3.5 w-3.5 text-[var(--emerald-dark)]" />
                Next run in 14h
              </span>
              <span className="inline-flex items-center gap-1.5 text-foreground/85">
                <Check className="h-3.5 w-3.5 text-[var(--emerald-dark)]" strokeWidth={2.5} />
                Asks before send
              </span>
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}

function ToolDot({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-grid h-7 w-7 place-items-center rounded-[8px] border border-border bg-background [&_svg]:h-3.5 [&_svg]:w-3.5">
      {children}
    </span>
  );
}
