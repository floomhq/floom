"use client";

/**
 * /v3 — the Ive cut. One jewel (the composer), one story (four beats),
 * one accent (blue, twice per screen), three type voices, no marquee,
 * no duplicate sections, one-line footer. /v2 remains for rollback.
 *
 * Cuts vs /v2, per the roast:
 * - channel sentence: dead (footer carries it)
 * - marquee: six static marks
 * - two scrollytelling sections merged into one four-beat story
 * - templates featured-card complexity: three flat cards
 * - final CTA: headline + one button, no second composer
 * - theme toggle: gone, follows system preference
 * - footer: one line
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { Check } from "lucide-react";
import {
  GCalLogo,
  GmailLogo,
  GranolaLogo,
  HubSpotLogo,
  NotionLogo,
  SheetsLogo,
  SlackLogo,
} from "@/components/landing-icons";
import { V3Composer } from "./V3Composer";
import { ChannelActions } from "./ChannelActions";
import { V3TemplateCard } from "./V3TemplateCard";
import { getTemplate } from "@/components/landing-ref/data";
import { Hl, V3Shell } from "./V3Shell";
import "./theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/* ── inline tool highlight with real brand logo ─────────────── */
function ToolHl({
  logo,
  children,
}: {
  logo: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <span className="v3-hl inline-flex items-center gap-[3px] align-baseline whitespace-nowrap">
      <span className="inline-flex h-[13px] w-[13px] shrink-0 items-center justify-center [&_svg]:h-[13px] [&_svg]:w-[13px]">
        {logo}
      </span>
      {children}
    </span>
  );
}

/* ───────────────── the one story: four beats ───────────────── */

const BEATS = [
  {
    t: "Describe the job",
    p: "One sentence, plain English. Floom recognises your tools as you type and drafts the worker.",
  },
  {
    t: "Approve the draft",
    p: "The finished work comes to you first. Nothing ships without your yes, in Slack, WhatsApp, or here.",
  },
  {
    t: "It runs, on the record",
    p: "Background work, every run auditable. The output lands where you already are.",
  },
];

/* beat visuals: the ARTIFACT, not the chrome */

function BeatDescribe() {
  return (
    <div className="w-full max-w-[460px] rounded-[18px] bg-card p-6">
      <div className="text-[16px] leading-relaxed">
        Summarise my{" "}
        <ToolHl logo={<GranolaLogo />}>Granola</ToolHl>
        {" "}meetings and post action items to{" "}
        <ToolHl logo={<HubSpotLogo />}>HubSpot</ToolHl>
        {" "}daily
        <span
          aria-hidden
          className="v3-caret ml-px inline-block h-[16px] w-[1.5px] translate-y-[2px] bg-foreground"
        />
      </div>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.5, duration: 0.4 }}
        className="mt-5 flex items-center justify-between bg-secondary/60 px-4 py-3"
      >
        <span className="text-[12px] text-muted-foreground">Recognised: Granola, HubSpot</span>
        <span className="whitespace-nowrap rounded-[10px] px-4 py-2 text-[13px] font-medium text-white" style={{ background: "var(--v3-accent)" }}>Hire</span>
      </motion.div>
    </div>
  );
}

function BeatApprove() {
  return (
    <div className="w-full max-w-[460px] overflow-hidden rounded-[18px] bg-card">
      <div className="bg-secondary/60 px-5 py-3.5">
        <div className="flex items-center justify-between gap-3">
          <div className="text-[10.5px] font-semibold uppercase tracking-[0.11em] text-muted-foreground">
            Email draft
          </div>
          <div className="rounded-full bg-secondary px-2.5 py-1 text-[10.5px] font-medium text-muted-foreground">
            To Sarah at Acme
          </div>
        </div>
      </div>
      <div className="px-5 py-5">
        <div className="text-[18px] font-semibold tracking-[-0.018em]">Next steps from today&apos;s call</div>
        <div className="mt-3 rounded-[14px] bg-secondary/80 px-4 py-3.5">
          <p className="text-[13.5px] leading-relaxed text-foreground/80">
            Hi Sarah, thanks for the call today. Based on what you shared, I&apos;d suggest starting with the onboarding workflow and the CRM cleanup before renewals…
          </p>
        </div>
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.3, duration: 0.4 }}
          className="mt-3 flex items-center gap-2 text-[11.5px] text-muted-foreground"
        >
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--v3-accent)" }} />
          Built from your tone guide and pricing sheet
        </motion.div>
      </div>
      <div className="flex gap-2 px-5 py-4">
        <motion.span
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.45, duration: 0.35 }}
          className="rounded-[10px] px-4 py-2 text-[13px] font-medium text-white"
          style={{ background: "var(--v3-accent)" }}
        >
          Approve
        </motion.span>
        <motion.span
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: 0.55, duration: 0.35 }}
          className="rounded-[10px] bg-secondary px-4 py-2 text-[13px] text-foreground/80"
        >
          Edit
        </motion.span>
      </div>
    </div>
  );
}

