"use client";

/**
 * /v2 — landing preview on the FINAL wireframe design system.
 * Composes the REAL landing-ref components (HeroPromptComposer, TemplateRow,
 * StatusPill, Footer, brand SVGs) under the scoped .theme-v2 token override.
 * Structure: hero → works-with → how-it-works (scrollytelling) → templates →
 * built-in (3 feature cards) → final CTA → footer.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Moon, Sun } from "lucide-react";
import { HeroPromptComposer } from "@/components/landing-ref/HeroPromptComposer";
import { TemplateRow } from "@/components/landing-ref/TemplateRow";
import { StatusPill } from "@/components/landing-ref/StatusPill";
import { Footer } from "@/components/landing-ref/Nav";
import { getTemplate } from "@/components/landing-ref/data";
import {
  GCalLogo,
  GmailLogo,
  HubSpotLogo,
  NotionLogo,
  SheetsLogo,
  SlackLogo,
  WhatsAppLogo,
} from "@/components/landing-icons";
import "./theme.css";

/* ── brand mark (same path as Nav's FloomMark) ── */
function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="Workeros" style={{ borderRadius: "27%" }}>
      <rect width="100" height="100" rx="24" fill="var(--primary)" />
      <path d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z" fill="var(--primary-text)" />
    </svg>
  );
}

function LogoTile({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] border border-border-soft bg-card [&_svg]:h-[17px] [&_svg]:w-[17px]">
      {children}
    </span>
  );
}

/* ── how-it-works scrollytelling ── */
const STEPS = [
  {
    n: "Step 1",
    t: "Describe the job",
    p: "One sentence, plain English. Workeros recognises your tools as you type.",
  },
  {
    n: "Step 2",
    t: "Review the draft",
    p: "It builds the worker with your tools and your company brain. Edit anything, then hire.",
  },
  {
    n: "Step 3",
    t: "It works in the background",
    p: "On a schedule, a webhook, or a trigger. It asks before anything ships externally.",
  },
];

