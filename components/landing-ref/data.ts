// Worker + workspace templates — ready-to-run AI workers (demand-side:
// prebuilt worker recipes) and curated workspaces (a bundle of workers for a
// whole role). NOT a supply-side skills marketplace.

export type Category =
  | "Sales"
  | "Ops"
  | "Founder"
  | "Recruiting"
  | "Finance"
  | "Research"
  | "Marketing"
  | "Customer";

export type Approval = "Required" | "Optional" | "Auto-run";

// The shape of the artifact a worker produces. Each worker carries a real
// miniature `sample` of its output so the card shows the WORK, not a skeleton.
export type PreviewKind = "email" | "digest" | "list" | "kpi" | "issues";

export type Sample =
  | { kind: "email"; subject: string; to: string; lines: string[] }
  | { kind: "digest"; title: string; items: string[] }
  | { kind: "list"; rows: { name: string; score: string }[] }
  | { kind: "kpi"; cells: { label: string; value: string; delta?: string }[] }
  | { kind: "issues"; rows: { pri: "high" | "med" | "low"; title: string }[] };

export type Template = {
  slug: string;
  name: string;
  category: Category;
  job: string;
  output: string;
  runs: string;
  tools: string[];
  approval: Approval;
  approvalNote: string;
  triggers: string[];
  sample: Sample;
};

export const CATEGORIES: Category[] = [
  "Sales",
  "Ops",
  "Founder",
  "Recruiting",
  "Finance",
  "Research",
  "Marketing",
  "Customer",
];

export const FILTER_TOOLS = [
  "Gmail",
  "Google Calendar",
  "HubSpot",
  "Sheets",
  "Notion",
  "Linear",
  "Slack",
  "Drive",
  "Web",
];

export const FILTER_TRIGGERS = ["Schedule", "New email", "On demand", "Webhook"];

