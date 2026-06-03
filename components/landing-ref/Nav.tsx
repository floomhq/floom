import Link from "next/link";
import { ThemeModeButton } from "../ThemeModeButton";

const TEMPLATES_HREF = "/templates";
const ASK_HREF = "/assistant";

const LINKS: Array<{ label: string; href: string }> = [
  { label: "Templates", href: "/templates" },
  { label: "Brain", href: "/#brain" },
  { label: "Runs", href: "/#runs" },
  { label: "Approvals", href: "/#approvals" },
  { label: "Connections", href: "/#connections" },
];

function Wordmark() {
  // Clean text-only lockup. No invented decorative mark.
  return (
    <Link
      href="/"
      className="text-[15px] font-semibold tracking-tight text-foreground"
      aria-label="Floom Workers home"
    >
      Floom <span className="font-medium text-muted-foreground">Workers</span>
    </Link>
  );
}

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-border/70 bg-background/85 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-6">
        <Wordmark />
        <nav className="hidden items-center gap-1 text-[13px] text-muted-foreground md:flex">
          {LINKS.map((l) => (
            <Link
              key={l.label}
              href={l.href}
              className="rounded-[12px] px-3 py-1.5 hover:bg-accent hover:text-foreground"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-1.5">
          <ThemeModeButton className="hidden sm:inline-flex" />
          <Link
            href={ASK_HREF}
            className="hidden h-11 items-center rounded-[12px] px-3 text-[13px] font-medium text-foreground hover:bg-accent sm:inline-flex"
          >
            Ask Floom
          </Link>
          <Link
            href={TEMPLATES_HREF}
            className="inline-flex h-11 items-center rounded-[12px] bg-primary px-4 text-[13px] font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            Browse templates
          </Link>
        </div>
      </div>
    </header>
  );
}

const FOOTER_COLS: Array<{
  title: string;
  links: Array<{ label: string; href: string; external?: boolean }>;
}> = [
  {
    title: "Product",
    links: [
      { label: "Templates", href: "/templates" },
      { label: "Ask Floom", href: "/assistant" },
      { label: "Sign in", href: "/login" },
      { label: "Docs", href: "https://github.com/floomhq/workeros", external: true },
      { label: "GitHub", href: "https://github.com/floomhq/workeros", external: true },
    ],
  },
  {
    title: "For your team",
    links: [
      { label: "Marketing", href: "/marketing" },
      { label: "Sales", href: "/sales" },
      { label: "Recruiting", href: "/recruiting" },
      { label: "Support", href: "/support" },
    ],
  },
  {
    title: "Floom",
    links: [
      { label: "Skills", href: "https://skills.floom.dev", external: true },
      { label: "Floom", href: "https://floom.dev", external: true },
    ],
  },
  {
    title: "Legal",
    links: [
      { label: "Terms", href: "/terms" },
      { label: "Privacy", href: "/privacy" },
    ],
  },
  {
    title: "Connect",
    links: [
      { label: "LinkedIn", href: "https://www.linkedin.com/company/floomhq/", external: true },
      { label: "X", href: "https://x.com/floomhq", external: true },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border/70 px-6 py-12">
      <div className="mx-auto grid max-w-6xl gap-8 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        <div className="lg:col-span-1">
          <div className="text-[15px] font-semibold text-foreground">
            Floom <span className="font-medium text-muted-foreground">Workers</span>
          </div>
          <p className="mt-2 text-[11.5px] text-muted-foreground">
            © 2026 Floom · Built with care in San Francisco
          </p>
        </div>
        {FOOTER_COLS.map((col) => (
          <div key={col.title} className="flex flex-col gap-2">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
              {col.title}
            </h3>
            {col.links.map((l) =>
              l.external ? (
                <a
                  key={l.label}
                  href={l.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-[13px] text-foreground/80 hover:text-foreground"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.label}
                  href={l.href}
                  className="text-[13px] text-foreground/80 hover:text-foreground"
                >
                  {l.label}
                </Link>
              ),
            )}
          </div>
        ))}
      </div>
    </footer>
  );
}
