"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { buttonVariants } from "@/components/ui/button";
import { FloomMark } from "@/components/layout/sidebar";
import { cn } from "@/lib/utils";

export default function NotFound() {
  // Detect whether the user is already authenticated so we can show the
  // appropriate CTA: "Go to app" for signed-in users, "Sign in" for guests.
  // Falls back to showing both if the check fails or is slow.
  const [authed, setAuthed] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/me", { credentials: "include" })
      .then((r) => {
        if (!cancelled) setAuthed(r.ok);
      })
      .catch(() => {
        if (!cancelled) setAuthed(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="flex min-h-full flex-1 items-center justify-center bg-[var(--bg-app)] px-6 py-16 text-[var(--ink)]">
      <section className="w-full max-w-md">
        <div className="flex items-center gap-2">
          <FloomMark size={24} />
          <span className="text-base font-semibold tracking-tight">Floom</span>
        </div>

        <div className="mt-10 space-y-3">
          <p className="text-sm font-medium text-[var(--accent)]">404</p>
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">
            Page not found
          </h1>
          <p className="max-w-sm text-sm leading-6 text-[var(--muted-text)]">
            This page does not exist or is no longer available in this workspace.
          </p>
        </div>

        <div className="mt-8 flex flex-col gap-2 sm:flex-row">
          {/* Show "Go to app" for authenticated users; "Sign in" for guests */}
          {authed !== false ? (
            <Link
              href="/overview"
              className={cn(
                buttonVariants(),
                "bg-[var(--accent)] text-white hover:bg-[color-mix(in_srgb,var(--accent)_88%,black_12%)]",
              )}
            >
              Go to app
              <ArrowRight className="size-4" />
            </Link>
          ) : (
            <>
              <Link
                href="/overview"
                className={cn(
                  buttonVariants(),
                  "bg-[var(--accent)] text-white hover:bg-[color-mix(in_srgb,var(--accent)_88%,black_12%)]",
                )}
              >
                Back to Overview
                <ArrowRight className="size-4" />
              </Link>
              <Link href="/login" className={buttonVariants({ variant: "secondary" })}>
                Sign in
              </Link>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