function BeatRecord() {
  return (
    <div className="w-full max-w-[460px] overflow-hidden rounded-[18px] bg-card">
      <div className="flex items-center justify-between bg-secondary/60 px-5 py-4">
        <span className="text-[15px] font-semibold tracking-[-0.012em]">This week</span>
        <span className="rounded-full bg-secondary px-2.5 py-1 font-mono text-[10.5px] text-muted-foreground">5 runs</span>
      </div>
      <div className="px-5 py-2">
        {[
          ["Mon", "Posted to HubSpot", true],
          ["Tue", "Posted to HubSpot", true],
          ["Wed", "Posted to HubSpot", true],
          ["Thu", "Posted to HubSpot", true],
          ["Today", "Waiting on you", false],
        ].map(([d, s, done], i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.12 + i * 0.08, duration: 0.35 }}
            className="flex items-center gap-3 py-3 text-[13px]"
          >
            <span className={`w-12 shrink-0 font-mono text-[10.5px] ${done ? "text-muted-foreground" : "font-semibold"}`} style={!done ? { color: "var(--v3-accent)" } : undefined}>
              {d as string}
            </span>
            <span className={`flex-1 ${done ? "text-muted-foreground" : "font-medium text-foreground"}`}>{s as string}</span>
            {done ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
            ) : (
              <span className="relative flex h-3 w-3 shrink-0 items-center justify-center">
                <span className="absolute h-3 w-3 rounded-full opacity-15" style={{ background: "var(--v3-accent)" }} />
                <span className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--v3-accent)" }} />
              </span>
            )}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function Story() {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (es) => {
        es.forEach((e) => {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.beat));
        });
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    refs.current.forEach((r) => r && io.observe(r));
    return () => io.disconnect();
  }, []);

  const VIS = [BeatDescribe, BeatApprove, BeatRecord];

  return (
    <section className="pb-24">
      <div className="grid gap-16 md:grid-cols-[1fr_1.05fr]">
        <div className="flex flex-col justify-center">
          {BEATS.map((b, i) => (
            <div
              key={b.t}
              data-beat={i}
              ref={(el) => { refs.current[i] = el; }}
              className="flex min-h-[200px] cursor-default flex-col justify-center py-4 md:min-h-[175px]"
              onMouseEnter={() => setActive(i)}
            >
              <h3 className={`text-[26px] font-semibold tracking-[-0.025em] transition-colors sm:text-[34px] duration-300 ${active === i ? "text-foreground" : "text-foreground md:text-muted-foreground/55"}`}>
                {b.t}
              </h3>
              <p className={`mt-2 max-w-[360px] text-[14px] leading-relaxed text-muted-foreground transition-opacity duration-300 ${active === i ? "opacity-100" : "opacity-100 md:opacity-55"}`}>
                {b.p}
              </p>
              <div className="mt-5 flex origin-top justify-center rounded-[18px] bg-secondary/70 p-4 md:hidden [&>div]:scale-[0.92]">
                {i === 0 ? <BeatDescribe /> : i === 1 ? <BeatApprove /> : <BeatRecord />}
              </div>
            </div>
          ))}
        </div>
        <div className="hidden md:sticky md:top-20 md:block md:h-[500px]">
          <div className="flex h-full items-center justify-center rounded-[22px] bg-secondary/70 p-9">
            <AnimatePresence mode="wait">
              {VIS.map((V, i) =>
                active === i ? (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 14, scale: 0.97 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -10, scale: 0.98 }}
                    transition={{ duration: 0.35, ease: EASE }}
                    style={{ display: "flex", justifyContent: "center", width: "100%" }}
                  >
                    <V />
                  </motion.div>
                ) : null,
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ───────────────── templates: shared card, real data ───────────────── */

const TPL_SLUGS = ["client-follow-up-worker", "monday-report-worker", "lead-research-worker"];

function Templates() {
  const templates = TPL_SLUGS.map((sl) => getTemplate(sl)!).filter(Boolean);
  return (
    <section className="pb-28">
      <motion.h2
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.5, ease: EASE }}
        className="text-[26px] font-semibold tracking-[-0.025em] sm:text-[32px]"
      >
        Or start from one that works.
      </motion.h2>
      <div className="mt-9 grid gap-3.5 md:grid-cols-3">
        {templates.map((t, i) => (
          <V3TemplateCard key={t.slug} t={t} i={i} animate="view" />
        ))}
      </div>
      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="mt-5 text-[13px]"
      >
        <Link href="/templates" className="text-muted-foreground transition-colors hover:text-foreground">
          All templates →
        </Link>
      </motion.div>
    </section>
  );
}

