"use client";

/**
 * /templates/hire — post-auth landing for "Hire this worker/workspace". Records
 * the hire, then routes the maker into their workspace to connect tools and run
 * it. Honest: it confirms the worker is added + what's next, it does not claim a
 * magic zero-config run.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

export function V3HireBody({
  kind,
  slug,
  name,
}: {
  kind: "worker" | "workspace";
  slug: string;
  name: string;
}) {
  const [recorded, setRecorded] = useState(false);

  useEffect(() => {
    fetch("/api/marketplace/hires", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ item_kind: kind, item_slug: slug, source: "first_party", status: "ready" }),
    })
      .catch(() => {})
      .finally(() => setRecorded(true));
  }, [kind, slug]);

  return (
    <main className="mx-auto flex min-h-[70vh] max-w-[460px] flex-col items-center justify-center px-6 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-full" style={{ background: "var(--v3-sel)" }}>
        <svg viewBox="0 0 20 20" className="h-6 w-6">
          <path d="M5 10.5l3.2 3.2L15 7" fill="none" stroke="var(--v3-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>
      <h1 className="mt-5 text-[26px] font-semibold tracking-[-0.022em]">{name} is yours</h1>
      <p className="mt-3 text-[14px] leading-relaxed text-muted-foreground">
        Added to your workspace. Connect its tools and approve the first run — it asks before anything
        ships.
      </p>
      <div className="mt-6 flex items-center gap-3">
        <Link
          href="/app/overview"
          className="inline-flex h-9 items-center rounded-[10px] px-4 text-[13.5px] font-medium text-white"
          style={{ background: "var(--v3-accent)" }}
        >
          Open your workspace
        </Link>
        <Link href="/templates" className="text-[13px] text-muted-foreground hover:text-foreground">
          Browse more
        </Link>
      </div>
      {!recorded && <span className="sr-only">recording…</span>}
    </main>
  );
}
