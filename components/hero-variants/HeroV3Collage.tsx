"use client";

/**
 * HeroV3Collage — "Tactile Collage" (uniform-rectangle base, near-black accent).
 *
 * Per workeros-cloud/CLAUDE.md design system: accent is near-black with
 * warm matte surfaces; green stays for the Floom mark and semantic status
 * indicators only. No emerald on hero atmosphere, italic emphasis, or
 * eyebrows. Cards use role-specific lucide icons instead of monogram letters.
 */

import {
  motion,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
  type Transition,
} from "motion/react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ComponentType,
} from "react";
import Link from "next/link";
import {
  BarChart3,
  DollarSign,
  MessageSquare,
  Search,
  TrendingUp,
  UserPlus,
  Workflow,
  type LucideProps,
} from "lucide-react";
import { HeroPromptComposer } from "../landing-ref/HeroPromptComposer";
import { ChannelInstall } from "../landing-ref/ChannelInstall";
import { ToolLogo, hasLogo } from "../landing-ref/logos";

const EASE_OUT: Transition["ease"] = [0.22, 1, 0.36, 1];

type WorkerStatus = "Live" | "Running" | "Drafted" | "Waiting" | "Approved";

type WorkerBadge = {
  Icon: ComponentType<LucideProps>;
  name: string;
  role: string;
  tools: string[];
  status: WorkerStatus;
  top: string;
  left?: string;
  right?: string;
  rotate: number;
  depth: 0 | 1 | 2;
  swaySec: number;
};

const BADGES: WorkerBadge[] = [
  {
    Icon: TrendingUp,
    name: "Maya",
    role: "Sales",
    tools: ["hubspot", "gmail", "slack"],
    status: "Live",
    top: "10%",
    left: "5%",
    rotate: -6,
    depth: 2,
    swaySec: 9.2,
  },
  {
    Icon: Workflow,
    name: "Atlas",
    role: "Ops",
    tools: ["notion", "sheets"],
    status: "Running",
    top: "14%",
    right: "7%",
    rotate: 5,
    depth: 2,
    swaySec: 11.4,
  },
  {
    Icon: BarChart3,
    name: "Nova",
    role: "Reports",
    tools: ["sheets", "slack"],
    status: "Approved",
    top: "72%",
    left: "8%",
    rotate: 3,
    depth: 2,
    swaySec: 12.3,
  },
  {
    Icon: UserPlus,
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
];

function statusTone(status: WorkerStatus) {
  // Only "Live" and "Approved" stay green: these are semantic success states.
  if (status === "Live" || status === "Approved")
    return {
      dot: "#1f7d57",
      text: "var(--ink)",
      bg: "color-mix(in srgb, #1f7d57 12%, transparent)",
    };
  if (status === "Running")
    return {
      dot: "#E0B349",
      text: "var(--ink)",
      bg: "color-mix(in srgb, #E0B349 16%, transparent)",
    };
  return {
    dot: "#6B6861",
    text: "var(--ink-soft)",
    bg: "color-mix(in srgb, #6B6861 10%, transparent)",
  };
}

function StatusDot({ status }: { status: WorkerStatus }) {
  const tone = statusTone(status);
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10.5px] font-medium"
      style={{ background: tone.bg, color: tone.text }}
    >
      <span
        className="inline-block h-1.5 w-1.5 rounded-full"
        style={{ background: tone.dot }}
        aria-hidden
      />
      {status === "Running" ? "Running…" : status}
    </span>
  );
}

function IconTile({ Icon }: { Icon: ComponentType<LucideProps> }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px]"
      style={{
        background:
          "linear-gradient(140deg, #3a6ea5 0%, #29547e 100%)",
        boxShadow:
          "inset 0 1px 0 rgba(255,255,255,0.18), 0 1px 0 rgba(0,0,0,0.08)",
      }}
    >
      <Icon className="h-4 w-4 text-[color:var(--paper)]" strokeWidth={2} />
    </span>
  );
}

