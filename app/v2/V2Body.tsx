"use client";

/**
 * /v2 — landing preview on the FINAL wireframe design system. Pass 2:
 * spec-blue accent used properly, channel-entry row on the hero, Lovable-clean
 * how-it-works, real app-frame section, upgraded Built-in, framer-motion
 * everywhere, v2 footer, Docs in nav.
 */

import { useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Moon, Sun } from "lucide-react";
import { TemplateRow } from "@/components/landing-ref/TemplateRow";
import { getTemplate } from "@/components/landing-ref/data";
import {
  CalendlyLogo,
  DiscordLogo,
  GCalLogo,
  GitHubSVG,
  GmailLogo,
  HubSpotLogo,
  IntercomLogo,
  NotionLogo,
  SalesforceLogo,
  SheetsLogo,
  SlackLogo,
  WhatsAppLogo,
} from "@/components/landing-icons";
import { V2Composer } from "./V2Composer";
import { BuiltIn, HowItWorks, RevealUp, SectionHead, V2Footer } from "./V2Sections";
import "./theme.css";

const EASE: [number, number, number, number] = [0.22, 1, 0.36, 1];

function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="Workeros" style={{ borderRadius: "27%" }}>
      <rect width="100" height="100" rx="24" fill="var(--primary)" />
      <path d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z" fill="var(--primary-text)" />
    </svg>
  );
}

function GitHubMark() {
  return <span className="text-foreground [&_svg]:h-[17px] [&_svg]:w-[17px]"><GitHubSVG /></span>;
}

function LogoTile({ children }: { children: React.ReactNode }) {
  return (
    <motion.span
      whileHover={{ y: -2 }}
      transition={{ type: "spring", stiffness: 320, damping: 20 }}
      className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-[8px] border border-border-soft bg-card [&_svg]:h-[17px] [&_svg]:w-[17px]"
    >
      {children}
    </motion.span>
  );
}

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
            <Link href="/v2/templates" className="rounded-[10px] px-3 py-1.5 hover:bg-secondary hover:text-foreground">Templates</Link>
            <Link href="/v2/product" className="rounded-[10px] px-3 py-1.5 hover:bg-secondary hover:text-foreground">Product</Link>
            <Link href="/v2/docs" className="rounded-[10px] px-3 py-1.5 hover:bg-secondary hover:text-foreground">Docs</Link>
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

        {/* hero */}
        <section className="pb-10 pt-24 text-center">
          <motion.h1
            initial={{ opacity: 0, y: 14 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.6, ease: EASE }}
            className="text-[54px] font-semibold leading-[1.03] tracking-[-0.03em]"
          >
            Hire AI workers.
          </motion.h1>
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.08, ease: EASE }}
            className="mx-auto mt-4 max-w-[430px] text-[15px] text-muted-foreground"
          >
            Describe the job. Workeros runs it and asks before anything ships.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.55, delay: 0.18, ease: EASE }}
            className="mt-9"
          >
            <V2Composer channels pills />
          </motion.div>
        </section>

        {/* works-with: full-width band */}
        <motion.section
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.34 }}
          className="relative left-1/2 w-screen -translate-x-1/2 border-y border-border-soft py-6 mb-24 mt-8"
        >
          <div className="mb-3.5 text-center text-[11px] font-medium uppercase tracking-[0.08em] text-muted-foreground">Works with 1,000+ tools</div>
          <div className="flex flex-wrap items-center justify-center gap-3 px-6">
            <LogoTile><GmailLogo /></LogoTile>
            <LogoTile><SlackLogo /></LogoTile>
            <LogoTile><HubSpotLogo /></LogoTile>
            <LogoTile><NotionLogo /></LogoTile>
            <LogoTile><GCalLogo /></LogoTile>
            <LogoTile><SheetsLogo /></LogoTile>
            <LogoTile><GitHubMark /></LogoTile>
            <LogoTile><SalesforceLogo /></LogoTile>
            <LogoTile><IntercomLogo /></LogoTile>
            <LogoTile><WhatsAppLogo /></LogoTile>
            <LogoTile><DiscordLogo /></LogoTile>
            <LogoTile><CalendlyLogo /></LogoTile>
          </div>
        </motion.section>

        <HowItWorks />

        {/* templates */}
        <section id="tpl" className="pb-32">
          <SectionHead title="Or start from a template." sub="Ready-made workers for the recurring jobs your team already does." />
          <div className="mt-8 flex flex-col gap-2.5">
            {templates.map((t, i) => (
              <RevealUp key={t.slug} delay={i * 0.05}>
                <TemplateRow t={t} />
              </RevealUp>
            ))}
          </div>
          <RevealUp delay={0.1} className="mt-4 text-[13px]">
            <Link href="/v2/templates" className="font-medium transition-colors" style={{ color: "var(--v2-accent)" }}>
              Browse all templates →
            </Link>
          </RevealUp>
        </section>

        <BuiltIn />

        {/* final */}
        <section className="pb-28 text-center">
          <SectionHead title="Hire your first worker." />
          <RevealUp delay={0.08} className="mt-7">
            <V2Composer slim placeholder="Describe the job…" />
          </RevealUp>
          <RevealUp delay={0.14} className="mt-4 text-[13px] text-muted-foreground">
            or <Link href="/v2/templates" className="font-medium" style={{ color: "var(--v2-accent)" }}>browse templates</Link>
          </RevealUp>
        </section>
      </div>

      <V2Footer />
    </div>
  );
}
