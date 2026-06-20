"use client";

/**
 * V3WorkspaceCard — a bundle of workers for a whole role. Where a worker card
 * shows one artifact, a workspace shows its COMPOSITION: a short stack of the
 * workers inside. No avatars, no fake team portraits. Card is the link.
 */

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowRight } from "lucide-react";
import {
  getWorkspaceWorkers,
  type Workspace,
} from "@/components/landing-ref/data";
import {
  GCalLogo,
  GmailLogo,
  HubSpotLogo,
  NotionLogo,
  SheetsLogo,
} from "@/components/landing-icons";

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

export function V3WorkspaceCard({ w, i = 0 }: { w: Workspace; i?: number }) {
  const workers = getWorkspaceWorkers(w);

  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: Math.min(i * 0.05, 0.3), ease: EASE }}
    >
      <Link
        href={`/workspaces/${w.slug}`}
        className="group flex h-full min-h-[300px] flex-col overflow-hidden rounded-[16px] border border-border-soft bg-card transition-colors hover:bg-secondary/40"
      >
        <div className="p-5 pb-4">
          <div className="flex items-start justify-between gap-3">
            <div className="text-[10.5px] font-medium uppercase tracking-[0.07em] text-muted-foreground">
              {w.category} · Workspace
            </div>
            <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground opacity-0 transition-all duration-200 group-hover:translate-x-0.5 group-hover:opacity-100" />
          </div>
          <h3 className="mt-2 text-[15px] font-medium leading-snug">{w.name}</h3>
          <p className="mt-1.5 line-clamp-2 text-[13px] leading-relaxed text-muted-foreground">{w.pitch}</p>
        </div>

        {/* the stack: workers inside */}
        <div className="mx-5 mb-4 space-y-1.5">
          {workers.map((t) => {
            const marks = t.tools
              .map((tool) => ({ tool, mark: MARKS[tool.toLowerCase()] }))
              .filter((m) => m.mark)
              .slice(0, 2);
            return (
              <div
                key={t.slug}
                className="flex items-center justify-between gap-3 rounded-[10px] bg-secondary/55 px-3 py-2"
              >
                <span className="truncate text-[12.5px] text-foreground/80">{t.name}</span>
                <span className="flex shrink-0 items-center gap-1.5">
                  {marks.map(({ tool, mark }) => (
                    <span
                      key={tool}
                      className="flex h-[13px] w-[13px] items-center justify-center opacity-75 [&_svg]:h-[13px] [&_svg]:w-[13px]"
                    >
                      {mark}
                    </span>
                  ))}
                </span>
              </div>
            );
          })}
        </div>

        <div className="mt-auto flex items-center justify-between border-t border-border-soft px-5 py-3">
          <span className="font-mono text-[10.5px] text-muted-foreground">{workers.length} workers</span>
          <span className="text-[12px] font-medium" style={{ color: "var(--v3-accent)" }}>
            View workspace
          </span>
        </div>
      </Link>
    </motion.div>
  );
}
