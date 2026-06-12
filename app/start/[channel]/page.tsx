// #819 — channel-first entry, pre-auth. The landing's "Works without the
// dashboard" row lands HERE instead of /login: the visitor sees the actual
// install flow for their channel first, and sign-in is deferred to the final
// bind step (the CTA carries ?install=<channel>, which the app consumes after
// auth — the #552 mechanism). Full anonymous provisioning (no sign-in at all,
// signed onboarding token) is #817 and depends on backend work (#762/#733).

import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { V3Shell } from "../../v3/V3Shell";

type ChannelKey = "slack" | "whatsapp" | "mcp";

const CHANNELS: Record<
  ChannelKey,
  {
    name: string;
    title: string;
    lead: string;
    steps: [string, string][];
    cta: { label: string; href: string };
    ctaNote: string;
  }
> = {
  slack: {
    name: "Slack",
    title: "WorkerOS in Slack",
    lead: "Hire and run AI workers from the workspace you already live in. The dashboard stays optional.",
    steps: [
      ["Add WorkerOS to Slack", "One workspace install. Your team DMs Emily, the WorkerOS assistant, like any coworker."],
      ["Describe the job", "“Every Monday, pull last week’s signups and draft the investor update.” Emily sets the worker up from the conversation."],
      ["Approve in-channel", "Anything that writes to your tools pauses for an approval card in Slack. Nothing ships without you."],
    ],
    cta: { label: "Add to Slack", href: "/login?install=slack" },
    ctaNote: "Connecting Slack creates your workspace at the last step — that's the only moment sign-in appears.",
  },
  whatsapp: {
    name: "WhatsApp",
    title: "WorkerOS on WhatsApp",
    lead: "Message your workers like you message anyone else. No app to learn, no dashboard required.",
    steps: [
      ["Connect your number", "Scan a QR code and WorkerOS recognises your WhatsApp number."],
      ["Describe the job", "Send the job as a message. Emily sets the worker up and confirms what it will do."],
      ["Approve by reply", "Runs that need a decision message you first. Reply to approve or reject."],
    ],
    cta: { label: "Connect WhatsApp", href: "/login?install=whatsapp" },
    ctaNote: "The QR + number bind happens right after the one-time sign-in — everything else lives in WhatsApp.",
  },
  mcp: {
    name: "MCP",
    title: "WorkerOS from any MCP agent",
    lead: "Claude Code, Cursor, Codex — if it speaks MCP, it can hire and run your workers.",
    steps: [
      ["Install the server", "npm i -g @floomhq/workeros — ships the workeros-mcp stdio server."],
      ["Point your agent at it", "Add workeros-mcp to your agent's MCP config. The docs have copy-paste blocks for Claude Code, Cursor, and Codex."],
      ["Drive workers from your editor", "“Run client-follow-up for the Acme call.” The run lands in your workspace like any other."],
    ],
    cta: { label: "Read the MCP setup", href: "/docs#mcp" },
    ctaNote: "The server needs a workspace token; you sign in once to mint it and never need the dashboard again.",
  },
};

export function generateStaticParams() {
  return Object.keys(CHANNELS).map((channel) => ({ channel }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ channel: string }>;
}): Promise<Metadata> {
  const { channel } = await params;
  const c = CHANNELS[channel as ChannelKey];
  if (!c) return { title: "WorkerOS" };
  return {
    title: `${c.title} · WorkerOS`,
    description: c.lead,
  };
}

export default async function StartChannelPage({
  params,
}: {
  params: Promise<{ channel: string }>;
}) {
  const { channel } = await params;
  const c = CHANNELS[channel as ChannelKey];
  if (!c) notFound();

  return (
    <V3Shell>
      <main className="mx-auto max-w-[640px] pt-16 pb-8">
        <p className="text-[12px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          Works without the dashboard
        </p>
        <h1 className="mt-2 text-[28px] font-semibold leading-tight tracking-tight">
          {c.title}
        </h1>
        <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">{c.lead}</p>

        <ol className="mt-9 space-y-6">
          {c.steps.map(([heading, body], i) => (
            <li key={heading} className="flex gap-4">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-border text-[12px] font-medium text-muted-foreground">
                {i + 1}
              </span>
              <div>
                <h2 className="text-[14px] font-medium">{heading}</h2>
                <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">{body}</p>
              </div>
            </li>
          ))}
        </ol>

        <div className="mt-10">
          <Link
            href={c.cta.href}
            className="inline-flex h-9 items-center rounded-[10px] bg-primary px-4 text-[13px] font-medium text-primary-foreground transition-opacity hover:opacity-90"
          >
            {c.cta.label}
          </Link>
          <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">{c.ctaNote}</p>
        </div>
      </main>
    </V3Shell>
  );
}