function WorkerCard({
  badge,
  index,
  reduce,
  dispersed,
  parallaxY,
}: {
  badge: WorkerBadge;
  index: number;
  reduce: boolean;
  dispersed: boolean;
  parallaxY: MotionValue<number>;
}) {
  const depthStyles = {
    0: { opacity: 0.28, scale: 0.86, z: 0, blur: 0.8 },
    1: { opacity: 0.55, scale: 0.94, z: 10, blur: 0 },
    2: { opacity: 0.78, scale: 1, z: 20, blur: 0 },
  }[badge.depth];

  const cardStyle: CSSProperties = {
    top: badge.top,
    left: badge.left,
    right: badge.right,
    zIndex: depthStyles.z,
    filter: depthStyles.blur ? `blur(${depthStyles.blur}px)` : undefined,
    background: "color-mix(in srgb, var(--paper) 62%, transparent)",
    border: "1px solid color-mix(in srgb, var(--ink) 6%, transparent)",
    backdropFilter: "blur(8px) saturate(1.1)",
    WebkitBackdropFilter: "blur(8px) saturate(1.1)",
    boxShadow:
      badge.depth === 2
        ? "0 16px 28px -16px rgba(20,20,20,0.12), 0 2px 6px -2px rgba(20,20,20,0.04)"
        : badge.depth === 1
        ? "0 10px 22px -14px rgba(20,20,20,0.09)"
        : "0 6px 16px -12px rgba(20,20,20,0.07)",
  };

  // Idle sway removed — Federico noted ambient motion = noise. Cards stand
  // still at their tilt; movement only happens on interaction (dispersion).
  const initialRotate = badge.rotate;

  // Dispersion vector: push each card AWAY from the hero box on focus.
  const topPct = parseFloat(badge.top);
  const isLeft = badge.left !== undefined;
  const dispX = dispersed ? (isLeft ? -72 : 72) : 0;
  const dispY = dispersed ? (topPct < 50 ? -36 : 36) : 0;
  const dispersedOpacity = dispersed ? Math.max(0.18, depthStyles.opacity - 0.22) : depthStyles.opacity;

  // OUTER layer = dispersion + opacity (driven by `dispersed`, soft spring).
  // INNER layer = idle float/rotate + entrance (infinite keyframes).
  // Splitting them prevents the keyframe y-loop from fighting the spring x.
  // Parallax intensity per depth tier — back layers drift more (deeper feel).
  const parallaxFactor = badge.depth === 0 ? 1.3 : badge.depth === 1 ? 0.9 : 0.6;
  const cardParallaxY = useTransform(parallaxY, (v) => v * parallaxFactor);

  return (
    <motion.div
      className="pointer-events-none absolute w-[212px] cursor-default"
      style={{
        top: badge.top,
        left: badge.left,
        right: badge.right,
        zIndex: depthStyles.z,
        filter: depthStyles.blur ? `blur(${depthStyles.blur}px)` : undefined,
        y: cardParallaxY,
      }}
    >
      <motion.div
      animate={{ x: dispX, y: dispY, opacity: dispersedOpacity }}
      transition={{
        x: { type: "spring", stiffness: 70, damping: 22, mass: 1.1 },
        y: { type: "spring", stiffness: 70, damping: 22, mass: 1.1 },
        opacity: { duration: 0.6, ease: EASE_OUT },
      }}
    >
      <motion.div
      className="rounded-[18px]"
      style={{
        background: cardStyle.background,
        border: cardStyle.border,
        backdropFilter: cardStyle.backdropFilter,
        WebkitBackdropFilter: cardStyle.WebkitBackdropFilter,
        boxShadow: cardStyle.boxShadow,
      }}
      initial={
        reduce
          ? {
              opacity: 1,
              scale: depthStyles.scale,
              rotate: initialRotate,
              y: 0,
            }
          : {
              opacity: 0,
              scale: depthStyles.scale * 0.92,
              rotate: initialRotate,
              y: 18,
            }
      }
      animate={{
        opacity: 1,
        scale: depthStyles.scale,
        rotate: initialRotate,
        y: 0,
      }}
      transition={{
        opacity: { duration: 0.7, delay: 0.35 + index * 0.07, ease: EASE_OUT },
        scale: { duration: 0.7, delay: 0.35 + index * 0.07, ease: EASE_OUT },
        rotate: { duration: 0.7, delay: 0.35 + index * 0.07, ease: EASE_OUT },
        y: { duration: 0.7, delay: 0.35 + index * 0.07, ease: EASE_OUT },
      }}
    >
      <div className="rounded-[18px] p-3.5">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2.5">
            <IconTile Icon={badge.Icon} />
            <div className="min-w-0">
              <div className="truncate text-[13px] font-semibold leading-tight text-foreground">
                {badge.name}
              </div>
              <div className="truncate text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground">
                {badge.role}
              </div>
            </div>
          </div>
          <StatusDot status={badge.status} />
        </div>

        <div
          className="my-3 h-px w-full"
          style={{ background: "var(--border-soft)" }}
        />

        <div className="flex items-center justify-between">
          <div className="flex items-center -space-x-1.5">
            {badge.tools.filter(hasLogo).slice(0, 3).map((t) => (
              <span
                key={t}
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border bg-white [&_svg]:h-3 [&_svg]:w-3"
                style={{ borderColor: "var(--border-default)" }}
                aria-label={t}
              >
                <ToolLogo name={t} />
              </span>
            ))}
          </div>
          <span className="font-mono text-[10.5px] tracking-[0.06em] text-muted-foreground">
            #{String(index + 1).padStart(2, "0")}
          </span>
        </div>
      </div>
      </motion.div>
      </motion.div>
    </motion.div>
  );
}