// Real workers, drawn from the proven WorkerOS bench. `runs` = cadence.
export const TEMPLATES: Template[] = [
  // --- Sales ---
  {
    slug: "client-follow-up-worker",
    name: "Client Follow-up Worker",
    category: "Sales",
    job: "Drafts follow-up emails after calls and adds the CRM note.",
    output: "Email draft + CRM note",
    runs: "After selected calls",
    tools: ["Google Calendar", "Gmail", "HubSpot"],
    approval: "Required",
    approvalNote: "Required before sending",
    triggers: ["Calendar event"],
    sample: {
      kind: "email",
      subject: "Next steps from today's call",
      to: "Sarah at Acme",
      lines: ["Recapped the onboarding plan", "Logged the call in HubSpot", "Booked Friday follow-up"],
    },
  },
  {
    slug: "lead-research-worker",
    name: "Lead Research Worker",
    category: "Sales",
    job: "Researches new prospects and drafts outreach angles.",
    output: "Lead briefs + CRM notes",
    runs: "On every new lead",
    tools: ["HubSpot", "Gmail", "Web"],
    approval: "Required",
    approvalNote: "Required before CRM updates or outreach",
    triggers: ["New lead"],
    sample: {
      kind: "digest",
      title: "Acme Corp — 3 outreach angles",
      items: ["Just raised a $40M Series B", "Hiring 12 SDRs — scaling pain", "CTO posted about data silos"],
    },
  },
  {
    slug: "crm-sync-secretary",
    name: "CRM Sync Secretary",
    category: "Sales",
    job: "Scans your inbox daily and keeps a deduped, current CRM.",
    output: "CRM updates + contact brain",
    runs: "Every day",
    tools: ["Gmail", "Sheets"],
    approval: "Required",
    approvalNote: "Required before updating records",
    triggers: ["Schedule"],
    sample: {
      kind: "list",
      rows: [
        { name: "Acme Corp", score: "updated" },
        { name: "Northstar", score: "deduped" },
        { name: "Orbit Inc", score: "new" },
      ],
    },
  },

  // --- Ops ---
  {
    slug: "bug-triage-coordinator",
    name: "Bug Triage Coordinator",
    category: "Ops",
    job: "Turns Slack and email bug reports into prioritized Linear issues.",
    output: "Linear issues + alerts",
    runs: "Every 15 minutes",
    tools: ["Slack", "Gmail", "Linear"],
    approval: "Auto-run",
    approvalNote: "Files issues automatically; asks before closing",
    triggers: ["New email", "Schedule"],
    sample: {
      kind: "issues",
      rows: [
        { pri: "high", title: "Checkout 500 on Safari" },
        { pri: "high", title: "Stripe webhook 429s" },
        { pri: "med", title: "CSV export truncates" },
      ],
    },
  },
  {
    slug: "meeting-to-tasks",
    name: "Meeting-to-Tasks Operator",
    category: "Ops",
    job: "Turns meeting notes into deduped tasks and a team digest.",
    output: "Linear issues + Slack digest",
    runs: "Every 15 minutes",
    tools: ["Notion", "Linear", "Slack"],
    approval: "Optional",
    approvalNote: "Optional before creating issues",
    triggers: ["Schedule"],
    sample: {
      kind: "issues",
      rows: [
        { pri: "high", title: "Ship auth fix — Lin" },
        { pri: "med", title: "Draft the Q3 roadmap" },
        { pri: "low", title: "Update onboarding docs" },
      ],
    },
  },
  {
    slug: "inbox-manager",
    name: "Inbox Manager",
    category: "Ops",
    job: "Archives the noise, labels the rest, writes an important-vs-FYI digest.",
    output: "Clean inbox + daily digest",
    runs: "Every morning at 7am",
    tools: ["Gmail"],
    approval: "Required",
    approvalNote: "Required before archiving",
    triggers: ["Schedule"],
    sample: {
      kind: "email",
      subject: "Today: 3 need you, 28 archived",
      to: "you",
      lines: ["Investor reply from Mary", "Signed contract from Legal", "Archived 28 newsletters"],
    },
  },
  {
    slug: "github-digest",
    name: "GitHub Digest Sender",
    category: "Ops",
    job: "Emails a daily digest of the PRs and issues that need attention.",
    output: "Daily PR/issue digest",
    runs: "Every day at 9am",
    tools: ["Web", "Gmail"],
    approval: "Auto-run",
    approvalNote: "Sends automatically",
    triggers: ["Schedule"],
    sample: {
      kind: "issues",
      rows: [
        { pri: "high", title: "#412 auth token refresh" },
        { pri: "med", title: "#408 migration pending" },
        { pri: "low", title: "3 stale PRs to nudge" },
      ],
    },
  },

  // --- Marketing ---
  {
    slug: "seo-opportunity-scout",
    name: "SEO Opportunity Scout",
    category: "Marketing",
    job: "Finds page-2 keywords you can win and queues content briefs.",
    output: "Keyword digest + content briefs",
    runs: "Every Monday at 9am",
    tools: ["Google Search Console", "Notion", "Web"],
    approval: "Optional",
    approvalNote: "Optional before posting briefs",
    triggers: ["Schedule"],
    sample: {
      kind: "digest",
      title: "5 page-2 keywords to win",
      items: ['"ai worker" — pos 12, 3.2k/mo', '"hire ai agent" — pos 9', "2 briefs queued to Notion"],
    },
  },
  {
    slug: "seo-article-writer",
    name: "SEO Article Writer",
    category: "Marketing",
    job: "Writes a grounded, SEO-ready article with images and internal links.",
    output: "Publish-ready article",
    runs: "On demand",
    tools: ["Web", "Notion"],
    approval: "Required",
    approvalNote: "Required before publishing",
    triggers: ["Webhook"],
    sample: {
      kind: "digest",
      title: "Draft: How AI workers cut ops time",
      items: ["1,450 words, 6 sections", "4 internal links added", "2 images generated"],
    },
  },

  // --- Research ---
  {
    slug: "research-brief-writer",
    name: "Research Brief Writer",
    category: "Research",
    job: "Produces a structured, sourced brief on any topic you give it.",
    output: "Markdown research brief",
    runs: "On demand",
    tools: ["Web", "Drive"],
    approval: "Optional",
    approvalNote: "Optional before sharing",
    triggers: ["Webhook"],
    sample: {
      kind: "digest",
      title: "Brief: EU AI Act for SaaS",
      items: ["12 sources, all cited", "Key compliance risks", "Action checklist included"],
    },
  },
  {
    slug: "ai-news-reporter",
    name: "AI News Reporter",
    category: "Research",
    job: "Tracks the news and posts a sharp daily digest to your channel.",
    output: "News digest",
    runs: "Hourly",
    tools: ["Web", "Slack"],
    approval: "Auto-run",
    approvalNote: "Posts automatically",
    triggers: ["Schedule"],
    sample: {
      kind: "digest",
      title: "AI digest — today",
      items: ["OpenAI ships a new model", "Anthropic raises a round", "3 launches worth a look"],
    },
  },

  // --- Recruiting ---
  {
    slug: "recruiting-sourcer",
    name: "Recruiting Sourcer",
    category: "Recruiting",
    job: "Ranks a candidate shortlist from a mandate with per-candidate reasoning.",
    output: "Top-10 shortlist + reasoning",
    runs: "On demand",
    tools: ["Web", "Sheets"],
    approval: "Optional",
    approvalNote: "Optional before outreach",
    triggers: ["Webhook"],
    sample: {
      kind: "list",
      rows: [
        { name: "Maya Patel", score: "92" },
        { name: "Jon Bell", score: "88" },
        { name: "Ana Ruiz", score: "84" },
      ],
    },
  },
  {
    slug: "cv-writeup",
    name: "CV Writeup Specialist",
    category: "Recruiting",
    job: "Turns a raw CV into a clean, branded candidate writeup.",
    output: "Structured candidate profile",
    runs: "On every new CV",
    tools: ["Drive", "Web"],
    approval: "Optional",
    approvalNote: "Optional before sending",
    triggers: ["Webhook"],
    sample: {
      kind: "digest",
      title: "Maya Patel — Senior PM",
      items: ["8 yrs B2B SaaS, 2 exits", "Led 0→1 product teams", "DACH, fluent German + English"],
    },
  },

  // --- Founder ---
  {
    slug: "metrics-reporter",
    name: "Daily Metrics Reporter",
    category: "Founder",
    job: "Pulls product metrics and emails a styled KPI summary.",
    output: "KPI email",
    runs: "Every day at 9am",
    tools: ["Sheets", "Gmail"],
    approval: "Auto-run",
    approvalNote: "Sends automatically",
    triggers: ["Schedule"],
    sample: {
      kind: "kpi",
      cells: [
        { label: "MRR", value: "$84.2k", delta: "+6.4%" },
        { label: "Signups", value: "312", delta: "+18%" },
        { label: "Churn", value: "1.8%", delta: "-0.3" },
      ],
    },
  },
  {
    slug: "founder-update-worker",
    name: "Founder Update Worker",
    category: "Founder",
    job: "Turns metrics and notes into an investor or company update.",
    output: "Email draft + summary",
    runs: "Weekly or monthly",
    tools: ["Sheets", "Notion", "Gmail"],
    approval: "Required",
    approvalNote: "Required before sending or posting",
    triggers: ["Schedule"],
    sample: {
      kind: "kpi",
      cells: [
        { label: "MRR", value: "$84k", delta: "+6%" },
        { label: "Runway", value: "14mo" },
        { label: "NPS", value: "68", delta: "+5" },
      ],
    },
  },

  // --- Customer ---
  {
    slug: "email-reply-drafter",
    name: "Email Reply Drafter",
    category: "Customer",
    job: "Reads unread emails and drafts on-brand replies in your voice.",
    output: "Reply drafts",
    runs: "On every new email",
    tools: ["Gmail", "Notion"],
    approval: "Required",
    approvalNote: "Required before sending",
    triggers: ["New email"],
    sample: {
      kind: "email",
      subject: "Re: Question about pricing",
      to: "a customer",
      lines: ["Answered the tiering question", "Linked the docs page", "Offered a quick call"],
    },
  },
];

