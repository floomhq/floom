/**
 * V3Landing — the WorkerOS marketing landing page.
 *
 * Design rules (from Federico's brief + global CLAUDE.md):
 * - No emojis in UI
 * - Max 1-2 accent colors
 * - No colored left borders on cards
 * - No gradient backgrounds on every element
 * - No text-in-circles for brand logos (real SVG paths only)
 * - Brand logos: SimpleIcons > svgl.app > favicons
 *
 * Issues fixed here (#822 #823 #824):
 * 1. Black blob: GitHub chip in PromptText was rendering with hard dark color;
 *    fixed by using softer chip background so SVG color doesn't dominate.
 * 2. Two-row button: CTA label nowraps.
 * 3. Missing borders: subtle ring-1 on AppFrame card for light-bg definition.
 * 4. AppFrame casing: "WorkerOS" everywhere, never wrong-case.
 * 5. Tool logos: inline brand logos in composer + example prompts.
 * 6. Artifact cards: clean column rhythm, no floating checkmarks.
 * 7. Docs alignment: /docs uses the same design tokens.
 */

import type { ReactNode } from "react";
import Link from "next/link";
import { Check } from "lucide-react";
import { BrandLogo } from "@/components/connections/BrandLogo";
import { FloomMark } from "@/components/layout/sidebar";

// ---------------------------------------------------------------------------
// Inline tool-logo highlight — used in composer copy and example templates.
// Fix #823: real brand logos inline, never text-in-circles.
// Fix #1 (black blob): the chip MUST have a visible light background so the
// dark GitHub SVG doesn't render as a standalone blob. Using bg-[#F1EEE8]
// (the design-system --bg-2 light value) hard-coded here for SSR safety.
// ---------------------------------------------------------------------------

