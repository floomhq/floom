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

import { motion, type Variants } from "motion/react";
import { Check, Hash, Lock } from "lucide-react";

const EASE_OUT: [number, number, number, number] = [0.22, 1, 0.36, 1];

const stagger: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.08, delayChildren: 0.18 } },
};
const item: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0, transition: { duration: 0.45, ease: EASE_OUT } },
};
import {
  CalendlyLogo,
  CursorLogo,
  GmailLogo,
  HubSpotLogo,
  OpenCodeLogo,
  SlackLogo,
  WhatsAppLogo,
} from "../landing-icons";

const ACCENT = "#3a6ea5";

function Card({
  app,
  logo,
  meta,
  children,
}: {
  app: string;
  logo: React.ReactNode;
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
        <span className="inline-flex h-4 w-4 shrink-0 items-center justify-center [&>svg]:h-4 [&>svg]:w-4 [&>img]:h-4 [&>img]:w-4">
          {logo}
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
    <Card app="Slack" logo={<SlackLogo />} meta="#sales">
      <div className="flex items-center gap-2 pb-3 text-muted-foreground">
        <Hash className="h-3.5 w-3.5" />
        <span className="text-[12.5px] font-semibold text-foreground">sales</span>
        <Lock className="h-3 w-3" />
        <span className="ml-auto text-[10.5px]">24 members</span>
      </div>
      <motion.div
        initial="hidden"
        whileInView="show"
        viewport={{ once: true, amount: 0.35, margin: "0px 0px -8% 0px" }}
        variants={stagger}
        className="space-y-4"
      >
        <motion.div variants={item} className="flex gap-3">
          <Avatar initial="M" tone="worker" />
          <div className="min-w-0 flex-1">
            <NameLine name="Maya Worker" time="2:14 PM" app />
            <p className="mt-0.5 text-[12.5px] leading-relaxed text-foreground">
              Drafted the Acme follow-up. Pricing answer + last call notes. Send?
            </p>
            <motion.div
              variants={item}
              className="mt-2 rounded-[10px] border border-border bg-secondary/40 px-3 py-2"
            >
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
            </motion.div>
            <motion.div variants={item} className="mt-2 flex flex-wrap gap-1.5">
              <span
                className="inline-flex h-7 items-center gap-1.5 rounded-[8px] px-3 text-[11.5px] font-semibold text-white"
                style={{ background: ACCENT }}
              >
                Approve &amp; send
              </span>
              <span className="inline-flex h-7 items-center rounded-[8px] border border-border bg-card px-3 text-[11.5px] font-medium text-foreground">
                Edit
              </span>
            </motion.div>
          </div>
        </motion.div>
        <motion.div variants={item} className="flex gap-3">
          <Avatar initial="F" tone="user" />
          <div className="min-w-0 flex-1">
            <NameLine name="Federico" time="2:14 PM" />
            <p className="mt-0.5 inline-flex items-center gap-1 text-[12.5px] text-foreground">
              <motion.span
                animate={{ scale: [1, 1.15, 1] }}
                transition={{ duration: 1.6, repeat: Infinity, ease: "easeInOut" }}
                className="inline-flex"
              >
                <Check className="h-3.5 w-3.5" style={{ color: "#1f7d57" }} />
              </motion.span>
              Approved
            </p>
          </div>
        </motion.div>
      </motion.div>
    </Card>
  );
}

/* ── WhatsApp ──────────────────────────────────────────────────────── */
function WaInBubble({ children, time }: { children: React.ReactNode; time: string }) {
  return (
    <motion.div variants={item} className="flex justify-start">
      <div
        className="relative max-w-[82%] rounded-[7px] rounded-tl-[2px] px-2.5 py-1.5 text-[12px] leading-snug"
        style={{
          background: "#FFFFFF",
          color: "#111B21",
          boxShadow: "0 1px 0.5px rgba(0,0,0,0.13)",
        }}
      >
        <div>{children}</div>
        <div
          className="mt-0.5 text-right font-mono text-[9.5px]"
          style={{ color: "rgba(0,0,0,0.45)" }}
        >
          {time}
        </div>
      </div>
    </motion.div>
  );
}

