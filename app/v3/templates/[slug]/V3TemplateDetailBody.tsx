"use client";

/**
 * /v3/templates/[slug] — redesigned. The example run is the jewel (top right,
 * inside the soft panel). Left: name, summary, meta marks, Hire. Below: the
 * run receipt + what-it-does/brain. Bottom: three other workers (shared card)
 * so the page never dead-ends.
 */

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowLeft, Check } from "lucide-react";
import type { Template, TemplateDetail } from "@/components/landing-ref/data";
import { TEMPLATES } from "@/components/landing-ref/data";
import { V3Shell } from "../../V3Shell";
import { V3TemplateCard, MARKS, toolLabel } from "../../V3TemplateCard";
import { V3OutputPreview } from "../../V3OutputPreview";
import { V3Reviews } from "../../V3Reviews";
import "../../theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export function V3TemplateDetailBody({ t, d }: { t: Template; d: TemplateDetail }) {
  const others = TEMPLATES.filter((x) => x.slug !== t.slug).slice(0, 3);

  return (
    <V3Shell active="templates">
      <Link href="/templates" className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> All templates
      </Link>

      {/* head: text left, the jewel right */}
      <div className="grid items-center gap-10 pb-24 pt-10 md:grid-cols-[1fr_1.15fr] md:gap-14">
        <div>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
          >
            {t.category}
            <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/50" />
            Asks before anything ships
          </motion.div>
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.05, ease: EASE }}
            className="mt-3 text-[34px] font-semibold leading-[1.05] tracking-[-0.028em] sm:text-[44px]"
          >
            {t.name}
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.1, ease: EASE }}
            className="mt-3 max-w-[440px] text-[15px] leading-relaxed text-muted-foreground"
          >
            {d.summary}
          </motion.p>
          {/* LND-1: button + tool logos + trigger text on one clean row.
              Compact nowrap button, inline logos, inline trigger. */}
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, delay: 0.16, ease: EASE }}
            className="mt-6 flex flex-nowrap items-center gap-3"
          >
            <Link
              href={`/templates/hire?worker=${t.slug}`}
              className="inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-[10px] px-4 text-[13.5px] font-medium text-white"
              style={{ background: "var(--v3-accent)" }}
            >
              Hire this worker
            </Link>
            <span className="flex shrink-0 items-center gap-2">
              {t.tools.slice(0, 4).map((tool) => {
                const mark = MARKS[tool.toLowerCase()];
                return mark ? (
                  <span key={tool} className="flex h-[16px] w-[16px] items-center justify-center opacity-80 [&_svg]:h-[16px] [&_svg]:w-[16px]">{mark}</span>
                ) : null;
              })}
            </span>
            <span className="truncate font-mono text-[11px] text-muted-foreground">{t.runs}</span>
          </motion.div>
        </div>

        {/* the jewel: example output */}
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.12, ease: EASE }}
        >
          <div className="rounded-[22px] bg-secondary/60 p-4 sm:p-5">
            <div className="rounded-[18px] bg-card p-5 sm:p-6">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-2 [&_svg]:h-[16px] [&_svg]:w-[16px]">
                  {t.tools.slice(0, 4).map((tool) => {
                    const mark = MARKS[tool.toLowerCase()];
                    return mark ? (
                      <span key={tool} className="opacity-80">{mark}</span>
                    ) : (
                      <span key={tool} className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                        {toolLabel(tool)}
                      </span>
                    );
                  })}
                </span>
                <span className="font-mono text-[11px] text-muted-foreground">{d.exampleRun.id}</span>
              </div>
              <div className="mt-3 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
                {t.output}
              </div>
              <V3OutputPreview sample={t.sample} size="lg" bare className="mt-3" />
              <div className="mt-6 flex items-center justify-between pt-1">
                <span className="text-[12.5px] text-muted-foreground">{d.exampleRun.approvalQuestion}</span>
                <span className="flex gap-2">
                  <span className="rounded-[10px] px-3.5 py-1.5 text-[12.5px] font-medium text-white" style={{ background: "var(--v3-accent)" }}>Approve</span>
                  <span className="rounded-[10px] bg-secondary px-3.5 py-1.5 text-[12.5px] text-foreground/80">Edit</span>
                </span>
              </div>
            </div>
          </div>
        </motion.div>
      </div>

      {/* how it runs: receipt left, what-it-does + brain right */}
      <div className="grid gap-12 pb-24 md:grid-cols-2 md:gap-16">
        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: 0.5, ease: EASE }}
        >
          <h2 className="text-[22px] font-semibold tracking-[-0.018em]">How a run looks</h2>
          <div className="mt-5">
            {[
              ["Trigger", d.exampleRun.trigger, true],
              ["Tools", d.exampleRun.toolsUsed.join(" · "), true],
              ["Brain", d.exampleRun.brainUsed.join(" · "), true],
              ["Output", d.exampleRun.output, true],
              ["Approval", t.approvalNote, false],
            ].map(([k, v, ok], i) => (
              <motion.div
                key={k as string}
                initial={{ opacity: 0 }}
                whileInView={{ opacity: 1 }}
                viewport={{ once: true }}
                transition={{ delay: 0.1 + i * 0.07, duration: 0.35 }}
                className="flex items-start gap-4 border-b border-border-soft py-3 text-[13.5px] last:border-0"
              >
                <span className="w-[72px] shrink-0 pt-px text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">{k}</span>
                <span className="flex-1 text-foreground/85">{v}</span>
                {ok ? (
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
                ) : (
                  <span className="mt-0.5 shrink-0 rounded-full px-2.5 py-0.5 text-[10.5px] font-medium" style={{ background: "var(--v3-sel)", color: "var(--v3-accent)" }}>
                    you decide
                  </span>
                )}
              </motion.div>
            ))}
          </div>
        </motion.div>

        <motion.div
          initial={{ opacity: 0, y: 14 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true, amount: 0.25 }}
          transition={{ duration: 0.5, delay: 0.08, ease: EASE }}
        >
          <h2 className="text-[22px] font-semibold tracking-[-0.018em]">What it does</h2>
          <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">{d.whatItDoes}</p>
          <h3 className="mt-8 text-[13px] font-semibold">Company brain it uses</h3>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {d.brainUsed.map((b) => (
              <span key={b} className="rounded-full bg-secondary px-3 py-1.5 text-[12px] text-foreground/75">{b}</span>
            ))}
          </div>
        </motion.div>
      </div>

      {/* reviews */}
      <V3Reviews itemKind="worker" itemSlug={t.slug} />

      {/* never dead-end: three other workers */}
      <div className="pb-6">
        <motion.h2
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.45, ease: EASE }}
          className="text-[22px] font-semibold tracking-[-0.018em]"
        >
          More workers
        </motion.h2>
        <div className="mt-6 grid gap-3.5 md:grid-cols-3">
          {others.map((o, i) => (
            <V3TemplateCard key={o.slug} t={o} i={i} animate="view" />
          ))}
        </div>
      </div>
    </V3Shell>
  );
}
