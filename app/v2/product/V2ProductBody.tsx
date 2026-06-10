"use client";

/**
 * /v2/product — the cockpit page. The AppFrame moved here from the landing
 * (Federico: "on landing maybe too much, maybe on product"). Adds context
 * sections around it: what each surface is for, then the CTA.
 */

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowLeft } from "lucide-react";
import { AppFrame, RevealUp, SectionHead } from "../V2Sections";
import { V2Composer } from "../V2Composer";
import "../theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const SURFACES = [
  { t: "Workers", p: "The team roster. Status, last run, what needs you." },
  { t: "Runs", p: "Every execution on the record: trigger, tools, context, output." },
  { t: "Approvals", p: "The queue of things waiting for your yes." },
  { t: "Brain", p: "The files your company knows by heart. Auditable per run." },
  { t: "Connections", p: "Your tools, your tokens. Revoke at the source any time." },
  { t: "Assistant", p: "Ask anything about your workers, runs, or company data." },
];

export function V2ProductBody() {
  return (
    <div className="theme-v2 min-h-screen text-[13.5px]" style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}>
      <div className="mx-auto max-w-[1000px] px-7 pb-28">
        <nav className="flex h-[60px] items-center justify-between">
          <Link href="/v2" className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
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

        {/* surfaces */}
        <section className="pb-28">
          <SectionHead title="Every surface, one purpose." />
          <div className="mt-8 grid gap-x-10 gap-y-7 sm:grid-cols-2 lg:grid-cols-3">
            {SURFACES.map((s, i) => (
              <RevealUp key={s.t} delay={i * 0.04}>
                <div className="border-t border-border pt-4">
                  <div className="text-[14.5px] font-semibold">{s.t}</div>
                  <p className="mt-1 text-[12.5px] leading-relaxed text-muted-foreground">{s.p}</p>
                </div>
              </RevealUp>
            ))}
          </div>
        </section>

        <section className="text-center">
          <SectionHead title="See it with your own worker." />
          <RevealUp delay={0.08} className="mt-7">
            <V2Composer slim placeholder="Describe the job…" />
          </RevealUp>
        </section>
      </div>
    </div>
  );
}
