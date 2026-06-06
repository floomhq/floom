"use client";

import { motion, useReducedMotion, type Variants } from "motion/react";
import { ToolLogoChip } from "./logos";

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const chipStagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.04, delayChildren: 0.05 } },
};
const chipItem: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0, transition: { duration: 0.32, ease: EASE_OUT } },
};

export function CapabilityRow({
  label,
  items,
  kind,
}: {
  label: string;
  items: string[];
  kind: "tools" | "pills";
}) {
  const reduce = useReducedMotion() ?? false;
  if (reduce) {
    return (
      <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-6">
        <div className="w-32 shrink-0 text-[12.5px] font-semibold text-foreground">{label}</div>
        <div className="flex flex-wrap gap-1.5">
          {kind === "tools"
            ? items.map((t) => <ToolLogoChip key={t} tool={t} size="sm" surface="app" />)
            : items.map((t) => (
                <span
                  key={t}
                  className="inline-flex h-7 items-center rounded-[9px] border border-border bg-background px-2 text-[11.5px] font-medium text-foreground/85"
                >
                  {t}
                </span>
              ))}
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-6">
      <div className="w-32 shrink-0 text-[12.5px] font-semibold text-foreground">{label}</div>
      <motion.div
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.3, margin: "0px 0px -8% 0px" }}
        variants={chipStagger}
        className="flex flex-wrap gap-1.5"
      >
        {items.map((t) =>
          kind === "tools" ? (
            <motion.div
              key={t}
              variants={chipItem}
              whileHover={{ y: -1 }}
              transition={{ type: "spring", stiffness: 320, damping: 22 }}
            >
              <ToolLogoChip tool={t} size="sm" surface="app" />
            </motion.div>
          ) : (
            <motion.span
              key={t}
              variants={chipItem}
              whileHover={{ y: -1 }}
              transition={{ type: "spring", stiffness: 320, damping: 22 }}
              className="inline-flex h-7 items-center rounded-[9px] border border-border bg-background px-2 text-[11.5px] font-medium text-foreground/85"
            >
              {t}
            </motion.span>
          ),
        )}
      </motion.div>
    </div>
  );
}
