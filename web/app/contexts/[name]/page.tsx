"use client";

// /contexts/<name> deep links (breadcrumb, copied pack links) resolve to the
// main contexts page with the pack pre-selected. The split-pane on /contexts
// is the single source of truth for pack detail, so we redirect rather than
// duplicate that UI.
import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";

export default function PackRedirectPage() {
  const { name } = useParams<{ name: string }>();
  const router = useRouter();

  useEffect(() => {
    const packName = Array.isArray(name) ? name[0] : name;
    router.replace(`/contexts?pack=${encodeURIComponent(packName ?? "")}`);
  }, [name, router]);

  return null;
}