export const FEATURED_SLUG = "client-follow-up-worker";

export function getTemplate(slug: string): Template | undefined {
  return TEMPLATES.find((t) => t.slug === slug);
}

// --- Workspaces: a curated bundle of workers for a whole role ---

export type Workspace = {
  slug: string;
  name: string;
  category: Category;
  pitch: string;
  workers: string[]; // worker slugs included in the bundle
};

export const WORKSPACES: Workspace[] = [
  {
    slug: "recruiting-desk",
    name: "Recruiting Desk",
    category: "Recruiting",
    pitch: "A full sourcing desk: shortlist candidates, write them up, keep your CRM warm.",
    workers: ["recruiting-sourcer", "cv-writeup", "crm-sync-secretary"],
  },
  {
    slug: "founder-cockpit",
    name: "Founder Cockpit",
    category: "Founder",
    pitch: "Your week, handled: the metrics, the company update, and a clean inbox.",
    workers: ["metrics-reporter", "founder-update-worker", "inbox-manager"],
  },
  {
    slug: "growth-studio",
    name: "Growth Studio",
    category: "Marketing",
    pitch: "Find the keywords, write the articles, watch the news.",
    workers: ["seo-opportunity-scout", "seo-article-writer", "ai-news-reporter"],
  },
  {
    slug: "sales-engine",
    name: "Sales Engine",
    category: "Sales",
    pitch: "Research leads, follow up after calls, keep the CRM clean.",
    workers: ["lead-research-worker", "client-follow-up-worker", "crm-sync-secretary"],
  },
  {
    slug: "engineering-ops",
    name: "Engineering Ops",
    category: "Ops",
    pitch: "Triage bugs, turn meetings into tasks, ship a daily repo digest.",
    workers: ["bug-triage-coordinator", "meeting-to-tasks", "github-digest"],
  },
  {
    slug: "inbox-zero",
    name: "Inbox Zero",
    category: "Customer",
    pitch: "Archive the noise, draft every reply, brief you each morning.",
    workers: ["inbox-manager", "email-reply-drafter", "research-brief-writer"],
  },
  {
    slug: "content-engine",
    name: "Content Engine",
    category: "Marketing",
    pitch: "Find the keywords, write the article, ground it in real research.",
    workers: ["seo-opportunity-scout", "seo-article-writer", "research-brief-writer"],
  },
  {
    slug: "chief-of-staff",
    name: "Chief of Staff",
    category: "Founder",
    pitch: "Inbox handled, metrics in your inbox, replies drafted in your voice.",
    workers: ["inbox-manager", "metrics-reporter", "email-reply-drafter"],
  },
  {
    slug: "talent-pipeline",
    name: "Talent Pipeline",
    category: "Recruiting",
    pitch: "Find companies hiring, source the candidates, write them up.",
    workers: ["recruiting-sourcer", "cv-writeup", "lead-research-worker"],
  },
  {
    slug: "revenue-ops",
    name: "Revenue Ops",
    category: "Sales",
    pitch: "Research every lead, keep the CRM clean, report the numbers.",
    workers: ["lead-research-worker", "crm-sync-secretary", "metrics-reporter"],
  },
  {
    slug: "competitive-intel",
    name: "Competitive Intel",
    category: "Research",
    pitch: "Watch the news, brief the moves, find the keyword gaps.",
    workers: ["ai-news-reporter", "research-brief-writer", "seo-opportunity-scout"],
  },
  {
    slug: "support-desk",
    name: "Support Desk",
    category: "Customer",
    pitch: "Draft every reply, route the bugs, look up the answers.",
    workers: ["email-reply-drafter", "bug-triage-coordinator", "research-brief-writer"],
  },
];

