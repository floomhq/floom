import { Hash, Lock, Plus, Send, Star, Users } from "lucide-react";
import { RunCard } from "./RunCard";
import { ApprovalCard } from "./ApprovalCard";

function Avatar({ initial, color }: { initial: string; color: string }) {
  return (
    <div
      className="grid h-9 w-9 shrink-0 place-items-center rounded-md text-xs font-semibold text-white"
      style={{ backgroundColor: color }}
    >
      {initial}
    </div>
  );
}

function Message({
  who,
  color,
  time,
  app,
  children,
}: {
  who: string;
  color: string;
  time: string;
  app?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <Avatar initial={who[0]} color={color} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-[13.5px] font-bold text-foreground">{who}</span>
          {app && (
            <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-bold uppercase tracking-wider text-muted-foreground">
              App
            </span>
          )}
          <span className="font-mono text-[11px] text-muted-foreground">{time}</span>
        </div>
        <div className="mt-0.5 text-[13.5px] leading-relaxed text-foreground">{children}</div>
      </div>
    </div>
  );
}

/** Compact email preview embedded inside the hero run card. */
function EmailPreview() {
  return (
    <div className="rounded-[12px] border border-border bg-secondary/50 px-3 py-2.5">
      <div className="text-[12.5px] font-semibold text-foreground">
        Subject: Next steps from today&apos;s call
      </div>
      <p className="mt-1 text-[12.5px] leading-relaxed text-foreground/85">
        Hi Sarah — thanks for the call today. Based on what you shared, I&apos;d suggest starting
        with the onboarding workflow and CRM cleanup first. I&apos;ve added the call notes to HubSpot
        and drafted the next-step task.
      </p>
      <div className="mt-1.5 text-[11.5px] text-muted-foreground">— Maya</div>
    </div>
  );
}

export function SlackHero() {
  return (
    <div className="overflow-hidden rounded-[18px] border border-border bg-card shadow-md">
      {/* Restrained Slack chrome: aubergine titlebar */}
      <div className="flex items-center gap-2 border-b border-border bg-[#3F0E40] px-3 py-2 text-white">
        <div className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-[#ED6A5E]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#F4BF4F]" />
          <span className="h-2.5 w-2.5 rounded-full bg-[#61C554]" />
        </div>
        <div className="mx-auto flex items-center gap-2 font-mono text-[11.5px] text-white/70">
          <Lock className="h-3 w-3" /> floom-hq.slack.com
        </div>
        <div className="w-12" />
      </div>

      {/* Channel header */}
      <div className="flex items-center justify-between border-b border-border bg-card px-4 py-2.5">
        <div className="flex items-center gap-2">
          <Hash className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">sales</span>
          <Star className="h-3.5 w-3.5 text-muted-foreground/60" />
          <span className="ml-2 hidden text-xs text-muted-foreground sm:inline">
            Acme · deals, calls, and follow-ups
          </span>
        </div>
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Users className="h-3.5 w-3.5" /> 8
        </div>
      </div>

      {/* Thread */}
      <div className="space-y-5 px-4 py-5 sm:px-5">
        <Message who="Maya" color="#7C3AED" time="2:14 PM">
          Run <span className="font-semibold">Client Follow-up Worker</span> for the Acme call.
        </Message>
        <Message who="Floom" color="#181818" time="2:14 PM" app>
          On it. I&apos;ll check the meeting notes, CRM context, and past follow-ups.
        </Message>

        <div className="sm:pl-12">
          <RunCard
            id="Run #1042"
            worker="Client Follow-up Worker"
            statusLabel="Output ready"
            trigger="Slack request"
            tools={["Google Calendar", "Gmail", "HubSpot", "Slack"]}
            brain={["Tone guide", "Pricing", "CRM rules", "Past follow-ups"]}
            output="Follow-up email draft to Sarah at Acme"
            approval="Send this email?"
            fields={["trigger", "tools", "brain"]}
          >
            <div className="space-y-2">
              <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                Output · email draft
              </div>
              <EmailPreview />
            </div>
          </RunCard>

          <div id="approvals" className="mt-3 scroll-mt-24">
            <ApprovalCard
              question="Send this email?"
              action="Floom asks before sending external emails."
              primaryLabel="Send email"
            />
          </div>
        </div>
      </div>

      {/* Restrained composer */}
      <div className="mx-4 mb-4 rounded-[12px] border border-border bg-card shadow-sm sm:mx-5">
        <div className="flex items-center gap-2 px-3 py-2 text-[13.5px]">
          <Plus className="h-4 w-4 text-muted-foreground" />
          <span className="text-muted-foreground/70">Message #sales</span>
          <span
            aria-hidden="true"
            className="ml-auto grid h-6 w-6 place-items-center rounded bg-primary text-primary-foreground"
          >
            <Send className="h-3 w-3" />
          </span>
        </div>
      </div>
    </div>
  );
}
