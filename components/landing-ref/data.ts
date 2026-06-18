// Worker templates — ready-to-run AI workers (demand-side: prebuilt worker
// recipes, NOT a supply-side skills marketplace).

export type Category =
  | "Sales"
  | "Ops"
  | "Founder"
  | "Recruiting"
  | "Finance"
  | "Research"
  | "Customer";

export type Approval = "Required" | "Optional" | "Auto-run";

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
};

export const CATEGORIES: Category[] = [
  "Sales",
  "Ops",
  "Founder",
  "Recruiting",
  "Finance",
  "Research",
  "Customer",
];

export const FILTER_TOOLS = [
  "Gmail",
  "Google Calendar",
  "HubSpot",
  "Sheets",
  "Notion",
  "Linear",
  "Salesforce",
  "Drive",
  "Airtable",
  "Web",
];

export const FILTER_TRIGGERS = [
  "Schedule",
  "New email",
  "New lead",
  "Calendar event",
  "Webhook",
];

export const TEMPLATES: Template[] = [
  {
    slug: "client-follow-up-worker",
    name: "Client Follow-up Worker",
    category: "Sales",
    job: "Drafts follow-up emails after calls.",
    output: "Email draft + CRM note",
    runs: "After selected calendar calls",
    tools: ["Google Calendar", "Gmail", "HubSpot"],
    approval: "Required",
    approvalNote: "Required before sending",
    triggers: ["Calendar event"],
  },
  {
    slug: "monday-report-worker",
    name: "Monday Report Worker",
    category: "Ops",
    job: "Pulls metrics and writes a weekly update.",
    output: "Email summary + 1-page report",
    runs: "Every Monday at 9am",
    tools: ["Sheets", "Linear", "Notion"],
    approval: "Required",
    approvalNote: "Required before posting",
    triggers: ["Schedule"],
  },
  {
    slug: "lead-research-worker",
    name: "Lead Research Worker",
    category: "Sales",
    job: "Researches prospects and drafts outreach angles.",
    output: "Lead briefs + CRM notes",
    runs: "On every new lead",
    tools: ["HubSpot", "Gmail", "Web"],
    approval: "Required",
    approvalNote: "Required before CRM updates or outreach",
    triggers: ["New lead"],
  },
  {
    slug: "competitor-watch-worker",
    name: "Competitor Watch Worker",
    category: "Research",
    job: "Tracks competitor changes weekly.",
    output: "Digest + suggested response",
    runs: "Weekly schedule",
    tools: ["Web", "Notion"],
    approval: "Optional",
    approvalNote: "Optional before posting",
    triggers: ["Schedule"],
  },
  {
    slug: "founder-update-worker",
    name: "Founder Update Worker",
    category: "Founder",
    job: "Turns metrics and notes into an investor/company update.",
    output: "Email draft + summary",
    runs: "Weekly or monthly schedule",
    tools: ["Sheets", "Notion", "Linear"],
    approval: "Required",
    approvalNote: "Required before sending/posting",
    triggers: ["Schedule"],
  },
  {
    slug: "recruiting-bd-worker",
    name: "Recruiting BD Worker",
    category: "Recruiting",
    job: "Finds companies hiring and drafts outreach.",
    output: "Company list + outreach drafts",
    runs: "Weekly schedule",
    tools: ["Web", "Sheets", "Gmail"],
    approval: "Required",
    approvalNote: "Required before outreach",
    triggers: ["Schedule"],
  },
  {
    slug: "crm-cleanup-worker",
    name: "CRM Cleanup Worker",
    category: "Ops",
    job: "Finds stale records and drafts updates.",
    output: "CRM changes + exception list",
    runs: "Weekly schedule",
    tools: ["HubSpot", "Salesforce", "Sheets"],
    approval: "Required",
    approvalNote: "Required before updating CRM",
    triggers: ["Schedule"],
  },
  {
    slug: "customer-reply-worker",
    name: "Customer Reply Worker",
    category: "Customer",
    job: "Drafts replies using docs and past conversations.",
    output: "Reply draft + source notes",
    runs: "On every new support email",
    tools: ["Gmail", "Intercom", "Notion"],
    approval: "Required",
    approvalNote: "Required before sending",
    triggers: ["New email"],
  },
];

export const FEATURED_SLUG = "client-follow-up-worker";

export function getTemplate(slug: string): Template | undefined {
  return TEMPLATES.find((t) => t.slug === slug);
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
