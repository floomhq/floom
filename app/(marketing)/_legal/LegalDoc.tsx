"use client";

/**
 * LegalDoc — shared chrome for /privacy and /terms. Same cool-light V3 system
 * as the docs page: eyebrow pill, big hero with one <Hl> highlight, a
 * "last updated" metadata row, a sticky mini-TOC, and restrained bg-card
 * section cards. Renders inside the shared V3Shell (one nav, one footer) so
 * the legal pages are part of the site, not orphaned bare-text pages.
 *
 * Content is data-driven: callers pass section copy as plain nodes. This file
 * owns layout only — it never edits legal copy.
 */

import Link from "next/link";
import { motion } from "motion/react";
import { Hl, V3Shell } from "@/app/v3/V3Shell";
import "@/app/v3/theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export type LegalSection = {
  id: string;
  title: string;
  body: React.ReactNode;
};

export function LegalDoc({
  eyebrow,
  headline,
  highlight,
  lastUpdated,
  intro,
  sections,
  crossLink,
}: {
  eyebrow: string;
  /** headline text with `{hl}` marking where `highlight` is inserted */
  headline: [string, string];
  highlight: string;
  lastUpdated: string;
  intro: React.ReactNode;
  sections: LegalSection[];
  crossLink: { href: string; label: string };
}) {
  return (
    <V3Shell>
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: EASE }}
        className="pb-8 pt-16"
      >
        <div
          className="inline-flex rounded-full bg-[var(--v3-sel)] px-3 py-1 text-[12px] font-medium"
          style={{ color: "var(--v3-accent)" }}
        >
          {eyebrow}
        </div>
        <h1 className="mt-5 max-w-[640px] text-[40px] font-semibold leading-[1.05] tracking-[-0.034em] sm:text-[52px]">
          {headline[0]}
          <Hl>{highlight}</Hl>
          {headline[1]}
        </h1>
        <p className="mt-4 flex items-center gap-2 text-[12.5px] text-muted-foreground">
          <span
            className="h-1.5 w-1.5 rounded-full"
            style={{ background: "var(--v3-accent)" }}
            aria-hidden
          />
          Last updated {lastUpdated}
        </p>
        <p className="mt-4 max-w-[560px] text-[15px] leading-relaxed text-muted-foreground">
          {intro}
        </p>
      </motion.div>

      <div className="grid gap-10 md:grid-cols-[190px_1fr]">
        {/* mini TOC */}
        <div className="hidden md:block">
          <div className="sticky top-20 rounded-[16px] bg-card p-2">
            {sections.map((s) => (
              <a
                key={s.id}
                href={`#${s.id}`}
                className="block rounded-[10px] px-3 py-2 text-[12.5px] text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
              >
                {s.title}
              </a>
            ))}
          </div>
        </div>

        {/* content */}
        <div className="flex min-w-0 max-w-[700px] flex-col gap-4">
          {sections.map((s) => (
            <section key={s.id} className="rounded-[18px] bg-card p-5">
              <h2
                id={s.id}
                className="scroll-mt-24 text-[19px] font-semibold tracking-[-0.02em]"
              >
                {s.title}
              </h2>
              <div className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
                {s.body}
              </div>
            </section>
          ))}

          <div className="mt-2 flex items-center gap-3 px-1 text-[13px]">
            <Link
              href="/"
              className="font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              Back to home
            </Link>
            <span aria-hidden className="text-muted-foreground/40">
              ·
            </span>
            <Link
              href={crossLink.href}
              className="font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              {crossLink.label}
            </Link>
          </div>
        </div>
      </div>
    </V3Shell>
  );
}

/** Shared mailto link styled in the brand accent register. */
export function MailLink() {
  return (
    <a
      href="mailto:hello@floom.dev"
      className="font-medium underline-offset-4 hover:underline"
      style={{ color: "var(--v3-accent)" }}
    >
      hello@floom.dev
    </a>
  );
}
