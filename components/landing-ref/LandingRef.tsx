import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { Nav, Footer } from "./Nav";
import { ToolLogoChip } from "./logos";
import { TemplateCard } from "./TemplateCard";
import { TemplateRow } from "./TemplateRow";
import { BrainVisual } from "./BrainVisual";
import { EmailArtifact } from "./EmailArtifact";
import { ScrollEmailArtifact } from "./ScrollEmailArtifact";
import { RunCard } from "./RunCard";
import { Reveal, RevealItem, RevealStagger } from "./Reveal";
import { HeroPromptComposer } from "./HeroPromptComposer";
import { HeroV3Collage } from "../hero-variants/HeroV3Collage";
import { ScrollToHeroButton } from "./ScrollToHeroButton";
import { getTemplate } from "./data";

const TEMPLATES_HREF = "/templates";
const ASK_HREF = "/assistant";

export function LandingRef() {
  return (
    <div className="min-h-screen bg-background">
      <Nav />
      <main>
        <HeroV3Collage />
        <PopularTemplates />
        <OutputSection />
        <KnowsYourCompany />
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
    <Reveal className={center ? "mx-auto max-w-2xl text-center" : "max-w-2xl"}>
      {eyebrow && (
        <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-[#3a6ea5]"
          style={center ? { justifyContent: "center" } : undefined}
        >
          <span aria-hidden="true" className="h-px w-6 bg-[#3a6ea5]/30" />
          {eyebrow}
          <span aria-hidden="true" className="h-px w-6 bg-[#3a6ea5]/30" />
        </div>
      )}
      <h2 className="text-balance text-[32px] font-semibold leading-tight tracking-[-0.02em] text-foreground sm:text-[40px]">
        {title}
      </h2>
      {sub && <p className="mt-3 text-base text-muted-foreground">{sub}</p>}
    </Reveal>
  );
}

/* 1 — HERO: brand line + prompt composer (new-worker-flow first) */
/* PopularTemplates */
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
    <section
      id="templates"
      className="relative scroll-mt-20 bg-foreground px-6 py-20 text-background"
    >
      <div className="relative mx-auto max-w-6xl">
        <Reveal className="mb-10 flex flex-wrap items-end justify-between gap-4">
          <div className="max-w-2xl">
            <div className="mb-3 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.22em] text-background/65">
              <span aria-hidden="true" className="h-px w-6 bg-background/30" />
              Start in 60 seconds
            </div>
            <h2 className="text-balance text-[32px] font-semibold leading-tight tracking-[-0.02em] text-background sm:text-[40px]">
              Hire a worker in 60 seconds.
            </h2>
            <p className="mt-3 text-base text-background/65">
              Templates already tuned for the recurring work teams ask Workeros to handle.
            </p>
          </div>
          <Link
            href={TEMPLATES_HREF}
            className="group/cta inline-flex h-11 items-center gap-1.5 rounded-[12px] bg-background px-4 text-[13.5px] font-semibold text-foreground shadow-[0_8px_24px_-8px_rgba(0,0,0,0.45)] transition hover:-translate-y-px hover:shadow-[0_12px_32px_-10px_rgba(0,0,0,0.55)]"
          >
            Browse all templates{" "}
            <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover/cta:translate-x-0.5" />
          </Link>
        </Reveal>
        <RevealStagger className="grid gap-4 lg:grid-cols-[1.05fr_1fr] lg:items-stretch">
          <RevealItem className="min-w-0">
            <TemplateCard t={featured} featured />
          </RevealItem>
          <RevealStagger className="flex min-w-0 flex-col gap-3">
            {rows.map((t) => (
              <RevealItem key={t.slug} className="min-w-0">
                <TemplateRow t={t} />
              </RevealItem>
            ))}
          </RevealStagger>
        </RevealStagger>
      </div>
    </section>
  );
}

