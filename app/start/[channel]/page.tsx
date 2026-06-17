// #819 — channel-first entry, pre-auth. The landing's "Works without the
// dashboard" row lands HERE instead of /login: the visitor sees the actual
// install flow for their channel first, and sign-in is deferred to the final
// bind step (the CTA carries ?install=<channel>, which the app consumes after
// auth — the #552 mechanism). Full anonymous provisioning (no sign-in at all,
// signed onboarding token) is #817 and depends on backend work (#762/#733).

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ChannelActions } from "@/app/v3/ChannelActions";
import { V3Shell } from "../../v3/V3Shell";

type ChannelKey = "mcp";

const CHANNELS: Record<
  ChannelKey,
  {
    name: string;
    title: string;
    lead: string;
    steps: [string, string][];
    ctaNote: string;
  }
> = {
  mcp: {
    name: "MCP",
    title: "Floom from any MCP agent",
    lead: "Claude Code, Cursor, Codex — if it speaks MCP, it can hire and run your workers.",
    steps: [
      ["Install the server", "npm i -g @floomhq/workeros — ships the workeros-mcp stdio server."],
      ["Point your agent at it", "Copy the config below into Claude Code, Cursor, Codex, or any MCP client."],
      ["Drive workers from your editor", "“Run client-follow-up for the Acme call.” The run lands in your workspace like any other."],
    ],
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
  if (!c) return { title: "Floom" };
  return {
    title: `${c.title} · Floom`,
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
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-secondary text-[12px] font-medium text-muted-foreground">
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
          <ChannelActions compact only={channel as ChannelKey} />
          <p className="mt-3 text-[12px] leading-relaxed text-muted-foreground">{c.ctaNote}</p>
        </div>
      </main>
    </V3Shell>
  );
}
