"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  BarChart3,
  Check,
  Mail,
  MessageSquare,
  Search,
  type LucideIcon,
} from "lucide-react";

import { Button, buttonVariants } from "@/components/ui/button";
import { api, setActiveWorkspaceId } from "@/lib/api";
import { getPublicSiteOrigin } from "@/lib/api-base";
import { useWorkspaceHref } from "@/lib/useWorkspaceHref";

type OnboardingStep = "goal" | "template" | "sample";

export type GoalLane = {
  id: "outreach" | "inbox" | "research" | "reports";
  title: string;
  summary: string;
  Icon: LucideIcon;
  template: {
    handle: string;
    slug: string;
    name: string;
    description: string;
    connectionSlug: string;
    connectionName: string;
    permissions: readonly string[];
    sampleActions: readonly string[];
    sampleMeta: string;
    sampleBody: string;
  };
};

export const GOAL_LANES: readonly GoalLane[] = [
  {
    id: "outreach",
    title: "Outreach & Leads",
    summary: "Replies and follow-ups",
    Icon: Mail,
    template: {
      handle: "fede",
      slug: "partnership-signal-outreach",
      name: "Partnership Signal & Outreach",
      description:
        "Finds promising people in your LinkedIn activity and drafts personal outreach for your approval.",
      connectionSlug: "linkedin",
      connectionName: "LinkedIn",
      permissions: [
        "Reads recent interactions only.",
        "Never sends without your approval.",
        "Disconnect any time.",
      ],
      sampleActions: [
        "Read 8 sample LinkedIn interactions",
        "Matched 3 people to a partnership brief",
        "Drafted outreach and held it for approval",
      ],
      sampleMeta: "Sample: Priya M. engaged with two partnership posts",
      sampleBody:
        "Hi Priya, I noticed your work on partner-led growth. We are exploring a similar model at Floom and I would value your perspective. Open to connecting?",
    },
  },
  {
    id: "inbox",
    title: "Inbox & Comms",
    summary: "Triage and summaries",
    Icon: MessageSquare,
    template: {
      handle: "fede",
      slug: "gmail-inbox-cleaner",
      name: "Gmail Inbox Cleaner",
      description:
        "Sorts new mail with your rules, prepares a digest, and can draft replies for your approval.",
      connectionSlug: "gmail",
      connectionName: "Gmail",
      permissions: [
        "Reads the messages covered by your rules.",
        "Never sends a draft without your approval.",
        "Disconnect any time.",
      ],
      sampleActions: [
        "Scanned 14 sample emails",
        "Sorted 9 messages with inbox rules",
        "Drafted 2 replies and held them for approval",
      ],
      sampleMeta: "Sample: Anna asked to move next week's intro call",
      sampleBody:
        "Hi Anna, Wednesday at 14:00 works on my side. I will send an updated invite now. Happy to move it if another time suits you better.",
    },
  },
  {
    id: "research",
    title: "Research",
    summary: "Briefs and watchlists",
    Icon: Search,
    template: {
      handle: "fede",
      slug: "meeting-prep",
      name: "Meeting Prep",
      description:
        "Turns the context around a meeting into a short brief with talking points and decisions to land.",
      connectionSlug: "gmail",
      connectionName: "Gmail",
      permissions: [
        "Reads relevant meeting context only.",
        "Does not send or change messages.",
        "Disconnect any time.",
      ],
      sampleActions: [
        "Gathered sample account context",
        "Summarized the latest email thread",
        "Prepared talking points and decisions",
      ],
      sampleMeta: "Sample: Acme renewal call, Tuesday at 10:00",
      sampleBody:
        "Goal: agree the renewal scope. Open point: Acme wants weekly reporting. Ask who owns the rollout and confirm the 30-day success measure.",
    },
  },
  {
    id: "reports",
    title: "Reports & Dev",
    summary: "Digests and recaps",
    Icon: BarChart3,
    template: {
      handle: "fede",
      slug: "slack-weekly-recap",
      name: "Slack Weekly Recap",
      description:
        "Turns a week of Slack discussion into a concise Friday recap of themes, decisions, and open work.",
      connectionSlug: "slack",
      connectionName: "Slack",
      permissions: [
        "Reads the channels you choose.",
        "Nothing posts until you approve it.",
        "Disconnect any time.",
      ],
      sampleActions: [
        "Read a sample week of Slack messages",
        "Grouped the discussion into 4 themes",
        "Drafted a Friday recap for approval",
      ],
      sampleMeta: "Sample: Product team, week ending Friday",
      sampleBody:
        "This week: onboarding copy is final, the billing migration passed staging, and two mobile bugs remain open. Next: ship the migration and close the mobile fixes.",
    },
  },
] as const;

