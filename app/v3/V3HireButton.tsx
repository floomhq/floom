"use client";

/**
 * V3HireButton — session-aware "Hire" CTA that lands you in CREATING the worker.
 *
 * The dashboard's create flow IS a primed Emily conversation (#902): the route
 * /app/workers/new?prompt=<text> redirects to /?create=1&prime=<text>, opening
 * the worker-author pre-filled. So Hire carries a template-derived prompt into
 * that flow instead of dumping the user on a generic overview.
 *
 *   - signed in  -> /app/workers/new?prompt=<prompt>  (Emily, primed)
 *   - signed out -> /login?next=<that>                (returns into it after auth)
 *
 * Mirrors V3Shell's /api/session check (the cookie is HttpOnly). Renders the
 * login path first and flips once the session resolves.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

export function V3HireButton({
  label,
  createPrompt,
  className = "inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-[10px] px-4 text-[13.5px] font-medium text-white",
}: {
  label: string;
  createPrompt: string;
  className?: string;
}) {
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { authed: false }))
      .then((d) => {
        if (!cancelled && d && typeof d.authed === "boolean") setAuthed(d.authed);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  const target = `/app/workers/new?prompt=${encodeURIComponent(createPrompt)}`;
  const href = authed ? target : `/login?next=${encodeURIComponent(target)}`;

  return (
    <Link href={href} className={className} style={{ background: "var(--v3-accent)" }}>
      {label}
    </Link>
  );
}
