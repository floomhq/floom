"use client";

/**
 * /v3/templates/[slug] — template detail in the v3 voice. Name + summary,
 * what it does + brain, the example run as an artifact (the email itself,
 * approval row, run id), one blue Hire button.
 */

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowLeft } from "lucide-react";
import type { Template, TemplateDetail } from "@/components/landing-ref/data";
import { V3Shell } from "../../V3Shell";
import "../../theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export function V3TemplateDetailBody({ t, d }: { t: Template; d: TemplateDetail }) {
  return (
    <V3Shell active="templates">
      <div className="pb-24">
        <Link href="/v3/templates" className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
          <ArrowLeft className="h-3.5 w-3.5" /> All templates
        </Link>

        {/* head */}
        <div className="pb-12 pt-10">
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, ease: EASE }}
            className="text-[34px] font-semibold leading-[1.06] tracking-[-0.028em] sm:text-[44px]"
          >
            {t.name}
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.07, ease: EASE }}
            className="mt-3 max-w-[520px] text-[15px] leading-relaxed text-muted-foreground"
          >
            {d.summary}
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.14, ease: EASE }}
            className="mt-7"
          >
            <Link
              href="/login"
              className="inline-flex items-center rounded-[12px] px-5 py-2.5 text-[14px] font-medium text-white"
              style={{ background: "var(--v3-accent)" }}
            >
              Hire this worker
            </Link>
          </motion.div>
        </div>

        {/* body: what it does | example run artifact */}
        <div className="grid gap-12 md:grid-cols-[1fr_1.1fr] md:gap-16">
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.5, ease: EASE }}
          >
            <h2 className="text-[19px] font-semibold tracking-[-0.015em]">What it does</h2>
            <p className="mt-2.5 text-[14px] leading-relaxed text-muted-foreground">{d.whatItDoes}</p>

            <h2 className="mt-9 text-[19px] font-semibold tracking-[-0.015em]">Company brain it uses</h2>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {d.brainUsed.map((b) => (
                <span key={b} className="rounded-full bg-secondary px-3 py-1.5 text-[12px] text-foreground/75">{b}</span>
              ))}
            </div>

            <div className="mt-9 space-y-0">
              {[
                ["Returns", t.output],
                ["Approval", t.approvalNote],
                ["Used by", `${t.runs} this month`],
              ].map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-6 border-b border-border-soft py-3 text-[13.5px] last:border-0">
                  <span className="text-muted-foreground">{k}</span>
                  <span className="text-right text-foreground/85">{v}</span>
                </div>
              ))}
            </div>
          </motion.div>

          {/* example run artifact */}
          <motion.div
            initial={{ opacity: 0, y: 14 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.2 }}
            transition={{ duration: 0.5, delay: 0.08, ease: EASE }}
          >
            <div className="rounded-[22px] bg-secondary/70 p-6 sm:p-8">
              <div className="rounded-[18px] bg-card p-6">
                <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                  <span>Email draft · to {d.exampleRun.email.to}</span>
                  <span className="font-mono normal-case tracking-normal">{d.exampleRun.id}</span>
                </div>
                <div className="mt-3 text-[16px] font-medium tracking-[-0.01em]">{d.exampleRun.email.subject}</div>
                <p className="mt-2 whitespace-pre-line text-[13.5px] leading-relaxed text-muted-foreground">{d.exampleRun.email.body}</p>
                <p className="mt-2 text-[13.5px] text-muted-foreground">{d.exampleRun.email.signoff}</p>
                <div className="mt-5 flex items-center justify-between border-t border-border-soft pt-4">
                  <span className="text-[12px] text-muted-foreground">{d.exampleRun.approvalQuestion}</span>
                  <span className="flex gap-2">
                    <span className="rounded-[10px] px-3.5 py-1.5 text-[12.5px] font-medium text-white" style={{ background: "var(--v3-accent)" }}>Approve</span>
                    <span className="rounded-[10px] border border-border bg-card px-3.5 py-1.5 text-[12.5px]">Edit</span>
                  </span>
                </div>
              </div>
              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-1 px-1 text-[11.5px] text-muted-foreground">
                <span>Trigger: {d.exampleRun.trigger}</span>
                <span>Tools: {d.exampleRun.toolsUsed.join(" · ")}</span>
              </div>
            </div>
          </motion.div>
        </div>
      </div>
    </V3Shell>
  );
}
