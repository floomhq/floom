"use client";

/**
 * /v3/templates — designed templates browser on the v2 system.
 * Category pills + search + animated card grid; cards in the spec grammar
 * (flat, hairline, 16px radius, blue accent on hover + CTA).
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { ArrowLeft, ArrowRight, Search } from "lucide-react";
import { CATEGORIES, TEMPLATES, type Category, type Template } from "@/components/landing-ref/data";
import { StatusPill } from "@/components/landing-ref/StatusPill";
import { V2Composer } from "../../v2/V2Composer";
import { V2ToolChip } from "../../v2/V2Sections";
import "../theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function Card({ t, i }: { t: Template; i: number }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.4, delay: Math.min(i * 0.04, 0.3), ease: EASE }}
      className="group flex h-full flex-col rounded-[16px] bg-card p-5 transition-colors hover:bg-secondary/60"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold leading-tight">{t.name}</div>
          <div className="mt-1 text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{t.category}</div>
        </div>
        {t.approval === "Required" && <StatusPill tone="warning">Asks first</StatusPill>}
      </div>
      <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{t.job}</p>
      <div className="mt-3 rounded-[10px] bg-secondary/70 px-3 py-2 text-[12px] text-foreground/80">
        <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">Returns&nbsp;</span>
        {t.output}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {t.tools.slice(0, 4).map((tool) => (
          <V2ToolChip key={tool} tool={tool} />
        ))}
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-border-soft pt-3.5">
        <span className="font-mono text-[10.5px] text-muted-foreground">{t.runs}</span>
        <span className="flex items-center gap-1 text-[12.5px] font-medium" style={{ color: "var(--v2-accent)" }}>
          Hire this worker
          <ArrowRight className="h-3.5 w-3.5 transition-transform duration-200 group-hover:translate-x-0.5" />
        </span>
      </div>
    </motion.div>
  );
}

export function V3TemplatesBody() {
  const [cat, setCat] = useState<Category | "All">("All");
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    let list = TEMPLATES;
    if (cat !== "All") list = list.filter((t) => t.category === cat);
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(needle) ||
          t.job.toLowerCase().includes(needle) ||
          t.tools.some((tool) => tool.toLowerCase().includes(needle)),
      );
    }
    return list;
  }, [cat, q]);

  return (
    <div className="theme-v3 min-h-screen text-[13.5px]" style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}>
      <div className="mx-auto max-w-[1000px] px-7 pb-28">
        {/* slim nav */}
        <nav className="flex h-[60px] items-center justify-between">
          <Link href="/v3" className="flex items-center gap-1.5 text-[13px] text-muted-foreground hover:text-foreground">
            <ArrowLeft className="h-3.5 w-3.5" /> Back
          </Link>
          <Link href="/login" className="rounded-[10px] border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium hover:bg-secondary">Sign in</Link>
        </nav>

        {/* head */}
        <div className="pb-9 pt-14 text-center">
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: EASE }}
            className="text-[40px] font-semibold leading-[1.05] tracking-[-0.028em]"
          >
            Pick a worker. Hire it. Done.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.08, ease: EASE }}
            className="mx-auto mt-3 max-w-[460px] text-[14.5px] text-muted-foreground"
          >
            Each template connects to your tools and asks before anything ships.
          </motion.p>
        </div>

        {/* controls */}
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.16, ease: EASE }}
          className="mb-7 flex flex-wrap items-center gap-2"
        >
          <div className="flex flex-wrap gap-1.5">
            {(["All", ...CATEGORIES] as const).map((c) => (
              <button
                key={c}
                onClick={() => setCat(c as Category | "All")}
                className="rounded-full border px-3 py-1.5 text-[12.5px] font-medium transition-colors"
                style={
                  cat === c
                    ? { background: "var(--v2-accent)", borderColor: "var(--v2-accent)", color: "#fff" }
                    : { borderColor: "transparent", background: "var(--bg-2)", color: "var(--text-muted)" }
                }
              >
                {c}
              </button>
            ))}
          </div>
          <div className="ml-auto flex min-w-[200px] items-center gap-2 rounded-[10px] bg-secondary px-3 py-2">
            <Search className="h-3.5 w-3.5 text-muted-foreground" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search workers…"
              className="w-full bg-transparent text-[12.5px] placeholder:text-muted-foreground focus:outline-none"
            />
          </div>
        </motion.div>

        {/* grid */}
        <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((t, i) => (
            <Card key={t.slug} t={t} i={i} />
          ))}
        </div>
        {filtered.length === 0 && (
          <div className="py-16 text-center text-[13.5px] text-muted-foreground">
            Nothing matches. Describe it below and Workeros drafts it for you.
          </div>
        )}

        {/* custom CTA */}
        <div className="mt-20 text-center">
          <h2 className="text-[26px] font-semibold tracking-[-0.022em]">Don&apos;t see your job?</h2>
          <p className="mx-auto mt-2 max-w-[400px] text-[13.5px] text-muted-foreground">
            Describe it in one sentence. Workeros drafts the worker for review.
          </p>
          <div className="mt-6">
            <V2Composer slim placeholder="Describe the job…" />
          </div>
        </div>
      </div>
    </div>
  );
}
