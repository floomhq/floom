"use client";

/**
 * V3TemplateCard — THE worker card. The jewel is the name + the real output it
 * produces. Category lives in the filter pills (not repeated here). Name is a
 * heading; job is its subtitle; the artifact preview is the proof; tools +
 * cadence whisper at the bottom. Card is the link.
 */

import Link from "next/link";
import { motion } from "motion/react";
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
        className="group flex h-full flex-col overflow-hidden rounded-[16px] bg-card transition-colors hover:bg-secondary/50"
      >
        <div className="px-5 pb-4 pt-5">
          <h3 className="text-[16px] font-semibold leading-snug tracking-[-0.02em]">{t.name}</h3>
          <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-muted-foreground">{t.job}</p>
        </div>

        <V3OutputPreview
          sample={t.sample}
          className="mx-5 mb-4 transition-transform duration-200 group-hover:-translate-y-1"
        />

        <div className="mt-auto flex items-center justify-between gap-3 px-5 py-3">
          <span className="flex items-center gap-2">
            {marks.map(({ tool, mark }) => (
              <span
                key={tool}
                className="flex h-[14px] w-[14px] items-center justify-center opacity-60 [&_svg]:h-[14px] [&_svg]:w-[14px]"
              >
                {mark}
              </span>
            ))}
          </span>
          <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 font-mono text-[9.5px] text-muted-foreground">
            {t.runs}
          </span>
        </div>
      </Link>
    </motion.div>
  );
}
