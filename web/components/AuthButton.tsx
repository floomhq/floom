"use client";

import { useEffect, useState, type ReactNode } from "react";
import { getLastAuthMethod, setLastAuthMethod, type LastAuthMethod } from "@/lib/last-auth";
import { LastUsedBadge } from "./LastUsedBadge";

// Wraps an OAuth link, remembering the chosen method on click and showing the
// "Last used" badge when it matches. The badge resolves after mount only —
// localStorage is unavailable during SSR, so it stays hidden on first paint to
// avoid a hydration mismatch. className is passed through so each surface keeps
// its own button styling.
export function AuthButton({
  method,
  href,
  className,
  children,
}: {
  method: LastAuthMethod;
  href: string;
  className?: string;
  children: ReactNode;
}) {
  const [lastUsed, setLastUsed] = useState<LastAuthMethod | null>(null);

  useEffect(() => {
    setLastUsed(getLastAuthMethod());
  }, []);

  return (
    <div style={{ position: "relative" }}>
      <a href={href} className={className} onClick={() => setLastAuthMethod(method)}>
        {children}
      </a>
      {lastUsed === method ? <LastUsedBadge /> : null}
    </div>
  );
}
