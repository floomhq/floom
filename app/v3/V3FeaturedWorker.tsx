"use client";

/**
 * V3FeaturedWorker — the spotlight above the gallery grid. Turns /templates
 * from "directory of names" into "marketplace of work produced" by showing one
 * worker's real output (the same jewel the detail page uses) up top.
 */

import Link from "next/link";
import { motion } from "motion/react";
import {
  FEATURED_SLUG,
  getTemplate,
  getTemplateDetail,
} from "@/components/landing-ref/data";
import { GmailLogo, OutlookLogo } from "@/components/landing-icons";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export function V3FeaturedWorker() {
  const t = getTemplate(FEATURED_SLUG);
  if (!t) return null;
  const d = getTemplateDetail(t);

  return (
    <section className="mb-14 grid items-center gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:gap-12">
      <div>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: EASE }}
          className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
        >
          Featured worker · {t.category}
        </motion.div>
        <motion.h2
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.05, ease: EASE }}
          className="mt-2 text-[24px] font-semibold leading-[1.1] tracking-[-0.022em] sm:text-[28px]"
        >
          {t.name}
        </motion.h2>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.1, ease: EASE }}
          className="mt-3 max-w-[400px] text-[14px] leading-relaxed text-muted-foreground"
        >
          {d.summary}
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.16, ease: EASE }}
          className="mt-5 flex items-center gap-3"
        >
          <Link
            href={`/templates/${t.slug}`}
            className="inline-flex h-9 items-center whitespace-nowrap rounded-[10px] px-4 text-[13.5px] font-medium text-white"
            style={{ background: "var(--v3-accent)" }}
          >
            See this worker
          </Link>
          <span className="font-mono text-[11px] text-muted-foreground">{t.runs}</span>
        </motion.div>
      </div>

      {/* the jewel: example output */}
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.55, delay: 0.12, ease: EASE }}
      >
        <div className="rounded-[22px] bg-secondary/70 p-4 sm:p-5">
          <div className="rounded-[18px] border border-border-soft bg-card p-5 sm:p-6">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 [&_svg]:h-[15px] [&_svg]:w-[15px]" aria-label="Gmail or Outlook">
                <GmailLogo />
                <OutlookLogo />
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">{d.exampleRun.id}</span>
            </div>
            <div className="mt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
              Email draft · to {d.exampleRun.email.to}
            </div>
            <div className="mt-3 text-[16px] font-medium tracking-[-0.01em]">{d.exampleRun.email.subject}</div>
            <p className="mt-2 whitespace-pre-line text-[13.5px] leading-relaxed text-muted-foreground">{d.exampleRun.email.body}</p>
            <p className="mt-2 whitespace-pre-line text-[13.5px] text-muted-foreground">{d.exampleRun.email.signoff}</p>
            <div className="mt-5 flex items-center justify-between border-t border-border-soft pt-4">
              <span className="text-[12px] text-muted-foreground">{d.exampleRun.approvalQuestion}</span>
              <span className="flex gap-2">
                <span className="rounded-[10px] px-3.5 py-1.5 text-[12.5px] font-medium text-white" style={{ background: "var(--v3-accent)" }}>Approve</span>
                <span className="rounded-[10px] border border-border bg-card px-3.5 py-1.5 text-[12.5px]">Edit</span>
              </span>
            </div>
          </div>
        </div>
      </motion.div>
    </section>
  );
}