export function getWorkspace(slug: string): Workspace | undefined {
  return WORKSPACES.find((w) => w.slug === slug);
}

// Resolve a workspace's worker slugs to full Template objects (skips unknowns).
export function getWorkspaceWorkers(w: Workspace): Template[] {
  return w.workers
    .map((slug) => getTemplate(slug))
    .filter((t): t is Template => Boolean(t));
}

// Aggregate, de-duplicated tool list across a workspace's workers.
export function getWorkspaceTools(w: Workspace): string[] {
  const seen = new Set<string>();
  for (const t of getWorkspaceWorkers(w)) {
    for (const tool of t.tools) seen.add(tool);
  }
  return [...seen];
}

// Rich detail content for the worker proof page. Bespoke for the featured
// worker; the others fall back to a grounded default derived from card data.
export type TemplateDetail = {
  summary: string;
  whatItDoes: string;
  brainUsed: string[];
  exampleRun: {
    id: string;
    trigger: string;
    toolsUsed: string[];
    brainUsed: string[];
    output: string;
    approvalQuestion: string;
    email: { subject: string; body: string; signoff: string; to: string };
  };
};

const DETAILS: Record<string, TemplateDetail> = {
  "client-follow-up-worker": {
    summary:
      "Drafts client follow-up emails after calls, adds CRM notes, and prepares next-step tasks.",
    whatItDoes:
      "Client Follow-up Worker checks the meeting, CRM context, notes, past follow-ups, and company brain. It drafts a follow-up email, adds a CRM note, and prepares the next-step task.",
    brainUsed: ["Tone guide", "Pricing", "CRM rules", "Past follow-ups", "Product notes", "Approval rules"],
    exampleRun: {
      id: "Run #1042",
      trigger: "Calendar call ended",
      toolsUsed: ["Google Calendar", "Gmail", "HubSpot"],
      brainUsed: ["Tone guide", "Pricing", "CRM rules"],
      output: "Email draft + CRM note",
      approvalQuestion: "Send this email?",
      email: {
        to: "Sarah at Acme",
        subject: "Next steps from today's call",
        body: "Hi Sarah,\n\nGreat speaking today. Based on what you shared, I'd suggest starting with the onboarding workflow and CRM cleanup first. I've added the call notes to HubSpot and created the next-step task for Friday.",
        signoff: "Best,\nMaya",
      },
    },
  },
};

export function getTemplateDetail(t: Template): TemplateDetail {
  const bespoke = DETAILS[t.slug];
  if (bespoke) return bespoke;
  // Grounded fallback so every worker has a real proof page (no broken links).
  return {
    summary: `${t.job} ${t.output ? `Returns ${t.output.toLowerCase()}.` : ""}`.trim(),
    whatItDoes: `${t.name} pulls the data it needs, applies your company brain, and produces ${t.output.toLowerCase()}. It runs ${t.runs.toLowerCase()} and asks before any risky action.`,
    brainUsed: ["Tone guide", "Company rules", "Past work", "Approval rules"],
    exampleRun: {
      id: "Run #1042",
      trigger: t.triggers[0] ?? "Schedule",
      toolsUsed: t.tools.slice(0, 3),
      brainUsed: ["Tone guide", "Company rules"],
      output: t.output,
      approvalQuestion: "Approve this output?",
      email: {
        to: "your team",
        subject: t.output,
        body: `${t.name} prepared ${t.output.toLowerCase()} using your tools and company brain. Review the result, then approve or edit before it ships.`,
        signoff: "Floom",
      },
    },
  };
}
