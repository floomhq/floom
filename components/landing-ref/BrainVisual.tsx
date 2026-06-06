"use client";

import type { ComponentType } from "react";
import {
  Brain,
  Check,
  FileCode,
  FileImage,
  FileSpreadsheet,
  FileText,
  Link2,
  type LucideProps,
} from "lucide-react";
import { motion, useReducedMotion, type Variants } from "motion/react";
import { StatusPill } from "./StatusPill";

type FileType = "pdf" | "doc" | "md" | "xlsx" | "url" | "png";

const FILE_META: Record<
  FileType,
  { ext: string; Icon: ComponentType<LucideProps>; tint: string }
> = {
  pdf: { ext: "PDF", Icon: FileText, tint: "#D14343" },
  doc: { ext: "DOC", Icon: FileText, tint: "#2563eb" },
  md: { ext: "MD", Icon: FileCode, tint: "#181818" },
  xlsx: { ext: "XLSX", Icon: FileSpreadsheet, tint: "#0F9D58" },
  url: { ext: "URL", Icon: Link2, tint: "#3a6ea5" },
  png: { ext: "PNG", Icon: FileImage, tint: "#9d6df1" },
};

const CONTEXTS: Array<{ name: string; type: FileType }> = [
  { name: "Brand voice", type: "doc" },
  { name: "Pricing tiers", type: "xlsx" },
  { name: "ICP brief", type: "pdf" },
  { name: "Past outreach", type: "md" },
  { name: "CRM rules", type: "md" },
  { name: "Style guide", type: "url" },
  { name: "Q3 metrics", type: "xlsx" },
  { name: "Approval policy", type: "pdf" },
  { name: "Logos", type: "png" },
];

const KNOWS = [
  "Knows what good looks like",
  "Knows your tone",
  "Knows what needs approval",
  "Knows where to pull data",
];

const WORKERS = [
  "Client Follow-up Worker",
  "Monday Report Worker",
  "Lead Research Worker",
  "Founder Update Worker",
];

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.05, delayChildren: 0.06 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 8 },
  show: { opacity: 1, y: 0, transition: { duration: 0.4, ease: EASE_OUT } },
};

function FileCard({
  name,
  type,
  index,
  reduce,
}: {
  name: string;
  type: FileType;
  index: number;
  reduce: boolean;
}) {
  const meta = FILE_META[type];
  const Icon = meta.Icon;
  return (
    <motion.div variants={item}>
      <motion.div
        whileHover={reduce ? undefined : { y: -1 }}
        animate={reduce ? undefined : { y: [0, -1.5, 0] }}
        transition={
          reduce
            ? undefined
            : {
                y: {
                  duration: 3 + (index % 3) * 0.7,
                  repeat: Infinity,
                  ease: "easeInOut",
                  delay: index * 0.18,
                },
              }
        }
        className="inline-flex h-7 items-center gap-1.5 rounded-[9px] border border-border bg-card px-1.5 pr-2 text-[12px] text-foreground/85 shadow-[0_1px_0_rgba(20,20,20,0.04)] transition-colors hover:border-foreground/20"
      >
        <span
          aria-hidden="true"
          className="inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-[5px]"
          style={{
            background: `color-mix(in srgb, ${meta.tint} 12%, transparent)`,
            color: meta.tint,
          }}
        >
          <Icon className="h-3 w-3" strokeWidth={2} />
        </span>
        <span className="truncate font-medium">{name}</span>
        <span
          aria-hidden="true"
          className="ml-0.5 font-mono text-[8.5px] font-semibold uppercase tracking-wider"
          style={{ color: meta.tint }}
        >
          {meta.ext}
        </span>
      </motion.div>
    </motion.div>
  );
}

/** Subtle warm connector — horizontal on desktop, vertical on mobile. */
function Connector() {
  return (
    <span
      aria-hidden="true"
      className="mx-auto my-1 h-6 w-px shrink-0 bg-gradient-to-b from-transparent via-border to-transparent lg:my-0 lg:h-px lg:w-10 lg:bg-gradient-to-r"
    />
  );
}

export function BrainVisual() {
  const reduce = useReducedMotion() ?? false;
  return (
    <div className="flex flex-col items-stretch gap-1 lg:flex-row lg:items-center lg:gap-1">
      {/* Contexts — uploaded files, each with a visible type */}
      <motion.div
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.2, margin: "0px 0px -10% 0px" }}
        variants={stagger}
        className="flex-1 rounded-[18px] border border-border/60 bg-secondary/40 p-4"
      >
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[10.5px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
            Contexts
          </div>
          <motion.div variants={item} className="text-[10.5px] text-muted-foreground/85">
            9 files
          </motion.div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {CONTEXTS.map((c, i) => (
            <FileCard key={c.name} name={c.name} type={c.type} index={i} reduce={reduce} />
          ))}
        </div>
      </motion.div>

      <Connector />

      {/* Company Brain — focal card with the literal brain illustration behind */}
      <div className="relative shrink-0 lg:w-[260px]">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 z-0 size-[300px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#3a6ea5]/[0.10] blur-3xl lg:size-[380px]"
        />
        <motion.div
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 top-1/2 z-0 -translate-x-1/2 -translate-y-1/2"
          animate={reduce ? undefined : { scale: [1, 1.04, 1], opacity: [0.85, 1, 0.85] }}
          transition={{ duration: 4.5, repeat: Infinity, ease: "easeInOut" }}
        >
          <Brain strokeWidth={1.2} className="size-[380px] text-[#3a6ea5]/25 lg:size-[460px]" />
        </motion.div>
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.3, margin: "0px 0px -10% 0px" }}
          variants={stagger}
          className="relative z-10 rounded-[18px] border border-border bg-card p-5 shadow-md"
        >
          <motion.div variants={item} className="mb-3 flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-[14px] font-semibold text-foreground">
              <Brain className="h-4 w-4 text-[#3a6ea5]" strokeWidth={2} />
              Company Brain
            </div>
            <StatusPill tone="success">Live</StatusPill>
          </motion.div>
          <ul className="space-y-2">
            {KNOWS.map((k) => (
              <motion.li
                key={k}
                variants={item}
                className="flex items-center gap-2 rounded-[9px] border border-border bg-secondary/50 px-2.5 py-1.5 text-[12.5px]"
              >
                <Check className="h-3.5 w-3.5 shrink-0 text-[#3a6ea5]" strokeWidth={2.5} />
                <span className="text-foreground">{k}</span>
              </motion.li>
            ))}
          </ul>
        </motion.div>
      </div>

      <Connector />

      {/* Used by workers */}
      <motion.div
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.2, margin: "0px 0px -10% 0px" }}
        variants={stagger}
        className="flex-1 rounded-[18px] border border-border/60 bg-secondary/40 p-4"
      >
        <div className="mb-3 text-[10.5px] font-medium uppercase tracking-[0.18em] text-muted-foreground">
          Used by workers
        </div>
        <div className="space-y-1.5">
          {WORKERS.map((w) => (
            <motion.div
              key={w}
              variants={item}
              className="flex items-center gap-2 rounded-[10px] border border-border bg-card px-3 py-2 text-[12.5px]"
            >
              <span className="grid h-5 w-5 shrink-0 place-items-center rounded bg-primary text-[10px] font-bold text-primary-foreground">
                F
              </span>
              <span className="truncate font-medium text-foreground">{w}</span>
            </motion.div>
          ))}
          <motion.div variants={item} className="px-3 pt-1 text-[11.5px] text-muted-foreground">
            + every other worker
          </motion.div>
        </div>
      </motion.div>
    </div>
  );
}
