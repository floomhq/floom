"use client";

/**
 * V2 sections: Lovable-clean HowItWorks, real AppFrame ("what you get"),
 * upgraded BuiltIn, V2Footer. All framer-motion, all on the v2 token system.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import {
  Brain,
  CheckCircle2,
  Layers,
  LayoutGrid,
  MessageCircleMore,
  Play,
  Plug2,
  Search,
} from "lucide-react";
import { StatusPill } from "@/components/landing-ref/StatusPill";
import {
  GCalLogo,
  GmailLogo,
  HubSpotLogo,
  NotionLogo,
  SheetsLogo,
  SlackLogo,
  WhatsAppLogo,
  GitHubSVG,
} from "@/components/landing-icons";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

/* flat v2 tool chip: squircle tile + label, hairline, no shadows */
const TOOL_LOGOS: Record<string, React.ReactNode> = {
  gmail: <GmailLogo />,
  slack: <SlackLogo />,
  hubspot: <HubSpotLogo />,
  notion: <NotionLogo />,
  calendar: <GCalLogo />,
  "google calendar": <GCalLogo />,
  sheets: <SheetsLogo />,
  "google sheets": <SheetsLogo />,
  github: <span className="text-foreground"><GitHubSVG /></span>,
  whatsapp: <WhatsAppLogo />,
};

export function V2ToolChip({ tool }: { tool: string }) {
  const logo = TOOL_LOGOS[tool.toLowerCase()];
  return (
    <span className="inline-flex h-6 items-center gap-1.5 rounded-[7px] bg-secondary px-1.5 pr-2 text-[11px] font-medium text-foreground/75">
      {logo && <span className="flex h-3 w-3 items-center justify-center [&_svg]:h-3 [&_svg]:w-3">{logo}</span>}
      {tool}
    </span>
  );
}

export function RevealUp({
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
      initial={{ opacity: 0, y: 16 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.25, margin: "0px 0px -8% 0px" }}
      transition={{ duration: 0.55, delay, ease: EASE }}
      className={className}
    >
      {children}
    </motion.div>
  );
}

export function SectionHead({ title, sub }: { title: string; sub?: string }) {
  return (
    <RevealUp>
      <h2 className="text-[32px] font-semibold leading-[1.08] tracking-[-0.025em]">{title}</h2>
      {sub && <p className="mt-2 text-[14px] text-muted-foreground">{sub}</p>}
    </RevealUp>
  );
}

/* ================= HOW IT WORKS — Lovable pattern ================= */

const STEPS = [
  {
    t: "Describe the job",
    p: "One sentence, plain English. Workeros recognises your tools as you type.",
  },
  {
    t: "Watch it draft the worker",
    p: "Tools, schedule, approval rules and your company brain, assembled for review.",
  },
  {
    t: "Approve and let it run",
    p: "It works in the background and asks before anything ships externally.",
  },
];

function VisComposer() {
  return (
    <div className="w-full max-w-[440px] rounded-[14px] bg-card p-4">
      <div className="text-[13.5px] leading-relaxed">
        Summarise my <span className="v2-hl">Granola</span> meetings and post action items to{" "}
        <span className="v2-hl">HubSpot</span> daily
        <motion.span
          aria-hidden
          animate={{ opacity: [1, 0.1, 1] }}
          transition={{ duration: 1.05, repeat: Infinity }}
          className="ml-px inline-block h-[14px] w-[1.5px] translate-y-[2px] bg-foreground"
        />
      </div>
      <div className="mt-4 flex items-center justify-between border-t border-border-soft pt-3">
        <span className="font-mono text-[11px] text-muted-foreground">⌘ ↵</span>
        <span className="rounded-[10px] px-3 py-1.5 text-[12.5px] font-medium text-white" style={{ background: "var(--v2-accent)" }}>
          Hire this worker
        </span>
      </div>
    </div>
  );
}

