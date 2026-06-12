/* Per-vertical landing data. One entry per department.
   Adding a 4th vertical = add an entry here + a 3-line route file.
   Keep capabilities to what the product genuinely does: connect tools
   via OAuth, run an LLM job on a trigger, draft/summarize/enrich/post.

   v2 (2026-05-30): each vertical now leads with a Slack demo for THAT team
   (same SlackThreadMock spine as the homepage hero) and an expanded outcome
   grid for the department, scoped to the spec's locked H1s. */
import type { ReactNode } from "react";
import {
  AnalyticsLogo,
  ATSLogo,
  CalendarIcon,
  FileTextIcon,
  GCalLogo,
  GmailLogo,
  HubSpotLogo,
  IntercomLogo,
  LinkedInLogo,
  MailIcon,
  NotionLogo,
  SalesforceLogo,
  SheetsLogo,
  ShieldIcon,
  SlackLogo,
  SparkIcon,
  TicketIcon,
  TrendIcon,
  UsersIcon,
  ZendeskLogo,
  type LogoComp,
} from "@/components/landing-icons";

export interface Capability {
  icon: () => ReactNode;
  title: string;
  body: string;
  tools: LogoComp[];
}

export interface ToolPill {
  label: string;
  logo: LogoComp;
}

/* The hero demo is a Slack exchange for THIS team: someone asks @workeros to
   do the department's core job, and the worker returns finished artifacts +
   anything held for approval. Mirrors the homepage SlackThreadMock exactly. */
export interface SlackDemo {
  /* the Slack channel the exchange happens in (no leading #) */
  channel: string;
  /* the human asking */
  userInitials: string;
  userName: string;
  /* the request, after the @workeros mention */
  ask: string;
  /* one-line summary the worker leads with (bolded "Done.") */
  doneLine: string;
  /* the primary artifact file it produced */
  artifactName: string;
  artifactMeta: string;
  /* secondary created items (checklist) */
  created: string[];
  /* the single action held for approval */
  approval: string;
}

/* Outcome bullets for this department, expanded from the homepage grid. */
export interface OutcomeItem {
  title: string;
  body: string;
}

export interface Vertical {
  slug: string;
  /* nav + title */
  metaTitle: string;
  metaDescription: string;
  eyebrow: string;
  h1: string;
  /* the accent word inside h1, wrapped in <em> */
  h1Accent: string;
  sub: string;
  primaryCtaLabel: string;
  slack: SlackDemo;
  toolsLabel: string;
  tools: ToolPill[];
  outcomesHead: string;
  outcomesSub: string;
  outcomes: OutcomeItem[];
  capabilitiesHead: string;
  capabilitiesSub: string;
  capabilities: Capability[];
  closingHead: string;
  closingSub: string;
}

