// Tool logos as INLINE SVG (no external CDN — cdn.simpleicons.org 403s and
// would render empty boxes). Reuses the repo's proven brand SVGs. Fallback is
// a plain text label chip — never initials, never fake colored dots.
import {
  CalendlyLogo,
  GCalLogo,
  GmailLogo,
  GitHubSVG,
  HubSpotLogo,
  IntercomLogo,
  NotionLogo,
  SalesforceLogo,
  SheetsLogo,
  SlackLogo,
  WhatsAppLogo,
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

type LogoComp = () => React.ReactNode;

// Keyed by lowercased tool name (+ aliases). Only real, verified marks here.
const LOGOS: Record<string, LogoComp> = {
  slack: SlackLogo,
  whatsapp: WhatsAppLogo,
  gmail: GmailLogo,
  calendar: GCalLogo,
  "google calendar": GCalLogo,
  calendly: CalendlyLogo,
  hubspot: HubSpotLogo,
  sheets: SheetsLogo,
  "google sheets": SheetsLogo,
  notion: NotionLogo,
  salesforce: SalesforceLogo,
  intercom: IntercomLogo,
  github: GitHubSVG,
  linear: LinearLogo,
  web: WebLogo,
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
