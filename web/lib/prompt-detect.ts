/**
 * prompt-detect — ONE shared prompt tool/capability detector.
 *
 * Single source of truth for "what tools and capabilities does this prompt
 * touch?". Used everywhere a prompt string is shown or composed:
 *   - PromptText  (inline highlight inside prompt copy)
 *   - PromptChips (chip row under a prompt box)
 *   - /workers/new, /workers landing, Emily assistant, example cards
 *
 * Two kinds of detected item:
 *   1. CONNECTION apps — Composio integrations. The keyword map MIRRORS the
 *      backend `_COMPOSIO_APP_KEYWORDS` in apps/api/main.py so the chips the
 *      operator sees match the connections the worker-author actually wires up.
 *      Keep the two in sync: any app added there should be added here.
 *   2. CAPABILITIES — platform abilities that are not Composio connections:
 *      web search / browsing, schedule / cron, email-send. These come from the
 *      task verbs, not from a brand name.
 *
 * Detection is keyword/word-boundary based (no LLM) so it runs synchronously on
 * every keystroke. Longest patterns are matched first so "google sheets" wins
 * over "google".
 */

export type DetectedKind = "connection" | "capability";

export interface DetectedItem {
  /** Stable identity, e.g. "hubspot", "web-search". Dedupe key. */
  id: string;
  kind: DetectedKind;
  /** Human label, e.g. "HubSpot", "Web search". */
  label: string;
  /**
   * BrandLogo sprite slug for connections (e.g. "hubspot"). Null for
   * capabilities — those render a lucide glyph chosen by `capabilityIcon`.
   */
  brand: string | null;
}

// ---------------------------------------------------------------------------
// Connection apps — MIRROR of _COMPOSIO_APP_KEYWORDS (apps/api/main.py).
// Order: longest / most-specific phrases first so multi-word brands win.
// ---------------------------------------------------------------------------

interface AppDef {
  /** Composio app slug + BrandLogo sprite slug. */
  slug: string;
  label: string;
  /** Lowercase keyword phrases. First entry need not be the slug. */
  keywords: string[];
}

const CONNECTION_APPS: AppDef[] = [
  // Multi-word phrases first (longest-match-first)
  { slug: "google-calendar", label: "Google Calendar", keywords: ["google calendar", "google cal"] },
  { slug: "google-sheets",   label: "Google Sheets",   keywords: ["google sheets", "google sheet"] },
  { slug: "google-drive",    label: "Google Drive",    keywords: ["google drive", "gdrive"] },
  // Single-word brands
  { slug: "granola",     label: "Granola",     keywords: ["granola"] },
  { slug: "hubspot",     label: "HubSpot",     keywords: ["hubspot"] },
  { slug: "gmail",       label: "Gmail",       keywords: ["gmail"] },
  { slug: "slack",       label: "Slack",       keywords: ["slack"] },
  { slug: "notion",      label: "Notion",      keywords: ["notion"] },
  { slug: "salesforce",  label: "Salesforce",  keywords: ["salesforce", "sfdc"] },
  { slug: "github",      label: "GitHub",      keywords: ["github"] },
  { slug: "linear",      label: "Linear",      keywords: ["linear"] },
  { slug: "airtable",    label: "Airtable",    keywords: ["airtable"] },
  { slug: "stripe",      label: "Stripe",      keywords: ["stripe"] },
  { slug: "jira",        label: "Jira",        keywords: ["jira"] },
  { slug: "figma",       label: "Figma",       keywords: ["figma"] },
  { slug: "discord",     label: "Discord",     keywords: ["discord"] },
  { slug: "twitter",     label: "Twitter",     keywords: ["twitter", "x.com"] },
  { slug: "linkedin",    label: "LinkedIn",    keywords: ["linkedin"] },
  { slug: "dropbox",     label: "Dropbox",     keywords: ["dropbox"] },
  { slug: "apollo",      label: "Apollo",      keywords: ["apollo"] },
];

// ---------------------------------------------------------------------------
// Capabilities — platform abilities, not Composio connections. Detected from
// task verbs. Each has a small phrase list; first match wins per capability.
// ---------------------------------------------------------------------------

interface CapabilityDef {
  id: string;
  label: string;
  keywords: string[];
}

