// Tool logos as INLINE SVG (no external CDN — cdn.simpleicons.org 403s and
// would render empty boxes). Reuses the repo's proven brand SVGs. Fallback is
// a plain text label chip — never initials, never fake colored dots.
import {
  GCalLogo,
  GmailLogo,
  GitHubSVG,
  HubSpotLogo,
  IntercomLogo,
  NotionLogo,
  SalesforceLogo,
  SheetsLogo,
  SlackLogo,
} from "../landing-icons";

const LinearLogo = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path
      fill="#5E6AD2"
      d="M2.886 4.18A11.94 11.94 0 0 1 11.99 0C18.624 0 24 5.376 24 12.01c0 3.027-1.12 5.793-2.967 7.905zm-1.612 2.04A11.95 11.95 0 0 0 0 12.01c0 6.627 5.373 12 12 12 2.32 0 4.487-.66 6.32-1.804zM.134 9.073A11.964 11.964 0 0 0 0 11.95L11.95 24c.96-.013 1.892-.13 2.79-.338zM.816 6.733 17.267 23.184c.66-.227 1.292-.51 1.892-.844L1.66 4.84c-.334.6-.617 1.232-.844 1.892z"
    />
  </svg>
);

const WebLogo = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" aria-hidden="true">
    <circle cx="12" cy="12" r="9.25" stroke="#4285F4" strokeWidth="1.5" />
    <path
      d="M3 12h18M12 3c2.5 2.4 3.9 5.6 3.9 9s-1.4 6.6-3.9 9c-2.5-2.4-3.9-5.6-3.9-9S9.5 5.4 12 3Z"
      stroke="#4285F4"
      strokeWidth="1.5"
    />
  </svg>
);

const DriveLogo = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path fill="#1FA463" d="M12.01 1.485c-2.082 0-3.754.02-3.743.047.01.02 1.708 3.001 3.774 6.62l3.76 6.574h3.76c2.081 0 3.753-.02 3.742-.047-.005-.02-1.708-3.001-3.775-6.62l-3.76-6.574zm-4.76 1.73a789.828 789.861 0 0 0-3.63 6.319L0 15.868l1.89 3.298 1.885 3.297 3.62-6.335 3.618-6.33-1.88-3.287C8.1 4.704 7.255 3.22 7.25 3.214zm2.259 12.653-.203.348c-.114.198-.96 1.672-1.88 3.287a423.93 423.948 0 0 1-1.698 2.97c-.01.026 3.24.042 7.222.042h7.244l1.796-3.157c.992-1.734 1.85-3.23 1.906-3.323l.104-.167h-7.249z" />
  </svg>
);

const AirtableLogo = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true">
    <path fill="#18BFFF" d="M11.992 1.966c-.434 0-.87.086-1.28.257L1.779 5.917c-.503.208-.49.908.012 1.116l8.982 3.558a3.266 3.266 0 0 0 2.454 0l8.982-3.558c.503-.196.503-.908.012-1.116l-8.957-3.694a3.255 3.255 0 0 0-1.272-.257zM23.4 8.056a.589.589 0 0 0-.222.045l-10.012 3.877a.612.612 0 0 0-.38.564v8.896a.6.6 0 0 0 .821.552L23.62 18.1a.583.583 0 0 0 .38-.551V8.653a.6.6 0 0 0-.6-.596zM.676 8.095a.644.644 0 0 0-.48.19C.086 8.396 0 8.53 0 8.69v8.355c0 .442.515.737.908.54l6.27-3.006.307-.147 2.969-1.436c.466-.22.43-.908-.061-1.092L.883 8.138a.57.57 0 0 0-.207-.044z" />
  </svg>
);

const WebhooksLogo = () => (
  <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="#C73A63" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="6" cy="17.5" r="2.5" />
    <circle cx="18" cy="17.5" r="2.5" />
    <circle cx="12" cy="6" r="2.5" />
    <path d="M12 8.5 8.4 15.2M15.6 15.2 12 8.5M8.5 17.5h7" />
  </svg>
);

type LogoComp = () => React.ReactNode;

// Keyed by lowercased tool name (+ aliases). Only real, verified marks here.
const LOGOS: Record<string, LogoComp> = {
  slack: SlackLogo,
  gmail: GmailLogo,
  calendar: GCalLogo,
  "google calendar": GCalLogo,
  hubspot: HubSpotLogo,
  sheets: SheetsLogo,
  "google sheets": SheetsLogo,
  notion: NotionLogo,
  salesforce: SalesforceLogo,
  intercom: IntercomLogo,
  github: GitHubSVG,
  linear: LinearLogo,
  web: WebLogo,
  drive: DriveLogo,
  "google drive": DriveLogo,
  airtable: AirtableLogo,
  webhooks: WebhooksLogo,
  webhook: WebhooksLogo,
};

export function hasLogo(name: string): boolean {
  return name.toLowerCase() in LOGOS;
}

export function ToolLogo({ name }: { name: string }) {
  const Comp = LOGOS[name.toLowerCase()];
  return Comp ? (
    <span className="inline-flex h-[14px] w-[14px] shrink-0 items-center justify-center [&>svg]:h-[14px] [&>svg]:w-[14px]">
      <Comp />
    </span>
  ) : null;
}

/**
 * ToolLogoChip — standardized tool chip. 28px tall, warm border,
 * white/bg-app surface, real inline logo when available, label text otherwise.
 * Falls back to a plain label chip (never initials).
 */
export function ToolLogoChip({
  tool,
  showLabel = true,
  surface = "card",
}: {
  tool: string;
  showLabel?: boolean;
  size?: "sm" | "md";
  surface?: "card" | "app";
}) {
  const logo = hasLogo(tool);
  // Always show the label when there's no logo, so nothing renders empty.
  const label = showLabel || !logo;
  const surfaceCls = surface === "app" ? "bg-background" : "bg-card";
  return (
    <span
      className={`inline-flex h-7 items-center gap-1.5 rounded-[9px] border border-border ${surfaceCls} px-2 text-[11.5px] font-medium text-foreground/85`}
    >
      {logo && <ToolLogo name={tool} />}
      {label && <span className="leading-none">{tool}</span>}
    </span>
  );
}
