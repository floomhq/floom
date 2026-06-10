"use client";

/**
 * V3TemplateCard — THE template card, shared by the landing's template
 * section and /v3/templates. One design: name + hover arrow, one-line job,
 * three bare tool marks, mono runs. Card is the link.
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
  SlackLogo,
} from "@/components/landing-icons";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

const MARKS: Record<string, React.ReactNode> = {
  gmail: <GmailLogo />,
  slack: <SlackLogo />,
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

  return (
    <motion.div {...anim} transition={{ duration: 0.4, delay: Math.min(i * 0.05, 0.3), ease: EASE }}>
      <Link
        href={href ?? `/v3/templates/${t.slug}`}
        className="group flex h-full flex-col rounded-[16px] bg-card p-6 transition-colors hover:bg-secondary/70"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="truncate text-[15px] font-medium leading-tight">{t.name}</div>
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100" />
        </div>
        <p className="mt-2 flex-1 text-[13px] leading-relaxed text-muted-foreground">{t.job}</p>
        <div className="mt-5 flex items-center justify-between">
          <span className="flex items-center gap-2">
            {t.tools.slice(0, 3).map((tool) => {
              const mark = MARKS[tool.toLowerCase()];
              return mark ? (
                <span key={tool} className="flex h-[15px] w-[15px] items-center justify-center opacity-80 [&_svg]:h-[15px] [&_svg]:w-[15px]">
                  {mark}
                </span>
              ) : null;
            })}
          </span>
          <span className="font-mono text-[10.5px] text-muted-foreground">{t.runs}</span>
        </div>
      </Link>
    </motion.div>
  );
}