export function HeroV3Collage() {
  const reduce = useReducedMotion() ?? false;
  const sectionRef = useRef<HTMLElement | null>(null);
  const { scrollY } = useScroll();
  // Drift cards downward as user scrolls past the hero. Springed so it
  // doesn't feel jittery on fast wheel input.
  const rawParallax = useTransform(scrollY, [0, 800], [0, 60]);
  const parallaxY = useSpring(rawParallax, { stiffness: 90, damping: 28, mass: 0.6 });
  const [mounted, setMounted] = useState(false);
  const [focused, setFocused] = useState(false);
  useEffect(() => setMounted(true), []);

  const badges = useMemo(() => BADGES, []);

  return (
    <section
      className="relative isolate overflow-hidden px-6 pt-14 pb-16 sm:pt-20 sm:pb-24"
      style={{ minHeight: "min(820px, 92vh)" }}
    >
      {/* Subtle warm radial wash — single soft vignette, near-monochrome.
          Replaces the previous dual-emerald-bloom cringe. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(80% 60% at 50% 20%, color-mix(in srgb, var(--paper) 55%, transparent) 0%, transparent 70%)",
          zIndex: 0,
        }}
      />
      {/* Soft top-down vignette so the eye lands on the hero stack */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "linear-gradient(180deg, transparent 0%, transparent 60%, color-mix(in srgb, var(--ink) 4%, transparent) 100%)",
          zIndex: 0,
        }}
      />
      {/* Grain texture — premium editorial paper feel */}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 h-full w-full opacity-[0.045] mix-blend-multiply"
        style={{ zIndex: 0 }}
      >
        <filter id="v3-grain">
          <feTurbulence type="fractalNoise" baseFrequency="0.95" numOctaves="2" seed="7" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.15  0 0 0 0 0.15  0 0 0 0 0.12  0 0 0 1 0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#v3-grain)" />
      </svg>

      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 hidden sm:block"
        style={{ zIndex: 1 }}
      >
        {mounted &&
          badges.map((b, i) => (
            <WorkerCard
              key={b.name}
              badge={b}
              index={i}
              reduce={reduce}
              dispersed={focused}
              parallaxY={parallaxY}
            />
          ))}
      </div>

      <div
        className="relative mx-auto max-w-3xl text-center"
        style={{ zIndex: 30 }}
      >
        <motion.a
          href="https://f.inc/"
          target="_blank"
          rel="noopener noreferrer"
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: EASE_OUT }}
          className="mb-7 inline-flex items-center gap-2 rounded-full border border-foreground/10 bg-card px-3 py-1 text-[11.5px] text-muted-foreground shadow-[0_1px_0_rgba(0,0,0,0.02)] backdrop-blur-sm transition-all duration-200 hover:-translate-y-px hover:border-foreground/25 hover:text-foreground hover:shadow-[0_4px_12px_-2px_rgba(20,20,20,0.10)]"
        >
          <span
            className="inline-block h-1.5 w-1.5 rounded-full bg-foreground/40"
            aria-hidden
          />
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
              color: "#3a6ea5",
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
          Describe the job. Workeros hires the worker and runs it for your team,
          with your approval before anything ships.
        </motion.p>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.28, ease: EASE_OUT }}
        >
          <HeroPromptComposer onFocusedChange={setFocused} />
        </motion.div>

        <ChannelInstall />

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0.56, ease: EASE_OUT }}
          className="mt-6 text-center text-[13px] text-muted-foreground"
        >
          Or{" "}
          <Link
            href="/templates"
            className="font-medium text-foreground underline-offset-4 transition-colors hover:text-[#3a6ea5] hover:underline"
          >
            browse ready-made workers
          </Link>
          .
        </motion.div>
      </div>
    </section>
  );
}
