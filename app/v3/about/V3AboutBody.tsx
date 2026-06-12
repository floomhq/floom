"use client";

/**
 * /v3/about — the manifesto. One image, plain prose.
 * Design rule: no cards, no artifacts, no chrome. Words and one picture.
 * The bridge photo anchors the open-source section.
 */

import Image from "next/image";
import Link from "next/link";
import { motion } from "motion/react";
import { appUrl } from "@/lib/app-url";
import { V3Shell } from "../V3Shell";
import "../theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function Reveal({
  children,
  delay = 0,
  className,
}: {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.55, delay, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function V3AboutBody() {
  return (
    <V3Shell active="about">
      <article className="mx-auto max-w-[660px] pb-20 pt-16 sm:pt-28">

        <Reveal>
          <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            Manifesto
          </p>
        </Reveal>

        {/* The manifesto — verbatim. Do not edit this copy. */}
        <Reveal delay={0.05}>
          <h1 className="mt-4 text-[34px] font-semibold leading-[1.15] tracking-[-0.03em] sm:text-[44px]">
            You have one life. You will not get a second.
          </h1>
        </Reveal>

        <div className="mt-10 space-y-7 text-[17px] leading-[1.8] text-foreground/85">
          <Reveal>
            <p>
              And yet most working hours are spent on work that requires no creativity, no judgment, no humanity. We hire thinkers and make them clerks. Builders and make them maintainers. Sellers and make them data entry operators.
            </p>
          </Reveal>
          <Reveal>
            <p>The business needs the work done. The human needs it gone.</p>
          </Reveal>
          <Reveal>
            <p>
              Floom builds software that finishes the work so life can continue. Not faster. Not smarter. Finished. Returned. Yours again.
            </p>
          </Reveal>
          <Reveal>
            <p className="font-semibold text-foreground">Time is life. Defend it.</p>
          </Reveal>
        </div>

        {/* bridge */}
        <Reveal>
          <figure className="mt-16 overflow-hidden rounded-[18px]">
            <Image
              src="/bridge.webp"
              alt="The Golden Gate Bridge, shot on film"
              width={1280}
              height={940}
              className="w-full object-cover"
              priority={false}
            />
          </figure>
        </Reveal>

        <Reveal>
          <div className="mt-5 text-[13px] leading-[1.7] text-muted-foreground">
            <p>Floom builds the bridge between the work that must be done and the life that must be lived.</p>
            <p className="mt-1">WorkerOS finishes the work on this side. You walk across.</p>
          </div>
        </Reveal>

        {/* CTA */}
        <Reveal delay={0.1}>
          <div className="mt-16 flex items-center gap-5">
            <Link
              href={appUrl("/workers/new")}
              className="inline-flex items-center gap-2 rounded-[12px] px-6 py-3 text-[14px] font-medium text-white"
              style={{ background: "var(--v3-accent)" }}
            >
              Hire your first worker
            </Link>
            <a
              href="https://github.com/floomhq/workeros"
              target="_blank"
              rel="noopener noreferrer"
              className="text-[13px] text-muted-foreground transition-colors hover:text-foreground"
            >
              View the source →
            </a>
          </div>
        </Reveal>

      </article>
    </V3Shell>
  );
}
