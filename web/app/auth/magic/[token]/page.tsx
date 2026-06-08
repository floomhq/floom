"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { api } from "@/lib/api";

export default function MagicLinkPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const result = await api.auth.consumeMagicLink(params.token);
        router.replace(result.redirect_to ?? "/overview");
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
