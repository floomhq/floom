"use client";

/**
 * HeroV3Mixed — "Tactile Collage" hero variant.
 *
 * Workers are mixed-shape artifacts floating around the hero: polaroid
 * snapshots, disk avatars, name-tag pills, and a sticky note. No uniform
 * rectangles; each shape carries a different meaning. The hero text sits
 * centered, the artifacts orbit at varying tilts and depths.
 *
 * Cards are hidden on small viewports so the hero text + composer breathe.
 */

import { motion, useReducedMotion, type Transition } from "motion/react";
import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { HeroPromptComposer } from "../landing-ref/HeroPromptComposer";
import { ToolLogo, hasLogo } from "../landing-ref/logos";

const EASE_OUT: Transition["ease"] = [0.22, 1, 0.36, 1];

type WorkerStatus = "Live" | "Running" | "Drafted" | "Waiting" | "Approved";
type WorkerShape = "polaroid" | "disk" | "pill" | "sticky";

type WorkerBadge = {
  shape: WorkerShape;
  monogram: string;
  name: string;
  role: string;
  tools: string[];
  status: WorkerStatus;
  top: string;
  left?: string;
  right?: string;
  rotate: number;
  /** Depth: 0 (back, faded) -> 2 (front, full opacity) */
  depth: 0 | 1 | 2;
  swaySec: number;
};

const BADGES: WorkerBadge[] = [
  {
    shape: "polaroid",
    monogram: "M",
    name: "Maya",
    role: "Sales",
    tools: ["hubspot", "gmail", "slack"],
    status: "Live",
    top: "6%",
    left: "3%",
    rotate: -6,
    depth: 2,
    swaySec: 9.2,
  },
  {
    shape: "pill",
    monogram: "A",
    name: "Atlas",
    role: "Ops",
    tools: ["notion", "sheets"],
    status: "Running",
    top: "12%",
    right: "5%",
    rotate: 5,
    depth: 2,
    swaySec: 11.4,
  },
  {
    shape: "disk",
    monogram: "O",
    name: "Otto",
    role: "Research",
    tools: ["web"],
    status: "Drafted",
    top: "40%",
    left: "0%",
    rotate: -8,
    depth: 1,
    swaySec: 13.1,
  },
  {
    shape: "sticky",
    monogram: "I",
    name: "Iris",
    role: "Support",
    tools: ["intercom", "slack"],
    status: "Waiting",
    top: "46%",
    right: "1%",
    rotate: 7,
    depth: 1,
    swaySec: 10.6,
  },
  {
    shape: "polaroid",
    monogram: "N",
    name: "Nova",
    role: "Reports",
    tools: ["sheets", "slack"],
    status: "Approved",
    top: "70%",
    left: "9%",
    rotate: 4,
    depth: 2,
    swaySec: 12.3,
  },
  {
    shape: "pill",
    monogram: "F",
    name: "Felix",
    role: "Recruiting",
    tools: ["linear", "gmail"],
    status: "Live",
    top: "74%",
    right: "8%",
    rotate: -4,
    depth: 2,
    swaySec: 9.8,
  },
  {
    shape: "disk",
    monogram: "S",
    name: "Sage",
    role: "Finance",
    tools: ["sheets"],
    status: "Running",
    top: "28%",
    left: "14%",
    rotate: 9,
    depth: 0,
    swaySec: 14.6,
  },
];

function statusTone(status: WorkerStatus) {
  if (status === "Live" || status === "Approved")
    return { dot: "var(--emerald-dark)", text: "var(--ink)", bg: "color-mix(in srgb, var(--emerald-dark) 12%, transparent)" };
  if (status === "Running")
    return { dot: "#E0B349", text: "var(--ink)", bg: "color-mix(in srgb, #E0B349 16%, transparent)" };
  return { dot: "#6B6861", text: "var(--ink-soft)", bg: "color-mix(in srgb, #6B6861 10%, transparent)" };
}

function StatusPill({ status }: { status: WorkerStatus }) {
  const tone = statusTone(status);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[9.5px] font-medium"
      style={{ background: tone.bg, color: tone.text }}
    >
      <span className="inline-block h-1.5 w-1.5 rounded-full" style={{ background: tone.dot }} aria-hidden />
      {status === "Running" ? "Running…" : status}
    </span>
  );
}