function HowItWorks() {
  const [active, setActive] = useState(0);
  const refs = useRef<Array<HTMLDivElement | null>>([]);

  useEffect(() => {
    const io = new IntersectionObserver(
      (es) => {
        es.forEach((e) => {
          if (e.isIntersecting) {
            const i = Number((e.target as HTMLElement).dataset.step);
            setActive(i);
          }
        });
      },
      { rootMargin: "-45% 0px -45% 0px" },
    );
    refs.current.forEach((r) => r && io.observe(r));
    return () => io.disconnect();
  }, []);

  return (
    <section id="how" className="pb-28">
      <div className="mb-11 flex items-center gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">How it works</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <h2 className="text-[32px] font-semibold leading-[1.08] tracking-[-0.025em]">
        From a sentence to a worker on payroll.
      </h2>
      <div className="mt-9 grid gap-16 md:grid-cols-[1.05fr_1fr]">
        {/* sticky visuals */}
        <div className="relative hidden h-[440px] md:sticky md:top-20 md:block">
          {/* 1 — the real composer */}
          <Vis on={active === 0}>
            <div className="w-full max-w-[440px] overflow-hidden rounded-[16px] border border-border bg-card">
              <PanelHead title="Hire a new AI worker" meta="workeros / new" />
              <div className="p-4">
                <HeroPromptComposer />
              </div>
            </div>
          </Vis>
          {/* 2 — drafted worker spec */}
          <Vis on={active === 1}>
            <div className="w-full max-w-[440px] overflow-hidden rounded-[16px] border border-border bg-card">
              <div className="flex items-center gap-2.5 border-b border-border-soft px-[18px] py-3">
                <span className="flex h-[26px] w-[26px] items-center justify-center rounded-[8px] border border-border bg-secondary text-[10.5px] font-semibold text-foreground/80">MD</span>
                <span className="text-[13px] font-semibold">Meeting Digest Worker</span>
                <span className="ml-auto"><StatusPill tone="pending">Draft</StatusPill></span>
              </div>
              {[
                ["Reads", "Granola · Google Calendar"],
                ["Writes", "HubSpot CRM notes"],
                ["Brain", "Tone guide · CRM rules"],
                ["Approval", "Required before anything ships"],
                ["Schedule", "Daily · 5:00 PM"],
              ].map(([k, v]) => (
                <div key={k} className="flex items-start justify-between gap-3 border-b border-border-soft px-[18px] py-[11px] text-[12.5px] last:border-0">
                  <span className="pt-px text-[11px] uppercase tracking-[0.04em] text-muted-foreground">{k}</span>
                  <span className="text-right text-foreground/80">{v}</span>
                </div>
              ))}
              <div className="flex justify-end gap-2 border-t border-border-soft px-[18px] py-3">
                <button className="rounded-[10px] border border-border bg-card px-3 py-1.5 text-[12.5px] hover:bg-secondary">Edit</button>
                <button className="rounded-[10px] bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground">Hire</button>
              </div>
            </div>
          </Vis>
          {/* 3 — runs */}
          <Vis on={active === 2}>
            <div className="w-full max-w-[440px] overflow-hidden rounded-[16px] border border-border bg-card">
              <PanelHead title="Runs" meta="last 3 days" />
              {[
                ["Today, 5:00 PM", "Output ready · 12 action items", <StatusPill key="a" tone="pending">Awaiting you</StatusPill>],
                ["Yesterday, 5:00 PM", "Approved · posted to HubSpot", <StatusPill key="b" tone="success">Done</StatusPill>],
                ["Monday, 5:00 PM", "Approved · posted to HubSpot", <StatusPill key="c" tone="success">Done</StatusPill>],
              ].map(([t, s, pill], i) => (
                <div key={i} className="flex h-16 items-center gap-3.5 border-b border-border-soft px-[18px] last:border-0">
                  <span className="flex h-[30px] w-[30px] items-center justify-center rounded-[8px] border border-border bg-secondary text-[11px] font-semibold text-foreground/80">MD</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] font-medium">{t as string}</div>
                    <div className="truncate text-[12px] text-muted-foreground">{s as string}</div>
                  </div>
                  {pill}
                </div>
              ))}
            </div>
          </Vis>
        </div>
        {/* steps */}
        <div className="flex flex-col">
          {STEPS.map((s, i) => (
            <div
              key={s.n}
              data-step={i}
              ref={(el) => { refs.current[i] = el; }}
              className="flex min-h-[290px] flex-col justify-center py-4"
            >
              <div className={`mb-2.5 text-[11px] font-medium uppercase tracking-[0.06em] transition-colors ${active === i ? "text-[var(--v2-accent)]" : "text-muted-foreground"}`}>{s.n}</div>
              <h3 className={`mb-2 text-[26px] font-semibold tracking-[-0.02em] transition-colors ${active === i ? "text-foreground" : "text-muted-foreground"}`}>{s.t}</h3>
              <p className={`max-w-[360px] text-[14px] text-muted-foreground transition-opacity ${active === i ? "opacity-100" : "opacity-60"}`}>{s.p}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Vis({ on, children }: { on: boolean; children: React.ReactNode }) {
  return (
    <div className={`absolute inset-0 grid place-items-start justify-center transition-opacity duration-300 ${on ? "opacity-100" : "pointer-events-none opacity-0"}`}>
      {children}
    </div>
  );
}

function PanelHead({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="flex items-center gap-2.5 border-b border-border-soft px-[18px] py-3">
      <span className="text-[13px] font-semibold">{title}</span>
      <span className="ml-auto font-mono text-[10.5px] text-muted-foreground">{meta}</span>
    </div>
  );
}

/* ── built-in feature cards ── */
function BuiltIn() {
  return (
    <section id="built" className="pb-28">
      <div className="mb-11 flex items-center gap-3">
        <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Built in</span>
        <span className="h-px flex-1 bg-border" />
      </div>
      <h2 className="text-[32px] font-semibold leading-[1.08] tracking-[-0.025em]">Safe to hand over real work.</h2>
      <p className="mt-2 text-[14px] text-muted-foreground">The properties that make delegation safe, in the product from day one.</p>

      <div className="mt-9 grid gap-3.5 md:grid-cols-3">
        {/* any interface */}
        <div className="flex flex-col overflow-hidden rounded-[16px] border border-border bg-card">
          <div className="flex min-h-[150px] flex-col justify-center gap-2.5 border-b border-border-soft bg-secondary/60 p-[18px]">
            <div className="flex gap-2">
              {[
                { label: "Slack", logo: <SlackLogo /> },
                { label: "WhatsApp", logo: <WhatsAppLogo /> },
                { label: "CLI", logo: <span className="flex h-[19px] w-[19px] items-center justify-center rounded-[5px] bg-primary font-mono text-[9px] font-bold text-primary-foreground">&gt;_</span> },
              ].map((i) => (
                <div key={i.label} className="flex flex-1 flex-col items-center gap-1.5 rounded-[10px] border border-border-soft bg-card px-1.5 py-2.5 text-[11px] font-medium text-foreground/80">
                  <span className="flex h-5 w-5 items-center justify-center [&_svg]:h-[17px] [&_svg]:w-[17px]">{i.logo}</span>
                  {i.label}
                </div>
              ))}
            </div>
            <div className="flex items-center justify-between rounded-[10px] border border-border-soft bg-card py-2 pl-3 pr-2 font-mono text-[11px] text-foreground/80">
              <span>$ claude mcp add workeros</span>
              <button className="rounded-[7px] border border-border bg-secondary px-2 py-0.5 font-sans text-[10.5px] font-medium text-foreground/70 hover:text-foreground">Copy</button>
            </div>
          </div>
          <div className="px-[18px] py-4">
            <div className="mb-1 text-[14.5px] font-semibold">Any interface, any model</div>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">Slack, WhatsApp, your terminal — or any agent that speaks MCP. One worker, every surface.</p>
          </div>
        </div>

        {/* knows your company */}
        <div className="flex flex-col overflow-hidden rounded-[16px] border border-border bg-card">
          <div className="flex min-h-[150px] flex-col justify-center gap-1.5 border-b border-border-soft bg-secondary/60 p-[18px]">
            {[
              { ext: "PDF", tint: "#E5533D", name: "ICP brief", size: "12 pages" },
              { ext: "XLS", tint: "#2F8F5B", name: "Pricing tiers", size: "4 sheets" },
              { ext: "MD", tint: "#6B7280", name: "Tone guide", size: "1,840 words" },
            ].map((f) => (
              <div key={f.name} className="flex items-center gap-2.5 rounded-[10px] border border-border-soft bg-card px-3 py-2">
                <span className="flex h-[22px] w-[30px] items-center justify-center rounded-[6px] border border-border bg-[var(--bg-app)] font-mono text-[9px] font-bold" style={{ color: f.tint }}>{f.ext}</span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium">{f.name}</div>
                  <div className="text-[10.5px] text-muted-foreground">{f.size}</div>
                </div>
                <span className="text-[12px] font-semibold" style={{ color: "var(--success, #2F8F5B)" }}>✓</span>
              </div>
            ))}
          </div>
          <div className="px-[18px] py-4">
            <div className="mb-1 text-[14.5px] font-semibold">Knows your company</div>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">Drop in SOPs, pricing, tone docs. Every brief comes pre-loaded with what your team already knows.</p>
          </div>
        </div>

        {/* observable & secure */}
        <div className="flex flex-col overflow-hidden rounded-[16px] border border-border bg-card">
          <div className="flex min-h-[150px] flex-col justify-center border-b border-border-soft bg-secondary/60 p-[18px]">
            <div className="overflow-hidden rounded-[10px] border border-border-soft bg-card">
              {[
                { t: "17:00", n: "Run #1042 · drafted email", pill: <StatusPill tone="success">Approved</StatusPill> },
                { t: "17:00", n: "Wrote HubSpot note", pill: <StatusPill tone="success">Logged</StatusPill> },
                { t: "17:01", n: "Send to sarah@acme.com", pill: <StatusPill tone="warning">Held for you</StatusPill> },
              ].map((r, i) => (
                <div key={i} className="flex items-center gap-2.5 border-b border-border-soft px-3 py-2 text-[11.5px] last:border-0">
                  <span className="font-mono text-[10px] text-muted-foreground">{r.t}</span>
                  <span className="min-w-0 flex-1 truncate text-foreground/80">{r.n}</span>
                  {r.pill}
                </div>
              ))}
            </div>
          </div>
          <div className="px-[18px] py-4">
            <div className="mb-1 text-[14.5px] font-semibold">Observable &amp; secure</div>
            <p className="text-[12.5px] leading-relaxed text-muted-foreground">Every run on the record. Approval gates before anything ships. Your tokens stay yours.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ── page ── */
export function V2Body() {
  const [dark, setDark] = useState(false);
  const tplSlugs = ["client-follow-up-worker", "monday-report-worker", "lead-research-worker", "competitor-watch-worker", "recruiting-bd-worker"];
  const templates = tplSlugs.map((s) => getTemplate(s)!).filter(Boolean);

  return (
    <div className={`theme-v2 min-h-screen text-[13.5px] ${dark ? "dark" : ""}`} style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}>
      <div className="mx-auto max-w-[1000px] px-7">

        {/* nav */}
        <nav className="flex h-[60px] items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 text-[14px] font-semibold">
            <Mark />
            Workeros
            <span className="text-[9.5px] font-medium uppercase tracking-[0.15em] text-muted-foreground">by Floom</span>
          </Link>
          <div className="hidden gap-0.5 text-[13px] text-muted-foreground md:flex">
            <a href="#how" className="rounded-[10px] px-3 py-1.5 hover:bg-secondary hover:text-foreground">How it works</a>
            <a href="#tpl" className="rounded-[10px] px-3 py-1.5 hover:bg-secondary hover:text-foreground">Templates</a>
            <a href="#built" className="rounded-[10px] px-3 py-1.5 hover:bg-secondary hover:text-foreground">Built in</a>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setDark(!dark)}
              aria-label="Toggle theme"
              className="flex h-8 w-8 items-center justify-center rounded-[8px] border border-border text-muted-foreground hover:bg-secondary hover:text-foreground"
            >
              {dark ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
            </button>
            <Link href="/login" className="rounded-[10px] border border-border bg-card px-3 py-1.5 text-[12.5px] font-medium hover:bg-secondary">Sign in</Link>
          </div>
        </nav>

        {/* hero — REAL composer */}
        <section className="pb-11 pt-24 text-center">
          <h1 className="text-[54px] font-semibold leading-[1.03] tracking-[-0.03em]">Hire AI workers.</h1>
          <p className="mx-auto mt-4 max-w-[430px] text-[15px] text-muted-foreground">
            Describe the job. Workeros runs it and asks before anything ships.
          </p>
          <HeroPromptComposer />
        </section>

        {/* works-with — REAL logos */}
        <section className="flex items-center justify-center gap-2.5 pb-24 pt-6 text-[12px] text-muted-foreground">
          <LogoTile><GmailLogo /></LogoTile>
          <LogoTile><SlackLogo /></LogoTile>
          <LogoTile><HubSpotLogo /></LogoTile>
          <LogoTile><NotionLogo /></LogoTile>
          <LogoTile><GCalLogo /></LogoTile>
          <LogoTile><SheetsLogo /></LogoTile>
          <span className="ml-1">1,000+ tools via Composio</span>
        </section>

        <HowItWorks />

        {/* templates — REAL TemplateRow */}
        <section id="tpl" className="pb-28">
          <div className="mb-11 flex items-center gap-3">
            <span className="text-[11px] font-medium uppercase tracking-[0.06em] text-muted-foreground">Templates</span>
            <span className="h-px flex-1 bg-border" />
          </div>
          <h2 className="text-[32px] font-semibold leading-[1.08] tracking-[-0.025em]">Or start from a template.</h2>
          <p className="mb-7 mt-2 text-[14px] text-muted-foreground">Ready-made workers for the recurring jobs your team already does.</p>
          <div className="flex flex-col gap-2.5">
            {templates.map((t) => (
              <TemplateRow key={t.slug} t={t} />
            ))}
          </div>
          <div className="mt-4 text-[13px]">
            <Link href="/templates" className="text-muted-foreground hover:text-foreground">Browse all templates →</Link>
          </div>
        </section>

        <BuiltIn />

        {/* final */}
        <section className="pb-28 text-center">
          <h2 className="mb-7 text-[36px] font-semibold tracking-[-0.028em]">Hire your first worker.</h2>
          <HeroPromptComposer />
        </section>
      </div>

      <Footer />
    </div>
  );
}