/* 4 — REAL WORK, NOT CHAT (output artifact) */
function OutputSection() {
  return (
    <section className="px-6 py-20">
      <div className="mx-auto grid max-w-5xl gap-12 md:grid-cols-[1fr_1.2fr] md:items-center">
        <SectionHead
          eyebrow="Real work, not chat"
          title="The finished email, draft, or report lands on your desk."
          sub="Workers return what your team would have written: the follow-up, the brief, the report. Ready to send, with the work shown."
        />
        <ScrollEmailArtifact
          title="Client follow-up email"
          byline="by Client Follow-up Worker · just now"
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

/* 5 — KNOWS YOUR COMPANY (Brain only — focal brain visual) */
function KnowsYourCompany() {
  return (
    <section
      id="how-it-works"
      className="scroll-mt-20 border-t border-border/70 bg-secondary/40 px-6 py-20"
    >
      <div className="mx-auto max-w-6xl">
        <div className="mb-12">
          <SectionHead
            center
            eyebrow="Knows your company"
            title="Workers learn your company first."
            sub="Docs, SOPs, examples, rules, past work. Every brief includes what your team already knows."
          />
        </div>

        <Reveal className="mx-auto max-w-5xl" delay={0.1}>
          <BrainVisual />
        </Reveal>
      </div>
    </section>
  );
}

/* 6 — EVERY RUN ON THE RECORD (RunCard inspector, own section) */
function RunsSection() {
  return (
    <section id="runs" className="scroll-mt-20 px-6 py-20">
      <div className="mx-auto grid max-w-5xl gap-12 md:grid-cols-[0.85fr_1.15fr] md:items-center">
        <SectionHead
          eyebrow="Every run on the record"
          title="What happened, what was used, what's waiting on you."
          sub="Floom shows the trigger, the tools the worker used, the context it pulled, and the output it created, with the approval gate before anything ships."
        />
        <Reveal>
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
        </Reveal>
      </div>
    </section>
  );
}

/* 6 — WORKS WITH YOUR STACK (merged StackRow + Connections, operator copy) */
const CAPABILITIES: Array<{ label: string; items: string[]; kind: "tools" | "pills" }> = [
  { label: "Reads from", items: ["Gmail", "Slack", "HubSpot", "Notion", "Drive"], kind: "tools" },
  { label: "Writes to", items: ["Gmail", "Sheets", "HubSpot", "Salesforce", "Linear", "Airtable"], kind: "tools" },
  { label: "Starts on", items: ["Schedule", "New email", "New lead", "Webhook", "Calendar event", "Slack request"], kind: "pills" },
  { label: "Asks you in", items: ["Slack"], kind: "tools" },
];

function ConnectionsSection() {
  return (
    <section id="connections" className="scroll-mt-20 px-6 py-20">
      <div className="mx-auto max-w-5xl">
        <div className="mb-10 flex flex-wrap items-end justify-between gap-6">
          <SectionHead
            eyebrow="Works with your stack"
            title="Your worker uses the tools your team already works in."
            sub="And asks before doing anything that ships externally: emails, CRM updates, posts, signed docs."
          />
          <p className="text-[12.5px] text-muted-foreground">1,000+ tools via Composio</p>
        </div>
        <RevealStagger className="divide-y divide-border/70 overflow-hidden rounded-[18px] border border-border bg-card shadow-sm">
          {CAPABILITIES.map((cap) => (
            <RevealItem
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
            </RevealItem>
          ))}
        </RevealStagger>
      </div>
    </section>
  );
}

/* 7 — FINAL CTA (repeat the hero primitive — single source of conversion) */
function FinalCTA() {
  return (
    <section className="border-t border-border/70 bg-secondary/40 px-6 py-20">
      <div className="mx-auto max-w-3xl text-center">
        <Reveal>
          <h2 className="text-balance text-[40px] font-semibold leading-[1.02] tracking-[-0.03em] text-foreground sm:text-[56px]">
            Hire your first worker.
          </h2>
        </Reveal>
        <Reveal delay={0.08}>
          <p className="mx-auto mt-5 max-w-md text-[16px] text-muted-foreground">
            Describe the task once. Workeros runs it for your team, with your approval before anything ships.
          </p>
        </Reveal>
        <Reveal delay={0.16}>
          <div className="mt-9 flex flex-col items-stretch justify-center gap-3 sm:flex-row sm:flex-wrap sm:items-center">
            <ScrollToHeroButton className="w-full sm:w-auto">Describe your worker</ScrollToHeroButton>
            <Link
              href={TEMPLATES_HREF}
              className="inline-flex h-12 w-full items-center justify-center gap-1.5 rounded-[12px] border border-border bg-card px-5 text-[14px] font-medium text-foreground transition hover:border-foreground/30 hover:bg-secondary/60 sm:w-auto"
            >
              Or browse templates
            </Link>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
