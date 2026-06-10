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
import { StatusPill } from "@/components/landing-ref/StatusPill";
import {
  GCalLogo,
  GmailLogo,
  HubSpotLogo,
  NotionLogo,
  SheetsLogo,
  SlackLogo,
} from "@/components/landing-icons";
import { V3Composer } from "./V3Composer";
import "./theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/* ───────────────────────── nav ───────────────────────── */

function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="Workeros" style={{ borderRadius: "27%" }}>
      <rect width="100" height="100" rx="24" fill="var(--primary)" />
      <path d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z" fill="var(--primary-text)" />
    </svg>
  );
}

/* ───────────────── the one story: four beats ───────────────── */

const BEATS = [
  {
    t: "Describe the job",
    p: "One sentence, plain English. Workeros recognises your tools as you type.",
  },
  {
    t: "It drafts the worker",
    p: "Tools, schedule, and your company brain, assembled for your review.",
  },
  {
    t: "You approve",
    p: "Nothing ships without your yes. In Slack, WhatsApp, or here.",
  },
  {
    t: "It runs, on the record",
    p: "Background work, every run auditable. The output lands where you already are.",
  },
];

/* beat visuals: the ARTIFACT, not the chrome */

function BeatDescribe() {
  return (
    <div className="w-full max-w-[420px] rounded-[16px] bg-card p-5">
      <div className="text-[15px] leading-relaxed">
        Summarise my <span className="v3-hl">Granola</span> meetings and post action items to{" "}
        <span className="v3-hl">HubSpot</span> daily
        <motion.span
          aria-hidden
          animate={{ opacity: [1, 0.1, 1] }}
          transition={{ duration: 1.05, repeat: Infinity }}
          className="ml-px inline-block h-[15px] w-[1.5px] translate-y-[2px] bg-foreground"
        />
      </div>
    </div>
  );
}