function WaOutBubble({ children, time }: { children: React.ReactNode; time: string }) {
  return (
    <motion.div variants={item} className="flex justify-end">
      <div
        className="max-w-[82%] rounded-[7px] rounded-tr-[2px] px-2.5 py-1.5 text-[12px] leading-snug"
        style={{
          background: "#D9FDD3",
          color: "#111B21",
          boxShadow: "0 1px 0.5px rgba(0,0,0,0.13)",
        }}
      >
        <div>{children}</div>
        <div
          className="mt-0.5 flex items-center justify-end gap-1 text-right font-mono text-[9.5px]"
          style={{ color: "rgba(0,0,0,0.45)" }}
        >
          {time}
          <span style={{ color: "#53BDEB" }}>✓✓</span>
        </div>
      </div>
    </motion.div>
  );
}

function WhatsAppMockup() {
  return (
    <Card app="WhatsApp" logo={<WhatsAppLogo />} meta="DM">
      <div className="overflow-hidden rounded-[10px] border border-border">
        {/* Green chat header */}
        <div
          className="flex items-center gap-2.5 px-3 py-2"
          style={{ background: "#075E54" }}
        >
          <span
            aria-hidden
            className="grid h-8 w-8 place-items-center rounded-full text-[12px] font-semibold"
            style={{ background: "#25D366", color: "#FFFFFF" }}
          >
            N
          </span>
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold text-white">Nova Worker</div>
            <div className="text-[10.5px]" style={{ color: "rgba(255,255,255,0.78)" }}>
              online
            </div>
          </div>
        </div>
        {/* Chat surface */}
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.35, margin: "0px 0px -8% 0px" }}
          variants={stagger}
          className="space-y-1.5 px-3 py-3"
          style={{
            background: "#ECE5DD",
            backgroundImage:
              "radial-gradient(circle at 25% 30%, rgba(255,255,255,0.35) 0, transparent 35%), radial-gradient(circle at 75% 70%, rgba(0,0,0,0.03) 0, transparent 35%)",
          }}
        >
          <WaInBubble time="9:02">
            Weekly pipeline summary is ready. 23 new deals, 4 need a nudge, 2 stuck &gt; 7 days.
          </WaInBubble>
          <WaInBubble time="9:02">Want the action items, or the full breakdown?</WaInBubble>
          <WaOutBubble time="9:03">Action items</WaOutBubble>
          <WaInBubble time="9:03">
            <ol className="m-0 list-decimal pl-4 leading-[1.55]">
              <li>Ping Acme on pricing</li>
              <li>Reschedule Tara&apos;s demo</li>
              <li>Forward Q4 deck to Notion</li>
            </ol>
          </WaInBubble>
        </motion.div>
      </div>
    </Card>
  );
}

/* ── Coding agent (Claude Code) ────────────────────────────────────── */
function ToolCall({
  verb,
  tool,
  detail,
}: {
  verb: string;
  tool: string;
  detail?: string;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-[4px] border px-2 py-1 text-[10.5px]"
      style={{
        borderColor: "#2a2a2a",
        background: "#181818",
        color: "#9aa0a6",
      }}
    >
      <span style={{ color: "#7ee0a7" }}>●</span>
      <span style={{ color: "#D97757" }} className="font-semibold">
        {verb}
      </span>
      <span style={{ color: "#c8c8c8" }}>{tool}</span>
      {detail && (
        <span className="ml-auto truncate" style={{ color: "#6c6c6c" }}>
          {detail}
        </span>
      )}
    </div>
  );
}

