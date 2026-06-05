"use client";

import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";
import { HeroPromptComposer } from "../landing-ref/HeroPromptComposer";

/**
 * V4 — Art version
 * Full-bleed AI-generated artwork as hero background. Accepts ?bg= query
 * param so all candidates (Imagen + Van Gogh series) are switchable inline.
 */

import { ART_CANDIDATES, type ArtKey } from "./art-candidates";
export { ART_CANDIDATES, type ArtKey };
const DEFAULT_ART: ArtKey = "vg1";

function isArtKey(s: string | null): s is ArtKey {
  return !!s && s in ART_CANDIDATES;
}

function HeroV4Body({ artKey }: { artKey: ArtKey }) {
  const reduce = useReducedMotion();
  const art = ART_CANDIDATES[artKey];

  return (
    <section className="relative isolate overflow-hidden min-h-[90vh] px-6 pt-16 pb-24 sm:pt-24">
      {/* Full-bleed artwork. key forces re-render so the picture animates in on swap. */}
      <Image
        key={artKey}
        src={art.src}
        alt=""
        aria-hidden="true"
        fill
        priority
        sizes="100vw"
        className="-z-30 object-cover"
      />

      {/* Scrim */}
      <div
        aria-hidden="true"
        className="absolute inset-0 -z-20"
        style={{
          background:
            "linear-gradient(180deg, rgba(0,0,0,0.42) 0%, rgba(0,0,0,0.34) 40%, rgba(0,0,0,0.55) 100%)",
        }}
      />

      {/* Top emerald glow */}
      <div
        aria-hidden="true"
        className="absolute -z-10"
        style={{
          left: "50%",
          top: "-20%",
          width: "70%",
          height: "70%",
          transform: "translateX(-50%)",
          background: "radial-gradient(ellipse at center, rgba(168, 232, 198, 0.18), transparent 70%)",
          filter: "blur(80px)",
        }}
      />

      <div className="relative mx-auto max-w-3xl text-center">
        <motion.a
          href="https://f.inc/"
          target="_blank"
          rel="noopener noreferrer"
          initial={reduce ? false : { opacity: 0, y: 10 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.55, delay: 0, ease: [0.22, 1, 0.36, 1] }}
          className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/20 bg-white/[0.08] px-3 py-1 text-[11.5px] text-white/85 backdrop-blur transition hover:border-white/40 hover:bg-white/[0.14] hover:text-white"
        >
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#a8e8c6]" aria-hidden="true" />
          <span>Backed by</span>
          <span className="font-semibold text-white">Founders Inc</span>
        </motion.a>

        <motion.h1
          key={`h1-${artKey}`}
          initial={reduce ? false : { opacity: 0, y: 14 }}
          animate={reduce ? undefined : { opacity: 1, y: 0 }}
          transition={{ duration: 0.7, delay: 0.08, ease: [0.22, 1, 0.36, 1] }}
          className="text-balance text-[40px] font-semibold leading-[1.04] tracking-[-0.025em] text-white sm:text-[68px]"
          style={{ textShadow: "0 2px 32px rgba(0,0,0,0.55)" }}
        >
          Hire AI{" "}
          <em
            className="font-serif italic"
            style={{
              fontFamily:
                'var(--font-serif), "Iowan Old Style", "Apple Garamond", Baskerville, Times, serif',
              fontWeight: 500,
              color: "#a8e8c6",
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
          className="text-balance mx-auto mt-7 max-w-xl text-[17px] leading-relaxed text-white/80"
          style={{ textShadow: "0 1px 16px rgba(0,0,0,0.45)" }}
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
          <div className="rounded-[20px] border border-white/15 bg-white/[0.08] p-1 shadow-[0_24px_80px_-12px_rgba(0,0,0,0.6)] backdrop-blur-xl">
            <div className="rounded-[16px] bg-[color:var(--paper)]/[0.97] p-1">
              <HeroPromptComposer />
            </div>
          </div>
        </motion.div>

        {/* Footer caption: current artwork */}
        <div className="mt-6 text-center text-[10.5px] uppercase tracking-[0.18em] text-white/55">
          Artwork: {art.label} · {art.style}
        </div>
      </div>
    </section>
  );
}

function HeroV4Inner() {
  const params = useSearchParams();
  const raw = params.get("bg");
  const artKey: ArtKey = isArtKey(raw) ? raw : DEFAULT_ART;
  return <HeroV4Body artKey={artKey} />;
}

export function HeroV4Artwork() {
  return (
    <Suspense fallback={<HeroV4Body artKey={DEFAULT_ART} />}>
      <HeroV4Inner />
    </Suspense>
  );
}