function MonogramDisk({ letter, size = 36 }: { letter: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: "linear-gradient(140deg, var(--emerald-dark) 0%, color-mix(in srgb, var(--emerald-dark) 70%, #000) 100%)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18), 0 1px 0 rgba(0,0,0,0.08)",
      }}
    >
      {letter}
    </span>
  );
}

function MonogramSquare({ letter, size = 36 }: { letter: string; size?: number }) {
  return (
    <span
      aria-hidden
      className="inline-flex shrink-0 items-center justify-center rounded-[10px] font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.42),
        background: "linear-gradient(140deg, var(--emerald-dark) 0%, color-mix(in srgb, var(--emerald-dark) 70%, #000) 100%)",
        boxShadow: "inset 0 1px 0 rgba(255,255,255,0.18), 0 1px 0 rgba(0,0,0,0.08)",
      }}
    >
      {letter}
    </span>
  );
}

function ToolDots({ tools, max = 3 }: { tools: string[]; max?: number }) {
  return (
    <span className="inline-flex items-center -space-x-1.5">
      {tools.filter(hasLogo).slice(0, max).map((t) => (
        <span
          key={t}
          className="inline-flex h-5 w-5 items-center justify-center rounded-full border bg-white [&_svg]:h-2.5 [&_svg]:w-2.5"
          style={{ borderColor: "var(--border-default)" }}
          aria-label={t}
        >
          <ToolLogo name={t} />
        </span>
      ))}
    </span>
  );
}

/* ─── Shape renderers ───────────────────────────────────────────────── */

function PolaroidCard({ badge }: { badge: WorkerBadge }) {
  return (
    <div
      className="w-[170px] rounded-[6px] p-3 pb-4"
      style={{
        background: "#FBFAF6",
        border: "1px solid color-mix(in srgb, var(--ink) 8%, transparent)",
        boxShadow:
          badge.depth === 2
            ? "0 22px 36px -16px rgba(20,20,20,0.22), 0 4px 10px -4px rgba(20,20,20,0.10), inset 0 1px 0 rgba(255,255,255,0.7)"
            : "0 14px 24px -14px rgba(20,20,20,0.16), inset 0 1px 0 rgba(255,255,255,0.6)",
      }}
    >
      {/* "Photo" tile */}
      <div
        className="relative grid h-[120px] w-full place-items-center overflow-hidden rounded-[3px]"
        style={{
          background:
            "linear-gradient(160deg, color-mix(in srgb, var(--emerald-dark) 22%, transparent), color-mix(in srgb, var(--emerald-dark) 8%, transparent))",
        }}
      >
        <MonogramDisk letter={badge.monogram} size={56} />
        <span className="absolute right-1.5 top-1.5">
          <StatusPill status={badge.status} />
        </span>
      </div>
      {/* Caption: handwritten-style name + role */}
      <div className="mt-2 flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div
            className="truncate text-[14px] leading-tight text-foreground"
            style={{ fontFamily: '"Caveat","Bradley Hand","Segoe Script",cursive', fontWeight: 600 }}
          >
            {badge.name}
          </div>
          <div className="truncate text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
            {badge.role}
          </div>
        </div>
        <ToolDots tools={badge.tools} max={2} />
      </div>
    </div>
  );
}

function DiskCard({ badge }: { badge: WorkerBadge }) {
  return (
    <div className="relative flex flex-col items-center">
      <div className="relative">
        <MonogramDisk letter={badge.monogram} size={88} />
        {/* status dot pinned to bottom-right of disk */}
        <span
          className="absolute -bottom-0.5 -right-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full text-white"
          style={{
            background: statusTone(badge.status).dot,
            boxShadow: "0 0 0 3px var(--bg)",
          }}
          aria-label={badge.status}
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-white/90" />
        </span>
      </div>
      <div className="mt-2.5 text-center">
        <div className="text-[12.5px] font-semibold leading-tight text-foreground">
          {badge.name}
        </div>
        <div className="text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
          {badge.role}
        </div>
      </div>
    </div>
  );
}

