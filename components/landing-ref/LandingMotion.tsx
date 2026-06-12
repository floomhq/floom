"use client";

/**
 * Client-side motion primitives that LandingRef (server) composes for the
 * dark-templates header and the final CTA. Keeps LandingRef plain-server while
 * giving each spot proper stagger entrances.
 */

import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import { ScrollToHeroButton } from "./ScrollToHeroButton";

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.06 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 14 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE_OUT } },
};
const eyebrowLine: Variants = {
  hidden: { scaleX: 0, opacity: 0 },
  show: { scaleX: 1, opacity: 1, transition: { duration: 0.5, ease: EASE_OUT } },
};

/**
 * TemplatesHeader — dark-slab "Hire a worker in 60 seconds" + the
 * Browse-all-templates CTA. Eyebrow line scales in, headline and sub stagger,
 * CTA pops last.
 */
export function TemplatesHeader({ templatesHref }: { templatesHref: string }) {
  const reduce = useReducedMotion() ?? false;
  if (reduce) {
    return (
      <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
        <div className="max-w-2xl">
          <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-background/65">
            <span aria-hidden="true" className="h-px w-6 bg-background/30" />
            Start in 60 seconds
          </div>
          <h2 className="text-balance text-[32px] font-semibold leading-tight tracking-[-0.02em] text-background sm:text-[40px]">
            Hire a worker in 60 seconds.
          </h2>
          <p className="mt-3 text-base text-background/65">
            Templates already tuned for the recurring work teams ask WorkerOS to handle.
          </p>
        </div>
        <Link
          href={templatesHref}
          className="group/cta inline-flex h-11 items-center gap-1.5 rounded-[12px] bg-background px-4 text-[13.5px] font-semibold text-foreground shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] transition hover:-translate-y-px hover:shadow-[0_12px_32px_-10px_rgba(0,0,0,0.55)]"
        >
          Browse all templates{" "}
          <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover/cta:translate-x-0.5" />
        </Link>
      </div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.2, margin: "0px 0px -8% 0px" }}
      variants={stagger}
      className="mb-10 flex flex-wrap items-end justify-between gap-4"
    >
      <div className="max-w-2xl">
        <motion.div
          variants={item}
          className="mb-3 inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-background/65"
        >
          <motion.span
            aria-hidden="true"
            variants={eyebrowLine}
            style={{ transformOrigin: "left" }}
            className="h-px w-6 bg-background/30"
          />
          Start in 60 seconds
        </motion.div>
        <motion.h2
          variants={item}
          className="text-balance text-[32px] font-semibold leading-tight tracking-[-0.02em] text-background sm:text-[40px]"
        >
          Hire a worker in 60 seconds.
        </motion.h2>
        <motion.p variants={item} className="mt-3 text-base text-background/65">
          Templates already tuned for the recurring work teams ask WorkerOS to handle.
        </motion.p>
      </div>
      <motion.div variants={item}>
        <Link
          href={templatesHref}
          className="group/cta inline-flex h-11 items-center gap-1.5 rounded-[12px] bg-background px-4 text-[13.5px] font-semibold text-foreground shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] transition hover:-translate-y-px hover:shadow-[0_12px_32px_-10px_rgba(0,0,0,0.55)]"
        >
          Browse all templates{" "}
          <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover/cta:translate-x-0.5" />
        </Link>
      </motion.div>
    </motion.div>
  );
}

/**
 * FinalCTAGroup — single stagger container for the close-out section: h2,
 * sub, and the two buttons. Replaces three separate Reveal wrappers.
 */
export function FinalCTAGroup({ templatesHref }: { templatesHref: string }) {
  const reduce = useReducedMotion() ?? false;
  if (reduce) {
    return (
      <div className="mx-auto max-w-3xl text-center">
        <h2 className="text-balance text-[40px] font-semibold leading-[1.02] tracking-[-0.03em] text-foreground sm:text-[56px]">
          Hire your first worker.
        </h2>
        <p className="mx-auto mt-5 max-w-md text-[16px] text-muted-foreground">
          Describe the task once. WorkerOS runs it for your team, with your approval before anything ships.
        </p>
        <div className="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:flex-wrap sm:items-center">
          <ScrollToHeroButton className="w-full sm:w-auto">Describe your worker</ScrollToHeroButton>
          <Link
            href={templatesHref}
            className="inline-flex h-12 w-full items-center justify-center gap-1.5 rounded-[12px] border border-border bg-card px-5 text-[14px] font-medium text-foreground transition hover:border-foreground/30 hover:bg-secondary/60 sm:w-auto"
          >
            Or browse templates
          </Link>
        </div>
      </div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.3, margin: "0px 0px -8% 0px" }}
      variants={stagger}
      className="mx-auto max-w-3xl text-center"
    >
      <motion.h2
        variants={item}
        className="text-balance text-[40px] font-semibold leading-[1.02] tracking-[-0.03em] text-foreground sm:text-[56px]"
      >
        Hire your first worker.
      </motion.h2>
      <motion.p
        variants={item}
        className="mx-auto mt-5 max-w-md text-[16px] text-muted-foreground"
      >
        Describe the task once. WorkerOS runs it for your team, with your approval before anything ships.
      </motion.p>
      <motion.div
        variants={item}
        className="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:flex-wrap sm:items-center"
      >
        <ScrollToHeroButton className="w-full sm:w-auto">Describe your worker</ScrollToHeroButton>
        <Link
          href={templatesHref}
          className="inline-flex h-12 w-full items-center justify-center gap-1.5 rounded-[12px] border border-border bg-card px-5 text-[14px] font-medium text-foreground transition hover:border-foreground/30 hover:bg-secondary/60 sm:w-auto"
        >
          Or browse templates
        </Link>
      </motion.div>
    </motion.div>
  );
}
