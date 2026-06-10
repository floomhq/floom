"use client";

/**
 * V3Shell — shared chrome for every /v3 page: theme wrapper (system default,
 * explicit override), one nav, one footer. Pages render content only.
 *
 * Signature pattern: <Hl> — the headline highlight. The composer recognises
 * tool names and highlights them; headlines echo it by highlighting exactly
 * ONE word per page. Discipline: never more than one per page.
 */

import { useState } from "react";
import Link from "next/link";
import { Moon, Sun } from "lucide-react";
import "./theme.css";

export function Hl({ children }: { children: React.ReactNode }) {
  return <span className="v3-hl">{children}</span>;
}

function Mark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" aria-label="Workeros" style={{ borderRadius: "27%" }}>
      <rect width="100" height="100" rx="24" fill="var(--primary)" />
      <path d="M30 22 h20 l22 22 a3 3 0 0 1 0 4 l-22 22 h-20 a6 6 0 0 1 -6 -6 v-36 a6 6 0 0 1 6 -6 z" fill="var(--primary-text)" />
    </svg>
  );
}

const NAV = [
  ["Product", "/v3/product"],
  ["Templates", "/v3/templates"],
  ["Docs", "/v3/docs"],
] as const;

export function V3Shell({
  active,
  children,
}: {
  active?: "product" | "templates" | "docs";
  children: React.ReactNode;
}) {
  const [dark, setDark] = useState<boolean | null>(null);
  const isDark =
    dark ?? (typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches);

  return (
    <div
      className={`theme-v3 flex min-h-screen flex-col text-[13.5px] ${dark === true ? "dark" : dark === false ? "light" : ""}`}
      style={{ background: "var(--bg-app)", color: "var(--text-primary)" }}
    >
      <div className="mx-auto w-full max-w-[1000px] flex-1 px-7">
        <nav className="flex h-[64px] items-center justify-between">
          <Link href="/v3" className="flex items-center gap-2.5 text-[14px] font-semibold">
            <Mark />
            Workeros
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
              aria-label="Toggle theme"
              onClick={() => setDark(!isDark)}
              className="ml-1 flex h-8 w-8 items-center justify-center rounded-[10px] transition-colors hover:bg-secondary hover:text-foreground"
            >
              {isDark ? <Moon className="h-3.5 w-3.5" /> : <Sun className="h-3.5 w-3.5" />}
            </button>
            <Link href="/login" className="rounded-[10px] px-3 py-1.5 transition-colors hover:bg-secondary hover:text-foreground">
              Sign in
            </Link>
          </div>
        </nav>

        {children}
      </div>

      <footer className="border-t border-border-soft">
        <div className="mx-auto flex max-w-[1000px] items-center justify-between px-7 py-6 text-[12px] text-muted-foreground">
          <span>Workeros by Floom · Backed by Founders Inc</span>
          <span className="flex gap-4">
            <Link href="/v3/product" className="transition-colors hover:text-foreground">Product</Link>
            <Link href="/v3/templates" className="transition-colors hover:text-foreground">Templates</Link>
            <Link href="/v3/docs" className="transition-colors hover:text-foreground">Docs</Link>
            <Link href="/privacy" className="transition-colors hover:text-foreground">Privacy</Link>
            <Link href="/terms" className="transition-colors hover:text-foreground">Terms</Link>
          </span>
        </div>
      </footer>
    </div>
  );
}