const CAPABILITIES: CapabilityDef[] = [
  {
    id: "web-search",
    label: "Web search",
    keywords: [
      "web search", "search the web", "search online", "google for", "look up online",
      "browse the web", "browse to", "browser", "scrape", "crawl", "research online",
    ],
  },
  {
    id: "schedule",
    label: "Schedule",
    keywords: [
      "every morning", "every day", "every week", "every hour", "daily", "weekly",
      "hourly", "nightly", "each morning", "on a schedule", "cron", "at 9am", "every monday",
      "every friday",
    ],
  },
  {
    id: "email-send",
    label: "Send email",
    keywords: [
      "send me an email", "send an email", "email me", "draft an email", "draft email",
      "draft follow-up email", "send email", "reply to the email",
    ],
  },
];

// ---------------------------------------------------------------------------
// Regex builders — escape + word-boundary-ish so "slack" doesn't match inside
// "slackness". A boundary is "not a word char on either side".
// ---------------------------------------------------------------------------

function escapeRegExp(s: string): string {
  return s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
}

// Connection patterns sorted globally longest-first so "google sheets" beats
// "google"-style overlaps even across apps.
interface FlatPattern {
  pattern: string;
  app: AppDef;
}

const FLAT_CONNECTION_PATTERNS: FlatPattern[] = CONNECTION_APPS.flatMap((app) =>
  app.keywords.map((k) => ({ pattern: k, app })),
).sort((a, b) => b.pattern.length - a.pattern.length);

const CONNECTION_REGEX = new RegExp(
  `(?<![\\p{L}\\p{N}])(${FLAT_CONNECTION_PATTERNS.map((p) => escapeRegExp(p.pattern)).join("|")})(?![\\p{L}\\p{N}])`,
  "giu",
);

// ---------------------------------------------------------------------------
// detectPromptItems — the one public detector. Returns deduped, stable-ordered
// items: connections (in prompt order) then capabilities (in prompt order).
// ---------------------------------------------------------------------------

export function detectPromptItems(input: string): DetectedItem[] {
  if (!input || !input.trim()) return [];
  const lower = input.toLowerCase();

  const seen = new Set<string>();
  const connections: DetectedItem[] = [];

  // Walk matches in document order so chips read left-to-right as the prompt does.
  CONNECTION_REGEX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CONNECTION_REGEX.exec(input)) !== null) {
    const raw = m[1].toLowerCase();
    const found = FLAT_CONNECTION_PATTERNS.find((p) => p.pattern === raw);
    if (found && !seen.has(found.app.slug)) {
      seen.add(found.app.slug);
      connections.push({
        id: found.app.slug,
        kind: "connection",
        label: found.app.label,
        brand: found.app.slug,
      });
    }
  }

  const capabilities: DetectedItem[] = [];
  for (const cap of CAPABILITIES) {
    if (seen.has(cap.id)) continue;
    if (cap.keywords.some((k) => lower.includes(k))) {
      seen.add(cap.id);
      capabilities.push({ id: cap.id, kind: "capability", label: cap.label, brand: null });
    }
  }

  return [...connections, ...capabilities];
}

// ---------------------------------------------------------------------------
// Inline-highlight tokeniser — used by PromptText. Splits text into plain /
// matched segments using the SAME connection patterns the detector uses, so
// highlight and chips never disagree.
// ---------------------------------------------------------------------------

export type PromptSegment =
  | { kind: "plain"; text: string }
  | { kind: "match"; text: string; brand: string | null };

export function tokenisePrompt(input: string): PromptSegment[] {
  const segments: PromptSegment[] = [];
  if (!input) return segments;

  CONNECTION_REGEX.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = CONNECTION_REGEX.exec(input)) !== null) {
    const start = match.index;
    if (start > lastIndex) {
      segments.push({ kind: "plain", text: input.slice(lastIndex, start) });
    }
    const raw = match[1];
    const found = FLAT_CONNECTION_PATTERNS.find((p) => p.pattern === raw.toLowerCase());
    segments.push({ kind: "match", text: raw, brand: found?.app.slug ?? null });
    lastIndex = start + raw.length;
  }
  if (lastIndex < input.length) {
    segments.push({ kind: "plain", text: input.slice(lastIndex) });
  }
  return segments;
}
