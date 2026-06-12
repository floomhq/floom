"use client";

/**
 * /v3/product — the depth page, rebuilt in the v3 artifact voice.
 * AppFrame up top, then three full beats (Approvals with the Slack moment,
 * the run record, the company brain), a quiet connections line, one button.
 * Alternating sides, one idea per screen, soft panels like the landing story.
 */

import Link from "next/link";
import Image from "next/image";
import { motion } from "motion/react";
import { Brain, Check, CheckCircle2, Layers, LayoutGrid, MessageCircleMore, Play, Plug2 } from "lucide-react";
import {
  GCalLogo,
  GmailLogo,
  HubSpotLogo,
  NotionLogo,
  SheetsLogo,
  SlackLogo,
} from "@/components/landing-icons";
import { Hl, V3Shell } from "../V3Shell";
import "../theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

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
  { av: "WU", nm: "Weekly Update", d: "Turns raw notes into a polished weekly company update.", st: "active" as const, meta: "5d ago", tools: [<NotionLogo key="n" />, <GmailLogo key="g" />] },
  { av: "CF", nm: "Client Follow-up", d: "Drafts follow-up emails after calls, adds CRM notes.", st: "review" as const, meta: "needs you", tools: [<GmailLogo key="g" />, <HubSpotLogo key="h" />] },
  { av: "GD", nm: "GitHub Digest", d: "Every morning at 9am, a digest of unread PRs and issues.", st: "active" as const, meta: "running", tools: [<SlackLogo key="s" />] },
  { av: "PB", nm: "Pipeline Brief", d: "Weekly pipeline summary posted in #sales.", st: "active" as const, meta: "3d ago", tools: [<SheetsLogo key="sh" />, <SlackLogo key="s" />] },
];

