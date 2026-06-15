"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";

/**
 * Validate that a redirect target is a safe same-origin relative path.
 *
 * Accepted: paths starting with a single "/" that are NOT protocol-relative
 * ("//evil.com") and NOT backslash-escaped ("/\evil.com"), preventing open
 * redirect attacks regardless of what the backend returns.
 *
 * Returns the sanitized path, or "/overview" if the input is invalid.
 */
function sanitizeRedirect(raw: string | null | undefined): string {
  const FALLBACK = "/overview";
  if (!raw || typeof raw !== "string") return FALLBACK;
  // Must start with exactly one "/" and NOT be "//" or "/\" (protocol-relative / backslash escape)
  if (!raw.startsWith("/")) return FALLBACK;
  if (raw.startsWith("//") || raw.startsWith("/\\")) return FALLBACK;
  // Must not contain a scheme (e.g. "javascript:" injected mid-path or after redirect)
  if (/[a-zA-Z][a-zA-Z0-9+\-.]*:/.test(raw)) return FALLBACK;
  return raw;
}

export default function MagicLinkPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.auth.consumeMagicLink(params.token);
        router.replace(sanitizeRedirect(result.redirect_to));
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Invalid or expired sign-in link.");
      }
    })();
  }, [params.token, router]);

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="max-w-sm w-full text-center space-y-4">
          <p className="text-sm text-[var(--negative)]">{error}</p>
          <a href="/login" className="text-sm underline text-[var(--ink-soft)] hover:text-[var(--ink)]">
            Go to login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <p className="text-sm text-[var(--ink-soft)]">Signing you in...</p>
    </div>
  );
}
