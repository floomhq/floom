"use client";

/**
 * V3Shell — shared chrome for every /v3 page: theme wrapper (system default,
 * explicit override), one nav, one footer. Pages render content only.
 *
 * Signature pattern: <Hl> — the headline highlight. The composer recognises
 * tool names and highlights them; headlines echo it by highlighting exactly
 * ONE word per page. Discipline: never more than one per page.
 */

import { useEffect, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import { Monitor, Moon, Sun } from "lucide-react";
import "./theme.css";

/* theme mode: same contract as the app's ThemeModeButton (key, values, cycle
   order) so a choice made on the landing carries into the app and back. */
type ThemeMode = "system" | "day" | "night";
const THEME_KEY = "floom-theme";
const MODE_ORDER: ThemeMode[] = ["system", "day", "night"];
const MODE_LABELS: Record<ThemeMode, string> = { system: "System", day: "Light", night: "Dark" };

function readMode(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = window.localStorage.getItem(THEME_KEY);
  return stored === "day" || stored === "night" || stored === "system" ? stored : "system";
}

export function Hl({ children }: { children: React.ReactNode }) {
  return <span className="v3-hl">{children}</span>;
}

function Mark({ size = 22 }: { size?: number }) {
  return (
    <span className="relative inline-flex shrink-0 items-center justify-center" style={{ width: size, height: size }}>
      <Image src="/floom-mark.svg" alt="" width={size} height={size} className="floom-mark-light" />
      <Image src="/floom-logo-1024-inverted.png" alt="" width={size} height={size} className="floom-mark-dark rounded-[5px]" />
    </span>
  );
}

// Header nav links removed per spec (Product / Templates / Docs).
const NAV: ReadonlyArray<readonly [string, string]> = [];

export function V3Shell({
  active,
  children,
}: {
  active?: "product" | "templates" | "integrations" | "docs" | "about" | "login";
  children: React.ReactNode;
}) {
  const [mode, setMode] = useState<ThemeMode>("system");
  // #821 — session-aware CTA. The session cookie is HttpOnly, so presence is
  // reflected by /api/session (non-blocking: the nav renders "Sign in" first
  // and swaps to "Dashboard" when the fetch resolves true).
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    setMode(readMode());
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

  function cycleMode() {
    const next = MODE_ORDER[(MODE_ORDER.indexOf(mode) + 1) % MODE_ORDER.length];
    setMode(next);
    window.localStorage.setItem(THEME_KEY, next);
    document.documentElement.classList.toggle("floom-night", next === "night");
    document.documentElement.classList.toggle("floom-day", next === "day");
  }

  return (
    <div
      className={`theme-v3 flex min-h-screen flex-col text-[13.5px] ${mode === "night" ? "dark" : mode === "day" ? "light" : ""}`}
      style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
    >
      <div className="mx-auto w-full max-w-[1000px] flex-1 px-7 pb-24">
        <nav className="flex h-[64px] items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5 text-[14px] font-semibold">
            <Mark />
            Floom
          </Link>
          <div className="flex items-center gap-0.5 text-[13px] text-muted-foreground">
            {NAV.map(([label, href]) => (
              <Link
                key={href}
                href={href}
                className={`hidden rounded-[10px] px-3 py-1.5 transition-colors hover:bg-secondary hover:text-foreground sm:block ${active === label.toLowerCase() ? "text-foreground" : ""}`}
              >
                {label}
              </Link>
            ))}
            <button
              type="button"
              aria-label={`Theme: ${MODE_LABELS[mode]}. Click to switch.`}
              title={`Theme: ${MODE_LABELS[mode]}`}
              onClick={cycleMode}
              className="ml-1 flex h-8 w-8 items-center justify-center rounded-[10px] transition-colors hover:bg-secondary hover:text-foreground"
            >
              {mode === "night" ? <Moon className="h-3.5 w-3.5" /> : mode === "day" ? <Sun className="h-3.5 w-3.5" /> : <Monitor className="h-3.5 w-3.5" />}
            </button>
            {/* #821: session-aware — Dashboard when a session exists. */}
            <Link
              href={authed ? "/app/overview" : "/login"}
              className="ml-1 rounded-[10px] bg-foreground px-3 py-1.5 font-medium text-background transition-opacity hover:opacity-85"
            >
              {authed ? "Open app →" : "Sign in"}
            </Link>
          </div>
        </nav>

        {children}
      </div>

      <footer>
        <div className="mx-auto flex max-w-[1000px] flex-col gap-2 px-7 py-6 text-[12px] text-muted-foreground sm:flex-row sm:items-center sm:justify-between">
          <span>© 2026 Floom · Built in San Francisco</span>
          <span className="flex flex-wrap gap-5">
            <Link href="/integrations" className="transition-colors hover:text-foreground">Integrations</Link>
            <a href="https://github.com/floomhq/workeros" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-foreground">GitHub</a>
            <Link href="/privacy" className="transition-colors hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">Terms</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
