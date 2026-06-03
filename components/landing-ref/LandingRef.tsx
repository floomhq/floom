import Link from "next/link";
import { ArrowRight, Hash, Send } from "lucide-react";
import { SlackHero } from "./SlackHero";
import { Nav, Footer } from "./Nav";
import { ToolLogoChip } from "./logos";
import { TemplateCard } from "./TemplateCard";
import { TemplateRow } from "./TemplateRow";
import { BrainVisual } from "./BrainVisual";
import { EmailArtifact } from "./EmailArtifact";
import { RunCard } from "./RunCard";
import { getTemplate } from "./data";

const TEMPLATES_HREF = "/templates";
const ASK_HREF = "/assistant";

const STACK = [
  "Slack",
  "Gmail",
  "Google Calendar",
  "HubSpot",
  "Sheets",
  "Notion",
  "Salesforce",
  "Linear",
  "Drive",
  "Airtable",
  "Webhooks",
];

export function LandingRef() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main>
        <Hero />
        <StackRow />
        <PopularTemplates />
        <OutputSection />
        <BrainSection />
        <RunsSection />
        <ConnectionsSection />
        <FinalCTA />
      </main>
      <Footer />
    </div>
  );
}

function SectionHead({
  eyebrow,
  title,
  sub,
  center,
}: {
  eyebrow?: string;
  title: string;
  sub?: string;
  center?: boolean;
}) {
  return (
    <div className={center ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      {eyebrow && (
        <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
          {eyebrow}
        </div>
      )}
      <h2 className="text-balance text-[32px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[40px]">
        {title}
      </h2>
      {sub && <p className="mt-3 text-base text-muted-foreground">{sub}</p>}
    </div>
  );
}

/* 1 + 2 — HERO + Slack/Floom run visual */
function Hero() {
  return (
    <section className="px-6 pt-20 pb-12 sm:pt-28">
      <div className="mx-auto max-w-3xl text-center">
        <h1 className="text-balance text-[44px] font-semibold leading-[1.05] tracking-[-0.025em] text-foreground sm:text-[60px]">
          AI workers that run
          <br className="hidden sm:inline" /> company ops from Slack.
        </h1>
        <p className="text-balance mx-auto mt-7 max-w-xl text-[17px] leading-relaxed text-muted-foreground">
          Choose a worker, or ask Floom for a recurring task. Floom uses your tools and company
          brain, runs the work behind Slack, and brings the output back for approval.
        </p>
        <div className="mt-9 flex flex-wrap items-center justify-center gap-2">
          <Link
            href={TEMPLATES_HREF}
            className="inline-flex h-11 items-center gap-1.5 rounded-[12px] bg-primary px-5 text-[14px] font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            Browse templates <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href={ASK_HREF}
            className="inline-flex h-11 items-center rounded-[12px] border border-border bg-card px-5 text-[14px] font-medium text-foreground shadow-sm transition hover:bg-accent"
          >
            Ask Floom
          </Link>
        </div>
      </div>
      <div id="see-how-it-works" className="relative mx-auto mt-16 max-w-[1000px] scroll-mt-20">
        <SlackHero />
      </div>
    </section>
  );
}

/* 3 — WORKS WITH YOUR STACK (quiet strip) */
function StackRow() {
  return (
    <section className="px-6 py-12">
      <div className="mx-auto max-w-5xl">
        <div className="text-center text-[11px] font-medium uppercase tracking-[0.22em] text-muted-foreground">
          Works with your stack
        </div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-1.5">
          {STACK.map((t) => (
            <ToolLogoChip key={t} tool={t} size="sm" surface="app" />
          ))}
          <span className="px-2 text-[11.5px] text-muted-foreground">1,000+ more</span>
        </div>
      </div>
    </section>
  );
}

/* 4 — POPULAR TEMPLATES (featured card + compact rows) */
function PopularTemplates() {
  const featured = getTemplate("client-follow-up-worker")!;
  const rows = [
    "monday-report-worker",
    "lead-research-worker",
    "competitor-watch-worker",
    "recruiting-bd-worker",
  ]
    .map((s) => getTemplate(s)!)
    .filter(Boolean);

  return (
    <section id="templates" className="scroll-mt-20 border-t border-border/70 bg-secondary/40 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-4">
          <SectionHead
            eyebrow="Templates"
            title="Start with a worker template."
            sub="Ready-to-run workers for recurring work teams already need."
          />
          <Link
            href={TEMPLATES_HREF}
            className="inline-flex h-11 items-center gap-1.5 rounded-[12px] border border-border bg-card px-4 text-[13.5px] font-medium text-foreground shadow-sm transition hover:bg-accent"
          >
            Browse all templates <ArrowRight className="h-4 w-4" />
          </Link>
        </div>
        <div className="grid gap-4 lg:grid-cols-[1.05fr_1fr] lg:items-stretch">
          <TemplateCard t={featured} featured />
          <div className="flex flex-col gap-3">
            {rows.map((t) => (
              <TemplateRow key={t.slug} t={t} />
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

/* 5 — ACTUAL WORK COMES BACK (artifact composition) */
function OutputSection() {
  return (
    <section className="px-6 py-24">
      <div className="mx-auto grid max-w-5xl gap-12 md:grid-cols-[1fr_1.2fr] md:items-center">
        <SectionHead
          eyebrow="Output"
          title="Actual work comes back."
          sub="Floom returns the finished email, report, note, brief, or draft your team asked for."
        />
        <EmailArtifact
          title="Client follow-up email"
          byline="by Client Follow-up Worker · just now"
          statusLabel="Draft"
          sources={["Google Calendar", "Gmail", "HubSpot", "Company Brain"]}
          subject="Next steps from today's call"
          body={
            "Hi Sarah,\n\nGreat speaking today. I pulled together the two workflows we discussed:\n\n1. onboarding follow-up after new accounts\n2. CRM cleanup before renewals\n\nI also added the call notes to HubSpot and created the next-step task for Friday."
          }
          signoff={"Best,\nMaya"}
          footerNote="Used meeting notes, CRM record, pricing context, and past follow-ups."
        />
      </div>
    </section>
  );
}

/* 6 — COMPANY BRAIN / CONTEXTS (spatial composition) */
function BrainSection() {
  return (
    <section id="brain" className="scroll-mt-20 border-t border-border/70 bg-secondary/40 px-6 py-24">
      <div className="mx-auto max-w-6xl">
        <div className="mb-12">
          <SectionHead
            center
            eyebrow="Company Brain"
            title="Every worker knows how your company works."
            sub="Floom uses your Contexts: docs, SOPs, examples, rules, and past work every time a worker runs."
          />
        </div>
        <BrainVisual />
      </div>
    </section>
  );
}

/* 7 — EVERY RUN IS VISIBLE (inspector) */
function RunsSection() {
  return (
    <section id="runs" className="scroll-mt-20 px-6 py-24">
      <div className="mx-auto grid max-w-5xl gap-12 md:grid-cols-[0.85fr_1.15fr] md:items-center">
        <SectionHead
          eyebrow="Runs"
          title="Every run is visible."
          sub="Floom shows what happened, what was used, what was created, what needs approval, and what failed."
        />
        <RunCard
          layout="inspector"
          id="Run #1042"
          worker="Client Follow-up Worker"
          statusLabel="Completed"
          trigger="Slack request"
          tools={["Google Calendar", "Gmail", "HubSpot", "Slack"]}
          brain={["Tone guide", "Pricing", "CRM rules", "Past follow-ups"]}
          output="Email draft + CRM note"
          approval="Required before sending"
        />
      </div>
    </section>
  );
}

/* 8 — CONNECTIONS (compact capability strip) */
const CAPABILITIES: Array<{ label: string; items: string[]; kind: "tools" | "pills" }> = [
  { label: "Read from", items: ["Gmail", "Slack", "HubSpot", "Notion", "Drive"], kind: "tools" },
  { label: "Write to", items: ["Gmail", "Sheets", "HubSpot", "Salesforce", "Linear", "Airtable"], kind: "tools" },
  { label: "Trigger from", items: ["Schedule", "New email", "New lead", "Webhook", "Calendar event", "Slack request"], kind: "pills" },
  { label: "Approve in", items: ["Slack"], kind: "tools" },
];

function ConnectionsSection() {
  return (
    <section id="connections" className="scroll-mt-20 border-t border-border/70 bg-secondary/40 px-6 py-24">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10">
          <SectionHead
            eyebrow="Connections"
            title="Connects to your tools."
            sub="Workers can read, write, trigger, and ask for approval across your stack."
          />
        </div>
        <div className="divide-y divide-border/70 overflow-hidden rounded-[18px] border border-border bg-card shadow-sm">
          {CAPABILITIES.map((cap) => (
            <div
              key={cap.label}
              className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-center sm:gap-6"
            >
              <div className="w-32 shrink-0 text-[12.5px] font-semibold text-foreground">
                {cap.label}
              </div>
              <div className="flex flex-wrap gap-1.5">
                {cap.kind === "tools"
                  ? cap.items.map((t) => <ToolLogoChip key={t} tool={t} size="sm" surface="app" />)
                  : cap.items.map((t) => (
                      <span
                        key={t}
                        className="inline-flex h-7 items-center rounded-[9px] border border-border bg-background px-2 text-[11.5px] font-medium text-foreground/85"
                      >
                        {t}
                      </span>
                    ))}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[12.5px] text-muted-foreground">Works with 1,000+ tools.</p>
      </div>
    </section>
  );
}

/* 9 — FINAL CTA */
function FinalCTA() {
  return (
    <section className="px-6 py-28">
      <div className="mx-auto max-w-2xl text-center">
        <h2 className="text-balance text-[40px] font-semibold leading-[1.05] tracking-[-0.025em] text-foreground sm:text-[52px]">
          Start with a template.
        </h2>
        <p className="mx-auto mt-5 max-w-md text-[15.5px] text-muted-foreground">
          Browse ready-to-run workers, or ask Floom for the recurring task you want off your plate.
        </p>

        <div className="mx-auto mt-9 max-w-xl overflow-hidden rounded-[18px] border border-border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border bg-secondary/40 px-3 py-1.5 text-[10.5px] text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Hash className="h-3 w-3" />
              <span className="font-mono text-foreground/80">sales</span>
            </div>
            <span>Slack</span>
          </div>
          <div className="flex items-center gap-2 px-3 py-2.5 text-left">
            <span className="font-mono text-[13.5px] text-foreground">
              <span className="text-muted-foreground">/floom</span> run Client Follow-up Worker after
              sales calls
            </span>
            <span
              aria-hidden="true"
              className="ml-auto grid h-6 w-6 shrink-0 place-items-center rounded bg-primary text-primary-foreground"
            >
              <Send className="h-3 w-3" />
            </span>
          </div>
        </div>

        <div className="mt-8 flex flex-wrap items-center justify-center gap-2">
          <Link
            href={TEMPLATES_HREF}
            className="inline-flex h-11 items-center gap-1.5 rounded-[12px] bg-primary px-5 text-[14px] font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            Browse templates <ArrowRight className="h-4 w-4" />
          </Link>
          <Link
            href={ASK_HREF}
            className="inline-flex h-11 items-center rounded-[12px] border border-border bg-card px-5 text-[14px] font-medium text-foreground shadow-sm transition hover:bg-accent"
          >
            Ask Floom
          </Link>
        </div>
        <p className="mt-6 text-[12px] text-muted-foreground">
          Runs in Slack · Uses your tools · Asks before it acts
        </p>
      </div>
    </section>
  );
}
