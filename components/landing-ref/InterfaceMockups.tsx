"use client";

/**
 * InterfaceMockups — "Lives in your team's tools" section.
 *
 * Three side-by-side static mockups of the surfaces workers operate in:
 * Slack, WhatsApp, and a coding agent IDE (Claude Code / Cursor).
 *
 * Design system: chrome is workeros warm matte (card surface, near-black ink,
 * blue accent). Brand colors are constrained to the tiny app-name logo at the
 * top of each mockup and the user/agent avatar accents. This keeps three
 * mockups visually coherent next to each other rather than letting Slack purple
 * + WhatsApp green + IDE neon compete for attention.
 */

import { motion } from "motion/react";
import { Check, Hash, Lock } from "lucide-react";
import {
  CalendlyLogo,
  GmailLogo,
  HubSpotLogo,
  SlackLogo,
  WhatsAppLogo,
} from "../landing-icons";

const ACCENT = "#3a6ea5";

function Card({
  app,
  Logo,
  meta,
  children,
}: {
  app: string;
  Logo: () => React.ReactNode;
  meta: string;
  children: React.ReactNode;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25, margin: "0px 0px -10% 0px" }}
      transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
      className="overflow-hidden rounded-[18px] border border-border bg-card shadow-[0_18px_44px_-24px_rgba(20,20,20,0.18),0_2px_6px_-2px_rgba(20,20,20,0.05)]"
    >
      <div className="flex items-center gap-2 border-b border-border/70 bg-secondary/40 px-3 py-2">
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4">
          <Logo />
        </span>
        <span className="text-[12px] font-semibold tracking-tight text-foreground">{app}</span>
        <span className="ml-auto text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {meta}
        </span>
      </div>
      <div className="px-4 py-4">{children}</div>
    </motion.div>
  );
}

function NameLine({ name, time, app }: { name: string; time: string; app?: boolean }) {
  return (
    <div className="flex items-baseline gap-2">
      <span className="text-[13px] font-semibold text-foreground">{name}</span>
      {app && (
        <span
          className="rounded-[3px] px-1 py-[1px] text-[8.5px] font-bold uppercase tracking-wider"
          style={{
            background: "color-mix(in srgb, #3a6ea5 14%, transparent)",
            color: "#1f4870",
          }}
        >
          Worker
        </span>
      )}
      <span className="font-mono text-[10px] text-muted-foreground">{time}</span>
    </div>
  );
}

function Avatar({ initial, tone }: { initial: string; tone: "worker" | "user" }) {
  return (
    <span
      aria-hidden
      className="grid h-8 w-8 shrink-0 place-items-center rounded-[8px] text-[12px] font-semibold text-white"
      style={{
        background:
          tone === "worker"
            ? `linear-gradient(140deg, ${ACCENT} 0%, #29547e 100%)`
            : "linear-gradient(140deg, var(--ink) 0%, var(--ink-soft) 100%)",
      }}
    >
      {initial}
    </span>
  );
}

/* ── Slack ─────────────────────────────────────────────────────────── */
function SlackMockup() {
  return (
    <Card app="Slack" Logo={SlackLogo} meta="#sales">
      <div className="flex items-center gap-2 pb-3 text-muted-foreground">
        <Hash className="h-3.5 w-3.5" />
        <span className="text-[12.5px] font-semibold text-foreground">sales</span>
        <Lock className="h-3 w-3" />
        <span className="ml-auto text-[10.5px]">24 members</span>
      </div>
      <div className="space-y-4">
        <div className="flex gap-3">
          <Avatar initial="M" tone="worker" />
          <div className="min-w-0 flex-1">
            <NameLine name="Maya Worker" time="2:14 PM" app />
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-foreground">
              Drafted the Acme follow-up. Pricing answer + last call notes. Send?
            </p>
            <div className="mt-2 rounded-[10px] border border-border bg-secondary/40 px-3 py-2">
              <div className="flex items-center gap-1.5 text-[10.5px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <span className="inline-flex h-3 w-3 items-center justify-center [&>svg]:h-3 [&>svg]:w-3">
                  <GmailLogo />
                </span>
                Email draft
              </div>
              <div className="mt-0.5 truncate text-[12px] font-semibold text-foreground">
                Next steps from today&apos;s call
              </div>
              <p className="mt-0.5 line-clamp-1 text-[11.5px] text-muted-foreground">
                Hi Sarah, thanks for the call. Based on what you shared, I&apos;d…
              </p>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span
                className="inline-flex h-7 items-center gap-1.5 rounded-[8px] px-3 text-[11.5px] font-semibold text-white"
                style={{ background: ACCENT }}
              >
                Approve &amp; send
              </span>
              <span className="inline-flex h-7 items-center rounded-[8px] border border-border bg-card px-3 text-[11.5px] font-medium text-foreground">
                Edit
              </span>
            </div>
          </div>
        </div>
        <div className="flex gap-3">
          <Avatar initial="F" tone="user" />
          <div className="min-w-0 flex-1">
            <NameLine name="Federico" time="2:14 PM" />
            <p className="mt-0.5 inline-flex items-center gap-1 text-[12.5px] text-foreground">
              <Check className="h-3.5 w-3.5" style={{ color: "#1f7d57" }} />
              Approved
            </p>
          </div>
        </div>
      </div>
    </Card>
  );
}

