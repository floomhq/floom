"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

export default function MagicLinkPage() {
  const params = useParams<{ token: string }>();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.token) {
      setError("Invalid or expired sign-in link.");
      return;
    }
    window.location.assign(`/api/proxy/auth/magic/${encodeURIComponent(params.token)}`);
  }, [params.token]);

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
