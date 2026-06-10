"use client";

/**
 * /v3/templates — designed templates browser on the v2 system.
 * Category pills + search + animated card grid; cards in the spec grammar
 * (flat, hairline, 16px radius, blue accent on hover + CTA).
 */

import { useMemo, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Search } from "lucide-react";
import { TEMPLATES, type Category, type Template } from "@/components/landing-ref/data";
import { V3Composer } from "../V3Composer";
import { V3TemplateCard } from "../V3TemplateCard";
import { Hl, V3Shell } from "../V3Shell";
import "../theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

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
    <V3Shell active="templates">


        {/* head */}
        <div className="pb-9 pt-14 text-center">
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: EASE }}
            className="text-[40px] font-semibold leading-[1.05] tracking-[-0.028em]"
          >
            Pick a <Hl>worker</Hl>. Hire it. Done.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.08, ease: EASE }}
            className="mx-auto mt-3 max-w-[460px] text-[14.5px] text-muted-foreground"
          >
            Every worker connects to your tools and asks before anything ships.
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
            {(["All", "Sales", "Ops", "Founder"] as const).map((c) => (
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
            <V3TemplateCard key={t.slug} t={t} i={i} href="/login" animate="mount" />
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
            <V3Composer placeholder="Describe the job…" />
          </div>
        </div>
    </V3Shell>
  );
}