function BeatDraft() {
  return (
    <div className="w-full max-w-[420px] rounded-[16px] bg-card p-5">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-medium">Meeting Digest</span>
        <StatusPill tone="pending">Draft</StatusPill>
      </div>
      <div className="mt-4 space-y-2.5 text-[13px] text-muted-foreground">
        {["Reads Granola and Calendar", "Writes HubSpot notes", "Uses your tone guide", "Daily at 5:00 PM"].map((line, i) => (
          <motion.div
            key={line}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 0.15 + i * 0.12, duration: 0.4 }}
            className="flex items-center gap-2.5"
          >
            <Check className="h-3.5 w-3.5" style={{ color: "var(--v3-accent)" }} />
            {line}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function BeatApprove() {
  return (
    <div className="w-full max-w-[420px] rounded-[16px] bg-card p-5">
      <div className="text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Email draft · to Sarah at Acme</div>
      <div className="mt-2.5 text-[14.5px] font-medium">Next steps from today&apos;s call</div>
      <p className="mt-1.5 text-[13px] leading-relaxed text-muted-foreground">
        Hi Sarah, thanks for the call today. Based on what you shared, I&apos;d suggest starting with the onboarding workflow…
      </p>
      <div className="mt-4 flex gap-2">
        <span className="rounded-[10px] px-3.5 py-1.5 text-[12.5px] font-medium text-white" style={{ background: "var(--v3-accent)" }}>Approve</span>
        <span className="rounded-[10px] border border-border bg-card px-3.5 py-1.5 text-[12.5px]">Edit</span>
      </div>
    </div>
  );
}

function BeatRecord() {
  return (
    <div className="w-full max-w-[420px] rounded-[16px] bg-card p-5">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-medium">This week</span>
        <span className="font-mono text-[10.5px] text-muted-foreground">5 runs</span>
      </div>
      <div className="mt-3.5 space-y-px">
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
            className="flex items-center gap-3 border-b border-border-soft py-2 text-[13px] last:border-0"
          >
            <span className="w-11 font-mono text-[10.5px] text-muted-foreground">{d as string}</span>
            <span className="flex-1 text-muted-foreground">{s as string}</span>
            {done ? (
              <Check className="h-3.5 w-3.5 text-muted-foreground/60" />
            ) : (
              <span className="h-2 w-2 rounded-full" style={{ background: "var(--v3-accent)" }} />
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

  const VIS = [BeatDescribe, BeatDraft, BeatApprove, BeatRecord];

  return (
    <section className="pb-40">
      <div className="grid gap-16 md:grid-cols-[1fr_1.05fr]">
        <div className="flex flex-col justify-center">
          {BEATS.map((b, i) => (
            <div
              key={b.t}
              data-beat={i}
              ref={(el) => { refs.current[i] = el; }}
              className="flex min-h-[180px] cursor-default flex-col justify-center py-3 md:min-h-[150px]"
              onMouseEnter={() => setActive(i)}
            >
              <h3 className={`text-[28px] font-semibold tracking-[-0.022em] transition-colors duration-300 ${active === i ? "text-foreground" : "text-foreground md:text-muted-foreground/40"}`}>
                {b.t}
              </h3>
              <p className={`mt-2 max-w-[360px] text-[14px] leading-relaxed text-muted-foreground transition-opacity duration-300 ${active === i ? "opacity-100" : "opacity-100 md:opacity-40"}`}>
                {b.p}
              </p>
              <div className="mt-5 flex justify-center rounded-[18px] bg-secondary/70 p-6 md:hidden">
                {i === 0 ? <BeatDescribe /> : i === 1 ? <BeatDraft /> : i === 2 ? <BeatApprove /> : <BeatRecord />}
              </div>
            </div>
          ))}
        </div>
        <div className="hidden md:sticky md:top-24 md:block md:h-[460px]">
          <div className="flex h-full items-center justify-center rounded-[22px] bg-secondary/70 p-9">
            <AnimatePresence mode="wait">
              {VIS.map((V, i) =>
                active === i ? (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -6 }}
                    transition={{ duration: 0.3, ease: EASE }}
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

/* ───────────────── templates: three flat cards ───────────────── */

const TPLS = [
  { nm: "Client Follow-up", d: "Drafts the email after every call. CRM note included.", runs: "2,140 runs" },
  { nm: "Monday Report", d: "Pipeline summary in #sales, Mondays at 9.", runs: "1,080 runs" },
  { nm: "Lead Research", d: "Five inbound leads briefed before your first meeting.", runs: "960 runs" },
];

function Templates() {
  return (
    <section className="pb-40">
      <motion.h2
        initial={{ opacity: 0, y: 12 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true, amount: 0.4 }}
        transition={{ duration: 0.5, ease: EASE }}
        className="text-[32px] font-semibold tracking-[-0.025em]"
      >
        Or start from one that works.
      </motion.h2>
      <div className="mt-9 grid gap-3.5 md:grid-cols-3">
        {TPLS.map((t, i) => (
          <motion.div
            key={t.nm}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.45, delay: i * 0.07, ease: EASE }}
          >
            <Link
              href="/v2/templates"
              className="flex h-full flex-col rounded-[16px] bg-card p-6 transition-colors hover:bg-secondary/70"
            >
              <div className="text-[15px] font-medium">{t.nm}</div>
              <p className="mt-2 flex-1 text-[13px] leading-relaxed text-muted-foreground">{t.d}</p>
              <div className="mt-5 font-mono text-[10.5px] text-muted-foreground">{t.runs}</div>
            </Link>
          </motion.div>
        ))}
      </div>
      <motion.div
        initial={{ opacity: 0 }}
        whileInView={{ opacity: 1 }}
        viewport={{ once: true }}
        transition={{ duration: 0.5, delay: 0.2 }}
        className="mt-5 text-[13px]"
      >
        <Link href="/v2/templates" className="text-muted-foreground transition-colors hover:text-foreground">
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
    <div className="theme-v3 min-h-screen text-[13.5px]" style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}>
      <div className="mx-auto max-w-[1000px] px-7">

        {/* nav: mark, name, sign in. that's it */}
        <nav className="flex h-[64px] items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 text-[14px] font-semibold">
            <Mark />
            Workeros
          </Link>
          <div className="flex items-center gap-0.5 text-[13px] text-muted-foreground">
            <Link href="/v2/templates" className="rounded-[10px] px-3 py-1.5 transition-colors hover:bg-secondary hover:text-foreground">Templates</Link>
            <Link href="/v2/docs" className="rounded-[10px] px-3 py-1.5 transition-colors hover:bg-secondary hover:text-foreground">Docs</Link>
            <Link href="/login" className="ml-1 rounded-[10px] px-3 py-1.5 transition-colors hover:bg-secondary hover:text-foreground">Sign in</Link>
          </div>
        </nav>

        {/* hero: headline, one line, the jewel, three pills */}
        <section className="pb-16 pt-40 text-center">
          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="text-[64px] font-semibold leading-[1.02] tracking-[-0.034em]"
          >
            Hire AI workers.
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
            className="mt-11"
          >
            <V3Composer fillSignal={fill} />
          </motion.div>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.36 }}
            className="mt-6 flex flex-wrap items-center justify-center gap-2"
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
          <motion.p
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ duration: 0.5, delay: 0.46 }}
            className="mx-auto mt-9 text-[12.5px] text-muted-foreground"
          >
            Works without the dashboard too:{" "}
            <Link href="/login?install=slack" className="text-foreground/70 underline-offset-4 transition-colors hover:text-foreground hover:underline">Slack</Link>,{" "}
            <Link href="/login?install=whatsapp" className="text-foreground/70 underline-offset-4 transition-colors hover:text-foreground hover:underline">WhatsApp</Link>, or any{" "}
            <Link href="/v2/docs#mcp" className="text-foreground/70 underline-offset-4 transition-colors hover:text-foreground hover:underline">MCP agent</Link>.
          </motion.p>
        </section>

        {/* six marks, still */}
        <motion.section
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.7, delay: 0.5 }}
          className="flex items-center justify-center gap-5 pb-36 pt-10 opacity-80"
        >
          {[<GmailLogo key="g" />, <SlackLogo key="s" />, <HubSpotLogo key="h" />, <NotionLogo key="n" />, <GCalLogo key="c" />, <SheetsLogo key="sh" />].map((logo, i) => (
            <span key={i} className="flex h-5 w-5 items-center justify-center grayscale-[0.2] [&_svg]:h-5 [&_svg]:w-5">{logo}</span>
          ))}
        </motion.section>

        <Story />

        <Templates />

        {/* close: headline + one button */}
        <section className="pb-36 pt-4 text-center">
          <motion.h2
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.5 }}
            transition={{ duration: 0.55, ease: EASE }}
            className="text-[40px] font-semibold tracking-[-0.03em]"
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
            <Link
              href="/app/workers/new"
              className="inline-flex items-center gap-2 rounded-[12px] px-6 py-3 text-[14.5px] font-medium text-white"
              style={{ background: "var(--v3-accent)" }}
            >
              Hire your first worker
            </Link>
          </motion.div>
        </section>
      </div>

      {/* one line */}
      <footer className="border-t border-border-soft">
        <div className="mx-auto flex max-w-[1000px] items-center justify-between px-7 py-6 text-[12px] text-muted-foreground">
          <span>Workeros by Floom · Backed by Founders Inc</span>
          <span className="flex gap-4">
            <Link href="/v2/templates" className="hover:text-foreground">Templates</Link>
            <Link href="/v2/docs" className="hover:text-foreground">Docs</Link>
            <Link href="/privacy" className="hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="hover:text-foreground">Terms</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