function Progress({ step }: { step: OnboardingStep }) {
  const active = step === "goal" ? 0 : step === "template" ? 1 : 2;
  const labels = ["Choose", "Try it", "First run"] as const;

  return (
    <ol className="flex items-center justify-center gap-2" aria-label="Onboarding progress">
      {labels.map((label, index) => (
        <li key={label} className="contents">
          {index > 0 && (
            <span
              className={`h-px w-5 ${index <= active ? "bg-[var(--accent)]" : "bg-[var(--border)]"}`}
              aria-hidden="true"
            />
          )}
          <span
            className={`inline-flex items-center gap-1.5 text-[11.5px] font-medium ${
              index === active ? "text-ink" : "text-[var(--ink-mute)]"
            }`}
            aria-current={index === active ? "step" : undefined}
          >
            <span
              className={`inline-flex size-5 items-center justify-center rounded-full text-[10px] font-semibold ${
                index <= active
                  ? "bg-[var(--accent)] text-white"
                  : "bg-[var(--bg-2)] text-[var(--ink-mute)]"
              }`}
            >
              {index + 1}
            </span>
            <span className="hidden sm:inline">{label}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function BackButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={onClick}
      className="h-7 gap-1 bg-transparent px-0 text-xs text-[var(--ink-soft)] hover:bg-transparent hover:text-ink"
    >
      <ArrowLeft className="size-3.5" aria-hidden="true" />
      Back
    </Button>
  );
}

export function GoalOnboarding() {
  const router = useRouter();
  const workspaceHref = useWorkspaceHref();
  const [step, setStep] = useState<OnboardingStep>("goal");
  const [lane, setLane] = useState<GoalLane | null>(null);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);

  const chooseLane = (next: GoalLane) => {
    setLane(next);
    setImportError(null);
    setStep("template");
  };

  const importTemplate = async () => {
    if (!lane || importing) return;
    setImporting(true);
    setImportError(null);
    try {
      const result = await api.workers.importFromPermalink(
        lane.template.handle,
        lane.template.slug,
      );
      if (result.workspace_id) setActiveWorkspaceId(result.workspace_id);
      router.push(workspaceHref(`/run/${encodeURIComponent(result.worker_id)}`));
    } catch (error) {
      setImporting(false);
      setImportError(
        error instanceof Error
          ? error.message
          : "Could not add this worker. Try again.",
      );
    }
  };

  const template = lane?.template;
  const connectHref = template
    ? workspaceHref(
        `/connections/connect/${encodeURIComponent(template.connectionSlug)}?return_to=${encodeURIComponent("/")}`,
      )
    : "/connections";
  const templateHref = template
    ? `${getPublicSiteOrigin()}/@${template.handle}/${template.slug}`
    : `${getPublicSiteOrigin()}/templates`;

  return (
    <section className="w-full max-w-[720px] px-5 sm:px-8" aria-label="Get your first worker running">
      <div className="mb-7">
        <Progress step={step} />
      </div>

      {step === "goal" && (
        <div className="text-center">
          <p className="mx-auto max-w-[620px] text-[28px] font-semibold leading-[1.12] tracking-[-0.03em] text-ink sm:text-[34px]">
            Hire AI workers to handle the tasks you do over and over.
          </p>
          <h1 className="mt-7 text-[21px] font-semibold tracking-[-0.02em] text-ink sm:text-[24px]">
            What do you want off your plate?
          </h1>
          <p className="mt-2 text-[13.5px] text-[var(--text-muted)]">
            Emily helps you choose a worker and understand each step.
          </p>

          <div className="mt-6 grid gap-2.5 text-left sm:grid-cols-2">
            {GOAL_LANES.map((item) => {
              const Icon = item.Icon;
              return (
                <Button
                  key={item.id}
                  type="button"
                  variant="outline"
                  onClick={() => chooseLane(item)}
                  className="group h-auto min-h-[88px] w-full justify-start gap-3 rounded-[var(--radius-card)] bg-[var(--bg-card)] px-4 py-3.5 text-left whitespace-normal [border:var(--bd-card)] hover:bg-[var(--bg-2)]"
                >
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-[var(--radius-button)] bg-[var(--accent-soft)] text-[var(--accent)]">
                    <Icon className="size-[17px]" aria-hidden="true" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-[14.5px] font-semibold text-ink">
                      {item.title}
                    </span>
                    <span className="mt-0.5 block text-xs text-[var(--text-muted)]">
                      {item.summary}
                    </span>
                  </span>
                </Button>
              );
            })}
          </div>
        </div>
      )}

      {step === "template" && template && (
        <div>
          <BackButton onClick={() => setStep("goal")} />
          <div className="mt-4 rounded-[var(--radius-card)] bg-[var(--bg-card)] p-5 [border:var(--bd-card)] sm:p-6">
            <p className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[var(--accent)]">
              Prefilled template
            </p>
            <h1 className="mt-2 text-[22px] font-semibold tracking-[-0.02em] text-ink">
              {template.name}
            </h1>
            <p className="mt-2 text-[13.5px] leading-6 text-[var(--ink-soft)]">
              {template.description}
            </p>

            <ul className="mt-5 space-y-2.5">
              {template.permissions.map((permission) => (
                <li key={permission} className="flex items-center gap-2.5 text-[13px] text-[var(--ink-soft)]">
                  <span className="flex size-4 shrink-0 items-center justify-center rounded bg-[var(--accent-soft)] text-[var(--accent)]">
                    <Check className="size-2.5" strokeWidth={3} aria-hidden="true" />
                  </span>
                  {permission}
                </li>
              ))}
            </ul>

            <Button
              type="button"
              size="lg"
              onClick={() => setStep("sample")}
              className="mt-6 h-11 w-full px-4 text-[13.5px] font-semibold"
            >
              See it with sample data first
            </Button>
            <Link
              href={connectHref}
              className={buttonVariants({
                variant: "outline",
                size: "lg",
                className: "mt-2.5 h-10 w-full px-4 text-[13px] no-underline",
              })}
            >
              Connect {template.connectionName}
            </Link>
            <p className="mt-2 text-center text-[11.5px] text-[var(--ink-mute)]">
              No connection is needed for the sample.
            </p>
          </div>
        </div>
      )}

      {step === "sample" && template && (
        <div>
          <BackButton onClick={() => setStep("template")} />
          <div className="mt-4 rounded-[var(--radius-card)] bg-[var(--bg-card)] p-5 [border:var(--bd-card)] sm:p-6">
            <div className="flex flex-wrap items-center gap-2.5">
              <span className="size-2 rounded-full bg-[var(--accent)]" aria-hidden="true" />
              <h1 className="text-[18px] font-semibold text-ink">First sample run complete</h1>
              <span className="text-[11.5px] text-[var(--ink-mute)]">Sample data, no external tools used</span>
            </div>

            <div className="mt-5 overflow-hidden rounded-[var(--radius-card)] bg-[var(--bg-2)]">
              {template.sampleActions.map((action, index) => (
                <div
                  key={action}
                  className={`flex items-center gap-2.5 px-4 py-3 text-[13px] text-[var(--ink-soft)] ${
                    index > 0 ? "[border-top:var(--bd-div)]" : ""
                  }`}
                >
                  <span className="flex size-[18px] shrink-0 items-center justify-center rounded bg-[var(--accent-soft)] text-[var(--accent)]">
                    <Check className="size-3" strokeWidth={3} aria-hidden="true" />
                  </span>
                  {action}
                </div>
              ))}
            </div>

            <div className="mt-4 rounded-[var(--radius-card)] bg-[var(--bg-2)] p-4">
              <p className="text-[11.5px] font-medium text-[var(--ink-mute)]">
                {template.sampleMeta}
              </p>
              <p className="mt-2 text-[13px] leading-6 text-[var(--ink-soft)]">
                {template.sampleBody}
              </p>
            </div>

            {importError && (
              <p className="mt-4 rounded-[var(--radius-button)] bg-[color-mix(in_srgb,var(--negative)_8%,transparent)] px-3 py-2 text-center text-xs text-[var(--negative)]" role="alert">
                {importError}
              </p>
            )}

            <Button
              type="button"
              size="lg"
              onClick={() => void importTemplate()}
              disabled={importing}
              className="mt-5 h-11 w-full px-4 text-[13.5px] font-semibold disabled:cursor-wait"
            >
              {importing ? "Adding worker..." : "Add to workspace and continue"}
            </Button>
            <div className="mt-2.5 flex flex-col items-center justify-center gap-1.5 text-xs sm:flex-row sm:gap-4">
              <Link
                href={connectHref}
                className="font-medium text-[var(--ink-soft)] no-underline hover:text-ink"
              >
                Connect {template.connectionName}
              </Link>
              <a
                href={templateHref}
                className="font-medium text-[var(--ink-soft)] no-underline hover:text-ink"
              >
                View template details
              </a>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
