"use client";

import { useRef, useState } from "react";
import {
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
} from "motion/react";
import { Check, Edit3, Send } from "lucide-react";
import { ToolLogo, ToolLogoChip } from "./logos";

/**
 * ScrollEmailArtifact — story-driven version.
 *
 * Implementation: each line of the body has its own scroll-driven opacity
 * transform (no React state, no per-char DOM updates). Status pill + send
 * button cross-fade at scroll progress ~90% to "Sent". All motion is GPU
 * compositor work (opacity, transform), no layout thrash.
 */
export function ScrollEmailArtifact({
  title,
  byline,
  sources,
  subject,
  body,
  signoff,
  footerNote,
}: {
  title: string;
  byline?: string;
  sources?: string[];
  subject: string;
  body: string;
  signoff?: string;
  footerNote?: string;
}) {
  const reduce = useReducedMotion();
  const ref = useRef<HTMLDivElement | null>(null);

  // Scroll progress through the card.
  const { scrollYProgress } = useScroll({
    target: ref,
    offset: ["start 85%", "end 25%"],
  });
  // Tighter spring → tracks scroll responsively, no lag stutter.
  const smooth = useSpring(scrollYProgress, { stiffness: 220, damping: 32, mass: 0.5 });

  // Split body into lines for sequential reveal. Empty lines stay as
  // paragraph breaks but don't animate (no flicker on blanks).
  const lines = body.split("\n");
  const allLines = signoff ? [...lines, "", ...signoff.split("\n")] : lines;
  const visibleCount = allLines.filter((l) => l.trim().length > 0).length;

  // Lines reveal between scroll 0.10 and 0.72.
  const revealStart = 0.10;
  const revealEnd = 0.72;
  const perLine = (revealEnd - revealStart) / Math.max(1, visibleCount);

  // Status: ≥ 0.88 → sent. (No "sending" intermediate; cleaner.)
  const [sent, setSent] = useState(false);
  useMotionValueEvent(smooth, "change", (v) => {
    if (reduce) return;
    setSent(v >= 0.88);
  });

  // Header / sources / subject fade in early.
  const headerOpacity = useTransform(smooth, [0, 0.06], [0, 1]);
  const sourcesOpacity = useTransform(smooth, [0.03, 0.10], [0, 1]);
  const subjectOpacity = useTransform(smooth, [0.05, 0.12], [0, 1]);

  return (
    <div
      ref={ref}
      className="overflow-hidden rounded-[18px] border border-border bg-card shadow-sm"
    >
      <motion.div
        className="flex items-center justify-between border-b border-border px-4 py-3"
        style={reduce ? undefined : { opacity: headerOpacity }}
      >
        <div className="flex items-center gap-2">
          <ToolLogo name="Gmail" />
          <div>
            <div className="text-[13.5px] font-semibold text-foreground">{title}</div>
            {byline && <div className="text-[11px] text-muted-foreground">{byline}</div>}
          </div>
        </div>
        <StatusBadge sent={sent} />
      </motion.div>

      {sources && sources.length > 0 && (
        <motion.div
          className="flex flex-wrap items-center gap-1.5 border-b border-border bg-secondary/40 px-4 py-2 text-[11px]"
          style={reduce ? undefined : { opacity: sourcesOpacity }}
        >
          <span className="text-muted-foreground">Sources</span>
          {sources.map((s) =>
            s === "Company Brain" ? (
              <span
                key={s}
                className="inline-flex h-7 items-center rounded-[9px] border border-border bg-card px-2 font-medium text-foreground/85"
              >
                Company Brain
              </span>
            ) : (
              <ToolLogoChip key={s} tool={s} size="sm" />
            ),
          )}
        </motion.div>
      )}

      <div className="space-y-2 px-5 py-4 text-[13.5px] leading-relaxed text-foreground">
        <div>
          <motion.span
            className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground"
            style={reduce ? undefined : { opacity: subjectOpacity }}
          >
            Subject
          </motion.span>
          <motion.div
            className="mt-0.5 font-semibold"
            style={reduce ? undefined : { opacity: subjectOpacity }}
          >
            {subject}
          </motion.div>
        </div>

        {reduce ? (
          allLines.map((line, i) => <Line key={i} text={line} />)
        ) : (
          <BodyLines
            lines={allLines}
            progress={smooth}
            revealStart={revealStart}
            perLine={perLine}
          />
        )}
      </div>

      {footerNote && (
        <div className="border-t border-border bg-secondary/40 px-4 py-2 text-[11.5px] text-muted-foreground">
          {footerNote}
        </div>
      )}

      <div className="flex items-center justify-end gap-1.5 border-t border-border px-4 py-2.5">
        <button className="inline-flex h-11 items-center gap-1 rounded-[12px] border border-border bg-card px-3.5 text-[12.5px] font-medium text-foreground transition hover:border-foreground/30 hover:bg-secondary/60">
          <Edit3 className="h-3.5 w-3.5" /> Edit draft
        </button>
        <SendButton sent={sent} />
      </div>
    </div>
  );
}

