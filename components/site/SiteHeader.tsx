import Link from "next/link";

const LINKS: Array<{ label: string; href: string }> = [
  { label: "Templates", href: "/templates" },
  { label: "How it works", href: "/#see-how-it-works" },
  { label: "Integrations", href: "/integrations" },
];

function FloomMark({ size = 24 }: { size?: number }) {
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

export function SiteHeader() {
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
        </div>
      </div>
    </header>
  );
}