/* ── WhatsApp ──────────────────────────────────────────────────────── */
function Bubble({
  side,
  children,
  meta,
}: {
  side: "left" | "right";
  children: React.ReactNode;
  meta: string;
}) {
  const isUser = side === "right";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className="max-w-[88%] rounded-[12px] px-3 py-2 text-[12.5px] leading-relaxed shadow-[0_1px_0_rgba(0,0,0,0.04)]"
        style={{
          background: isUser
            ? "color-mix(in srgb, #3a6ea5 12%, transparent)"
            : "var(--bg-card)",
          border: isUser
            ? "1px solid color-mix(in srgb, #3a6ea5 26%, transparent)"
            : "1px solid var(--border-default)",
          color: "var(--ink)",
        }}
      >
        <div>{children}</div>
        <div className="mt-1 text-right font-mono text-[9.5px] text-muted-foreground">{meta}</div>
      </div>
    </div>
  );
}

function WhatsAppMockup() {
  return (
    <Card app="WhatsApp" Logo={WhatsAppLogo} meta="DM">
      <div className="flex items-center gap-2 pb-3">
        <Avatar initial="N" tone="worker" />
        <div>
          <div className="text-[12.5px] font-semibold text-foreground">Nova Worker</div>
          <div className="text-[10.5px] text-muted-foreground">Online</div>
        </div>
      </div>
      <div className="space-y-2">
        <Bubble side="left" meta="9:02">
          Weekly pipeline summary is ready. 23 new deals, 4 need a nudge, 2 are
          stuck &gt; 7 days.
        </Bubble>
        <Bubble side="left" meta="9:02">
          Want the action items, or the full breakdown?
        </Bubble>
        <Bubble side="right" meta="9:03 ✓✓">
          Action items
        </Bubble>
        <Bubble side="left" meta="9:03">
          <ol className="m-0 list-decimal pl-4 leading-[1.6]">
            <li>Ping Acme on pricing</li>
            <li>Reschedule Tara&apos;s demo</li>
            <li>Forward Q4 deck to Notion</li>
          </ol>
        </Bubble>
      </div>
    </Card>
  );
}

/* ── Coding agent (Claude Code / Cursor) ───────────────────────────── */
function CodexMark() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
      <rect x="2" y="3" width="20" height="18" rx="3" fill="#181818" />
      <path
        d="M7 9l-2.2 2.2a.8.8 0 0 0 0 1.1L7 14.5"
        stroke="#a7c4e2"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M14 9l2.2 2.2a.8.8 0 0 1 0 1.1L14 14.5"
        stroke="#a7c4e2"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
      <line
        x1="12"
        y1="8"
        x2="9.5"
        y2="16"
        stroke="#a7c4e2"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function CodingAgentMockup() {
  return (
    <Card app="Claude Code · Cursor" Logo={CodexMark} meta="terminal">
      <div className="rounded-[10px] border border-border bg-[#161616] p-3 font-mono text-[11.5px] leading-relaxed text-[#d4d4d4]">
        <div className="flex items-center gap-2 pb-2 text-[10px] text-[#888]">
          <span className="inline-flex h-2 w-2 rounded-full bg-[#ff5f56]" />
          <span className="inline-flex h-2 w-2 rounded-full bg-[#ffbd2e]" />
          <span className="inline-flex h-2 w-2 rounded-full bg-[#27c93f]" />
          <span className="ml-1">workeros · client-follow-up</span>
        </div>
        <div>
          <span className="text-[#7ee0a7]">$</span> workeros run client-follow-up{" "}
          <span className="text-[#a7c4e2]">--ctx acme</span>
        </div>
        <div className="mt-1 text-[#9aa0a6]">
          <span className="text-[#9d6df1]">→</span> Reading Google Calendar · 3 calls
        </div>
        <div className="text-[#9aa0a6]">
          <span className="text-[#9d6df1]">→</span> Loading brain (tone, pricing, CRM rules)
        </div>
        <div className="text-[#9aa0a6]">
          <span className="text-[#9d6df1]">→</span> Drafting email + CRM note…
        </div>
        <div className="mt-1 text-[#7ee0a7]">
          ✓ Output ready · <span className="text-[#d4d4d4]">Run #1042</span>
        </div>
        <div className="mt-0.5 text-[#9aa0a6]">
          Awaiting approval in <span className="text-[#a7c4e2]">#sales</span>
        </div>
      </div>
      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="inline-flex h-3 w-3 items-center justify-center [&>svg]:h-3 [&>svg]:w-3">
            <CalendlyLogo />
          </span>
          Triggered by Calendly
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-flex h-3 w-3 items-center justify-center [&>svg]:h-3 [&>svg]:w-3">
            <HubSpotLogo />
          </span>
          Wrote to HubSpot
        </span>
      </div>
    </Card>
  );
}

export function InterfaceMockups() {
  return (
    <section
      id="interfaces"
      className="scroll-mt-20 border-y border-border/60 bg-secondary/30 px-6 py-20"
    >
      <div className="mx-auto max-w-6xl">
        <div className="mx-auto mb-12 max-w-2xl text-center">
          <div className="mb-3 inline-flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
            <span aria-hidden="true" className="h-px w-6 bg-foreground/20" />
            Lives in your team&apos;s tools
          </div>
          <h2 className="text-balance text-[32px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[40px]">
            The worker shows up where you already work.
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-base text-muted-foreground">
            Slack, WhatsApp, your IDE. Approve, edit, redirect. The worker handles the rest.
          </p>
        </div>
        <div className="grid gap-5 lg:grid-cols-3">
          <SlackMockup />
          <WhatsAppMockup />
          <CodingAgentMockup />
        </div>
      </div>
    </section>
  );
}
