"use client";

import { motion, useReducedMotion, type Variants } from "motion/react";

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.04 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: { duration: 0.55, ease: EASE_OUT } },
};
const eyebrowLine: Variants = {
  hidden: { scaleX: 0, opacity: 0 },
  show: { scaleX: 1, opacity: 1, transition: { duration: 0.5, ease: EASE_OUT } },
};

/**
 * SectionHeader — motion-rich eyebrow + h2 + sub.
 *
 * Eyebrow lines (left + right) scale from 0 -> 1 with transform-origin matching
 * the inside edge so they appear to extend outward from the text. Eyebrow,
 * h2, and sub stagger in afterwards.
 */
export function SectionHeader({
  eyebrow,
  title,
  sub,
  center = false,
  tone = "light",
}: {
  eyebrow?: string;
  title: string;
  sub?: string;
  center?: boolean;
  tone?: "light" | "dark";
}) {
  const reduce = useReducedMotion() ?? false;
  const eyebrowColor = tone === "dark" ? "text-background/65" : "text-[#3a6ea5]";
  const lineColor = tone === "dark" ? "bg-background/30" : "bg-[#3a6ea5]/30";
  const titleColor = tone === "dark" ? "text-background" : "text-foreground";
  const subColor = tone === "dark" ? "text-background/65" : "text-muted-foreground";

  if (reduce) {
    return (
      <div className={center ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
        {eyebrow && (
          <div
            className={`mb-3 inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] ${eyebrowColor}`}
          >
            <span aria-hidden="true" className={`h-px w-6 ${lineColor}`} />
            {eyebrow}
            <span aria-hidden="true" className={`h-px w-6 ${lineColor}`} />
          </div>
        )}
        <h2
          className={`text-balance text-[32px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px] ${titleColor}`}
        >
          {title}
        </h2>
        {sub && <p className={`mt-3 text-base ${subColor}`}>{sub}</p>}
      </div>
    );
  }

  return (
    <motion.div
      initial="hidden"
      whileInView="show"
      viewport={{ once: true, amount: 0.35, margin: "0px 0px -8% 0px" }}
      variants={stagger}
      className={center ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}
    >
      {eyebrow && (
        <motion.div
          variants={item}
          className={`mb-3 inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] ${eyebrowColor}`}
        >
          <motion.span
            aria-hidden="true"
            variants={eyebrowLine}
            style={{ transformOrigin: "right" }}
            className={`h-px w-6 ${lineColor}`}
          />
          {eyebrow}
          <motion.span
            aria-hidden="true"
            variants={eyebrowLine}
            style={{ transformOrigin: "left" }}
            className={`h-px w-6 ${lineColor}`}
          />
        </motion.div>
      )}
      <motion.h2
        variants={item}
        className={`text-balance text-[32px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px] ${titleColor}`}
      >
        {title}
      </motion.h2>
      {sub && (
        <motion.p variants={item} className={`mt-3 text-base ${subColor}`}>
          {sub}
        </motion.p>
      )}
    </motion.div>
  );
}
