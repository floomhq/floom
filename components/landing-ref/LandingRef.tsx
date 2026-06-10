import { TemplateCard } from "./TemplateCard";
import { TemplateRow } from "./TemplateRow";
import { BrainVisual } from "./BrainVisual";
import { ScrollEmailArtifact } from "./ScrollEmailArtifact";
import { RunCard } from "./RunCard";
import { RevealItem, RevealStagger } from "./Reveal";
import { HeroV3Collage } from "../hero-variants/HeroV3Collage";
import { InterfaceMockups } from "./InterfaceMockups";
import { SectionHeader } from "./SectionHeader";
import { TemplatesHeader, FinalCTAGroup } from "./LandingMotion";
import { CapabilityRow } from "./CapabilityRow";
import { getTemplate } from "./data";

const TEMPLATES_HREF = "/templates";

export function LandingRef() {
  return (
    <main>
      <HeroV3Collage />
      <PopularTemplates />
      <OutputSection />
      <InterfaceMockups />
      <KnowsYourCompany />
      <RunsSection />
      <ConnectionsSection />
      <FinalCTA />
    </main>
  );
}

// SectionHead extracted to ./SectionHeader (client) with proper stagger motion.
const SectionHead = SectionHeader;

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
        <TemplatesHeader templatesHref={TEMPLATES_HREF} />
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

        <div className="mx-auto max-w-5xl">
          <BrainVisual />
        </div>
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
            <RevealItem key={cap.label}>
              <CapabilityRow label={cap.label} items={cap.items} kind={cap.kind} />
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
      <FinalCTAGroup templatesHref={TEMPLATES_HREF} />
    </section>
  );
}