function PillCard({ badge }: { badge: WorkerBadge }) {
  return (
    <div
      className="inline-flex items-center gap-2.5 rounded-full py-1.5 pl-1.5 pr-3.5"
      style={{
        background: "var(--bg-card)",
        border: "1px solid var(--border-default)",
        boxShadow:
          badge.depth === 2
            ? "0 14px 28px -14px rgba(20,20,20,0.18), inset 0 1px 0 rgba(255,255,255,0.6)"
            : "0 8px 18px -12px rgba(20,20,20,0.14), inset 0 1px 0 rgba(255,255,255,0.5)",
      }}
    >
      <MonogramDisk letter={badge.monogram} size={28} />
      <div className="min-w-0">
        <div className="truncate text-[12.5px] font-semibold leading-tight text-foreground">
          {badge.name}
          <span className="ml-1.5 text-[9.5px] font-normal uppercase tracking-[0.14em] text-muted-foreground">
            · {badge.role}
          </span>
        </div>
      </div>
      <span className="ml-1"><StatusPill status={badge.status} /></span>
    </div>
  );
}

function StickyCard({ badge }: { badge: WorkerBadge }) {
  return (
    <div
      className="w-[164px] p-3"
      style={{
        background: "linear-gradient(160deg, #FFF4C2 0%, #FFE99A 100%)",
        clipPath: "polygon(0 0, 100% 0, 100% 92%, 96% 100%, 0 100%)",
        boxShadow:
          "0 14px 28px -14px rgba(120, 100, 20, 0.30), inset 0 1px 0 rgba(255,255,255,0.5)",
      }}
    >
      <div className="flex items-center gap-2">
        <MonogramSquare letter={badge.monogram} size={28} />
        <div className="min-w-0">
          <div className="truncate text-[12.5px] font-semibold leading-tight text-foreground">
            {badge.name}
          </div>
          <div className="truncate text-[9.5px] uppercase tracking-[0.14em] text-foreground/55">
            {badge.role}
          </div>
        </div>
      </div>
      <div
        className="mt-2 text-[11px] leading-snug text-foreground/80"
        style={{ fontFamily: '"Caveat","Bradley Hand","Segoe Script",cursive', fontWeight: 600 }}
      >
        {badge.status === "Waiting" ? "waiting on review" : badge.status.toLowerCase()}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <ToolDots tools={badge.tools} max={2} />
        <StatusPill status={badge.status} />
      </div>
    </div>
  );
}

/* ─── Floating wrapper ───────────────────────────────────────────────── */

function FloatingBadge({ badge, index, reduce }: { badge: WorkerBadge; index: number; reduce: boolean }) {
  const depthStyles = {
    0: { opacity: 0.45, scale: 0.86, z: 0, blur: 0.6 },
    1: { opacity: 0.85, scale: 0.95, z: 10, blur: 0 },
    2: { opacity: 1, scale: 1, z: 20, blur: 0 },
  }[badge.depth];

  const cardStyle: CSSProperties = {
    top: badge.top,
    left: badge.left,
    right: badge.right,
    zIndex: depthStyles.z,
    filter: depthStyles.blur ? `blur(${depthStyles.blur}px)` : undefined,
  };

  const swayRange = 1.8;
  const initialRotate = badge.rotate;
  const animateRotate = reduce
    ? initialRotate
    : [initialRotate - swayRange, initialRotate + swayRange, initialRotate - swayRange];

  const shapeNode =
    badge.shape === "polaroid" ? (
      <PolaroidCard badge={badge} />
    ) : badge.shape === "disk" ? (
      <DiskCard badge={badge} />
    ) : badge.shape === "pill" ? (
      <PillCard badge={badge} />
    ) : (
      <StickyCard badge={badge} />
    );

  return (
    <motion.div
      className="pointer-events-none absolute"
      style={cardStyle}
      initial={
        reduce
          ? { opacity: depthStyles.opacity, scale: depthStyles.scale, rotate: initialRotate, y: 0 }
          : { opacity: 0, scale: depthStyles.scale * 0.92, rotate: initialRotate, y: 18 }
      }
      animate={{
        opacity: depthStyles.opacity,
        scale: depthStyles.scale,
        rotate: animateRotate,
        y: reduce ? 0 : [0, -4, 0],
      }}
      transition={{
        opacity: { duration: 0.7, delay: 0.35 + index * 0.07, ease: EASE_OUT },
        scale: { duration: 0.7, delay: 0.35 + index * 0.07, ease: EASE_OUT },
        rotate: reduce
          ? { duration: 0 }
          : { duration: badge.swaySec, repeat: Infinity, ease: "easeInOut", delay: index * 0.4 },
        y: reduce
          ? { duration: 0 }
          : { duration: badge.swaySec * 0.9, repeat: Infinity, ease: "easeInOut", delay: index * 0.55 },
      }}
    >
      {shapeNode}
    </motion.div>
  );
}

