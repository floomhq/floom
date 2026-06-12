import Link from "next/link";

export const metadata = {
  title: "Not found — WorkerOS",
};

function FloomMark({ size = 28 }: { size?: number }) {
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

export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="mx-auto max-w-md text-center">
        <Link href="/" aria-label="WorkerOS home" className="mb-10 inline-flex">
          <FloomMark size={36} />
        </Link>
        <div className="mb-3 text-[11px] font-medium uppercase tracking-[0.22em] text-[#3a6ea5]">
          404
        </div>
        <h1 className="text-balance text-[36px] font-semibold leading-[1.05] tracking-[-0.025em] text-foreground sm:text-[44px]">
          Nothing here.
        </h1>
        <p className="mx-auto mt-4 max-w-sm text-[15px] text-muted-foreground">
          The page you tried doesn&apos;t exist, or the worker isn&apos;t live yet. Head back home and
          describe what you need.
        </p>
        <div className="mt-8 flex items-center justify-center gap-2">
          <Link
            href="/"
            className="inline-flex h-10 items-center rounded-[10px] bg-primary px-4 text-[13px] font-medium text-primary-foreground shadow-sm transition hover:bg-primary/90"
          >
            Back home
          </Link>
          <Link
            href="/templates"
            className="inline-flex h-10 items-center rounded-[10px] border border-border bg-card px-4 text-[13px] font-medium text-foreground transition hover:border-foreground/30 hover:bg-secondary/60"
          >
            Browse templates
          </Link>
        </div>
      </div>
    </main>
  );
}
