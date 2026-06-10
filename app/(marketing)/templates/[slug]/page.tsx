import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowRight, ArrowLeft } from "lucide-react";
import { ToolLogoChip } from "@/components/landing-ref/logos";
import { StatusPill } from "@/components/landing-ref/StatusPill";
import { RunCard } from "@/components/landing-ref/RunCard";
import { EmailArtifact } from "@/components/landing-ref/EmailArtifact";
import { ApprovalCard } from "@/components/landing-ref/ApprovalCard";
import { TEMPLATES, getTemplate, getTemplateDetail } from "@/components/landing-ref/data";

const USE_HREF = "/login";
const ASK_HREF = "/assistant";

export function generateStaticParams() {
  return TEMPLATES.map((t) => ({ slug: t.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const t = getTemplate(slug);
  if (!t) return { title: "Template — Floom Workers" };
  return {
    title: `${t.name} — Floom Workers`,
    description: t.job,
  };
}

function SummaryItem({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex-1 rounded-[18px] border border-border bg-card p-4 shadow-sm">
      <div className="text-[10.5px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
        {k}
      </div>
      <div className="mt-1.5 text-[13.5px] font-medium text-foreground">{children}</div>
    </div>
  );
}

export default async function TemplateDetailPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const t = getTemplate(slug);
  if (!t) notFound();
  const d = getTemplateDetail(t);
  const run = d.exampleRun;

  return (
    <main className="px-6 py-14 sm:py-16">
      <div className="mx-auto max-w-4xl">
        <Link
          href="/templates"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> All templates
        </Link>

        {/* Header */}
        <div className="mt-6 flex flex-wrap items-start justify-between gap-6">
          <div className="max-w-xl">
            <div className="mb-3 flex items-center gap-2">
              <span className="inline-flex items-center rounded-full border border-border bg-secondary/60 px-2 py-0.5 text-[10.5px] font-medium text-muted-foreground">
                {t.category}
              </span>
              <StatusPill tone={t.approval === "Required" ? "warning" : t.approval === "Optional" ? "muted" : "default"}>
                Approval {t.approval.toLowerCase()}
              </StatusPill>
            </div>
            <h1 className="text-balance text-[34px] font-semibold leading-tight tracking-[-0.025em] text-foreground sm:text-[42px]">
              {t.name}
            </h1>
            <p className="mt-3 text-[16px] leading-relaxed text-muted-foreground">{d.summary}</p>
            <div className="mt-6 flex flex-wrap gap-2">
              <Link
                href={USE_HREF}
                className="group/cta inline-flex h-11 items-center gap-1.5 rounded-[12px] px-5 text-[14px] font-semibold text-white shadow-[0_8px_24px_-8px_rgba(58,110,165,0.45)] transition hover:-translate-y-px hover:shadow-[0_12px_32px_-10px_rgba(58,110,165,0.55)]"
                style={{ background: "#3a6ea5" }}
              >
                Hire this worker
                <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover/cta:translate-x-0.5" />
              </Link>
              <Link
                href={ASK_HREF}
                className="inline-flex h-11 items-center rounded-[12px] border border-border bg-card px-5 text-[14px] font-medium text-foreground shadow-sm transition hover:border-foreground/30 hover:bg-secondary/60"
              >
                Ask Floom
              </Link>
            </div>
          </div>
        </div>

        {/* Summary strip */}
        <div className="mt-10 flex flex-col gap-3 sm:flex-row">
          <SummaryItem k="Output">{t.output}</SummaryItem>
          <SummaryItem k="Runs when">{t.runs}</SummaryItem>
          <SummaryItem k="Approval">{t.approvalNote}</SummaryItem>
        </div>

        {/* Tools */}
        <div className="mt-10">
          <h2 className="text-[12.5px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            Tools
          </h2>
          <div className="mt-3 flex flex-wrap gap-1.5">
            {t.tools.map((tool) => (
              <ToolLogoChip key={tool} tool={tool} surface="app" />
            ))}
          </div>
        </div>

        {/* What it does */}
        <div className="mt-10 grid gap-8 md:grid-cols-2">
          <div>
            <h2 className="text-[18px] font-semibold text-foreground">What it does</h2>
            <p className="mt-3 text-[14.5px] leading-relaxed text-muted-foreground">{d.whatItDoes}</p>
          </div>
          <div>
            <h2 className="text-[18px] font-semibold text-foreground">Company Brain it uses</h2>
            <div className="mt-3 flex flex-wrap gap-1.5">
              {d.brainUsed.map((b) => (
                <span
                  key={b}
                  className="inline-flex h-7 items-center rounded-[9px] border border-border bg-secondary/60 px-2 text-[12px] text-foreground/85"
                >
                  {b}
                </span>
              ))}
            </div>
          </div>
        </div>

        {/* Example run */}
        <div className="mt-12">
          <h2 className="mb-4 text-[18px] font-semibold text-foreground">Example run</h2>
          <RunCard
            id={run.id}
            worker={t.name}
            statusLabel="Output ready"
            trigger={run.trigger}
            tools={run.toolsUsed}
            brain={run.brainUsed}
            output={run.output}
            approval={run.approvalQuestion}
            fields={["trigger", "tools", "brain", "output"]}
            footer={
              <ApprovalCard
                question={run.approvalQuestion}
                action="Floom asks before any external action."
                primaryLabel={run.approvalQuestion.toLowerCase().includes("send") ? "Send email" : "Approve"}
              />
            }
          >
            <div className="space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Output
              </div>
              <EmailArtifact
                title={`Draft · to ${run.email.to}`}
                subject={run.email.subject}
                body={run.email.body}
                signoff={run.email.signoff}
                showActions={false}
              />
            </div>
          </RunCard>
        </div>

        {/* Final CTA */}
        <div className="mt-14 rounded-[18px] border border-border bg-secondary/40 px-6 py-10 text-center">
          <h2 className="text-balance text-[26px] font-semibold tracking-[-0.02em] text-foreground sm:text-[30px]">
            Use {t.name} from Slack.
          </h2>
          <p className="mx-auto mt-3 max-w-md text-[14.5px] text-muted-foreground">
            Connect your tools, add your company brain, and Floom will run this worker and bring
            the output back for approval.
          </p>
          <div className="mt-6 flex justify-center">
            <Link
              href={USE_HREF}
              className="group/cta inline-flex h-11 items-center gap-1.5 rounded-[12px] px-5 text-[14px] font-semibold text-white shadow-[0_8px_24px_-8px_rgba(58,110,165,0.45)] transition hover:-translate-y-px hover:shadow-[0_12px_32px_-10px_rgba(58,110,165,0.55)]"
              style={{ background: "#3a6ea5" }}
            >
              Hire this worker
              <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover/cta:translate-x-0.5" />
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