export const VERTICALS: Record<string, Vertical> = {
  marketing: {
    slug: "marketing",
    metaTitle: "WorkerOS for Marketing: Campaign reporting that writes itself",
    metaDescription:
      "Hire an AI worker for your marketing team. It pulls performance from Google Analytics, drafts social from new posts, scores inbound leads in HubSpot, and watches competitors, on a schedule, a webhook, or with your approval.",
    eyebrow: "WorkerOS for Marketing",
    h1: "Campaign reporting that writes itself",
    h1Accent: "writes itself",
    sub: "Ask in Slack, connect Analytics, HubSpot, and Slack, and your worker pulls the numbers, drafts the posts, and scores the leads, using your brand voice and ICP, on a schedule, a webhook, or with your approval.",
    primaryCtaLabel: "Hire your marketing worker",
    slack: {
      channel: "marketing",
      userInitials: "PL",
      userName: "Priya Lang",
      ask: "write last week's performance digest and post it here",
      doneLine: "Last week's digest is up.",
      artifactName: "weekly-digest.md",
      artifactMeta: "Markdown · 6.2 KB · posted to #marketing",
      created: ["3 LinkedIn drafts from the new post", "CAC delta vs prior week"],
      approval: "Publish the 3 social drafts",
    },
    toolsLabel: "Connects to your marketing stack",
    tools: [
      { label: "Google Analytics", logo: AnalyticsLogo },
      { label: "HubSpot", logo: HubSpotLogo },
      { label: "Slack", logo: SlackLogo },
      { label: "LinkedIn", logo: LinkedInLogo },
      { label: "Sheets", logo: SheetsLogo },
      { label: "Gmail", logo: GmailLogo },
    ],
    outcomesHead: "What your marketing worker ships.",
    outcomesSub:
      "Each one connects the tools you already pay for, runs on a trigger you set, and returns a finished artifact, not a to-do.",
    outcomes: [
      { title: "Competitor research", body: "Tracks named competitors and your category, posts only what changed." },
      { title: "Campaign briefs", body: "Turns a goal into a brief with audience, angles, and channels." },
      { title: "Content repurposing", body: "Reworks one post into LinkedIn, X, and newsletter drafts in your voice." },
      { title: "Market digests", body: "Pulls the numbers and writes the weekly performance summary." },
    ],
    capabilitiesHead: "Four jobs it does on day one.",
    capabilitiesSub:
      "Each one connects the tools you already pay for, runs on a trigger you set, and shows you the artifact it produced.",
    capabilities: [
      {
        icon: TrendIcon,
        title: "Weekly performance digest",
        body: "Pulls sessions, conversions, and top pages from Google Analytics, joins spend from a Sheet, and posts a written digest with callouts to Slack.",
        tools: [AnalyticsLogo, SheetsLogo, SlackLogo],
      },
      {
        icon: SparkIcon,
        title: "Draft social from every new post",
        body: "When a new blog or press post ships, it drafts LinkedIn and X copy in your voice from your brand context, and holds them for your approval.",
        tools: [LinkedInLogo, SlackLogo],
      },
      {
        icon: HubSpotLogo,
        title: "Enrich + score inbound leads",
        body: "New form fills get enriched against public data, scored against your ICP context, and written back to HubSpot with a fit note for sales.",
        tools: [HubSpotLogo, GmailLogo],
      },
      {
        icon: ShieldIcon,
        title: "Competitor + news watch",
        body: "On a daily schedule it scans named competitors and your category, then posts only what changed to a Slack channel, no noise.",
        tools: [SlackLogo, GmailLogo],
      },
    ],
    closingHead: "Hire your marketing worker in two minutes.",
    closingSub:
      "Ask the job in Slack, connect Analytics, HubSpot, and Slack, set the approval policy. It runs on a schedule, a webhook, or on demand.",
  },

  recruiting: {
    slug: "recruiting",
    metaTitle: "WorkerOS for Recruiting: Screen every applicant before standup",
    metaDescription:
      "Hire an AI worker for your recruiting team. It screens new applicants against the role brief, drafts personalized outreach, sends a daily pipeline digest, and schedules interviews via Calendar, with your approval.",
    eyebrow: "WorkerOS for Recruiting",
    h1: "Screen every applicant before standup",
    h1Accent: "before standup",
    sub: "Ask in Slack, connect your ATS, Gmail, and Calendar, and your worker scores each new applicant against the brief, drafts the outreach, and books the interviews, on a schedule, a webhook, or with your approval.",
    primaryCtaLabel: "Hire your recruiting worker",
    slack: {
      channel: "hiring",
      userInitials: "SM",
      userName: "Sam Mehta",
      ask: "screen the overnight applicants for the Senior Backend role",
      doneLine: "Screened 9 overnight applicants.",
      artifactName: "shortlist.md",
      artifactMeta: "Markdown · 4.0 KB · 3 strong fits",
      created: ["Scorecards for all 9 vs the role brief", "3 outreach drafts for top fits"],
      approval: "Send 3 first-touch messages",
    },
    toolsLabel: "Connects to your recruiting stack",
    tools: [
      { label: "LinkedIn", logo: LinkedInLogo },
      { label: "Gmail", logo: GmailLogo },
      { label: "Google Calendar", logo: GCalLogo },
      { label: "Your ATS", logo: ATSLogo },
      { label: "Sheets", logo: SheetsLogo },
      { label: "Slack", logo: SlackLogo },
    ],
    outcomesHead: "What your recruiting worker ships.",
    outcomesSub:
      "Each one connects the tools you already pay for, runs on a trigger you set, and returns a finished artifact, not a to-do.",
    outcomes: [
      { title: "Candidate sourcing", body: "Finds and reads candidates against the role brief, ranks by fit." },
      { title: "Shortlists", body: "Turns the overnight pile into a ranked shortlist with rationale." },
      { title: "Outreach drafts", body: "Writes personalized first messages grounded in real background." },
      { title: "Interview summaries", body: "Summarizes calls and updates the candidate record." },
    ],
    capabilitiesHead: "Four jobs it does on day one.",
    capabilitiesSub:
      "Each one connects the tools you already pay for, runs on a trigger you set, and shows you the artifact it produced.",
    capabilities: [
      {
        icon: UsersIcon,
        title: "Screen new applicants",
        body: "Every new application is read against the role brief in your company context, scored for fit, and written back to your ATS with a short rationale.",
        tools: [ATSLogo, SheetsLogo],
      },
      {
        icon: MailIcon,
        title: "Draft personalized outreach",
        body: "For high-fit candidates it drafts a first message that references their actual background, then holds it for your approval before sending.",
        tools: [LinkedInLogo, GmailLogo],
      },
      {
        icon: TrendIcon,
        title: "Daily pipeline digest",
        body: "Each morning it summarizes new applicants, stalled candidates, and what needs a decision, and posts the digest to your team channel.",
        tools: [SlackLogo, ATSLogo],
      },
      {
        icon: CalendarIcon,
        title: "Auto-schedule interviews",
        body: "When a candidate replies, it finds open slots on your calendar, proposes times, and books the interview once they pick one.",
        tools: [GCalLogo, GmailLogo],
      },
    ],
    closingHead: "Hire your recruiting worker in two minutes.",
    closingSub:
      "Ask the job in Slack, connect your ATS, Gmail, and Calendar, set the approval policy. It runs on a schedule, a webhook, or on demand.",
  },

  support: {
    slug: "support",
    metaTitle: "WorkerOS for Support: Every ticket triaged the moment it lands",
    metaDescription:
      "Hire an AI worker for your support team. It triages and tags incoming tickets, drafts first-response replies, escalates urgent issues to Slack, and writes a weekly support-trends report, with your approval.",
    eyebrow: "WorkerOS for Support",
    h1: "Every ticket triaged the moment it lands",
    h1Accent: "the moment it lands",
    sub: "Ask in Slack, connect your helpdesk, Slack, and Notion, and your worker tags and prioritizes each ticket, drafts the first reply, and escalates what's urgent, on a schedule, a webhook, or with your approval.",
    primaryCtaLabel: "Hire your support worker",
    slack: {
      channel: "support",
      userInitials: "TK",
      userName: "Tess Koh",
      ask: "triage the new tickets and draft replies for the easy ones",
      doneLine: "Triaged 12 new tickets.",
      artifactName: "triage-summary.md",
      artifactMeta: "Markdown · 3.1 KB · 12 tickets tagged",
      created: ["7 first-response drafts", "2 urgent issues flagged to #oncall"],
      approval: "Send 7 first-response replies",
    },
    toolsLabel: "Connects to your support stack",
    tools: [
      { label: "Zendesk", logo: ZendeskLogo },
      { label: "Intercom", logo: IntercomLogo },
      { label: "Slack", logo: SlackLogo },
      { label: "Gmail", logo: GmailLogo },
      { label: "Notion", logo: NotionLogo },
    ],
    outcomesHead: "What your support worker ships.",
    outcomesSub:
      "Each one connects the tools you already pay for, runs on a trigger you set, and returns a finished artifact, not a to-do.",
    outcomes: [
      { title: "Ticket triage", body: "Reads each ticket with history, tags topic, and sets priority." },
      { title: "First-response drafts", body: "Writes accurate first replies grounded in your help docs." },
      { title: "Urgent escalation", body: "Posts outages, churn risks, and security reports to Slack fast." },
      { title: "Weekly trends report", body: "Groups tickets by theme and writes what's rising to Notion." },
    ],
    capabilitiesHead: "Four jobs it does on day one.",
    capabilitiesSub:
      "Each one connects the tools you already pay for, runs on a trigger you set, and shows you the artifact it produced.",
    capabilities: [
      {
        icon: TicketIcon,
        title: "Triage + tag incoming tickets",
        body: "Every new ticket is read with the customer's history, tagged by topic, and prioritized, so the right person sees the right ticket first.",
        tools: [ZendeskLogo, IntercomLogo],
      },
      {
        icon: MailIcon,
        title: "Draft first-response replies",
        body: "It drafts an accurate first reply grounded in your help docs in company context, then holds it for an agent to approve and send.",
        tools: [ZendeskLogo, NotionLogo],
      },
      {
        icon: ShieldIcon,
        title: "Escalate urgent issues",
        body: "When a ticket looks like an outage, an angry churn risk, or a security report, it posts the full context to a Slack channel right away.",
        tools: [SlackLogo, ZendeskLogo],
      },
      {
        icon: TrendIcon,
        title: "Weekly support-trends report",
        body: "Each week it groups tickets by theme, surfaces what's rising, and writes a report to Notion so the team fixes causes, not just tickets.",
        tools: [NotionLogo, SlackLogo],
      },
    ],
    closingHead: "Hire your support worker in two minutes.",
    closingSub:
      "Ask the job in Slack, connect your helpdesk, Slack, and Notion, set the approval policy. It runs on a schedule, a webhook, or on demand.",
  },

  sales: {
    slug: "sales",
    metaTitle: "WorkerOS for Sales: Every lead researched before you call",
    metaDescription:
      "Hire an AI worker for your sales team. It enriches and scores every new inbound lead in your CRM, drafts personalized first-touch outreach, sends a daily pipeline digest, and researches accounts before your calls, on a schedule, a webhook, or with your approval.",
    eyebrow: "WorkerOS for Sales",
    h1: "Every lead researched before you call",
    h1Accent: "before you call",
    sub: "Ask in Slack, connect your CRM, LinkedIn, and Gmail, and your worker enriches and scores each new lead, drafts the first touch, and briefs you on the account, on a schedule, a webhook, or with your approval.",
    primaryCtaLabel: "Hire your sales worker",
    slack: {
      channel: "revenue",
      userInitials: "JR",
      userName: "Jordan Rivera",
      ask: "research these 5 inbound leads before my 2pm calls",
      doneLine: "Done.",
      artifactName: "lead-brief.md",
      artifactMeta: "Markdown · 6.2 KB · 5 leads",
      created: ["3 follow-up drafts", "HubSpot score updates"],
      approval: "Send 3 external replies",
    },
    toolsLabel: "Connects to your sales stack",
    tools: [
      { label: "Salesforce", logo: SalesforceLogo },
      { label: "HubSpot", logo: HubSpotLogo },
      { label: "LinkedIn", logo: LinkedInLogo },
      { label: "Gmail", logo: GmailLogo },
      { label: "Google Calendar", logo: GCalLogo },
      { label: "Sheets", logo: SheetsLogo },
    ],
    outcomesHead: "What your sales worker ships.",
    outcomesSub:
      "Each one connects the tools you already pay for, runs on a trigger you set, and returns a finished artifact, not a to-do.",
    outcomes: [
      { title: "Lead research", body: "Enriches each new lead with company, funding, role, and news." },
      { title: "CRM updates", body: "Scores fit against your ICP and writes the note back to the CRM." },
      { title: "Follow-up drafts", body: "Drafts personalized first-touch replies grounded in your messaging." },
      { title: "Account briefs", body: "Pulls signals and writes a pre-call brief so you walk in ready." },
    ],
    capabilitiesHead: "Four jobs it does on day one.",
    capabilitiesSub:
      "Each one connects the tools you already pay for, runs on a trigger you set, and shows you the artifact it produced.",
    capabilities: [
      {
        icon: SparkIcon,
        title: "Enrich + score every new lead",
        body: "Every new inbound lead is enriched against public data, scored against your ICP context, and written back to your CRM with a fit note so reps work the right ones first.",
        tools: [SalesforceLogo, LinkedInLogo],
      },
      {
        icon: MailIcon,
        title: "Draft personalized first-touch outreach",
        body: "For high-fit leads it drafts a first email that references their company and role, grounded in your messaging context, then holds it for your approval before sending.",
        tools: [GmailLogo, HubSpotLogo],
      },
      {
        icon: TrendIcon,
        title: "Daily pipeline digest",
        body: "Each morning it summarizes deal movement, stalled opportunities, and what needs a next step, and posts the digest to your team channel.",
        tools: [SlackLogo, SalesforceLogo],
      },
      {
        icon: FileTextIcon,
        title: "Research an account before a call",
        body: "Ahead of a meeting it pulls recent news, headcount changes, and buying signals, then posts a short brief to your inbox or channel so you walk in prepared.",
        tools: [LinkedInLogo, GCalLogo],
      },
    ],
    closingHead: "Hire your sales worker in two minutes.",
    closingSub:
      "Ask the job in Slack, connect your CRM, LinkedIn, and Gmail, set the approval policy. It runs on a schedule, a webhook, or on demand.",
  },
};

export const VERTICAL_SLUGS = Object.keys(VERTICALS);
