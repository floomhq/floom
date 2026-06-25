"use client";

/**
 * V3HireButton - session-aware "Hire" CTA that lands in primed worker creation.
 * The session cookie is HttpOnly, so we mirror V3Shell (#821): ask /api/session,
 * hold the CTA until the session resolves, then route accordingly:
 *
 * The dashboard create route opens the worker author pre-filled with a prompt,
 * so Hire carries a template-derived prompt instead of dumping the user on a
 * generic overview.
 *
 *   - signed in  -> /app/workers/new?prompt=<prompt>
 *   - signed out -> /login?next=<that>
 */

import { useEffect, useState } from "react";
import Link from "next/link";

type SessionState = "checking" | "authed" | "guest";

export function V3HireButton({
  label,
  createPrompt,
  className = "inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-[10px] px-4 text-[13.5px] font-medium text-white",
}: {
  label: string;
  createPrompt: string;
  className?: string;
}) {
  const [sessionState, setSessionState] = useState<SessionState>("checking");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/session", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { authed: false }))
      .then((d) => {
        if (!cancelled) setSessionState(d?.authed === true ? "authed" : "guest");
      })
      .catch(() => {
        if (!cancelled) setSessionState("guest");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const target = `/app/workers/new?prompt=${encodeURIComponent(createPrompt)}`;
  const href =
    sessionState === "authed" ? target : `/login?next=${encodeURIComponent(target)}`;

  if (sessionState === "checking") {
    return (
      <span
        aria-busy="true"
        aria-disabled="true"
        className={`${className} pointer-events-none opacity-70`}
        role="link"
        style={{ background: "var(--v3-accent)" }}
      >
        {label}
      </span>
    );
  }

  return (
    <Link href={href} className={className} style={{ background: "var(--v3-accent)" }}>
      {label}
    </Link>
  );
}