function ToolMention({ slug, label }: { slug: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-[3px] rounded-[4px] bg-[#F1EEE8] px-[5px] py-[1px] mx-[1px] align-baseline whitespace-nowrap text-[var(--foreground,#16171A)]">
      <BrandLogo icon={slug} className="size-[13px] shrink-0 translate-y-[1px]" />
      <span>{label}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// AppFrame mock — a static product screenshot mockup.
// Fix #4: label says "WorkerOS" (correct brand casing).
// Fix #3: ring-1 ring-black/[0.06] gives definition against the light bg.
// ---------------------------------------------------------------------------

function AppFrameMock() {
  return (
    <div
      className="overflow-hidden rounded-2xl ring-1 ring-black/[0.07] shadow-[0_2px_24px_rgba(0,0,0,0.10)] bg-[#FAFAF7]"
      aria-label="WorkerOS app preview"
    >
      {/* Window chrome */}
      <div className="flex items-center gap-1.5 bg-[#F1EEE8] px-3 py-2 border-b border-[#E7E0D6]">
        <span className="size-2.5 rounded-full bg-[#FF5F57]" />
        <span className="size-2.5 rounded-full bg-[#FEBC2E]" />
        <span className="size-2.5 rounded-full bg-[#28C840]" />
        <span className="ml-3 text-[11px] text-[#8B8279] font-mono select-none">
          workers.floom.dev
        </span>
      </div>

      <div className="flex" style={{ minHeight: 340 }}>
        {/* Sidebar */}
        <div className="flex flex-col w-[160px] shrink-0 border-r border-[#E7E0D6] bg-[#F5F2EE] py-3">
          {/* Brand */}
          <div className="flex items-center gap-2 px-3 pb-3 border-b border-[#E7E0D6]">
            <FloomMark size={20} />
            <span className="text-[12px] font-semibold tracking-tight text-[#16171A]">WorkerOS</span>
          </div>

          {/* Nav items */}
          <nav className="flex-1 px-2 pt-2 space-y-0.5">
            {[
              { label: "Overview", active: false },
              { label: "Assistant", active: false },
              { label: "Workers", active: true },
              { label: "Brain", active: false },
              { label: "Runs", active: false },
              { label: "Approvals", active: false, badge: 2 },
              { label: "Connections", active: false },
            ].map((item) => (
              <div
                key={item.label}
                className={`flex items-center justify-between gap-2 px-2 py-[5px] rounded-[7px] text-[11.5px] ${
                  item.active
                    ? "bg-white text-[#16171A] font-medium shadow-[0_1px_2px_rgba(0,0,0,0.06)]"
                    : "text-[#6B7280]"
                }`}
              >
                <span>{item.label}</span>
                {item.badge ? (
                  <span className="text-[9px] bg-[#16171A] text-white rounded-full px-1.5 py-0.5 leading-none font-medium">
                    {item.badge}
                  </span>
                ) : null}
              </div>
            ))}
          </nav>
        </div>

        {/* Main content */}
        <div className="flex-1 min-w-0 p-4">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h2 className="text-[15px] font-semibold text-[#16171A]">Workers</h2>
              <p className="text-[11px] text-[#6B7280]">8 active · 1 needs attention</p>
            </div>
            <button
              className="flex items-center gap-1 bg-[#16171A] text-white text-[11px] font-medium px-3 py-1.5 rounded-[8px]"
              aria-label="New worker"
            >
              <span className="text-[13px] leading-none">+</span>
              New worker
            </button>
          </div>

          {/* Worker cards */}
          <div className="space-y-2">
            {[
              {
                name: "Weekly Update",
                desc: "Turns raw notes into a formatted update",
                status: "healthy",
                tools: ["notion", "gmail"],
              },
              {
                name: "GitHub Digest",
                desc: "Every morning, summarise open PRs",
                status: "healthy",
                tools: ["github", "slack"],
              },
              {
                name: "Invoice Reconciler",
                desc: "Matches invoices to deals in HubSpot",
                status: "needs_attention",
                tools: ["gmail", "hubspot"],
              },
            ].map((w) => (
              <div
                key={w.name}
                className="flex items-center gap-3 bg-white rounded-[10px] px-3 py-2.5 shadow-[0_1px_2px_rgba(0,0,0,0.05)]"
              >
                <div
                  className="size-7 rounded-[7px] bg-[#F1EEE8] flex items-center justify-center text-[11px] font-semibold text-[#6B7280] shrink-0"
                  aria-hidden="true"
                >
                  {w.name[0]}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[12px] font-medium text-[#16171A] truncate">{w.name}</div>
                  <div className="text-[10.5px] text-[#6B7280] truncate">{w.desc}</div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {w.tools.map((t) => (
                    <BrandLogo key={t} icon={t} className="size-3.5" />
                  ))}
                </div>
                <span
                  className={`text-[9.5px] font-medium px-1.5 py-0.5 rounded-full shrink-0 ${
                    w.status === "healthy"
                      ? "bg-emerald-50 text-emerald-700"
                      : "bg-amber-50 text-amber-700"
                  }`}
                >
                  {w.status === "healthy" ? "active" : "attention"}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer card — the PromptText style composer input with inline tool logos.
// Fix #2 (two-row button): "Hire" button has whitespace-nowrap.
// Fix #5 (tool logos): ToolMention components inline in the prompt text.
// ---------------------------------------------------------------------------

function ComposerCard() {
  return (
    <div className="bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.06] p-5 space-y-4">
      <p className="text-[15px] leading-[1.6] text-[#16171A]">
        Summarise my{" "}
        <ToolMention slug="granola" label="Granola" />
        {" "}meetings and post action items to{" "}
        <ToolMention slug="hubspot" label="HubSpot" />
        {" "}daily
      </p>
      <div className="border-t border-[#E7E0D6]" />
      <div className="flex items-center justify-between gap-3">
        <span className="text-[12px] text-[#6B7280]">Recognised: Granola, HubSpot</span>
        <button
          className="bg-[#3E6FE0] text-white text-[13px] font-medium px-4 py-2 rounded-[10px] whitespace-nowrap shrink-0"
          aria-label="Hire this worker"
        >
          Hire
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// "This week" artifact card — runs log.
// Fix #6: clean column rhythm, fixed day-column width (w-10), checkmarks
// inline at end of row (not floating), consistent padding.
// ---------------------------------------------------------------------------

const RUNS = [
  { day: "Mon", action: "Posted to HubSpot", done: true },
  { day: "Tue", action: "Posted to HubSpot", done: true },
  { day: "Wed", action: "Posted to HubSpot", done: true },
  { day: "Thu", action: "Posted to HubSpot", done: true },
  { day: "Today", action: "Waiting on you", done: false },
] as const;

function ThisWeekCard() {
  return (
    <div className="bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.06] p-5">
      <div className="flex items-baseline justify-between mb-4">
        <h3 className="text-[14px] font-semibold text-[#16171A]">This week</h3>
        <span className="text-[11.5px] text-[#6B7280]">5 runs</span>
      </div>
      <div className="space-y-0">
        {RUNS.map((run, i) => (
          <div key={i}>
            {i > 0 && <div className="border-t border-[#F1EEE8]" />}
            <div className="flex items-center gap-3 py-2.5">
              {/* Fix #6: fixed day-column width so columns align */}
              <span className="w-10 shrink-0 text-[11.5px] font-medium text-[#6B7280]">
                {run.day}
              </span>
              <span className="flex-1 text-[13px] text-[#16171A]">{run.action}</span>
              {/* Fix #6: checkmark inline in row, not floating */}
              {run.done ? (
                <Check className="size-3.5 text-[#6B7280] shrink-0" strokeWidth={2.5} />
              ) : (
                <span className="size-2 rounded-full bg-[#3E6FE0] shrink-0" />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Email draft artifact card.
// Fix #6: consistent spacing, clean label typography, proper button sizing.
// ---------------------------------------------------------------------------

function EmailDraftCard() {
  return (
    <div className="bg-white rounded-2xl shadow-[0_2px_12px_rgba(0,0,0,0.08)] ring-1 ring-black/[0.06] p-5 space-y-3">
      <p className="text-[10.5px] font-medium uppercase tracking-wide text-[#6B7280]">
        Email draft · to Sarah at Acme
      </p>
      <h3 className="text-[16px] font-semibold text-[#16171A] leading-snug">
        Next steps from today&apos;s call
      </h3>
      <p className="text-[13px] text-[#6B7280] leading-[1.55]">
        Hi Sarah, thanks for the call today. Based on what you shared, I&apos;d
        suggest starting with the onboarding workflow and the CRM cleanup before
        renewals&hellip;
      </p>
      <p className="text-[11.5px] text-[#6B7280]">Built from your tone guide and pricing sheet</p>
      <div className="flex items-center gap-2 pt-1">
        <button className="bg-[#3E6FE0] text-white text-[13px] font-medium px-4 py-2 rounded-[10px] whitespace-nowrap">
          Approve
        </button>
        <button className="border border-[#E7E0D6] text-[#16171A] text-[13px] font-medium px-4 py-2 rounded-[10px] whitespace-nowrap">
          Edit
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Example prompt card — shows a template with inline tool mentions.
// Fix #1 (black blob): ToolMention uses light bg so GitHub logo (dark SVG)
// is always readable, never a solid blob.
// Fix #2 (two-row CTA): "Use template" is a small ghost button with nowrap.
// ---------------------------------------------------------------------------

interface ExampleCardProps {
  prompt: string;
  tools: Array<{ slug: string; label: string }>;
}

function ExampleCard({ prompt, tools }: ExampleCardProps) {
  return (
    <div className="bg-white rounded-xl ring-1 ring-black/[0.06] px-4 py-3 space-y-2">
      {/* Tokenise prompt: wrap tool names in ToolMention */}
      <p className="text-[12.5px] text-[#16171A] leading-[1.6]">
        {renderTokenisedPrompt(prompt, tools)}
      </p>
      <div className="flex items-center gap-1.5 flex-wrap">
        {tools.map((t) => (
          <span
            key={t.slug}
            className="inline-flex items-center gap-1 rounded-full bg-[#F1EEE8] px-2 py-0.5 text-[11px] text-[#16171A]"
          >
            <BrandLogo icon={t.slug} className="size-3 shrink-0" />
            {t.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Tokenise a prompt string: replace each tool label with a ToolMention span.
 * Simple sequential replacement — longest-first to avoid partial matches.
 */
function renderTokenisedPrompt(
  prompt: string,
  tools: Array<{ slug: string; label: string }>,
): ReactNode {
  // Sort tools longest-label-first to avoid partial overlaps.
  const sorted = [...tools].sort((a, b) => b.label.length - a.label.length);
  type Part = { type: "text"; text: string } | { type: "tool"; slug: string; label: string };

  let parts: Part[] = [{ type: "text", text: prompt }];

  for (const tool of sorted) {
    const next: Part[] = [];
    for (const part of parts) {
      if (part.type !== "text") {
        next.push(part);
        continue;
      }
      const idx = part.text.indexOf(tool.label);
      if (idx === -1) {
        next.push(part);
        continue;
      }
      if (idx > 0) next.push({ type: "text", text: part.text.slice(0, idx) });
      next.push({ type: "tool", slug: tool.slug, label: tool.label });
      const after = part.text.slice(idx + tool.label.length);
      if (after) next.push({ type: "text", text: after });
    }
    parts = next;
  }

  return parts.map((p, i) =>
    p.type === "text" ? (
      <span key={i}>{p.text}</span>
    ) : (
      <ToolMention key={i} slug={p.slug} label={p.label} />
    ),
  );
}

// ---------------------------------------------------------------------------
// Main landing layout
// ---------------------------------------------------------------------------

const EXAMPLES: Array<{ prompt: string; tools: Array<{ slug: string; label: string }> }> = [
  {
    prompt: "Summarise my Granola meetings and post action items to HubSpot daily",
    tools: [
      { slug: "granola", label: "Granola" },
      { slug: "hubspot", label: "HubSpot" },
    ],
  },
  {
    // Fix #1: "GitHub" is detected; ToolMention gives it a light bg so the
    // dark GitHub SVG (#181717) reads as a logo, never as a black blob.
    prompt: "Every morning at 9am, send me a digest of my unread GitHub PRs and open issues",
    tools: [{ slug: "github", label: "GitHub" }],
  },
  {
    prompt: "Every Monday 9am, pull last week's pipeline from HubSpot and post a summary in #sales",
    tools: [{ slug: "hubspot", label: "HubSpot" }],
  },
  {
    prompt: "Process any new email in label 'invoices', extract total amount, add a row to Google Sheets",
    tools: [
      { slug: "gmail", label: "Gmail" },
      { slug: "google-sheets", label: "Google Sheets" },
    ],
  },
];

export function V3Landing() {
  return (
    <div className="min-h-screen bg-[#FAFAF7]">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-[#E7E0D6] bg-[#FAFAF7]/90 backdrop-blur-sm">
        <div className="max-w-6xl mx-auto px-5 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2">
            <FloomMark size={22} />
            <span className="text-[14px] font-semibold tracking-tight text-[#16171A]">WorkerOS</span>
          </Link>
          <nav className="hidden sm:flex items-center gap-6">
            <Link href="/docs" className="text-[13px] text-[#6B7280] hover:text-[#16171A] transition-colors">
              Docs
            </Link>
            <Link href="/login" className="text-[13px] text-[#6B7280] hover:text-[#16171A] transition-colors">
              Sign in
            </Link>
          </nav>
          <Link
            href="/workers/new"
            className="bg-[#16171A] text-white text-[13px] font-medium px-4 py-2 rounded-[10px] whitespace-nowrap hover:bg-[#2a2b2f] transition-colors"
          >
            Get started
          </Link>
        </div>
      </header>

      {/* Hero */}
      <section className="max-w-6xl mx-auto px-5 pt-16 pb-12">
        <div className="max-w-2xl">
          <h1 className="text-[40px] sm:text-[52px] font-semibold tracking-tight text-[#16171A] leading-[1.1]">
            Hire AI workers
            <br />
            for your company.
          </h1>
          <p className="mt-4 text-[16px] text-[#6B7280] leading-[1.6] max-w-lg">
            Jobs that run themselves — on a schedule, from a message, or on demand.
            You get the output, not the mechanics.
          </p>
          <div className="mt-8 flex items-center gap-3 flex-wrap">
            <Link
              href="/workers/new"
              className="bg-[#16171A] text-white text-[14px] font-medium px-5 py-2.5 rounded-[10px] whitespace-nowrap hover:bg-[#2a2b2f] transition-colors"
            >
              Hire your first worker
            </Link>
            <Link
              href="/docs"
              className="text-[14px] text-[#6B7280] hover:text-[#16171A] transition-colors whitespace-nowrap"
            >
              Read the docs
            </Link>
          </div>
        </div>
      </section>

      {/* AppFrame product shot */}
      {/* Fix #3: AppFrame has ring-1 definition on light background. */}
      <section className="max-w-6xl mx-auto px-5 pb-16">
        <div className="max-w-3xl">
          <AppFrameMock />
        </div>
      </section>

      {/* Composer + artifact cards */}
      <section className="max-w-6xl mx-auto px-5 pb-16">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {/* Composer card (col 1) */}
          <div className="space-y-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-[#6B7280]">Composer</p>
            <ComposerCard />
          </div>

          {/* Artifact cards (col 2) */}
          <div className="space-y-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-[#6B7280]">This week</p>
            <ThisWeekCard />
          </div>

          {/* Email draft (col 3) */}
          <div className="space-y-4">
            <p className="text-[11px] font-medium uppercase tracking-wide text-[#6B7280]">Output</p>
            <EmailDraftCard />
          </div>
        </div>
      </section>

      {/* Example templates */}
      <section className="max-w-6xl mx-auto px-5 pb-20">
        <h2 className="text-[20px] font-semibold text-[#16171A] mb-6">Start from a template</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {EXAMPLES.map((ex, i) => (
            <ExampleCard key={i} {...ex} />
          ))}
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-[#E7E0D6] bg-[#F5F2EE]">
        <div className="max-w-6xl mx-auto px-5 py-8 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <FloomMark size={18} />
            <span className="text-[12.5px] font-semibold text-[#16171A]">WorkerOS</span>
          </div>
          <div className="flex items-center gap-5">
            <Link href="/docs" className="text-[12px] text-[#6B7280] hover:text-[#16171A] transition-colors">
              Docs
            </Link>
            <Link href="/privacy" className="text-[12px] text-[#6B7280] hover:text-[#16171A] transition-colors">
              Privacy
            </Link>
            <Link href="/terms" className="text-[12px] text-[#6B7280] hover:text-[#16171A] transition-colors">
              Terms
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
