"use client";

import { motion, useReducedMotion } from "motion/react";
import { HeroPromptComposer } from "../landing-ref/HeroPromptComposer";

/**
 * V1 — Cinematic
 * Almanac-inspired: full-bleed atmospheric background, italic emphasis on
 * the key word, big editorial type, glass-card prompt composer. Pure CSS
 * artwork (radial blooms + grain + silhouette) so no generated images.
 */
export function HeroV1Cinematic() {
  const reduce = useReducedMotion();

  return (
    <section className="relative isolate overflow-hidden min-h-[88vh] px-6 pt-12 pb-20 sm:pt-20">
      {/* ── Background art ────────────────────────────────────────── */}
      {/* Deep emerald base wash */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-30"
        style={{
          background:
            "radial-gradient(120% 80% at 50% 0%, #0a3b27 0%, #0a2a1d 40%, #050f0b 100%)",
        }}
      />

      {/* Emerald + cream bloom layers (atmospheric depth) */}
      <div
        aria-hidden="true"
        className="absolute -z-20"
        style={{
          left: "10%",
          top: "-10%",
          width: "60%",
          height: "70%",
          background:
            "radial-gradient(ellipse at center, rgba(74, 158, 108, 0.55), transparent 70%)",
          filter: "blur(80px)",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute -z-20"
        style={{
          right: "5%",
          top: "20%",
          width: "55%",
          height: "60%",
          background:
            "radial-gradient(ellipse at center, rgba(193, 215, 173, 0.4), transparent 70%)",
          filter: "blur(100px)",
        }}
      />
      <div
        aria-hidden="true"
        className="absolute -z-20"
        style={{
          left: "30%",
          bottom: "-20%",
          width: "70%",
          height: "60%",
          background:
            "radial-gradient(ellipse at center, rgba(10, 82, 48, 0.6), transparent 70%)",
          filter: "blur(120px)",
        }}
      />

      {/* Forest-canopy silhouette at the bottom (organic feel) */}
      <svg
        aria-hidden="true"
        viewBox="0 0 1440 320"
        className="absolute inset-x-0 bottom-0 -z-10 w-full opacity-50"
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id="canopy" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#031108" stopOpacity="0" />
            <stop offset="100%" stopColor="#031108" stopOpacity="0.9" />
          </linearGradient>
        </defs>
        <path
          fill="url(#canopy)"
          d="M0,140 C 80,90 160,170 260,150 C 360,130 420,80 540,110 C 660,140 720,80 840,90 C 960,100 1080,160 1200,130 C 1320,100 1380,140 1440,120 L1440,320 L0,320 Z"
        />
        <path
          fill="#000"
          fillOpacity="0.35"
          d="M0,200 C 100,170 200,230 320,210 C 440,190 540,160 660,180 C 780,200 900,160 1020,170 C 1140,180 1260,210 1440,200 L1440,320 L0,320 Z"
        />
      </svg>

      {/* Subtle grain via SVG noise */}
      <svg
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 -z-10 h-full w-full opacity-[0.08] mix-blend-overlay"
      >
        <filter id="grain-v1">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="3" />
          <feColorMatrix type="matrix" values="0 0 0 0 0.95  0 0 0 0 0.93  0 0 0 0 0.85  0 0 0 1 0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain-v1)" />
      </svg>

      {/* ── Content ─────────────────────────────────────────────── */}
      <div className="relative mx-auto max-w-3xl text-center">
        <motion.a
          href="https://f.inc/"
          target="_blank"
          rel="noopener noreferrer"
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0, ease: [0.22, 1, 0.36, 1] }}
          className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/15 bg-white/[0.06] px-3 py-1 text-[11.5px] text-white/75 backdrop-blur transition hover:border-white/30 hover:bg-white/[0.10] hover:text-white"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#7ee0a7]" aria-hidden="true" />
          <span>Backed by</span>
          <span className="font-semibold text-white">Founders Inc</span>
        </motion.a>

        <motion.h1
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
          className="text-balance text-[40px] font-semibold leading-[1.04] tracking-[-0.025em] text-white sm:text-[68px]"
          style={{ textShadow: "0 2px 24px rgba(0,0,0,0.35)" }}
        >
          Hire AI{" "}
          <em
            className="font-serif italic text-[#a8e8c6]"
            style={{
              fontFamily: 'var(--font-serif), "Iowan Old Style", "Apple Garamond", Baskerville, Times, serif',
              fontWeight: 500,
              letterSpacing: "-0.01em",
            }}
          >
            workers
          </em>
          <br className="hidden sm:inline" /> for your company.
        </motion.h1>

        <motion.p
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.18, ease: [0.22, 1, 0.36, 1] }}
          className="text-balance mx-auto mt-7 max-w-xl text-[17px] leading-relaxed text-white/75"
        >
          Describe the job. Workeros hires the worker and runs it for your team, with your approval
          before anything ships.
        </motion.p>

        <motion.div
          initial={reduce ? false : { opacity: 0, y: 12 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.28, ease: [0.22, 1, 0.36, 1] }}
          className="mt-10"
        >
          {/* Glass wrapper around the composer so it floats on the dark bg */}
          <div className="rounded-[20px] border border-white/15 bg-white/[0.08] p-1 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.5)] backdrop-blur-xl">
            <div className="rounded-[16px] bg-[color:var(--paper)]/[0.96] p-1">
              <HeroPromptComposer />
            </div>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
