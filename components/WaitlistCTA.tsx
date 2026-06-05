"use client";

import { useState } from "react";

/* Shared primary-CTA control for the marketing landing + verticals.
 *
 * NEXT_PUBLIC_WAITLIST_MODE (default OFF):
 *   - OFF  -> renders the normal "Get your first worker" link to /templates
 *             so prospects can browse worker templates before signing in.
 *   - ON   -> renders "Join the waitlist" which reveals an inline email
 *             capture that POSTs to /api/waitlist (anon-key Supabase insert).
 *
 * The env var is a NEXT_PUBLIC_* value, so Next inlines it at build time —
 * both build variants (set and unset) compile and render correctly.
 */

const WAITLIST_ON =
  (process.env.NEXT_PUBLIC_WAITLIST_MODE ?? "").toLowerCase() === "1" ||
  (process.env.NEXT_PUBLIC_WAITLIST_MODE ?? "").toLowerCase() === "true";

const SIGN_IN_HREF = "/templates";

type Status = "idle" | "loading" | "success" | "error";

function isValidEmail(value: string): boolean {
  // Pragmatic RFC-lite check: something@something.tld
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export function WaitlistCTA({
  label = "Get your first worker",
  waitlistLabel = "Join the waitlist",
  source = "homepage",
}: {
  label?: string;
  waitlistLabel?: string;
  source?: string;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [message, setMessage] = useState("");

  if (!WAITLIST_ON) {
    return (
      <a href={SIGN_IN_HREF} className="ln-btn-primary">
        {label}
      </a>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (status === "loading") return;
    if (!isValidEmail(email)) {
      setStatus("error");
      setMessage("Enter a valid email address.");
      return;
    }
    setStatus("loading");
    setMessage("");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), source }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
      };
      if (res.ok && data.ok) {
        setStatus("success");
        setMessage("You're on the list. We'll be in touch.");
      } else {
        setStatus("error");
        setMessage(data.error || "Something went wrong. Try again.");
      }
    } catch {
      setStatus("error");
      setMessage("Network error. Try again.");
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        className="ln-btn-primary"
        onClick={() => setOpen(true)}
      >
        {waitlistLabel}
      </button>
    );
  }

  if (status === "success") {
    return (
      <div className="ln-wl ln-wl-done" role="status">
        <CheckGlyph />
        <span>{message}</span>
      </div>
    );
  }

  return (
    <form className="ln-wl" onSubmit={submit} noValidate>
      <div className="ln-wl-field">
        <input
          type="email"
          className="ln-wl-input"
          placeholder="you@company.com"
          value={email}
          autoFocus
          autoComplete="email"
          aria-label="Work email"
          aria-invalid={status === "error"}
          onChange={(ev) => {
            setEmail(ev.target.value);
            if (status === "error") {
              setStatus("idle");
              setMessage("");
            }
          }}
        />
        <button
          type="submit"
          className="ln-wl-submit"
          disabled={status === "loading"}
        >
          {status === "loading" ? "Joining…" : "Join"}
        </button>
      </div>
      {status === "error" && message ? (
        <span className="ln-wl-msg err" role="alert">
          {message}
        </span>
      ) : null}
    </form>
  );
}

function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      width="16"
      height="16"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
