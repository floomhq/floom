"use client";

/**
 * V3HireButton — session-aware "Hire" CTA. The session cookie is HttpOnly, so
 * we mirror V3Shell (#821): ask /api/session, then route accordingly:
 *   - signed in  -> open the app (no pointless re-login)
 *   - signed out -> /login?next=<this page> so they return here after auth
 * Holds the CTA until the session resolves so signed-in users are not raced
 * through the login path by a fast click.
 *
 * NOTE: this does not yet PROVISION the template into a workspace — that's the
 * engine-coupled import flow (docs/TEMPLATES-IMPORT-FLOW.md). It fixes the
 * "funnels through sign-in even when already logged in" bug.
 */

import { useEffect, useState } from "react";
import Link from "next/link";

type SessionState = "checking" | "authed" | "guest";

export function V3HireButton({
  label,
  returnPath,
  className = "inline-flex h-9 shrink-0 items-center whitespace-nowrap rounded-[10px] px-4 text-[13.5px] font-medium text-white",
}: {
  label: string;
  returnPath: string;
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

  const href =
    sessionState === "authed" ? "/app/overview" : `/login?next=${encodeURIComponent(returnPath)}`;

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