/* ── Sub-components ───────────────────────────────────────────────── */

function BodyLines({
  lines,
  progress,
  revealStart,
  perLine,
}: {
  lines: string[];
  progress: ReturnType<typeof useSpring>;
  revealStart: number;
  perLine: number;
}) {
  // Index only the non-empty lines; empty lines render as paragraph spacers.
  const nonEmptyTotal = lines.filter((line) => line.trim().length > 0).length;
  return (
    <>
      {lines.map((line, i) => {
        if (line.trim().length === 0) return <div key={i} className="h-2" />;
        const visibleIndex = lines.slice(0, i).filter((l) => l.trim().length > 0).length;
        return (
          <BodyLine
            key={i}
            text={line}
            progress={progress}
            from={revealStart + visibleIndex * perLine}
            to={revealStart + (visibleIndex + 1) * perLine}
            isLast={visibleIndex === Math.max(0, nonEmptyTotal - 1)}
          />
        );
      })}
    </>
  );
}

function BodyLine({
  text,
  progress,
  from,
  to,
  isLast,
}: {
  text: string;
  progress: ReturnType<typeof useSpring>;
  from: number;
  to: number;
  isLast?: boolean;
}) {
  const opacity = useTransform(progress, [from, to], [0, 1]);
  const y = useTransform(progress, [from, to], [4, 0]);
  // Signoff (last line) reads slightly muted.
  return (
    <motion.p
      className="whitespace-pre-line"
      style={{
        opacity,
        y,
        color: isLast && text.includes("Maya") ? "var(--ink-soft)" : undefined,
      }}
    >
      {text}
    </motion.p>
  );
}

function Line({ text }: { text: string }) {
  if (text.trim().length === 0) return <div className="h-2" />;
  return <p className="whitespace-pre-line">{text}</p>;
}

function StatusBadge({ sent }: { sent: boolean }) {
  return (
    <motion.span
      key={sent ? "sent" : "draft"}
      initial={{ opacity: 0, scale: 0.92 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider"
      style={
        sent
          ? {
              background: "color-mix(in srgb, #1f7d57 16%, transparent)",
              color: "#0c5535",
            }
          : {
              background: "color-mix(in srgb, #E0B349 16%, transparent)",
              color: "#7a5a17",
            }
      }
    >
      {sent ? (
        <>
          <Check className="h-3 w-3" strokeWidth={2.8} /> Sent
        </>
      ) : (
        "Draft"
      )}
    </motion.span>
  );
}

function SendButton({ sent }: { sent: boolean }) {
  return (
    <motion.button
      key={sent ? "sent" : "send"}
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
      disabled={sent}
      whileHover={sent ? undefined : { y: -1 }}
      whileTap={sent ? undefined : { scale: 0.97 }}
      className="inline-flex h-11 items-center gap-1 rounded-[12px] px-3.5 text-[12.5px] font-semibold text-white shadow-sm"
      style={{
        background: sent ? "#1f7d57" : "var(--ink)",
      }}
    >
      {sent ? (
        <>
          <Check className="h-3.5 w-3.5" strokeWidth={2.8} /> Sent
        </>
      ) : (
        <>
          <Send className="h-3.5 w-3.5" /> Send email
        </>
      )}
    </motion.button>
  );
}