function VisDraft() {
  return (
    <div className="w-full max-w-[440px] overflow-hidden rounded-[14px] bg-card">
      <div className="flex items-center gap-2.5 border-b border-border-soft px-4 py-3">
        <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[8px] bg-[var(--bg-3)] text-[10.5px] font-semibold text-foreground/80">MD</span>
        <span className="text-[13px] font-semibold">Meeting Digest Worker</span>
        <span className="ml-auto"><StatusPill tone="pending">Draft</StatusPill></span>
      </div>
      {[
        ["Reads", <span key="r" className="flex items-center justify-end gap-1.5">Granola · <span className="[&_svg]:h-3 [&_svg]:w-3"><GCalLogo /></span> Calendar</span>],
        ["Writes", <span key="w" className="flex items-center justify-end gap-1.5"><span className="[&_svg]:h-3 [&_svg]:w-3"><HubSpotLogo /></span> HubSpot notes</span>],
        ["Brain", "Tone guide · CRM rules"],
        ["Approval", "Required before anything ships"],
      ].map(([k, v], i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: 6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.12 + i * 0.09, duration: 0.35, ease: EASE }}
          className="flex items-start justify-between gap-3 border-b border-border-soft px-4 py-2.5 text-[12.5px] last:border-0"
        >
          <span className="pt-px text-[10.5px] uppercase tracking-[0.05em] text-muted-foreground">{k as string}</span>
          <span className="text-right text-foreground/80">{v}</span>
        </motion.div>
      ))}
      <div className="flex justify-end gap-2 border-t border-border-soft px-4 py-2.5">
        <span className="rounded-[10px] border border-border bg-card px-3 py-1.5 text-[12px]">Edit</span>
        <span className="rounded-[10px] px-3 py-1.5 text-[12px] font-medium text-white" style={{ background: "var(--v2-accent)" }}>Hire</span>
      </div>
    </div>
  );
}

function VisRuns() {
  return (
    <div className="w-full max-w-[440px] overflow-hidden rounded-[14px] bg-card">
      <div className="flex items-center justify-between border-b border-border-soft px-4 py-3">
        <span className="text-[13px] font-semibold">Runs</span>
        <span className="font-mono text-[10.5px] text-muted-foreground">last 3 days</span>
      </div>
      {[
        { t: "Today, 5:00 PM", s: "Output ready · 12 action items", pill: <StatusPill tone="pending">Awaiting you</StatusPill> },
        { t: "Yesterday, 5:00 PM", s: "Approved · posted to HubSpot", pill: <StatusPill tone="success">Done</StatusPill> },
        { t: "Monday, 5:00 PM", s: "Approved · posted to HubSpot", pill: <StatusPill tone="success">Done</StatusPill> },
      ].map((r, i) => (
        <motion.div
          key={i}
          initial={{ opacity: 0, x: 6 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ delay: 0.12 + i * 0.09, duration: 0.35, ease: EASE }}
          className="flex h-[58px] items-center gap-3 border-b border-border-soft px-4 last:border-0"
        >
          <span className="flex h-[28px] w-[28px] items-center justify-center rounded-[8px] bg-[var(--bg-3)] text-[10.5px] font-semibold text-foreground/80">MD</span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12.5px] font-medium">{r.t}</div>
            <div className="truncate text-[11.5px] text-muted-foreground">{r.s}</div>
          </div>
          {r.pill}
        </motion.div>
      ))}
    </div>
  );
}

