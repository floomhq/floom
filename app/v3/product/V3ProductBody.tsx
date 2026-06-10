"use client";

/**
 * /v2/product — the cockpit page. The AppFrame moved here from the landing
 * (Federico: "on landing maybe too much, maybe on product"). Adds context
 * sections around it: what each surface is for, then the CTA.
 */

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowLeft } from "lucide-react";
import { AppFrame, RevealUp, SectionHead } from "../../v2/V2Sections";
import "../theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const SURFACES = [
  { t: "Runs", p: "Every execution on the record: trigger, tools, context, output." },
  { t: "Approvals", p: "The queue of things waiting for your yes." },
  { t: "Brain", p: "The files your company knows by heart. Auditable per run." },
];

export function V3ProductBody() {
  return (
    <div className="theme-v3 min-h-screen text-[13.5px]" style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}>
      <div className="mx-auto max-w-[1000px] px-7 pb-28">
        <nav className="flex h-[60px] items-center justify-between">
          <Link href="/v3" className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </Link>
          <Link href="/login" className="rounded-[10px] border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium hover:bg-secondary">Sign in</Link>
        </nav>

        <div className="pb-10 pt-14 text-center">
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: EASE }}
            className="text-[44px] font-semibold leading-[1.04] tracking-[-0.03em]"
          >
            The cockpit behind every worker.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.08, ease: EASE }}
            className="mx-auto mt-3 max-w-[480px] text-[14.5px] text-muted-foreground"
          >
            Most days the worker reports in Slack and you never open this. When you do, everything is on the record.
          </motion.p>
        </div>

        <AppFrame standalone />

        {/* three captions, attached to the frame */}
        <section className="-mt-12 pb-28">
          <div className="grid gap-x-10 gap-y-6 sm:grid-cols-3">
            {SURFACES.map((s, i) => (
              <RevealUp key={s.t} delay={i * 0.04}>
                <div className="border-t border-border pt-4">
                  <div className="text-[14px] font-medium">{s.t}</div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{s.p}</p>
                </div>
              </RevealUp>
            ))}
          </div>
        </section>

        <section className="pb-8 text-center">
          <RevealUp>
            <Link
              href="/login"
              className="inline-flex items-center rounded-[12px] px-6 py-3 text-[14.5px] font-medium text-white"
              style={{ background: "var(--v2-accent)" }}
            >
              See it with your own worker
            </Link>
          </RevealUp>
        </section>
      </div>
    </div>
  );
}
