"use client";

/**
 * V3TemplateCard — THE worker card. Sells the OUTPUT, not just the label.
 * Category + name + one-line job, a small artifact preview (by output type),
 * footer with real tool logos + cadence. Card is the link.
 */

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import type { Template } from "@/components/landing-ref/data";
import {
  GCalLogo,
  GmailLogo,
  HubSpotLogo,
  NotionLogo,
  SheetsLogo,
} from "@/components/landing-icons";
import { V3OutputPreview } from "./V3OutputPreview";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const MARKS: Record<string, React.ReactNode> = {
  gmail: <GmailLogo />,
  hubspot: <HubSpotLogo />,
  notion: <NotionLogo />,
  calendar: <GCalLogo />,
  "google calendar": <GCalLogo />,
  sheets: <SheetsLogo />,
  "google sheets": <SheetsLogo />,
};

export function V3TemplateCard({
  t,
  i = 0,
  href,
  animate = "mount",
}: {
  t: Template;
  i?: number;
  href?: string;
  /** "mount" animates on load (templates page), "view" on scroll into view (landing) */
  animate?: "mount" | "view";
}) {
  const anim =
    animate === "mount"
      ? { initial: { opacity: 0, y: 12 }, animate: { opacity: 1, y: 0 } }
      : { initial: { opacity: 0, y: 12 }, whileInView: { opacity: 1, y: 0 }, viewport: { once: true, amount: 0.3 } };

  const marks = t.tools
    .map((tool) => ({ tool, mark: MARKS[tool.toLowerCase()] }))
    .filter((m) => m.mark)
    .slice(0, 3);

  return (
    <motion.div {...anim} transition={{ duration: 0.4, delay: Math.min(i * 0.05, 0.3), ease: EASE }}>
      <Link
        href={href ?? `/templates/${t.slug}`}
        className="group flex h-full min-h-[262px] flex-col overflow-hidden rounded-[16px] border border-border-soft bg-card transition-colors hover:bg-secondary/40"
      >
        <div className="p-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
              {t.category}
            </div>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100" />
          </div>
          <h3 className="mt-2 line-clamp-1 text-[15px] font-medium leading-snug">{t.name}</h3>
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{t.job}</p>
        </div>

        <V3OutputPreview
          kind={t.preview}
          className="mx-5 mb-4 transition-transform duration-200 group-hover:-translate-y-0.5"
        />

        <div className="mt-auto flex items-center justify-between border-t border-border-soft px-5 py-3">
          <span className="flex items-center gap-2">
            {marks.map(({ tool, mark }) => (
              <span
                key={tool}
                className="flex h-[15px] w-[15px] items-center justify-center opacity-80 [&_svg]:h-[15px] [&_svg]:w-[15px]"
              >
                {mark}
              </span>
            ))}
          </span>
          <span className="font-mono text-[10.5px] text-muted-foreground">{t.runs}</span>
        </div>
      </Link>
    </motion.div>
  );
}
