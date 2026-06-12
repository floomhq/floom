import Link from "next/link";
import { MobileNav } from "./MobileNav";

const LINKS: Array<{ label: string; href: string }> = [
  { label: "Templates", href: "/templates" },
  { label: "How it works", href: "/#see-how-it-works" },
  { label: "Integrations", href: "/integrations" },
];

function FloomMark({ size = 24 }: { size?: number }) {
  // Near-black variant for product-level chrome. The canonical green Floom
  // mark lives on floom.dev; sub-products use this monochrome treatment so
  // the parent attribution stays quiet.
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Floom"
      style={{ borderRadius: "22%" }}
    >
      <rect width="100" height="100" rx="22" fill="var(--ink)" />
      <path
        d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z"
        fill="var(--paper)"
      />
    </svg>
  );
}

function Wordmark() {
  return (
    <Link
      href="/"
      className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-foreground"
      aria-label="WorkerOS home"
    >
      <FloomMark size={24} />
      <span className="flex items-baseline gap-1.5">
        WorkerOS
        <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
          by Floom
        </span>
      </span>
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
              className="rounded-[12px] border border-transparent px-3 py-1.5 transition-colors hover:border-foreground/15 hover:bg-secondary/60 hover:text-foreground"
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="flex items-center gap-1.5">
          <Link
            href="/login"
            className="inline-flex h-8 items-center rounded-[8px] border border-border/70 bg-card px-3 text-[12.5px] font-medium text-foreground/85 transition hover:border-foreground/30 hover:text-foreground"
          >
            Sign in
          </Link>
          <MobileNav links={LINKS} />
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
      { label: "Integrations", href: "/integrations" },
      { label: "Sign in", href: "/login" },
      { label: "Marketing", href: "/marketing" },
      { label: "Sales", href: "/sales" },
      { label: "Recruiting", href: "/recruiting" },
      { label: "Support", href: "/support" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "GitHub", href: "https://github.com/floomhq/workeros", external: true },
      { label: "Floom Skills", href: "https://skills.floom.dev", external: true },
      { label: "Floom", href: "https://floom.dev", external: true },
    ],
  },
  {
    title: "Company",
    links: [
      { label: "LinkedIn", href: "https://www.linkedin.com/company/floomhq/", external: true },
      { label: "X", href: "https://x.com/floomhq", external: true },
      { label: "Terms", href: "/terms" },
      { label: "Privacy", href: "/privacy" },
    ],
  },
];

export function Footer() {
  return (
    <footer className="border-t border-border/70 px-6 py-12">
      <div className="mx-auto grid max-w-6xl gap-8 sm:grid-cols-2 md:grid-cols-4">
        <div>
          <div className="flex items-center gap-2">
            <FloomMark size={22} />
            <div className="flex items-baseline gap-1.5 text-[15px] font-semibold text-foreground">
              WorkerOS
              <span className="text-[11px] font-medium uppercase tracking-[0.16em] text-muted-foreground">
                by Floom
              </span>
            </div>
          </div>
          <p className="mt-2 text-[11.5px] text-muted-foreground">
            © 2026 Floom
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
                  className="block py-1.5 text-[13px] text-foreground/80 transition-colors hover:text-foreground"
                >
                  {l.label}
                </a>
              ) : (
                <Link
                  key={l.label}
                  href={l.href}
                  className="block py-1.5 text-[13px] text-foreground/80 transition-colors hover:text-foreground"
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