function CodingAgentMockup() {
  return (
    <Card
      app="Claude Code"
      logo={<img src="/agent-logos/claude-code.png" alt="" width={16} height={16} />}
      meta="agent"
    >
      <div
        className="overflow-hidden rounded-[10px]"
        style={{ background: "#0F0F0F", border: "1px solid #232323" }}
      >
        {/* Top bar */}
        <div
          className="flex items-center gap-2 px-3 py-1.5"
          style={{ borderBottom: "1px solid #1f1f1f" }}
        >
          <span className="inline-flex h-2 w-2 rounded-full" style={{ background: "#ff5f56" }} />
          <span className="inline-flex h-2 w-2 rounded-full" style={{ background: "#ffbd2e" }} />
          <span className="inline-flex h-2 w-2 rounded-full" style={{ background: "#27c93f" }} />
          <span
            className="ml-2 font-mono text-[10px]"
            style={{ color: "#6c6c6c" }}
          >
            ~/workeros · claude
          </span>
        </div>
        {/* Conversation */}
        <motion.div
          initial="hidden"
          whileInView="show"
          viewport={{ once: true, amount: 0.3, margin: "0px 0px -8% 0px" }}
          variants={stagger}
          className="space-y-3 px-3 py-3 font-mono text-[11.5px] leading-relaxed"
        >
          {/* User prompt */}
          <motion.div variants={item} className="flex items-start gap-2">
            <span className="mt-0.5 text-[12px]" style={{ color: "#6c6c6c" }}>
              &gt;
            </span>
            <span style={{ color: "#c8c8c8" }}>
              Run client-follow-up for the Acme call
            </span>
          </motion.div>
          {/* Claude turn */}
          <motion.div variants={item} className="flex items-start gap-2">
            <span className="mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center [&>img]:h-3.5 [&>img]:w-3.5 [&>img]:object-contain">
              <img src="/agent-logos/claude-code.png" alt="" width={14} height={14} />
            </span>
            <motion.div
              variants={stagger}
              className="min-w-0 flex-1 space-y-2"
            >
              <motion.div variants={item} style={{ color: "#d4d4d4" }}>
                Pulling context from your tools.
              </motion.div>
              <motion.div variants={stagger} className="space-y-1">
                <motion.div variants={item}>
                  <ToolCall verb="Read" tool="Google Calendar" detail="3 calls" />
                </motion.div>
                <motion.div variants={item}>
                  <ToolCall verb="Read" tool="Company Brain" detail="tone · pricing · CRM" />
                </motion.div>
                <motion.div variants={item}>
                  <ToolCall verb="Write" tool="Gmail draft" detail="+ HubSpot note" />
                </motion.div>
              </motion.div>
              <motion.div variants={item} style={{ color: "#d4d4d4" }}>
                Output ready.{" "}
                <span style={{ color: "#7ee0a7" }}>Run #1042</span>{" "}
                <span style={{ color: "#6c6c6c" }}>·</span> approval requested in{" "}
                <span style={{ color: "#a7c4e2" }}>#sales</span>
              </motion.div>
            </motion.div>
          </motion.div>
        </motion.div>
        {/* Prompt input — caret blinks to signal a live prompt */}
        <div
          className="flex items-center gap-2 px-3 py-2 font-mono text-[11px]"
          style={{ borderTop: "1px solid #1f1f1f" }}
        >
          <span style={{ color: "#D97757" }}>&gt;</span>
          <motion.span
            aria-hidden
            animate={{ opacity: [1, 0.15, 1] }}
            transition={{ duration: 1.05, repeat: Infinity, ease: "easeInOut" }}
            className="inline-block h-3 w-[2px]"
            style={{ background: "#d4d4d4" }}
          />
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
      <div className="mt-3 border-t border-border/60 pt-2.5">
        <div className="mb-1.5 text-center text-[10.5px] uppercase tracking-[0.16em] text-muted-foreground">
          Same flow, any agent
        </div>
        <div className="flex flex-wrap items-center justify-center gap-1.5">
          {[
            {
              logo: (
                <img
                  src="/agent-logos/claude-code.png"
                  alt=""
                  width={14}
                  height={14}
                />
              ),
              label: "Claude Code",
            },
            {
              logo: (
                <img src="/agent-logos/codex.webp" alt="" width={14} height={14} />
              ),
              label: "Codex",
            },
            { logo: <CursorLogo />, label: "Cursor" },
            { logo: <OpenCodeLogo />, label: "OpenCode" },
          ].map(({ logo, label }) => (
            <span
              key={label}
              className="inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-card px-2 text-[11px] font-medium text-foreground/85"
            >
              <span className="inline-flex h-3.5 w-3.5 items-center justify-center [&>svg]:h-3.5 [&>svg]:w-3.5 [&>img]:h-3.5 [&>img]:w-3.5 [&>img]:rounded-[2px] [&>img]:object-contain">
                {logo}
              </span>
              {label}
            </span>
          ))}
        </div>
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