function Reveal({ children, delay = 0, className }: { children: React.ReactNode; delay?: number; className?: string }) {
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

/* ───────── artifacts ───────── */

function ApprovalArtifact() {
  return (
    <div className="w-full max-w-[440px] rounded-[18px] bg-card p-6">
      <div className="flex items-center gap-2 text-[11.5px] text-muted-foreground">
        <span className="[&_svg]:h-3.5 [&_svg]:w-3.5"><SlackLogo /></span>
        <span className="font-medium text-foreground"># sales</span>
        <span className="ml-auto font-mono text-[10px]">2:14 PM</span>
      </div>
      <div className="mt-4">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">Client Follow-up Worker</div>
          <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">Drafted the Acme follow-up with pricing from the brain. Send?</p>
          <div className="mt-3.5 flex gap-2">
            <motion.span
              initial={{ opacity: 0, y: 6 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.35, duration: 0.35 }}
              className="rounded-[10px] px-4 py-2 text-[12.5px] font-medium text-white"
              style={{ background: "var(--v3-accent)" }}
            >
              Approve &amp; send
            </motion.span>
            <motion.span
              initial={{ opacity: 0, y: 6 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true }}
              transition={{ delay: 0.45, duration: 0.35 }}
              className="rounded-[10px] bg-secondary px-4 py-2 text-[12.5px]"
            >
              Edit
            </motion.span>
          </div>
        </div>
      </div>
    </div>
  );
}

function RecordArtifact() {
  const rows = [
    ["17:00:04", "Read Google Calendar · 3 events", true],
    ["17:00:07", "Loaded brain: tone, pricing, CRM rules", true],
    ["17:00:09", "Drafted email + HubSpot note", true],
    ["17:00:11", "Send to sarah@acme.com", false],
  ] as const;
  return (
    <div className="w-full max-w-[440px] rounded-[18px] bg-card p-6">
      <div className="flex items-center justify-between">
        <span className="text-[14px] font-medium">Run #1042</span>
        <span className="font-mono text-[10.5px] text-muted-foreground">today, 17:00</span>
      </div>
      <div className="mt-4">
        {rows.map(([t, n, ok], i) => (
          <motion.div
            key={i}
            initial={{ opacity: 0 }}
            whileInView={{ opacity: 1 }}
            viewport={{ once: true }}
            transition={{ delay: 0.15 + i * 0.1, duration: 0.35 }}
            className="flex items-center gap-3 py-2.5 text-[13px]"
          >
            <span className="font-mono text-[10px] text-muted-foreground">{t}</span>
            <span className="flex-1 text-muted-foreground">{n}</span>
            {ok ? (
              <Check className="h-3.5 w-3.5 text-muted-foreground/60" />
            ) : (
              <span className="rounded-full px-2.5 py-0.5 text-[10.5px] font-medium" style={{ background: "var(--v3-sel)", color: "var(--v3-accent)" }}>held for you</span>
            )}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function BrainArtifact() {
  const files = [
    { ext: "PDF", name: "ICP brief", x: "4%", y: "8%" },
    { ext: "XLS", name: "Pricing", x: "62%", y: "2%" },
    { ext: "MD", name: "Tone guide", x: "8%", y: "74%" },
    { ext: "URL", name: "Style guide", x: "60%", y: "72%" },
  ];
  return (
    <div className="relative h-[280px] w-full max-w-[440px]">
      <svg className="absolute inset-0 h-full w-full" aria-hidden>
        {[["18%", "20%"], ["74%", "14%"], ["22%", "82%"], ["74%", "82%"]].map(([x, y], i) => (
          <line key={i} x1="50%" y1="50%" x2={x} y2={y} stroke="var(--bg-3)" strokeWidth="1" />
        ))}
      </svg>
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-center">
        <div className="v3-breathe mx-auto flex h-[76px] w-[76px] items-center justify-center rounded-full bg-card">
          <Brain className="h-7 w-7" style={{ color: "var(--v3-accent)" }} strokeWidth={1.6} />
        </div>
        <div className="mt-2 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Company brain</div>
      </div>
      {files.map((f, i) => (
        <div
          key={f.name}
          className="v3-float absolute flex items-center gap-2 rounded-[10px] bg-card px-3 py-2"
          style={{ left: f.x, top: f.y, animationDuration: `${3 + i * 0.6}s`, animationDelay: `${i * 0.4}s` }}
        >
          <span className="flex h-[18px] w-[28px] items-center justify-center rounded-[5px] bg-secondary font-mono text-[8px] font-bold text-muted-foreground">{f.ext}</span>
          <span className="text-[11.5px] font-medium">{f.name}</span>
        </div>
      ))}
    </div>
  );
}

function ProductMockup() {
  return (
    <section id="product" className="pb-0">
      <Reveal delay={0.1}>
        <div className="overflow-hidden rounded-[24px] bg-secondary p-3">
          <div className="overflow-hidden rounded-[18px] bg-[var(--bg-app)]">
            <div className="flex min-h-[430px]">
              <aside className="hidden w-[190px] shrink-0 flex-col bg-card py-3 sm:flex">
                <div className="flex items-center gap-2 px-4 pb-3">
                  <Image src="/floom-mark.svg" alt="" width={20} height={20} />
                  <span className="text-[12.5px] font-semibold">Floom</span>
                </div>
                <div className="flex flex-col gap-px px-2.5">
                  {NAV_ITEMS.map((n) => (
                    <div key={n.label} className={`flex items-center gap-2.5 rounded-[8px] px-2.5 py-[7px] text-[12px] ${n.on ? "bg-secondary font-medium text-foreground" : "text-muted-foreground"}`}>
                      <n.icon className="h-[14px] w-[14px] opacity-70" />
                      {n.label}
                      {n.badge ? (
                        <span className="ml-auto flex h-4 min-w-4 items-center justify-center rounded-full bg-secondary px-1 text-[9.5px] font-semibold text-muted-foreground">{n.badge}</span>
                      ) : null}
                    </div>
                  ))}
                </div>
              </aside>
              <div className="min-w-0 flex-1 bg-[var(--bg-app)] p-5">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-[17px] font-semibold tracking-[-0.01em]">Workers</div>
                    <div className="text-[11.5px] text-muted-foreground">8 active · 1 waiting for review</div>
                  </div>
                  <span className="rounded-[10px] px-3 py-1.5 text-[12px] font-medium text-white" style={{ background: "var(--v3-accent)" }}>+ New worker</span>
                </div>
                <div className="mt-4 grid gap-2.5 sm:grid-cols-2">
                  {APP_WORKERS.map((w, i) => (
                    <motion.div
                      key={w.nm}
                      initial={{ opacity: 0, y: 8 }}
                      whileInView={{ opacity: 1, y: 0 }}
                      viewport={{ once: true }}
                      transition={{ delay: i * 0.06, duration: 0.4, ease: EASE }}
                      className="rounded-[12px] bg-card p-3.5 transition-colors hover:bg-secondary"
                    >
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-[8px] bg-secondary font-mono text-[10px] font-semibold text-muted-foreground">{w.av}</span>
                        <span className="truncate text-[13px] font-medium">{w.nm}</span>
                        <span className="ml-auto">
                          <span
                            className="inline-flex items-center gap-1.5 rounded-full bg-secondary px-2 py-0.5 text-[10.5px] font-semibold uppercase text-muted-foreground"
                            style={w.st === "review" ? { background: "var(--v3-sel)", color: "var(--v3-accent)" } : undefined}
                          >
                            <span className="h-1.5 w-1.5 rounded-full" style={{ background: w.st === "review" ? "var(--v3-accent)" : "currentColor" }} />
                            {w.st === "review" ? "Review" : "Active"}
                          </span>
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
        </div>
      </Reveal>
    </section>
  );
}

/* ───────── beats ───────── */

function Beat({
  title,
  copy,
  detail,
  artifact,
  flip = false,
}: {
  title: string;
  copy: string;
  detail: string;
  artifact: React.ReactNode;
  flip?: boolean;
}) {
  return (
    <section className="grid items-center gap-10 pb-20 md:grid-cols-2 md:gap-14">
      <Reveal className={flip ? "md:order-2" : ""}>
        <h2 className="text-[27px] font-semibold leading-[1.06] tracking-[-0.025em] sm:text-[34px]">{title}</h2>
        <p className="mt-3 max-w-[400px] text-[15px] leading-relaxed text-muted-foreground">{copy}</p>
        <p className="mt-3 max-w-[400px] text-[13px] leading-relaxed text-muted-foreground/80">{detail}</p>
      </Reveal>
      <Reveal delay={0.1} className={flip ? "md:order-1" : ""}>
        <div className="flex items-center justify-center rounded-[22px] bg-secondary/70 p-7 md:min-h-[340px]">
          {artifact}
        </div>
      </Reveal>
    </section>
  );
}

export function V3ProductBody() {
  return (
    <V3Shell active="product">


        {/* hero */}
        <div className="pb-10 pt-20 text-center">
          <motion.h1
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, ease: EASE }}
            className="text-[34px] font-semibold leading-[1.03] tracking-[-0.032em] sm:text-[48px]"
          >
            The <Hl>record</Hl> behind every worker.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5, delay: 0.08, ease: EASE }}
            className="mx-auto mt-4 max-w-[460px] text-[15.5px] text-muted-foreground"
          >
            Most days the worker reports in Slack and you never open this. When you do, everything is on the record.
          </motion.p>
        </div>

        <div className="pb-16">
          <ProductMockup />
        </div>

        <Beat
          title="Nothing ships without your yes."
          copy="Emails, CRM updates, posts: the worker drafts, you approve. Where you already are."
          detail="Approval gates are on by default for anything that leaves the building. Relax them per worker once it has earned it."
          artifact={<ApprovalArtifact />}
        />

        <Beat
          flip
          title="Every run on the record."
          copy="Trigger, tools, context, output. Each step timestamped, each held action visible."
          detail="When something looks off, you read the run like a receipt instead of guessing what the model did."
          artifact={<RecordArtifact />}
        />

        <Beat
          title="It knows your company."
          copy="SOPs, pricing, tone. Drop in files once and every brief comes pre-loaded."
          detail="Each run logs which files it used, so you can audit the why behind every output."
          artifact={<BrainArtifact />}
        />

        {/* connections, one quiet line */}
        <Reveal className="flex flex-col items-center gap-4 pb-20 text-center">
          <Link href="/integrations" className="flex items-center justify-center gap-5 opacity-80 transition-opacity hover:opacity-100" aria-label="Browse Floom integrations">
            {[<GmailLogo key="g" />, <SlackLogo key="s" />, <HubSpotLogo key="h" />, <NotionLogo key="n" />, <GCalLogo key="c" />, <SheetsLogo key="sh" />].map((logo, i) => (
              <span key={i} className="flex h-5 w-5 items-center justify-center [&_svg]:h-5 [&_svg]:w-5">{logo}</span>
            ))}
          </Link>
          <p className="max-w-[420px] text-[13px] text-muted-foreground">
            Your tools connect with your tokens, and your tokens stay yours. Revoke at the source any time.
          </p>
        </Reveal>

        {/* close */}
        <Reveal className="pb-10 text-center">
          <Link
            href="/login"
            className="inline-flex items-center rounded-[12px] px-6 py-3 text-[14.5px] font-medium text-white"
            style={{ background: "var(--v3-accent)" }}
          >
            See it with your own worker
          </Link>
        </Reveal>
    </V3Shell>
  );
}