/* ───────────────────────── page ───────────────────────── */

const PILLS = [
  { label: "Pipeline report", prompt: "Every Monday 9am, pull last week's pipeline from HubSpot and post a summary in #sales" },
  { label: "Post-call follow-up", prompt: "After every call, draft a follow-up email using my CRM notes" },
  { label: "Lead research", prompt: "Each morning, research 5 new inbound leads before my first meeting" },
];

export function V3Body() {
  const [fill, setFill] = useState<{ text: string; n: number } | null>(null);
  return (
    <V3Shell>


        {/* hero: headline, one line, the jewel, three prompt pills */}
        <section className="pb-16 pt-24 text-center sm:pt-40">
          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="text-[42px] font-semibold leading-[1.02] tracking-[-0.034em] sm:text-[64px]"
          >
            <Hl>Hire</Hl> AI workers.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.08, ease: EASE }}
            className="mx-auto mt-5 max-w-[420px] text-[16px] text-muted-foreground"
          >
            Describe the job. It runs. You approve.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.18, ease: EASE }}
            className="mt-9"
          >
            <V3Composer
              compact
              fillSignal={fill}
              heading="Start with one job."
              placeholder="Tell Emily one job to handle..."
            />
          </motion.div>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.36 }}
            className="mt-4 flex flex-wrap items-center justify-center gap-2"
          >
            {PILLS.map((p) => (
              <button
                key={p.label}
                type="button"
                onClick={() => setFill((f) => ({ text: p.prompt, n: (f?.n ?? 0) + 1 }))}
                className="rounded-full bg-secondary px-3.5 py-1.5 text-[12px] font-medium text-foreground/70 transition-colors hover:bg-[var(--bg-3)] hover:text-foreground"
              >
                {p.label}
              </button>
            ))}
          </motion.div>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.46 }}
            className="mx-auto mt-8 flex flex-col items-center text-[12px] text-muted-foreground/90"
          >
            <span>Works without the dashboard too.</span>
            <ChannelActions />
          </motion.div>
        </section>

        {/* six marks, still */}
        <motion.section
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.5 }}
          className="flex flex-col items-center gap-4 pb-36 pt-10"
        >
          <Link href="/integrations" className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground/80 transition-colors hover:text-foreground">Connects to your tools</Link>
          <Link href="/integrations" aria-label="Browse Floom integrations" className="flex items-center justify-center gap-5 opacity-80 transition-opacity hover:opacity-100">
          {[<GmailLogo key="g" />, <SlackLogo key="s" />, <HubSpotLogo key="h" />, <NotionLogo key="n" />, <GCalLogo key="c" />, <SheetsLogo key="sh" />].map((logo, i) => (
            <span key={i} className="flex h-5 w-5 items-center justify-center grayscale-[0.2] [&_svg]:h-5 [&_svg]:w-5">{logo}</span>
          ))}
          </Link>
        </motion.section>

        <Story />

        <Templates />

        {/* close: headline + prompt box so visitors can start without scrolling back up */}
        <section className="pb-10 pt-4 text-center">
          <motion.h2
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={{ duration: 0.55, ease: EASE }}
            className="text-[30px] font-semibold tracking-[-0.03em] sm:text-[40px]"
          >
            Start with one job.
          </motion.h2>
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true }}
            transition={{ duration: 0.5, delay: 0.1, ease: EASE }}
            className="mt-8"
          >
            <V3Composer compact placeholder="Tell Emily one job to handle..." />
          </motion.div>
        </section>

    </V3Shell>
  );
}
