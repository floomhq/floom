"use client";

/**
 * /v3/workspaces/[slug] — a workspace is a bundle of workers for a whole role.
 * Same grammar as the worker detail page. The jewel here is "the team": the
 * member workers shown as the shared card, each linking to its own proof page.
 */

import Link from "next/link";
import { motion } from "motion/react";
import { ArrowLeft, ArrowRight } from "lucide-react";
import {
  WORKSPACES,
  getWorkspaceWorkers,
  getWorkspaceTools,
  getWorkspaceOutcome,
  type Workspace,
} from "@/components/landing-ref/data";
import { V3Shell } from "../../V3Shell";
import { V3TemplateCard } from "../../V3TemplateCard";
import { V3WorkspaceCard } from "../../V3WorkspaceCard";
import { V3Reviews } from "../../V3Reviews";
import "../../theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

export function V3WorkspaceDetailBody({ w }: { w: Workspace }) {
  const workers = getWorkspaceWorkers(w);
  const tools = getWorkspaceTools(w);
  const others = WORKSPACES.filter((x) => x.slug !== w.slug).slice(0, 3);

  return (
    <V3Shell active="templates">
      <Link
        href="/templates"
        className="mt-2 inline-flex items-center gap-1.5 text-[13px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-3.5 w-3.5" /> All templates
      </Link>

      {/* head */}
      <div className="pb-16 pt-10">
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: EASE }}
          className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground"
        >
          Workspace
          <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/50" />
          {w.category}
          <span className="h-0.5 w-0.5 rounded-full bg-muted-foreground/50" />
          {workers.length} workers
        </motion.div>
        <motion.h1
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.05, ease: EASE }}
          className="mt-3 text-[34px] font-semibold leading-[1.05] tracking-[-0.028em] sm:text-[44px]"
        >
          {w.name}
        </motion.h1>
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.1, ease: EASE }}
          className="mt-3 max-w-[520px] text-[15px] leading-relaxed text-muted-foreground"
        >
          {w.pitch}
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, delay: 0.16, ease: EASE }}
          className="mt-6"
        >
          <Link
            href={`/login?workspace=${w.slug}`}
            className="inline-flex h-9 items-center whitespace-nowrap rounded-[10px] px-4 text-[13.5px] font-medium text-white"
            style={{ background: "var(--v3-accent)" }}
          >
            Hire this workspace
          </Link>
        </motion.div>
      </div>

      {/* how it runs together — orchestration */}
      <div className="pb-20">
        <h2 className="text-[22px] font-semibold tracking-[-0.018em]">How it runs together</h2>
        <p className="mt-2 max-w-[560px] text-[14px] leading-relaxed text-foreground/75">
          {getWorkspaceOutcome(w)}
        </p>
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <span className="rounded-[10px] bg-secondary px-3 py-2 text-[12.5px] font-medium text-foreground/80">
            {workers[0]?.triggers[0] ?? "Trigger"}
          </span>
          {workers.map((t) => (
            <span key={t.slug} className="flex items-center gap-2">
              <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
              <Link
                href={`/templates/${t.slug}`}
                className="rounded-[10px] bg-secondary px-3 py-2 text-[12.5px] text-foreground/80 transition-colors hover:bg-secondary/70"
              >
                {t.name}
              </Link>
            </span>
          ))}
          <ArrowRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" />
          <span
            className="rounded-[10px] px-3 py-2 text-[12.5px] font-medium"
            style={{ background: "var(--v3-sel)", color: "var(--v3-accent)" }}
          >
            Reviewed output
          </span>
        </div>
      </div>

      {/* the team: member workers */}
      <div className="pb-20">
        <motion.h2
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.45, ease: EASE }}
          className="text-[22px] font-semibold tracking-[-0.018em]"
        >
          The team
        </motion.h2>
        <p className="mt-2 text-[13.5px] text-muted-foreground">
          {workers.length} workers, hired together. Each one asks before anything ships.
        </p>
        <div className="mt-6 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {workers.map((t, i) => (
            <V3TemplateCard key={t.slug} t={t} i={i} animate="view" />
          ))}
        </div>
      </div>

      {/* tools it connects to */}
      <div className="pb-20">
        <h2 className="text-[22px] font-semibold tracking-[-0.018em]">Tools it connects to</h2>
        <div className="mt-4 flex flex-wrap gap-1.5">
          {tools.map((tool) => (
            <span key={tool} className="rounded-full bg-secondary px-3 py-1.5 text-[12px] text-foreground/75">
              {tool}
            </span>
          ))}
        </div>
      </div>

      {/* reviews */}
      <V3Reviews itemKind="workspace" itemSlug={w.slug} />

      {/* never dead-end: other workspaces */}
      <div className="pb-6">
        <motion.h2
          initial={{ opacity: 0, y: 10 }}
          whileInView={{ opacity: 1, y: 0 }}
          viewport={{ once: true }}
          transition={{ duration: 0.45, ease: EASE }}
          className="text-[22px] font-semibold tracking-[-0.018em]"
        >
          More workspaces
        </motion.h2>
        <div className="mt-6 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {others.map((o, i) => (
            <V3WorkspaceCard key={o.slug} w={o} i={i} />
          ))}
        </div>
      </div>
    </V3Shell>
  );
}