export function HeroV3Mixed() {
  const reduce = useReducedMotion() ?? false;
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const badges = useMemo(() => BADGES, []);

  return (
    <section
      className="relative isolate overflow-hidden px-6 pt-14 pb-16 sm:pt-20 sm:pb-24"
      style={{ minHeight: "min(820px, 92vh)" }}
    >
      {/* Atmospheric emerald blooms */}
      <div
        aria-hidden
        className="pointer-events-none absolute -left-32 top-[6%] h-[420px] w-[520px] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at 40% 40%, color-mix(in srgb, var(--emerald-dark) 16%, transparent) 0%, color-mix(in srgb, var(--emerald-dark) 7%, transparent) 50%, transparent 80%)",
          zIndex: 0,
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-24 bottom-[4%] h-[460px] w-[540px] rounded-full blur-3xl"
        style={{
          background:
            "radial-gradient(ellipse at 60% 60%, color-mix(in srgb, var(--emerald-dark) 14%, transparent) 0%, color-mix(in srgb, var(--emerald-dark) 6%, transparent) 52%, transparent 82%)",
          zIndex: 0,
        }}
      />

      {/* Floating worker badges — desktop only */}
      <div aria-hidden className="pointer-events-none absolute inset-0 hidden sm:block" style={{ zIndex: 1 }}>
        {mounted && badges.map((b, i) => <FloatingBadge key={b.name} badge={b} index={i} reduce={reduce} />)}
      </div>

      {/* Centered hero stack */}
      <div className="relative mx-auto max-w-3xl text-center" style={{ zIndex: 30 }}>
        <motion.a
          href="https://f.inc/"
          target="_blank"
          rel="noopener noreferrer"
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE_OUT }}
          className="mb-7 inline-flex items-center gap-2 rounded-full border border-[var(--emerald-dark)]/25 bg-[var(--emerald-dark)]/[0.05] px-3 py-1 text-[11.5px] text-muted-foreground shadow-[0_1px_0_rgba(0,0,0,0.02)] backdrop-blur-sm transition-all duration-200 hover:-translate-y-px hover:border-[var(--emerald-dark)]/45 hover:bg-[var(--emerald-dark)]/[0.09] hover:text-foreground hover:shadow-[0_4px_12px_-2px_rgba(10,82,48,0.18)]"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--emerald-dark)]" aria-hidden />
          <span>Backed by</span>
          <span className="font-semibold text-foreground">Founders Inc</span>
        </motion.a>

        <motion.h1
          initial={reduce ? false : { opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.08, ease: EASE_OUT }}
          className="text-balance text-[34px] font-semibold leading-[1.06] tracking-[-0.025em] text-foreground sm:text-[64px] sm:leading-[1.03]"
        >
          Hire AI{" "}
          <em
            className="font-serif italic"
            style={{
              fontFamily:
                'var(--font-serif), "Iowan Old Style", "Apple Garamond", Baskerville, Times, serif',
              fontWeight: 500,
              color: "var(--emerald-dark)",
              letterSpacing: "-0.01em",
            }}
          >
            workers
          </em>
          <br className="hidden sm:inline" /> for your company.
        </motion.h1>

        <motion.p
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.18, ease: EASE_OUT }}
          className="text-balance mx-auto mt-6 max-w-xl text-[17px] leading-relaxed text-muted-foreground"
        >
          Describe the job. Workeros hires the worker and runs it for your team, with
          your approval before anything ships.
        </motion.p>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.28, ease: EASE_OUT }}
        >
          <HeroPromptComposer />
        </motion.div>
      </div>
    </section>
  );
}