export function HowItWorks() {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (es) => {
        es.forEach((e) => {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.step));
        });
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    refs.current.forEach((r) => r && io.observe(r));
    return () => io.disconnect();
  }, []);

  const VIS = [VisComposer, VisDraft, VisRuns];

  return (
    <section id="how" className="pb-32">
      <SectionHead title="Meet your first worker." />
      <div className="mt-10 grid gap-14 md:grid-cols-[1.05fr_1fr]">
        {/* Lovable: ONE soft rounded panel, visual centered inside */}
        <div className="hidden md:sticky md:top-20 md:block md:h-[480px]">
          <div className="flex h-full items-center justify-center rounded-[20px] bg-secondary/70 p-8">
            <AnimatePresence mode="wait">
              {VIS.map((V, i) =>
                active === i ? (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.32, ease: EASE }}
                    className="w-full"
                    style={{ display: "flex", justifyContent: "center" }}
                  >
                    <V />
                  </motion.div>
                ) : null,
              )}
            </AnimatePresence>
          </div>
        </div>
        {/* Lovable: just big bold headings, no labels, no rails */}
        <div className="flex flex-col justify-center">
          {STEPS.map((s, i) => (
            <div
              key={s.t}
              data-step={i}
              ref={(el) => { refs.current[i] = el; }}
              className="flex min-h-[200px] cursor-default flex-col justify-center py-3 md:min-h-[160px]"
              onMouseEnter={() => setActive(i)}
            >
              <h3 className={`text-[29px] font-semibold tracking-[-0.022em] transition-colors duration-300 ${active === i ? "text-foreground" : "text-muted-foreground/50"}`}>
                {s.t}
              </h3>
              <p className={`mt-2 max-w-[380px] text-[14px] leading-relaxed text-muted-foreground transition-opacity duration-300 ${active === i ? "opacity-100" : "opacity-45"}`}>
                {s.p}
              </p>
              {/* mobile inline visual */}
              <div className="mt-5 flex justify-center rounded-[16px] bg-secondary/70 p-5 md:hidden">
                {i === 0 ? <VisComposer /> : i === 1 ? <VisDraft /> : <VisRuns />}
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

/* ================= WHAT YOU GET — real app frame ================= */

const NAV_ITEMS = [
  { icon: LayoutGrid, label: "Overview" },
  { icon: MessageCircleMore, label: "Assistant" },
  { icon: Layers, label: "Workers", on: true },
  { icon: Brain, label: "Brain" },
  { icon: Play, label: "Runs" },
  { icon: CheckCircle2, label: "Approvals", badge: 2 },
  { icon: Plug2, label: "Connections" },
];

const APP_WORKERS = [
  { av: "WU", nm: "Weekly Update", d: "Turns raw notes into a polished weekly company update.", st: "ok" as const, meta: "5d ago", tools: [<NotionLogo key="n" />, <GmailLogo key="g" />] },
  { av: "CF", nm: "Client Follow-up", d: "Drafts follow-up emails after calls, adds CRM notes.", st: "warn" as const, meta: "needs you", tools: [<GmailLogo key="g" />, <HubSpotLogo key="h" />] },
  { av: "GD", nm: "GitHub Digest", d: "Every morning at 9am, a digest of unread PRs and issues.", st: "run" as const, meta: "running", tools: [<GitHubSVG key="gh" />, <SlackLogo key="s" />] },
  { av: "PB", nm: "Pipeline Brief", d: "Weekly pipeline summary posted in #sales.", st: "ok" as const, meta: "3d ago", tools: [<SheetsLogo key="sh" />, <SlackLogo key="s" />] },
];

export function AppFrame({ standalone = false }: { standalone?: boolean }) {
  return (
    <section id="product" className="pb-32">
      {!standalone && (
        <SectionHead
          title="The cockpit behind every worker."
          sub="What you see when you sign in: the team, the runs, the approvals waiting on you."
        />
      )}
      <RevealUp delay={0.1} className={standalone ? "" : "mt-9"}>
        <div className="overflow-hidden rounded-[16px] bg-card">
          <div className="flex">
            {/* sidebar */}
            <div className="hidden w-[190px] shrink-0 flex-col border-r border-border-soft bg-[var(--bg-app)] py-3 sm:flex">
              <div className="flex items-center gap-2 px-4 pb-3">
                <span className="flex h-5 w-5 items-center justify-center rounded-[6px] bg-primary">
                  <svg width="11" height="11" viewBox="0 0 100 100"><path d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z" fill="var(--primary-text)" /></svg>
                </span>
                <span className="text-[12.5px] font-semibold">WorkerOS</span>
              </div>
              <div className="flex flex-col gap-px px-2.5">
                {NAV_ITEMS.map((n) => (
                  <div key={n.label} className={`flex items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-[12px] ${n.on ? "bg-secondary font-medium text-foreground" : "text-muted-foreground"}`}>
                    <n.icon className="h-[14px] w-[14px] opacity-70" />
                    {n.label}
                    {n.badge && <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[9.5px] font-semibold text-primary-foreground">{n.badge}</span>}
                  </div>
                ))}
              </div>
            </div>
            {/* main */}
            <div className="min-w-0 flex-1 p-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-[17px] font-semibold tracking-[-0.01em]">Workers</div>
                  <div className="text-[11.5px] text-muted-foreground">8 active · 1 needs your approval</div>
                </div>
                <span className="rounded-[10px] bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground">+ New worker</span>
              </div>
              <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
                {APP_WORKERS.map((w, i) => (
                  <motion.div
                    key={w.nm}
                    initial={{ opacity: 0, y: 8 }}
                    whileInView={{ opacity: 1, y: 0 }}
                    viewport={{ once: true }}
                    transition={{ delay: i * 0.06, duration: 0.4, ease: EASE }}
                    className="rounded-[12px] bg-[var(--bg-app)] p-3.5 transition-colors hover:bg-secondary"
                  >
                    <div className="flex items-center gap-2.5">
                      <span className="truncate text-[13px] font-medium">{w.nm}</span>
                      <span className="ml-auto">
                        <StatusPill tone={w.st === "ok" ? "success" : w.st === "warn" ? "warning" : "pending"}>
                          {w.st === "ok" ? "Live" : w.st === "warn" ? "Needs you" : "Running"}
                        </StatusPill>
                      </span>
                    </div>
                    <p className="mt-2 line-clamp-2 text-[12px] leading-relaxed text-muted-foreground">{w.d}</p>
                    <div className="mt-2.5 flex items-center gap-1.5">
                      {w.tools.map((t, j) => (
                        <span key={j} className="flex h-[20px] w-[20px] items-center justify-center rounded-[6px] bg-secondary [&_svg]:h-[11px] [&_svg]:w-[11px]">{t}</span>
                      ))}
                      <span className="ml-auto font-mono text-[10px] text-muted-foreground">{w.meta}</span>
                    </div>
                  </motion.div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </RevealUp>
    </section>
  );
}

/* ================= BUILT IN — mirrored scrollytelling ================= */

const TRUST = [
  {
    t: "Approval before anything ships",
    p: "Emails, CRM updates, posts: the worker drafts, you approve. In Slack, WhatsApp, or the app.",
  },
  {
    t: "Knows your company",
    p: "Drop in SOPs, pricing, tone docs. Every brief comes pre-loaded, and you can audit which file each run used.",
  },
  {
    t: "Every run on the record",
    p: "Trigger, tools, context, output: auditable per run. Your tokens stay yours, revocable any time.",
  },
];

function VisApproval() {
  return (
    <div className="w-full max-w-[380px] overflow-hidden rounded-[14px] bg-card">
      <div className="flex items-center gap-2 border-b border-border-soft px-3.5 py-2 text-[11.5px] text-muted-foreground">
        <span className="[&_svg]:h-3.5 [&_svg]:w-3.5"><SlackLogo /></span>
        <span className="font-semibold text-foreground"># sales</span>
        <span className="ml-auto font-mono text-[10px]">2:14 PM</span>
      </div>
      <div className="flex gap-2.5 px-3.5 py-3">
        <span className="flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-[8px] text-[10px] font-semibold text-white" style={{ background: "var(--v2-accent)" }}>MA</span>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold">Maya <span className="ml-1 rounded-[3px] bg-secondary px-1 py-px text-[8.5px] font-bold uppercase tracking-wide text-muted-foreground">worker</span></div>
          <p className="mt-0.5 text-[12px] leading-relaxed text-foreground/85">Drafted the Acme follow-up with pricing from the brain. Send?</p>
          <div className="mt-2 flex gap-1.5">
            <span className="rounded-[8px] px-2.5 py-1 text-[11px] font-medium text-white" style={{ background: "var(--v2-accent)" }}>Approve &amp; send</span>
            <span className="rounded-[8px] border border-border bg-card px-2.5 py-1 text-[11px]">Edit</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function VisBrain() {
  const files = [
    { ext: "PDF", tint: "#E5533D", name: "ICP brief", x: "6%", y: "6%" },
    { ext: "XLS", tint: "#2F8F5B", name: "Pricing", x: "62%", y: "2%" },
    { ext: "MD", tint: "#6B7280", name: "Tone guide", x: "10%", y: "72%" },
    { ext: "URL", tint: "#3E6FE0", name: "Style guide", x: "64%", y: "70%" },
  ];
  return (
    <div className="relative h-[260px] w-full max-w-[380px]">
      {/* connection lines */}
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        {[["20%","18%"],["76%","14%"],["24%","82%"],["78%","80%"]].map(([x, y], i) => (
          <line key={i} x1="50%" y1="50%" x2={x} y2={y} stroke="var(--border-default)" strokeWidth="1" />
        ))}
        {[["20%","18%"],["76%","14%"],["24%","82%"],["78%","80%"]].map(([x, y], i) => (
          <circle key={`d${i}`} cx={x} cy={y} r="2.5" fill="var(--v2-accent)" />
        ))}
      </svg>
      {/* center brain node */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2">
        <motion.div
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
          className="flex h-[72px] w-[72px] items-center justify-center rounded-full bg-card"
         
        >
          <Brain className="h-7 w-7" style={{ color: "var(--v2-accent)" }} strokeWidth={1.6} />
        </motion.div>
        <div className="mt-2 text-center text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Company brain</div>
      </div>
      {/* file chips */}
      {files.map((f, i) => (
        <motion.div
          key={f.name}
          animate={{ y: [0, -3, 0] }}
          transition={{ duration: 3 + i * 0.6, repeat: Infinity, ease: "easeInOut", delay: i * 0.4 }}
          className="absolute flex items-center gap-2 rounded-[10px] bg-card px-2.5 py-1.5"
          style={{ left: f.x, top: f.y }}
        >
          <span className="flex h-[18px] w-[26px] items-center justify-center rounded-[5px] bg-secondary font-mono text-[8px] font-bold" style={{ color: f.tint }}>{f.ext}</span>
          <span className="text-[11px] font-medium">{f.name}</span>
        </motion.div>
      ))}
    </div>
  );
}

function VisRecord() {
  return (
    <div className="w-full max-w-[380px] overflow-hidden rounded-[14px] bg-card">
      <div className="flex items-center justify-between border-b border-border-soft px-3.5 py-2.5">
        <span className="text-[12.5px] font-semibold">Run #1042</span>
        <StatusPill tone="success">Completed</StatusPill>
      </div>
      {[
        { t: "17:00:04", n: "Read Google Calendar · 3 events", pill: <StatusPill tone="success">ok</StatusPill> },
        { t: "17:00:07", n: "Loaded brain: tone, pricing, CRM rules", pill: <StatusPill tone="success">ok</StatusPill> },
        { t: "17:00:09", n: "Drafted email + HubSpot note", pill: <StatusPill tone="success">ok</StatusPill> },
        { t: "17:00:11", n: "Send to sarah@acme.com", pill: <StatusPill tone="warning">held</StatusPill> },
      ].map((r, i) => (
        <div key={i} className="flex items-center gap-2.5 border-b border-border-soft px-3.5 py-2 text-[11.5px] last:border-0">
          <span className="font-mono text-[10px] text-muted-foreground">{r.t}</span>
          <span className="min-w-0 flex-1 truncate text-foreground/80">{r.n}</span>
          {r.pill}
        </div>
      ))}
    </div>
  );
}

export function BuiltIn() {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (es) => {
        es.forEach((e) => {
          if (e.isIntersecting) setActive(Number((e.target as HTMLElement).dataset.trust));
        });
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    refs.current.forEach((r) => r && io.observe(r));
    return () => io.disconnect();
  }, []);

  const VIS = [VisApproval, VisBrain, VisRecord];

  return (
    <section id="built" className="pb-32">
      <SectionHead title="Safe to hand over real work." />
      <div className="mt-10 grid gap-14 md:grid-cols-[1fr_1.05fr]">
        {/* headings LEFT (mirror of how-it-works) */}
        <div className="flex flex-col justify-center">
          {TRUST.map((s, i) => (
            <div
              key={s.t}
              data-trust={i}
              ref={(el) => { refs.current[i] = el; }}
              className="flex min-h-[200px] cursor-default flex-col justify-center py-3 md:min-h-[160px]"
              onMouseEnter={() => setActive(i)}
            >
              <h3 className={`text-[27px] font-semibold tracking-[-0.022em] transition-colors duration-300 ${active === i ? "text-foreground" : "text-muted-foreground/50"}`}>
                {s.t}
              </h3>
              <p className={`mt-2 max-w-[380px] text-[14px] leading-relaxed text-muted-foreground transition-opacity duration-300 ${active === i ? "opacity-100" : "opacity-45"}`}>
                {s.p}
              </p>
              {/* mobile inline visual */}
              <div className="mt-5 flex justify-center rounded-[16px] bg-secondary/70 p-5 md:hidden">
                {i === 0 ? <VisApproval /> : i === 1 ? <VisBrain /> : <VisRecord />}
              </div>
            </div>
          ))}
        </div>
        {/* panel RIGHT */}
        <div className="hidden md:sticky md:top-20 md:block md:h-[480px]">
          <div className="flex h-full items-center justify-center rounded-[20px] bg-secondary/70 p-8">
            <AnimatePresence mode="wait">
              {VIS.map((V, i) =>
                active === i ? (
                  <motion.div
                    key={i}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -8 }}
                    transition={{ duration: 0.32, ease: EASE }}
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

/* ================= TEMPLATES SHOWCASE (landing) ================= */

type ShowTpl = {
  av: string;
  nm: string;
  cat: string;
  d: string;
  tools: string[];
  runs: string;
  featured?: boolean;
};

const SHOW: ShowTpl[] = [
  { av: "CF", nm: "Client Follow-up", cat: "Sales", d: "Drafts follow-up emails after every call, adds the CRM note, creates the next-step task.", tools: ["calendar", "gmail", "hubspot"], runs: "2,140 runs", featured: true },
  { av: "MR", nm: "Monday Report", cat: "Ops", d: "Pipeline summary in #sales, Mondays 9:00.", tools: ["sheets", "slack"], runs: "1,080 runs" },
  { av: "LR", nm: "Lead Research", cat: "Sales", d: "5 inbound leads briefed before your first meeting.", tools: ["hubspot", "gmail"], runs: "960 runs" },
  { av: "CW", nm: "Competitor Watch", cat: "Founder", d: "Weekly digest of competitor changes.", tools: ["notion", "slack"], runs: "740 runs" },
  { av: "GD", nm: "GitHub Digest", cat: "Eng", d: "Unread PRs and issues, 9:00 daily.", tools: ["github", "slack"], runs: "1,420 runs" },
];

export function TemplatesShowcase() {
  const featured = SHOW.find((t) => t.featured)!;
  const rest = SHOW.filter((t) => !t.featured);
  return (
    <section id="tpl" className="pb-32">
      <SectionHead title="Or hire a proven worker." sub="Templates tuned for the recurring jobs teams hand over first." />
      <div className="mt-9 grid gap-3.5 md:grid-cols-3">
        {/* featured: spans 2 cols, includes a live output preview */}
        <RevealUp className="md:col-span-2">
          <div className="grid h-full overflow-hidden rounded-[16px] bg-card sm:grid-cols-2">
            <div className="flex flex-col p-5">
              <div className="flex items-center gap-2.5">
                <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] bg-[var(--bg-3)] text-[11px] font-semibold text-foreground/80">{featured.av}</span>
                <div>
                  <div className="text-[14.5px] font-semibold leading-tight">{featured.nm}</div>
                  <div className="text-[10.5px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{featured.cat}</div>
                </div>
                <span className="ml-auto"><StatusPill tone="success">Most hired</StatusPill></span>
              </div>
              <p className="mt-3 text-[13px] leading-relaxed text-muted-foreground">{featured.d}</p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {featured.tools.map((t) => <V2ToolChip key={t} tool={t} />)}
              </div>
              <div className="mt-auto flex items-center justify-between border-t border-border-soft pt-3.5">
                <span className="font-mono text-[10.5px] text-muted-foreground">{featured.runs}</span>
                <span className="text-[12.5px] font-medium" style={{ color: "var(--v2-accent)" }}>Hire this worker →</span>
              </div>
            </div>
            {/* output preview */}
            <div className="border-t border-border-soft bg-secondary/60 p-4 sm:border-l sm:border-t-0">
              <div className="rounded-[12px] bg-card p-3.5">
                <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">
                  <span className="[&_svg]:h-3 [&_svg]:w-3"><GmailLogo /></span> Email draft · just produced
                </div>
                <div className="mt-2 text-[12.5px] font-semibold">Next steps from today&apos;s call</div>
                <p className="mt-1 text-[11.5px] leading-relaxed text-muted-foreground">Hi Sarah, thanks for the call today. Based on what you shared, I&apos;d suggest starting with the onboarding workflow…</p>
                <div className="mt-2.5 flex items-center justify-between border-t border-border-soft pt-2">
                  <StatusPill tone="warning">Held for approval</StatusPill>
                  <span className="font-mono text-[9.5px] text-muted-foreground">Run #1042</span>
                </div>
              </div>
            </div>
          </div>
        </RevealUp>
        {/* rest: compact cards */}
        {rest.map((t, i) => (
          <RevealUp key={t.nm} delay={0.05 + i * 0.05}>
            <div className="flex h-full flex-col rounded-[16px] bg-card p-5 transition-colors hover:bg-secondary/60">
              <div className="flex items-center gap-2.5">
                <span className="flex h-[28px] w-[28px] items-center justify-center rounded-[8px] bg-[var(--bg-3)] text-[10.5px] font-semibold text-foreground/80">{t.av}</span>
                <div>
                  <div className="text-[13.5px] font-semibold leading-tight">{t.nm}</div>
                  <div className="text-[10px] font-medium uppercase tracking-[0.1em] text-muted-foreground">{t.cat}</div>
                </div>
              </div>
              <p className="mt-2.5 text-[12.5px] leading-relaxed text-muted-foreground">{t.d}</p>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {t.tools.map((tl) => <V2ToolChip key={tl} tool={tl} />)}
              </div>
              <div className="mt-auto flex items-center justify-between border-t border-border-soft pt-3">
                <span className="font-mono text-[10px] text-muted-foreground">{t.runs}</span>
                <span className="text-[12px] font-medium" style={{ color: "var(--v2-accent)" }}>Hire →</span>
              </div>
            </div>
          </RevealUp>
        ))}
      </div>
    </section>
  );
}

/* ================= FOOTER — v2 system ================= */

export function V2Footer() {
  return (
    <footer className="border-t border-border bg-[var(--bg-app)]">
      <div className="mx-auto max-w-[1000px] px-7">
        <div className="grid gap-8 py-11 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
          <div>
            <div className="flex items-center gap-2 text-[13.5px] font-semibold">
              <span className="flex h-[20px] w-[20px] items-center justify-center rounded-[6px] bg-primary">
                <svg width="11" height="11" viewBox="0 0 100 100"><path d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z" fill="var(--primary-text)" /></svg>
              </span>
              Workeros
              <span className="text-[9px] font-medium uppercase tracking-[0.15em] text-muted-foreground">by Floom</span>
            </div>
            <p className="mt-2.5 max-w-[230px] text-[12px] leading-relaxed text-muted-foreground">Hire AI workers for your company. Approval before anything ships.</p>
            <p className="mt-3 text-[11px] text-muted-foreground">Backed by Founders Inc</p>
          </div>
          {[
            { h: "Product", links: [["Product", "/v2/product"], ["Templates", "/v2/templates"], ["Docs", "/v2/docs"], ["Sign in", "/login"]] },
            { h: "Resources", links: [["GitHub", "https://github.com/floomhq/workeros"], ["Floom Skills", "https://skills.floom.dev"], ["Floom", "https://floom.dev"]] },
            { h: "Company", links: [["LinkedIn", "https://www.linkedin.com/company/floomhq/"], ["X", "https://x.com/floomhq"], ["Terms", "/terms"], ["Privacy", "/privacy"]] },
          ].map((col) => (
            <div key={col.h}>
              <div className="mb-2.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">{col.h}</div>
              <div className="flex flex-col gap-0.5">
                {col.links.map(([label, href]) => (
                  <Link key={label} href={href} className="py-1 text-[12.5px] text-foreground/70 transition-colors hover:text-foreground">
                    {label}
                  </Link>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between border-t border-border-soft py-5 text-[11px] text-muted-foreground">
          <span>© 2026 Floom. All rights reserved.</span>
          <span className="font-mono tracking-[0.06em]">WORKEROS</span>
        </div>
      </div>
    </footer>
  );
}

/* convenience re-exports for the templates page */
export { Search as SearchIcon };
