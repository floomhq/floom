/* Per-vertical landing data. One entry per department.
   Adding a 4th vertical = add an entry here + a 3-line route file.
   Keep capabilities to what the product genuinely does: connect tools
   via OAuth, run an LLM job on a trigger, draft/summarize/enrich/post. */
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

/* The hero mock evokes the worker's primary tool (a tasteful chrome +
   rows panel), with the agent doing one real task inside it. */
export interface HeroMock {
  /* tool-tinted accent, e.g. Slack aubergine, Zendesk teal, LinkedIn blue */
  accent: string;
  /* fake URL in the chrome bar */
  url: string;
  /* the tool surface title + the agent's task line */
  app: string;
  appIcon: () => ReactNode;
  taskKicker: string;
  task: string;
  /* the agent's run, as 3 concrete steps it took inside the tool */
  steps: string[];
  /* the artifact it produced + where it landed */
  artifactName: string;
  artifactMeta: string;
  artifactCta: string;
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
  hero: HeroMock;
  toolsLabel: string;
  tools: ToolPill[];
  capabilitiesHead: string;
  capabilitiesSub: string;
  capabilities: Capability[];
  closingHead: string;
  closingSub: string;
}

export const VERTICALS: Record<string, Vertical> = {
  marketing: {
    slug: "marketing",
    metaTitle: "Workeros for Marketing — Your marketing team's AI worker",
    metaDescription:
      "Hire an AI worker for your marketing team. It pulls performance from Google Analytics, drafts social from new posts, scores inbound leads in HubSpot, and watches competitors — on a schedule, a webhook, or with your approval.",
    eyebrow: "Workeros for Marketing",
    h1: "Your marketing team's AI worker",
    h1Accent: "marketing",
    sub: "It reads your analytics, drafts the posts, scores the leads, and watches the competition — connected to the tools your team already uses.",
    primaryCtaLabel: "Hire your marketing worker",
    hero: {
      accent: "#FF7A59",
      url: "workeros.floom.dev/runs · marketing-digest",
      app: "Weekly Performance Digest",
      appIcon: TrendIcon,
      taskKicker: "Runs every Monday 08:00",
      task: "Summarize last week's traffic + funnel and post it to #marketing",
      steps: [
        "Pulled sessions, conversions + top pages from Google Analytics",
        "Joined spend from the campaign sheet · computed CAC delta",
        "Wrote the digest + 3 callouts · posted to Slack #marketing",
      ],
      artifactName: "weekly-digest.md + Slack post",
      artifactMeta: "artifact · 6.2 KB · posted to #marketing",
      artifactCta: "Open",
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
        body: "When a new blog or press post ships, it drafts LinkedIn and X copy in your voice from a mounted style guide, and holds them for your approval.",
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
        body: "On a daily schedule it scans named competitors and your category, then posts only what changed to a Slack channel — no noise.",
        tools: [SlackLogo, GmailLogo],
      },
    ],
    closingHead: "Hire your marketing worker in two minutes.",
    closingSub:
      "Describe the job, connect Analytics, HubSpot, and Slack, set the approval policy. It runs on a schedule, a webhook, or on demand.",
  },

  recruiting: {
    slug: "recruiting",
    metaTitle: "Workeros for Recruiting — Your recruiting team's AI worker",
    metaDescription:
      "Hire an AI worker for your recruiting team. It screens new applicants against the role brief, drafts personalized outreach, sends a daily pipeline digest, and schedules interviews via Calendar — with your approval.",
    eyebrow: "Workeros for Recruiting",
    h1: "Your recruiting team's AI worker",
    h1Accent: "recruiting",
    sub: "It screens applicants against the brief, drafts the outreach, digests the pipeline, and books the interviews — working inside your ATS and inbox.",
    primaryCtaLabel: "Hire your recruiting worker",
    hero: {
      accent: "#24A47F",
      url: "workeros.floom.dev/runs · applicant-screen",
      app: "New Applicant Screen",
      appIcon: UsersIcon,
      taskKicker: "Runs on every new application",
      task: "Score the candidate against the Senior Backend role brief",
      steps: [
        "Read the resume + answers from your ATS",
        "Scored against the role brief in mounted context · 4 / 5 fit",
        "Drafted a personalized first message · held for your approval",
      ],
      artifactName: "scorecard.md + outreach draft",
      artifactMeta: "artifact · 3.4 KB · awaiting your approval",
      artifactCta: "Review",
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
    capabilitiesHead: "Four jobs it does on day one.",
    capabilitiesSub:
      "Each one connects the tools you already pay for, runs on a trigger you set, and shows you the artifact it produced.",
    capabilities: [
      {
        icon: UsersIcon,
        title: "Screen new applicants",
        body: "Every new application is read against the role brief in a mounted context, scored for fit, and written back to your ATS with a short rationale.",
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
      "Describe the job, connect your ATS, Gmail, and Calendar, set the approval policy. It runs on a schedule, a webhook, or on demand.",
  },

  support: {
    slug: "support",
    metaTitle: "Workeros for Support — Your support team's AI worker",
    metaDescription:
      "Hire an AI worker for your support team. It triages and tags incoming tickets, drafts first-response replies, escalates urgent issues to Slack, and writes a weekly support-trends report — with your approval.",
    eyebrow: "Workeros for Support",
    h1: "Your support team's AI worker",
    h1Accent: "support",
    sub: "It triages the queue, drafts the first reply, escalates what's urgent, and reports the trends — working inside your helpdesk and Slack.",
    primaryCtaLabel: "Hire your support worker",
    hero: {
      accent: "#03363D",
      url: "workeros.floom.dev/runs · ticket-triage",
      app: "Incoming Ticket Triage",
      appIcon: TicketIcon,
      taskKicker: "Runs on every new ticket",
      task: "Tag, prioritize, and draft a first reply for the new ticket",
      steps: [
        "Read the ticket + customer history from your helpdesk",
        "Tagged billing · priority high · matched a known issue",
        "Drafted a first-response reply · held for your approval",
      ],
      artifactName: "tagged ticket + reply draft",
      artifactMeta: "artifact · 2.1 KB · awaiting your approval",
      artifactCta: "Review",
    },
    toolsLabel: "Connects to your support stack",
    tools: [
      { label: "Zendesk", logo: ZendeskLogo },
      { label: "Intercom", logo: IntercomLogo },
      { label: "Slack", logo: SlackLogo },
      { label: "Gmail", logo: GmailLogo },
      { label: "Notion", logo: NotionLogo },
    ],
    capabilitiesHead: "Four jobs it does on day one.",
    capabilitiesSub:
      "Each one connects the tools you already pay for, runs on a trigger you set, and shows you the artifact it produced.",
    capabilities: [
      {
        icon: TicketIcon,
        title: "Triage + tag incoming tickets",
        body: "Every new ticket is read with the customer's history, tagged by topic, and prioritized — so the right person sees the right ticket first.",
        tools: [ZendeskLogo, IntercomLogo],
      },
      {
        icon: MailIcon,
        title: "Draft first-response replies",
        body: "It drafts an accurate first reply grounded in your help docs mounted as context, then holds it for an agent to approve and send.",
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
      "Describe the job, connect your helpdesk, Slack, and Notion, set the approval policy. It runs on a schedule, a webhook, or on demand.",
  },
};

export const VERTICAL_SLUGS = Object.keys(VERTICALS);
