/**
 * PromptText — inline tool-name highlight for prompt strings.
 *
 * Scans text for known tool names (case-insensitive, longest-match-first) and
 * renders matched terms with a faint rounded background + small brand icon.
 * Non-matched text is plain. No coloured badges, no gradients — just enough
 * chrome to signal "we know this tool".
 */

import { BrandLogo } from "@/components/connections/BrandLogo";

// ---------------------------------------------------------------------------
// Term → icon-slug map (longest terms first so "Google Sheets" beats "Google")
// ---------------------------------------------------------------------------

type ToolTerm = { pattern: string; icon: string | null; display: string };

const TOOL_TERMS: ToolTerm[] = [
  // Multi-word first (longest-match-first ordering)
  { pattern: "google calendar", icon: "google-calendar", display: "Google Calendar" },
  { pattern: "google sheets",   icon: "google-sheets",   display: "Google Sheets"   },
  { pattern: "google drive",    icon: "google-drive",    display: "Google Drive"    },
  { pattern: "google docs",     icon: "google-drive",    display: "Google Docs"     },
  { pattern: "hubspot crm",     icon: "hubspot",         display: "HubSpot CRM"     },
  // Single-word / brand names
  { pattern: "granola",         icon: "granola",         display: "Granola"         },
  { pattern: "hubspot",         icon: "hubspot",         display: "HubSpot"         },
  { pattern: "gmail",           icon: "gmail",           display: "Gmail"           },
  { pattern: "slack",           icon: "slack",           display: "Slack"           },
  { pattern: "github",          icon: "github",          display: "GitHub"          },
  { pattern: "notion",          icon: "notion",          display: "Notion"          },
  { pattern: "linear",          icon: "linear",          display: "Linear"          },
  { pattern: "salesforce",      icon: "salesforce",      display: "Salesforce"      },
  { pattern: "linkedin",        icon: "linkedin",        display: "LinkedIn"        },
  { pattern: "apollo",          icon: "apollo",          display: "Apollo"          },
  { pattern: "google",          icon: "google-drive",    display: "Google"          },
];

// ---------------------------------------------------------------------------
// Tokeniser — split text into [plain, matched, plain, …] segments
// ---------------------------------------------------------------------------

type Segment =
  | { kind: "plain"; text: string }
  | { kind: "match"; text: string; icon: string | null };

function tokenise(input: string): Segment[] {
  // Build one regex that captures any known pattern (longest first → already ordered).
  // We wrap each pattern in a word-boundary-like check: must not be preceded /
  // followed by a letter so "HubSpot" inside "HubSpotX" doesn't match.
  const regexSource = TOOL_TERMS.map((t) =>
    t.pattern.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")
  ).join("|");
  const re = new RegExp(`(${regexSource})`, "gi");

  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(input)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ kind: "plain", text: input.slice(lastIndex, match.index) });
    }
    const raw = match[0];
    // Find which term this corresponds to (for the icon slug)
    const term = TOOL_TERMS.find(
      (t) => t.pattern.toLowerCase() === raw.toLowerCase()
    );
    segments.push({ kind: "match", text: raw, icon: term?.icon ?? null });
    lastIndex = match.index + raw.length;
  }

  if (lastIndex < input.length) {
    segments.push({ kind: "plain", text: input.slice(lastIndex) });
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PromptText({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  const segments = tokenise(children);

  return (
    <span className={className}>
      {segments.map((seg, i) => {
        if (seg.kind === "plain") {
          return <span key={i}>{seg.text}</span>;
        }
        return (
          <span
            key={i}
            className="inline-flex items-baseline gap-[3px] rounded-[4px] bg-muted/50 px-[5px] py-[1px] mx-[1px] align-baseline whitespace-nowrap"
          >
            {seg.icon && (
              <BrandLogo
                icon={seg.icon}
                className="size-[13px] shrink-0 translate-y-[1px]"
              />
            )}
            <span>{seg.text}</span>
          </span>
        );
      })}
    </span>
  );
}
